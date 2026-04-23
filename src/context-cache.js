/**
 * Context Cache Module
 *
 * Builds and maintains the `.loopi-context/` cache directory inside a context
 * root. The cache turns prepared source files into normalized text chunks on
 * disk so the rest of the pipeline can keep doing phase-aware selection and
 * prompt injection without worrying about PDFs, DOCX, or notebooks.
 *
 * Design notes
 * ------------
 *   - Reuse is gated on three things:
 *       1. `manifest.version` matches the current schema version,
 *       2. the source file's SHA-256 matches the cached `sourceHash`,
 *       3. the per-source manifest override entry matches the cached
 *          `manifestEntryHash`.
 *     We deliberately compute a per-entry hash rather than a single manifest
 *     hash so that editing `context.json` for file A does not invalidate B.
 *
 *   - `mtimeMs` and `sizeBytes` are used as a fast-path: if both match the
 *     cached values we skip re-hashing the source. Hashing is still the
 *     authority.
 *
 *   - Writes are serialized per context root with a short-lived `.loopi.lock`
 *     file so two concurrent runs on the same prepared root do not scribble
 *     over each other's chunk files or manifest.
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { normalizeSourceFile } = require('./context-normalize');
const {
  matchesAnyPattern,
  normalizePatternList,
  inferPhase
} = require('./context-glob');

const CACHE_DIR_NAME = '.loopi-context';
const NORMALIZED_DIR = 'normalized';
const MANIFEST_FILE = 'manifest.json';
const LOCK_FILE = '.loopi.lock';

// v2 added prepared-config drift metadata plus source-tree fingerprinting.
// Bump this whenever the manifest schema changes in a way that makes cached
// entries unsafe to reuse. A mismatch forces a full rebuild.
const MANIFEST_SCHEMA_VERSION = 2;

// Short-lived locks are fine here — the cache build is local and finite.
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_RETRY_MS = 75;
const LOCK_MAX_WAIT_MS = 30 * 1000;  // 30 seconds

async function computeFileHash(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function computeEntryHash(value) {
  // `value` is the per-source override record from context.json, or `null`.
  // Canonicalize so key ordering cannot flip the hash.
  const canonical = value == null ? null : canonicalize(value);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Walks a directory tree and returns all regular files, skipping the cache
 * directory plus `node_modules/` and `.git/` so the cache walker never
 * descends into wildly large unrelated trees.
 */
