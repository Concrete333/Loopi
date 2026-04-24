/**
 * Context Index Module
 *
 * Separates context preparation from context consumption.
 *
 * - `prepareContextIndex(...)` builds or refreshes the prepared cache inside
 *   `.loopi-context/`.
 * - `buildContextIndex(...)` consumes an already-prepared cache and returns a
 *   `files` list suitable for phase-aware selection.
 * - `getPreparedContextStatus(...)` inspects the prepared cache and returns a
 *   structured status object without throwing.
 * - `validatePreparedContextReadiness(...)` throws PreparedContextError if the
 *   prepared context is missing, drifted, or has config mismatches.
 */

const fs = require('fs').promises;
const path = require('path');
const {
  ensureContextCache,
  readPreparedContextManifest,
  walkSourceTree,
  CACHE_DIR_NAME,
  buildPreparedConfigMetadata,
  comparePreparedConfig,
  formatMismatchSummary,
  computeSourceTreeFingerprint,
  resolveContextManifestPath,
  getContextManifestRelativePath
} = require('./context-cache');

const { matchesAnyPattern } = require('./context-glob');

// ---------------------------------------------------------------------------
// PreparedContextError — structured error for context readiness failures
// ---------------------------------------------------------------------------

class PreparedContextError extends Error {
  /**
   * @param {string} message  Human-readable error message
   * @param {Object} options
   * @param {string} options.code           Machine-readable code:
   *   'CONTEXT_MISSING_DIR' | 'CONTEXT_CACHE_MISSING' |
   *   'CONTEXT_CACHE_DRIFT'
   * @param {string} [options.contextDir]   Absolute path to the context root
   * @param {string} [options.cacheDir]     Absolute path to the cache dir
   * @param {Array}  [options.mismatches]   Structured mismatch objects from
   *   comparePreparedConfig or source-tree drift entries
   * @param {string} [options.instructions] Actionable recovery text
   * @param {Object} [options.statusInfo]   Original structured status payload
   */
  constructor(message, { code, contextDir, cacheDir, mismatches, instructions, statusInfo } = {}) {
    super(message);
    this.name = 'PreparedContextError';
    this.code = code || 'CONTEXT_UNKNOWN';
    if (contextDir) this.contextDir = contextDir;
    if (cacheDir) this.cacheDir = cacheDir;
    if (Array.isArray(mismatches) && mismatches.length > 0) this.mismatches = mismatches;
    if (instructions) this.instructions = instructions;
    if (statusInfo) this.statusInfo = statusInfo;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveContextDir(contextConfig, taskRootDir) {
  const contextDir = path.resolve(taskRootDir, contextConfig.dir);

  try {
    const stats = await fs.stat(contextDir);
    if (!stats.isDirectory()) {
      throw new Error(`Context directory "${contextDir}" exists but is not a directory.`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Context directory "${contextDir}" does not exist.`);
    }
    throw error;
  }

  return contextDir;
}

function getPreparedCacheInstruction(contextDir, reason) {
  const normalizedReason = typeof reason === 'string'
    ? reason.trim().replace(/[. ]+$/, '')
    : '';
  const detail = normalizedReason
    ? `Prepared context cache is not ready for "${contextDir}" (${normalizedReason}).`
    : `Prepared context cache is not ready for "${contextDir}".`;
  return `${detail} Run "npm run cli -- context prepare" from the project root, then retry the run.`;
}

function buildPreparedContextErrorFromStatus(status) {
  if (!status || !status.status || status.status === 'no-context') {
    return null;
  }

  if (status.status === 'missing') {
    const isMissingDir = !status.cacheDir;
    const instructions = status.instructions || (
      isMissingDir
        ? `Context directory "${status.contextDir}" is not available.`
        : getPreparedCacheInstruction(status.contextDir)
    );
    return new PreparedContextError(
      instructions,
      {
        code: isMissingDir ? 'CONTEXT_MISSING_DIR' : 'CONTEXT_CACHE_MISSING',
        contextDir: status.contextDir,
        cacheDir: status.cacheDir,
        instructions,
        statusInfo: status
      }
    );
  }

  if (status.status === 'config-mismatch') {
    const instructions = status.instructions || getPreparedCacheInstruction(
      status.contextDir,
      `config changed: ${formatMismatchSummary(status.mismatches)}`
    );
    return new PreparedContextError(
      instructions,
      {
        code: 'CONTEXT_CACHE_DRIFT',
        contextDir: status.contextDir,
        cacheDir: status.cacheDir,
        mismatches: status.mismatches,
        instructions,
        statusInfo: status
      }
    );
  }

  if (status.status === 'drifted') {
    const instructions = status.instructions || (
      `Prepared context cache is stale for "${status.contextDir}". ` +
      `${status.driftedSources.length} source(s) changed since last prepare. ` +
      'Run "npm run cli -- context prepare" to rebuild.'
    );
    return new PreparedContextError(
      instructions,
      {
        code: 'CONTEXT_CACHE_DRIFT',
        contextDir: status.contextDir,
        cacheDir: status.cacheDir,
        mismatches: status.driftedSources.map((d) => ({
          kind: 'source',
          field: d.sourceRelativePath,
          description: d.description || `Source ${d.change}: ${d.sourceRelativePath}`,
          reason: d.description || `Source ${d.change}: ${d.sourceRelativePath}`
        })),
        instructions,
        statusInfo: status
      }
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// prepareContextIndex — builds or refreshes the cache
// ---------------------------------------------------------------------------

async function prepareContextIndex(contextConfig, taskRootDir) {
  let contextDir;
  try {
    contextDir = await resolveContextDir(contextConfig, taskRootDir);
  } catch (error) {
    const resolvedContextDir = path.resolve(taskRootDir, contextConfig.dir);
    const status = {
      status: 'missing',
      state: 'missing',
      contextDir: resolvedContextDir,
      cacheDir: null,
      builtAt: null,
      mismatches: [],
      driftedSources: [],
      skippedSources: [],
      manifest: null,
      instructions: error.message
    };
    throw buildPreparedContextErrorFromStatus(status) || error;
  }
  const manifest = await ensureContextCache(contextConfig, taskRootDir);
  const files = await buildFilesFromCache(contextDir, manifest);

  return {
    rootDir: contextDir,
    cacheDir: path.join(contextDir, CACHE_DIR_NAME),
    builtAt: manifest.builtAt || Date.now(),
    manifest,
    files
  };
}

// ---------------------------------------------------------------------------
// buildContextIndex — consumes a previously prepared cache
// ---------------------------------------------------------------------------

/**
 * Builds a context index from a previously prepared cache.
 *
 * @param {Object} contextConfig Normalized context configuration
 * @param {string} taskRootDir Root directory of the task
 * @returns {Promise<Object>} `{ rootDir, files, builtAt }`
 */
async function buildContextIndex(contextConfig, taskRootDir) {
  const status = await validatePreparedContextReadiness(contextConfig, taskRootDir);
  const contextDir = status.contextDir || await resolveContextDir(contextConfig, taskRootDir);
  const cacheManifest = status.manifest || await readPreparedContextManifest(contextDir);
  const files = await buildFilesFromCache(contextDir, cacheManifest);
  return { rootDir: contextDir, files, builtAt: cacheManifest.builtAt || Date.now() };
}

// ---------------------------------------------------------------------------
// getPreparedContextStatus — non-throwing status check
// ---------------------------------------------------------------------------

/**
 * Returns a structured status object describing the current state of the
 * prepared context cache for the given context config.
 *
 * Status codes:
 *   'no-context'         — context config is missing or falsy
 *   'missing'            — context dir exists but no cache has been built
 *   'config-mismatch'    — cache exists but config patterns changed
 *   'drifted'            — config matches but source tree changed
 *   'ready'              — cache is fully up to date
 *   'ready-with-warnings'— cache is usable but has skipped sources
 *
 * @param {Object|null} contextConfig  Normalized context config (may be null)
 * @param {string} taskRootDir         Project root
 * @returns {Promise<Object>} `{ status, contextDir, cacheDir, builtAt,
 *   mismatches, driftedSources, skippedSources, manifest, instructions }`
 */
async function getPreparedContextStatus(contextConfig, taskRootDir) {
  if (!contextConfig || !contextConfig.dir) {
    return {
      status: 'no-context',
      state: 'no-context',
      contextDir: null,
      cacheDir: null,
      builtAt: null,
      mismatches: [],
      driftedSources: [],
      skippedSources: [],
      manifest: null,
      instructions: null
    };
  }

  let contextDir;
  try {
    contextDir = await resolveContextDir(contextConfig, taskRootDir);
  } catch (error) {
    return {
      status: 'missing',
      state: 'missing',
      contextDir: path.resolve(taskRootDir, contextConfig.dir),
      cacheDir: null,
      builtAt: null,
      mismatches: [],
      driftedSources: [],
      skippedSources: [],
      manifest: null,
      instructions: error.message
    };
  }

  const cacheDir = path.join(contextDir, CACHE_DIR_NAME);
  const cacheManifest = await readPreparedContextManifest(contextDir);

  if (!cacheManifest) {
    return {
      status: 'missing',
      state: 'missing',
      contextDir,
      cacheDir,
      builtAt: null,
      mismatches: [],
      driftedSources: [],
      skippedSources: [],
      manifest: null,
      instructions: getPreparedCacheInstruction(contextDir)
    };
  }

  // Check config mismatch
  const expectedPreparedConfig = buildPreparedConfigMetadata(contextConfig, taskRootDir, contextDir);
  const configComparison = comparePreparedConfig(
    cacheManifest.preparedConfig,
    expectedPreparedConfig
  );

  if (!configComparison.match) {
    return {
      status: 'config-mismatch',
      state: 'config-mismatch',
      contextDir,
      cacheDir,
      builtAt: cacheManifest.builtAt,
      mismatches: configComparison.mismatches,
      driftedSources: [],
      skippedSources: [],
      manifest: cacheManifest,
      instructions: getPreparedCacheInstruction(
        contextDir,
        `config changed: ${formatMismatchSummary(configComparison.mismatches)}`
      )
    };
  }

  // Check source-tree drift
  const manifestPath = resolveContextManifestPath(contextConfig, taskRootDir, contextDir);
  const manifestRelativePath = getContextManifestRelativePath(contextDir, manifestPath);
  const mustExclude = new Set(manifestRelativePath ? [manifestRelativePath] : []);
  const currentFingerprint = await computeSourceTreeFingerprint(
    contextDir,
    cacheDir,
    contextConfig.include || [],
    contextConfig.exclude || [],
    mustExclude
  );

  const cachedFingerprint = cacheManifest.sourceTreeFingerprint
    || (cacheManifest.preparedConfig && cacheManifest.preparedConfig.sourceTreeFingerprint)
    || null;
  const driftedSources = [];

  if (!cachedFingerprint) {
    const mismatches = [{
      kind: 'metadata',
      field: 'sourceTreeFingerprint',
      description: 'source tree fingerprint metadata is missing',
      reason: 'source tree fingerprint metadata is missing'
    }];
    return {
      status: 'config-mismatch',
      state: 'config-mismatch',
      contextDir,
      cacheDir,
      builtAt: cacheManifest.builtAt,
      mismatches,
      driftedSources: [],
      skippedSources: [],
      manifest: cacheManifest,
      instructions: getPreparedCacheInstruction(
        contextDir,
        `prepared cache metadata is incomplete (${formatMismatchSummary(mismatches)})`
      )
    };
  }

  if (cachedFingerprint !== currentFingerprint) {
    // Determine which specific sources drifted by comparing manifest entries
    // against current file stats
    const currentSourceMap = await buildCurrentSourceMap(
      contextDir, cacheDir, contextConfig.include || [], contextConfig.exclude || [], mustExclude
    );

    for (const entry of (cacheManifest.sources || [])) {
      const current = currentSourceMap.get(entry.sourceRelativePath);
      if (!current) {
        driftedSources.push({
          sourceRelativePath: entry.sourceRelativePath,
          change: 'removed',
          description: `source removed: ${entry.sourceRelativePath}`
        });
      } else if (current.mtimeMs !== entry.mtimeMs || current.sizeBytes !== entry.sizeBytes) {
        driftedSources.push({
          sourceRelativePath: entry.sourceRelativePath,
          change: 'modified',
          description: `source modified: ${entry.sourceRelativePath}`
        });
      }
    }

    // Check for added files
    const cachedPaths = new Set((cacheManifest.sources || []).map(s => s.sourceRelativePath));
    for (const [relativePath] of currentSourceMap) {
      if (!cachedPaths.has(relativePath)) {
        driftedSources.push({
          sourceRelativePath: relativePath,
          change: 'added',
          description: `source added: ${relativePath}`
        });
      }
    }
  }

  // Collect skipped sources
  const skippedSources = (cacheManifest.sources || [])
    .filter(s => s.skipped)
    .map(s => ({
      sourceRelativePath: s.sourceRelativePath,
      skipReason: s.skipReason,
      reason: s.skipReason
    }));

  // Determine final status
  const hasDrift = driftedSources.length > 0;
  const hasSkips = skippedSources.length > 0;
  let status;
  if (hasDrift) {
    status = 'drifted';
  } else if (hasSkips) {
    status = 'ready-with-warnings';
  } else {
    status = 'ready';
  }

  return {
    status,
    state: status,
    contextDir,
    cacheDir,
    builtAt: cacheManifest.builtAt,
    mismatches: [],
    driftedSources,
    skippedSources,
    manifest: cacheManifest,
    instructions: hasDrift
      ? `Source tree has changed (${driftedSources.length} change(s)). Run "npm run cli -- context prepare" to rebuild.`
      : null
  };
}

/**
 * Builds a map of relative path -> { mtimeMs, sizeBytes } for the current
 * source tree, respecting include/exclude patterns.
 */
async function buildCurrentSourceMap(contextDir, cacheDirPath, includePatterns, excludePatterns, mustExcludeRelativePaths) {
  const sourceFiles = await walkSourceTree(contextDir, cacheDirPath);

  const map = new Map();
  for (const sourcePath of sourceFiles) {
    const relativePath = path.relative(contextDir, sourcePath).replace(/\\/g, '/');
    if (mustExcludeRelativePaths.has(relativePath)) continue;
    if (matchesAnyPattern(relativePath, excludePatterns)) continue;
    if (includePatterns.length > 0 && !matchesAnyPattern(relativePath, includePatterns)) continue;

    try {
      const stats = await fs.stat(sourcePath);
      if (stats.isFile()) {
        map.set(relativePath, { mtimeMs: stats.mtimeMs, sizeBytes: stats.size });
      }
    } catch (_) {
      // File disappeared — skip
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// validatePreparedContextReadiness — throws PreparedContextError if not ready
// ---------------------------------------------------------------------------

/**
 * Validates that the prepared context cache is ready for a run. Throws
 * PreparedContextError for blocking states (missing, config-mismatch,
// drifted). Passes silently for no-context and ready states.
 *
 * @param {Object|null} contextConfig  Normalized context config
 * @param {string} taskRootDir         Project root
 * @returns {Promise<Object>} The status object (when no error is thrown)
 */
async function validatePreparedContextReadiness(contextConfig, taskRootDir) {
  const status = await getPreparedContextStatus(contextConfig, taskRootDir);

  if (status.status === 'no-context') {
    return status;
  }

  const blockingError = buildPreparedContextErrorFromStatus(status);
  if (blockingError) {
    throw blockingError;
  }

  return status;
}

// ---------------------------------------------------------------------------
// buildFilesFromCache — shared file list builder
// ---------------------------------------------------------------------------

/**
 * Builds an index entry per source chunk from the cache manifest. Skipped
 * sources are kept as explicit entries so diagnostics flow downstream.
 */
async function buildFilesFromCache(contextDir, cacheManifest) {
  const files = [];
  const cacheDir = path.join(contextDir, CACHE_DIR_NAME);

  for (const source of cacheManifest.sources) {
    if (source.skipped) {
      files.push({
        filePath: path.join(contextDir, source.sourceRelativePath),
        relativePath: source.sourceRelativePath,
        phase: source.phase || 'shared',
        sizeBytes: source.sizeBytes ?? 0,
        content: null,
        skipped: true,
        skipReason: source.skipReason || 'Skipped during cache build',
        sourceType: source.sourceType || 'unknown',
        extractor: source.extractor || null,
        priority: source.priority ?? 0,
        purpose: source.purpose ?? null
      });
      continue;
    }

    for (const output of source.outputs) {
      const chunkPath = path.join(cacheDir, output.cacheRelativePath);
      const displayPath = output.displayPath || source.sourceRelativePath;
      const relativePath = buildChunkRelativePath(displayPath, output.chunkOrdinal, output.chunkCount);
      const baseEntry = {
        filePath: chunkPath,
        relativePath,
        displayPath,
        phase: source.phase || 'shared',
        sizeBytes: output.charCount ?? 0,
        content: null,
        sourceType: source.sourceType || 'unknown',
        extractor: source.extractor || null,
        priority: source.priority ?? 0,
        purpose: source.purpose ?? null,
        sourceRelativePath: source.sourceRelativePath,
        chunkOrdinal: output.chunkOrdinal,
        chunkCount: output.chunkCount,
        sectionLabel: output.sectionLabel || null,
        isChunk: true,
        cacheRelativePath: output.cacheRelativePath
      };

      try {
        await fs.access(chunkPath);
      } catch (error) {
        files.push({
          ...baseEntry,
          skipped: true,
          skipReason: `Chunk file missing: ${error.message}`,
          deferredContent: false
        });
        continue;
      }

      files.push({
        ...baseEntry,
        skipped: false,
        skipReason: null,
        deferredContent: true
      });
    }
  }

  return files;
}

function buildChunkRelativePath(displayPath, chunkOrdinal, chunkCount) {
  if (!displayPath) {
    return `(unknown)#chunk-${String(chunkOrdinal).padStart(3, '0')}`;
  }
  if (!Number.isInteger(chunkCount) || chunkCount <= 1) {
    return displayPath;
  }
  return `${displayPath}#chunk-${String(chunkOrdinal).padStart(3, '0')}`;
}

module.exports = {
  buildContextIndex,
  prepareContextIndex,
  buildFilesFromCache,
  getPreparedContextStatus,
  validatePreparedContextReadiness,
  PreparedContextError
};