async function walkSourceTree(dir, cacheDirPath) {
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return files;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (cacheDirPath && fullPath === cacheDirPath) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const subFiles = await walkSourceTree(fullPath, cacheDirPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function readManifest(cacheDir) {
  const manifestPath = path.join(cacheDir, MANIFEST_FILE);
  try {
    const content = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(content);
    // Reject older or future schema versions — caller will rebuild from scratch.
    if (!parsed || parsed.version !== MANIFEST_SCHEMA_VERSION) {
      return null;
    }
    return parsed;
  } catch (_) {
    // Missing or malformed manifest: treat as "no manifest" and rebuild.
    return null;
  }
}

async function writeManifest(cacheDir, manifest) {
  const manifestPath = path.join(cacheDir, MANIFEST_FILE);
  const tempPath = manifestPath + '.tmp';

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.rename(tempPath, manifestPath);
}

/**
 * Builds the cache-relative output path for one chunk of one source file.
 * Preserves the source directory tree under `.loopi-context/normalized/` and
 * keeps the original file name + extension as a prefix so `notes.md` and
 * `notes.txt` never collide.
 */
function buildChunkOutputPath(sourceRelativePath, chunkOrdinal) {
  const parsed = path.parse(sourceRelativePath);
  const dir = parsed.dir;
  const base = parsed.base;
  const paddedOrdinal = String(chunkOrdinal).padStart(3, '0');
  const chunkFileName = `${base}__chunk-${paddedOrdinal}.md`;

  return dir
    ? path.join(NORMALIZED_DIR, dir, chunkFileName)
    : path.join(NORMALIZED_DIR, chunkFileName);
}

function resolveContextManifestPath(contextConfig, taskRootDir, contextDir) {
  if (contextConfig.manifest) {
    return path.resolve(taskRootDir, contextConfig.manifest);
  }
  return path.join(contextDir, 'context.json');
}

function buildPreparedConfigMetadata(contextConfig, taskRootDir, contextDir) {
  const include = normalizePatternList(contextConfig.include || []);
  const exclude = normalizePatternList(contextConfig.exclude || []);
  const manifestPath = resolveContextManifestPath(contextConfig, taskRootDir, contextDir);
  const contextManifestPath = getContextManifestRelativePath(contextDir, manifestPath)
    || manifestPath.replace(/\\/g, '/');

  return {
    include,
    exclude,
    contextManifestPath
  };
}

function comparePreparedConfig(actualPreparedConfig, expectedPreparedConfig) {
  if (!actualPreparedConfig || typeof actualPreparedConfig !== 'object') {
    return {
      match: false,
      mismatches: [{
        kind: 'metadata',
        field: 'preparedConfig',
        description: 'prepared cache metadata is missing',
        reason: 'prepared cache metadata is missing'
      }]
    };
  }

  const mismatches = [];

  const actualInclude = JSON.stringify(normalizePatternList(actualPreparedConfig.include || []));
  const expectedInclude = JSON.stringify(normalizePatternList(expectedPreparedConfig.include || []));
  if (actualInclude !== expectedInclude) {
    mismatches.push({
      kind: 'config',
      field: 'include',
      description: 'include patterns changed',
      reason: 'include patterns changed'
    });
  }

  const actualExclude = JSON.stringify(normalizePatternList(actualPreparedConfig.exclude || []));
  const expectedExclude = JSON.stringify(normalizePatternList(expectedPreparedConfig.exclude || []));
  if (actualExclude !== expectedExclude) {
    mismatches.push({
      kind: 'config',
      field: 'exclude',
      description: 'exclude patterns changed',
      reason: 'exclude patterns changed'
    });
  }

  if ((actualPreparedConfig.contextManifestPath || null) !== (expectedPreparedConfig.contextManifestPath || null)) {
    mismatches.push({
      kind: 'config',
      field: 'contextManifestPath',
      description: 'context manifest path changed',
      reason: 'context manifest path changed'
    });
  }

  return {
    match: mismatches.length === 0,
    mismatches
  };
}

function formatMismatchSummary(mismatches) {
  if (!Array.isArray(mismatches) || mismatches.length === 0) return '';
  return mismatches.map((m) => m.description || m.reason || m.field || 'unknown mismatch').join(', ');
}

function buildSourceTreeFingerprintFromEntries(entries) {
  const normalizedEntries = Array.isArray(entries)
    ? entries
      .filter((entry) => entry && entry.sourceRelativePath)
      .map((entry) => ({
        sourceRelativePath: String(entry.sourceRelativePath),
        mtimeMs: entry.mtimeMs,
        sizeBytes: entry.sizeBytes
      }))
      .sort((left, right) => left.sourceRelativePath.localeCompare(right.sourceRelativePath))
    : [];

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizedEntries))
    .digest('hex');
}

/**
 * Computes a deterministic fingerprint of the source tree that would be
 * considered for context preparation. Used to detect added, removed, or
 * modified source files even when context config is unchanged.
 *
 * Only stats files — does not read full file contents.
 */
async function computeSourceTreeFingerprint(contextDir, cacheDirPath, includePatterns, excludePatterns, mustExcludeRelativePaths) {
  const sourceFiles = await walkSourceTree(contextDir, cacheDirPath);

  const filteredSources = sourceFiles.filter((filePath) => {
    const relativePath = path.relative(contextDir, filePath).replace(/\\/g, '/');
    if (mustExcludeRelativePaths.has(relativePath)) return false;
    if (matchesAnyPattern(relativePath, excludePatterns)) return false;
    if (includePatterns.length > 0 && !matchesAnyPattern(relativePath, includePatterns)) return false;
    return true;
  });

  const entries = [];
  for (const sourcePath of filteredSources) {
    const relativePath = path.relative(contextDir, sourcePath).replace(/\\/g, '/');
    try {
      const stats = await fs.stat(sourcePath);
      if (stats.isFile()) {
        entries.push({
          sourceRelativePath: relativePath,
          mtimeMs: stats.mtimeMs,
          sizeBytes: stats.size
        });
      }
    } catch (_) {
      // File disappeared between walk and stat — skip it
    }
  }

  entries.sort((a, b) => a.sourceRelativePath.localeCompare(b.sourceRelativePath));
  const serialized = JSON.stringify(entries);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * If the manifest lives inside the context root, return its path relative to
 * that root so we can exclude it from the source list. Manifests outside the
 * root are referenced by absolute path only.
 */
function getContextManifestRelativePath(contextDir, manifestPath) {
  const normalizedContextDir = contextDir.replace(/\\/g, '/');
  const normalizedManifestPath = manifestPath.replace(/\\/g, '/');

  if (!normalizedManifestPath.startsWith(`${normalizedContextDir}/`)) {
    return null;
  }

  return path.relative(contextDir, manifestPath).replace(/\\/g, '/');
}

async function loadContextManifest(contextConfig, taskRootDir, contextDir) {
  const manifestPath = resolveContextManifestPath(contextConfig, taskRootDir, contextDir);
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return { manifestPath, manifestData: parsed, manifestWarning: null };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { manifestPath, manifestData: null, manifestWarning: null };
    }
    return {
      manifestPath,
      manifestData: null,
      manifestWarning: `Failed to load context manifest at "${manifestPath}": ${error.message}`
    };
  }
}

/**
 * Best-effort per-context-root lock so concurrent Loopi runs do not race on
 * the same cache directory. If another process is holding a fresh lock we
 * wait briefly; if the lock is stale or from a missing PID we steal it.
 */
async function acquireCacheLock(cacheDir) {
  const lockPath = path.join(cacheDir, LOCK_FILE);
  await fs.mkdir(cacheDir, { recursive: true });

  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      await handle.close();
      return lockPath;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      if (await tryStealStaleLock(lockPath)) {
        continue;
      }
      if (Date.now() - started >= LOCK_MAX_WAIT_MS) {
        // Give up waiting and proceed without a lock. The manifest write is
        // still atomic via rename, so the worst case is a wasted rebuild.
        return null;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function tryStealStaleLock(lockPath) {
  try {
    const [stat, raw] = await Promise.all([
      fs.stat(lockPath),
      fs.readFile(lockPath, 'utf-8').catch(() => '')
    ]);
    const age = Date.now() - stat.mtimeMs;
    if (age > LOCK_STALE_MS) {
      await fs.unlink(lockPath).catch(() => {});
      return true;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.pid === 'number' && !isPidAlive(parsed.pid)) {
        await fs.unlink(lockPath).catch(() => {});
        return true;
      }
    } catch (_) {
      // Unreadable lock payload — treat as stale only if old enough, already
      // handled above.
    }
  } catch (_) {
    // Lock vanished between checks; let the caller retry the create.
    return true;
  }
  return false;
}

function isPidAlive(pid) {
  if (!pid || pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function releaseCacheLock(lockPath) {
  if (!lockPath) return;
  try {
    await fs.unlink(lockPath);
  } catch (_) {
    // Already gone, fine.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ensures the context cache is built and up-to-date. Returns the manifest
 * that downstream indexing consumes.
 */
async function ensureContextCache(contextConfig, taskRootDir) {
  const contextDir = path.resolve(taskRootDir, contextConfig.dir);
  const cacheDir = path.join(contextDir, CACHE_DIR_NAME);
  const normalizedDir = path.join(cacheDir, NORMALIZED_DIR);

  await fs.mkdir(normalizedDir, { recursive: true });

  const lockPath = await acquireCacheLock(cacheDir);
  try {
    return await buildCacheManifest(contextConfig, taskRootDir, contextDir, cacheDir);
  } finally {
    await releaseCacheLock(lockPath);
  }
}

async function buildCacheManifest(contextConfig, taskRootDir, contextDir, cacheDir) {
  const existingManifest = await readManifest(cacheDir);
  const existingEntries = new Map();
  if (existingManifest && Array.isArray(existingManifest.sources)) {
    for (const entry of existingManifest.sources) {
      existingEntries.set(entry.sourceRelativePath, entry);
    }
  }

  const { manifestPath, manifestData, manifestWarning } = await loadContextManifest(
    contextConfig,
    taskRootDir,
    contextDir
  );
  if (manifestWarning) {
    console.warn(`Warning: ${manifestWarning}`);
  }
  const manifestPathInsideContext = getContextManifestRelativePath(contextDir, manifestPath);
  const mustExcludeRelativePaths = new Set(
    manifestPathInsideContext ? [manifestPathInsideContext] : []
  );

  const sourceFiles = await walkSourceTree(contextDir, cacheDir);

  const includePatterns = contextConfig.include || [];
  const excludePatterns = contextConfig.exclude || [];
  const preparedConfig = buildPreparedConfigMetadata(contextConfig, taskRootDir, contextDir);

  const filteredSources = sourceFiles.filter((filePath) => {
    const relativePath = path.relative(contextDir, filePath).replace(/\\/g, '/');
    if (mustExcludeRelativePaths.has(relativePath)) return false;
    if (matchesAnyPattern(relativePath, excludePatterns)) return false;
    if (includePatterns.length > 0 && !matchesAnyPattern(relativePath, includePatterns)) {
      return false;
    }
    return true;
  });

  const manifestSources = [];
  const sourceFingerprintEntries = [];
  const seenCachePaths = new Set();
  let rebuilt = 0;
  let reused = 0;
  let skipped = 0;

  for (const sourcePath of filteredSources) {
    const relativePath = path.relative(contextDir, sourcePath).replace(/\\/g, '/');
    const manifestOverride = manifestData && manifestData[relativePath]
      ? manifestData[relativePath]
      : null;
    const manifestEntryHash = computeEntryHash(manifestOverride);

    const statResult = await safeStat(sourcePath);
    if (!statResult.ok) {
      manifestSources.push(buildSkippedEntry(relativePath, {
        phase: inferPhase(relativePath),
        manifestEntryHash,
        skipReason: `Failed to stat: ${statResult.error.message}`
      }));
      skipped += 1;
      continue;
    }
    const stats = statResult.stats;
    sourceFingerprintEntries.push({
      sourceRelativePath: relativePath,
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size
    });

    // Fast-path reuse: if file stats match, skip the SHA-256 read entirely.
    const existing = existingEntries.get(relativePath);
    const statsLookSame = existing
      && existing.sizeBytes === stats.size
      && existing.mtimeMs === stats.mtimeMs
      && existing.manifestEntryHash === manifestEntryHash;

    if (statsLookSame) {
      const reuseReady = await canReuseExistingEntry(cacheDir, existing);
      if (reuseReady) {
        const reusedEntry = applyManifestOverride(existing, manifestOverride, manifestEntryHash);
        manifestSources.push(reusedEntry);
        reused += 1;
        trackOutputPaths(seenCachePaths, reusedEntry);
        continue;
      }
    }

    const hashResult = await safeHash(sourcePath);
    if (!hashResult.ok) {
      manifestSources.push(buildSkippedEntry(relativePath, {
        phase: inferPhase(relativePath),
        manifestEntryHash,
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.size,
        skipReason: `Failed to hash: ${hashResult.error.message}`
      }));
      skipped += 1;
      continue;
    }
    const sourceHash = hashResult.hash;

    // Slow-path reuse: source content unchanged. Chunk files are still valid
    // regardless of whether the manifest override was edited, so reuse the
    // chunks and refresh metadata in place. We only count this as `rebuilt`
    // if the metadata actually changed; otherwise it is a true reuse.
    if (existing && existing.sourceHash === sourceHash) {
      const reuseReady = await canReuseExistingEntry(cacheDir, existing);
      if (reuseReady) {
        const reusedEntry = applyManifestOverride(
          { ...existing, mtimeMs: stats.mtimeMs, sizeBytes: stats.size },
          manifestOverride,
          manifestEntryHash
        );
        manifestSources.push(reusedEntry);
        if (existing.manifestEntryHash === manifestEntryHash) {
          reused += 1;
        } else {
          rebuilt += 1;
        }
        trackOutputPaths(seenCachePaths, reusedEntry);
        continue;
      }
    }

    const result = await normalizeSourceFile(sourcePath);
    const phase = inferPhase(relativePath);
    const { phase: effectivePhase, priority, purpose } = resolveOverrides(phase, manifestOverride);

    if (result.skipped) {
      manifestSources.push({
        sourceRelativePath: relativePath,
        phase: effectivePhase,
        priority,
        purpose,
        sourceType: result.sourceType,
        extractor: result.extractor,
        sourceHash,
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.size,
        manifestEntryHash,
        skipped: true,
        skipReason: result.skipReason,
        outputs: []
      });
      skipped += 1;
      continue;
    }

    const outputs = [];
    for (const chunk of result.chunks) {
      const outputPath = buildChunkOutputPath(relativePath, chunk.chunkOrdinal);
      const absoluteOutputPath = path.join(cacheDir, outputPath);
      await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
      await fs.writeFile(absoluteOutputPath, chunk.text, 'utf-8');

      outputs.push({
        cacheRelativePath: outputPath.replace(/\\/g, '/'),
        displayPath: relativePath,
        sourceRelativePath: relativePath,
        chunkOrdinal: chunk.chunkOrdinal,
        chunkCount: chunk.chunkCount,
        sectionLabel: chunk.sectionLabel,
        charCount: chunk.text.length
      });
    }

    const newEntry = {
      sourceRelativePath: relativePath,
      phase: effectivePhase,
      priority,
      purpose,
      sourceType: result.sourceType,
      extractor: result.extractor,
      sourceHash,
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
      manifestEntryHash,
      skipped: false,
      skipReason: null,
      outputs
    };

    manifestSources.push(newEntry);
    trackOutputPaths(seenCachePaths, newEntry);
    rebuilt += 1;
  }

  await pruneOrphanChunks(cacheDir, seenCachePaths);
  const sourceTreeFingerprint = buildSourceTreeFingerprintFromEntries(sourceFingerprintEntries);
  preparedConfig.sourceTreeFingerprint = sourceTreeFingerprint;

  const manifest = {
    version: MANIFEST_SCHEMA_VERSION,
    builtAt: Date.now(),
    preparedConfig,
    sourceTreeFingerprint,
    contextManifestPath: manifestPathInsideContext
      || manifestPath.replace(/\\/g, '/'),
    stats: { total: manifestSources.length, rebuilt, reused, skipped },
    sources: manifestSources
  };

  await writeManifest(cacheDir, manifest);
  return manifest;
}

function trackOutputPaths(seen, entry) {
  if (!entry || !Array.isArray(entry.outputs)) return;
  for (const out of entry.outputs) {
    if (out && out.cacheRelativePath) {
      seen.add(out.cacheRelativePath.replace(/\\/g, '/'));
    }
  }
}

/**
 * Walks `.loopi-context/normalized/` and removes any chunk file that is no
 * longer referenced by a manifest entry. This keeps the cache directory
 * bounded as sources are renamed or removed over time.
 */
async function pruneOrphanChunks(cacheDir, seenCachePaths) {
  const normalizedRoot = path.join(cacheDir, NORMALIZED_DIR);
  const entries = await walkSourceTree(normalizedRoot, null);

  for (const absolutePath of entries) {
    const relative = path
      .relative(cacheDir, absolutePath)
      .replace(/\\/g, '/');
    if (!seenCachePaths.has(relative)) {
      try {
        await fs.unlink(absolutePath);
      } catch (_) {
        // Ignore — another process may have removed it already.
      }
    }
  }
}

function applyManifestOverride(existingEntry, manifestOverride, manifestEntryHash) {
  const basePhase = existingEntry && existingEntry.sourceRelativePath
    ? inferPhase(existingEntry.sourceRelativePath)
    : (existingEntry.phase || 'shared');
  const { phase, priority, purpose } = resolveOverrides(
    basePhase,
    manifestOverride
  );
  return {
    ...existingEntry,
    phase,
    priority,
    purpose,
    manifestEntryHash
  };
}

function resolveOverrides(inferredPhase, manifestOverride) {
  let phase = inferredPhase;
  let priority = 0;
  let purpose = null;

  if (manifestOverride && typeof manifestOverride === 'object') {
    if (typeof manifestOverride.phase === 'string' && manifestOverride.phase) {
      phase = manifestOverride.phase;
    }
    if (typeof manifestOverride.priority === 'number' && Number.isFinite(manifestOverride.priority)) {
      priority = manifestOverride.priority;
    }
    if (typeof manifestOverride.purpose === 'string' && manifestOverride.purpose) {
      purpose = manifestOverride.purpose;
    }
  }

  return { phase, priority, purpose };
}

function buildSkippedEntry(relativePath, meta) {
  return {
    sourceRelativePath: relativePath,
    phase: meta.phase || 'shared',
    priority: 0,
    purpose: null,
    sourceType: 'unknown',
    extractor: null,
    sourceHash: null,
    mtimeMs: meta.mtimeMs ?? null,
    sizeBytes: meta.sizeBytes ?? null,
    manifestEntryHash: meta.manifestEntryHash,
    skipped: true,
    skipReason: meta.skipReason,
    outputs: []
  };
}

async function safeStat(filePath) {
  try {
    return { ok: true, stats: await fs.stat(filePath) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function safeHash(filePath) {
  try {
    return { ok: true, hash: await computeFileHash(filePath) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function verifyChunkFilesExist(cacheDir, outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) return false;
  for (const output of outputs) {
    const absolutePath = path.join(cacheDir, output.cacheRelativePath);
    try {
      await fs.access(absolutePath);
    } catch (_) {
      return false;
    }
  }
  return true;
}

async function canReuseExistingEntry(cacheDir, existingEntry) {
  if (!existingEntry) return false;

  if (existingEntry.skipped) {
    // Reuse only skips produced after a successful source hash. That covers
    // stable outcomes like unsupported file types or empty extraction results
    // while still re-attempting transient stat/hash failures.
    return typeof existingEntry.sourceHash === 'string' && existingEntry.sourceHash.length > 0;
  }

  return verifyChunkFilesExist(cacheDir, existingEntry.outputs);
}

async function readPreparedContextManifest(contextDir) {
  const cacheDir = path.join(contextDir, CACHE_DIR_NAME);
  return readManifest(cacheDir);
}

module.exports = {
  ensureContextCache,
  readPreparedContextManifest,
  walkSourceTree,
  CACHE_DIR_NAME,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  resolveContextManifestPath,
  getContextManifestRelativePath,
  buildPreparedConfigMetadata,
  comparePreparedConfig,
  formatMismatchSummary,
  computeSourceTreeFingerprint
};
