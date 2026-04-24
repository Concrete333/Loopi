const fs = require('fs').promises;
const path = require('path');
const { normalizeTaskConfig } = require('../task-config');
const taskPaths = require('../task-paths');
const { CollaborationStore } = require('../collaboration-store');
const { listPresets, savePreset, usePreset } = require('../cli-presets');
const { atomicWriteText } = require('../atomic-write');
const { listAvailableUseCases } = require('../use-case-loader');
const setupService = require('../setup-service');
const providerService = require('../provider-service');
const { getPreparedContextStatus } = require('../context-index');
const { prepareContextIndex } = require('../context-index');

function contextBlockerCode(status) {
  if (status.status === 'drifted' || status.status === 'config-mismatch') {
    return 'CONTEXT_CACHE_DRIFT';
  }
  // status.status === 'missing': distinguish "directory does not exist" from
  // "directory exists but cache has never been built" by whether a cacheDir
  // is known. getPreparedContextStatus only populates cacheDir when the
  // context directory resolved.
  if (!status.cacheDir) {
    return 'CONTEXT_MISSING_DIR';
  }
  return 'CONTEXT_CACHE_MISSING';
}

function buildBlockingContextLaunchError(status) {
  if (!status || !status.status) {
    return null;
  }

  const blocking = status.status === 'missing'
    || status.status === 'config-mismatch'
    || status.status === 'drifted';

  if (!blocking) {
    return null;
  }

  return {
    code: contextBlockerCode(status),
    message: status.instructions || 'Prepared context cache is not ready.',
    contextDir: status.contextDir || null,
    cacheDir: status.cacheDir || null,
    instructions: status.instructions || null,
    mismatches: Array.isArray(status.mismatches) ? status.mismatches : [],
    driftedSources: Array.isArray(status.driftedSources) ? status.driftedSources : [],
    skippedSources: Array.isArray(status.skippedSources) ? status.skippedSources : [],
    contextStatus: status
  };
}

// Error codes task-config.js attaches to context-path errors. Matching on
// these is preferable to matching on error-message prefixes; keep the string
// fallback only as a defensive net if an error somehow loses its code.
const CONTEXT_PATH_ERROR_CODES = new Set([
  'CONTEXT_DIR_MISSING',
  'CONTEXT_DIR_NOT_DIRECTORY'
]);

function isContextPathError({ errorCode, errorMessage }) {
  if (errorCode && CONTEXT_PATH_ERROR_CODES.has(errorCode)) {
    return true;
  }
  const trimmed = typeof errorMessage === 'string' ? errorMessage.trim() : '';
  return trimmed.startsWith('context.dir does not exist:')
    || trimmed.startsWith('context.dir must resolve to a directory:');
}

function buildInvalidContextStatusFromConfigError({ errorMessage, errorCode, errorDetails, rawConfig, projectRoot }) {
  if (!rawConfig || !rawConfig.context || typeof rawConfig.context.dir !== 'string') {
    return null;
  }

  if (!isContextPathError({ errorCode, errorMessage })) {
    return null;
  }

  const contextDir = (errorDetails && typeof errorDetails.contextDir === 'string')
    ? errorDetails.contextDir
    : path.resolve(projectRoot, rawConfig.context.dir);
  const trimmedError = typeof errorMessage === 'string' ? errorMessage.trim() : '';
  return {
    status: 'missing',
    state: 'missing',
    contextDir,
    cacheDir: null,
    builtAt: null,
    mismatches: [],
    driftedSources: [],
    skippedSources: [],
    manifest: null,
    instructions: trimmedError || `Context directory "${contextDir}" is not available.`
  };
}

function buildRunSummary(taskArtifact, {
  snapshotCount = 0,
  stepCount = 0,
  isDamaged = false,
  readError = null,
  runId = null
} = {}) {
  const data = taskArtifact && taskArtifact.data ? taskArtifact.data : {};
  return {
    runId: taskArtifact ? taskArtifact.taskId : runId,
    mode: data.mode || 'unknown',
    prompt: data.prompt || '',
    agents: Array.isArray(data.agents) ? data.agents : [],
    startedAt: data.startedAt || taskArtifact?.createdAt || null,
    finishedAt: data.finishedAt || null,
    durationMs: data.durationMs || null,
    status: data.status || (isDamaged ? 'damaged' : 'unknown'),
    error: data.error || null,
    createdAt: taskArtifact?.createdAt || null,
    updatedAt: taskArtifact?.updatedAt || taskArtifact?.createdAt || null,
    hasSnapshots: snapshotCount > 0,
    snapshotCount,
    stepCount,
    isDamaged,
    readError
  };
}

function buildLaunchRunResult({ success, launched, run, normalized, taskFile, error }) {
  return {
    success,
    launched,
    runId: run && run.runId ? run.runId : null,
    status: run && run.status ? run.status : null,
    mode: run && run.mode ? run.mode : (normalized && normalized.mode ? normalized.mode : null),
    taskFile,
    normalized: normalized || null,
    run: run ? {
      runId: run.runId,
      mode: run.mode,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      error: run.error || null
    } : null,
    error: error || null
  };
}

function describeThrownValue(errorLike) {
  if (typeof errorLike === 'string' && errorLike.trim() !== '') {
    return errorLike;
  }
  if (errorLike && typeof errorLike.message === 'string' && errorLike.message.trim() !== '') {
    return errorLike.message;
  }
  if (errorLike == null) {
    return 'Unknown error.';
  }
  try {
    const coerced = String(errorLike);
    if (coerced && coerced !== '[object Object]') {
      return coerced;
    }
  } catch (coercionError) {
    // Ignore coercion problems and fall through to the generic fallback.
  }
  return 'Unknown error.';
}

function extractRunFromThrownValue(errorLike) {
  if (!errorLike || typeof errorLike !== 'object') {
    return null;
  }
  return errorLike.run && typeof errorLike.run === 'object'
    ? errorLike.run
    : null;
}

function errorPayloadFromThrownValue(errorLike) {
  const message = describeThrownValue(errorLike);
  if (errorLike && typeof errorLike === 'object' && typeof errorLike.stack === 'string' && errorLike.stack.trim() !== '') {
    return {
      message,
      stack: errorLike.stack
    };
  }
  return { message };
}

function finalizeRunSessionFailure(session, { orchestrator, errorLike }) {
  const failedRun = (orchestrator && orchestrator.lastRun) || extractRunFromThrownValue(errorLike) || null;
  const finishedAt = failedRun && failedRun.finishedAt ? failedRun.finishedAt : new Date().toISOString();
  session.status = failedRun && failedRun.status ? failedRun.status : 'failed';
  session.finishedAt = finishedAt;
  session.durationMs = failedRun && failedRun.durationMs != null
    ? failedRun.durationMs
    : Date.parse(finishedAt) - Date.parse(session.startedAt);
  session.error = failedRun && failedRun.error
    ? failedRun.error
    : errorPayloadFromThrownValue(errorLike);
}

function createRunIdentity() {
  const startedAt = new Date().toISOString();
  return {
    runId: `run-${startedAt.replace(/[:.]/g, '-')}`,
    startedAt
  };
}

function buildRunSessionSummary(session) {
  if (!session) {
    return null;
  }

  return {
    runId: session.runId,
    status: session.status,
    mode: session.mode || null,
    prompt: session.prompt || '',
    startedAt: session.startedAt || null,
    finishedAt: session.finishedAt || null,
    durationMs: session.durationMs || null,
    taskFile: session.taskFile || null,
    error: session.error || null,
    active: Boolean(session.active),
    launchedAt: session.launchedAt || session.startedAt || null,
    updatedAt: session.updatedAt || session.startedAt || null
  };
}

class ControlPlaneService {
  constructor({ projectRoot } = {}) {
    this.projectRoot = taskPaths.getProjectRoot(projectRoot);
    this.store = new CollaborationStore({ projectRoot: this.projectRoot });
    this.runSessions = new Map();
  }

  async getSetupStatus() {
    const adapterStatuses = await setupService.getAllAdapterDisplayStatus({
      cwd: this.projectRoot
    });

    return {
      projectRoot: this.projectRoot,
      adapters: adapterStatuses,
      summary: {
        total: adapterStatuses.length,
        ready: adapterStatuses.filter((status) => status.ready).length,
        needsLogin: adapterStatuses.filter((status) => status.status === setupService.STATUS.INSTALLED_BUT_NEEDS_LOGIN).length,
        missing: adapterStatuses.filter((status) => status.status === setupService.STATUS.MISSING).length
      }
    };
  }

  async getReadyAdapters() {
    return setupService.getReadyAdapters({
      cwd: this.projectRoot
    });
  }

  getAllAdapterMetadata() {
    return setupService.getAllAdapterMetadata();
  }

  async runAdapterInstall(agentId, { approved = false } = {}) {
    return setupService.runAdapterInstall(agentId, {
      approved,
      cwd: this.projectRoot
    });
  }

  async runAdapterLogin(agentId, { approved = false } = {}) {
    return setupService.runAdapterLogin(agentId, {
      approved,
      cwd: this.projectRoot
    });
  }

  listUseCases() {
    return listAvailableUseCases(this.projectRoot);
  }

  async testProvider(providerId, providerConfig) {
    return providerService.getProviderDisplayStatus(providerId, providerConfig);
  }

  async testCurrentProviders() {
    const taskConfig = await this.loadConfig();
    if (!taskConfig.exists || !taskConfig.valid) {
      return {
        success: false,
        providers: {},
        normalized: null,
        error: taskConfig.error
      };
    }

    return {
      success: true,
      providers: await providerService.getAllProviderDisplayStatus(taskConfig.normalized.providers || {}),
      normalized: taskConfig.normalized,
      error: null
    };
  }

  async testProvidersFromTask(rawTask) {
    try {
      const normalized = normalizeTaskConfig(rawTask, { projectRoot: this.projectRoot });
      return {
        success: true,
        providers: await providerService.getAllProviderDisplayStatus(normalized.providers || {}),
        normalized,
        error: null
      };
    } catch (error) {
      return {
        success: false,
        providers: {},
        normalized: null,
        error: error.message
      };
    }
  }

  async loadConfig() {
    const taskFile = taskPaths.legacyTaskFile(this.projectRoot);

    try {
      const content = await fs.readFile(taskFile, 'utf8');
      let rawConfig = null;
      try {
        rawConfig = JSON.parse(content);
      } catch (error) {
        return {
          exists: true,
          filePath: taskFile,
          raw: null,
          rawText: content,
          normalized: null,
          valid: false,
          error: `Invalid JSON in task file: ${error.message}`
        };
      }

      try {
        const normalized = normalizeTaskConfig(rawConfig, { projectRoot: this.projectRoot });

        return {
          exists: true,
          filePath: taskFile,
          raw: rawConfig,
          rawText: content,
          normalized,
          valid: true,
          error: null,
          errorCode: null,
          errorDetails: null
        };
      } catch (error) {
        return {
          exists: true,
          filePath: taskFile,
          raw: rawConfig,
          rawText: content,
          normalized: null,
          valid: false,
          error: error.message,
          errorCode: error && typeof error.code === 'string' ? error.code : null,
          errorDetails: error && typeof error.contextDir === 'string'
            ? { contextDir: error.contextDir }
            : null
        };
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {
          exists: false,
          filePath: taskFile,
          raw: null,
          rawText: '',
          normalized: null,
          valid: false,
          error: 'Task file not found'
        };
      }

      return {
        exists: true,
        filePath: taskFile,
        raw: null,
        rawText: '',
        normalized: null,
        valid: false,
        error: error.message
      };
    }
  }

  async validateConfig(rawTask) {
    try {
      const normalized = normalizeTaskConfig(rawTask, { projectRoot: this.projectRoot });
      return {
        valid: true,
        normalized,
        error: null,
        errorCode: null,
        errorDetails: null
      };
    } catch (error) {
      return {
        valid: false,
        normalized: null,
        error: error.message,
        // Preserve structured error metadata so callers can match on stable
        // codes (CONTEXT_DIR_MISSING, CONTEXT_DIR_NOT_DIRECTORY) rather than
        // on English error-message prefixes.
        errorCode: error && typeof error.code === 'string' ? error.code : null,
        errorDetails: error && typeof error.contextDir === 'string'
          ? { contextDir: error.contextDir }
          : null
      };
    }
  }

  async resolveConfigInput({ rawConfig = null } = {}) {
    const taskFile = taskPaths.legacyTaskFile(this.projectRoot);

    if (rawConfig) {
      const validation = await this.validateConfig(rawConfig);
      if (!validation.valid) {
        return {
          success: false,
          fromDraft: true,
          taskFile,
          raw: rawConfig,
          normalized: null,
          error: validation.error,
          errorCode: validation.errorCode,
          errorDetails: validation.errorDetails
        };
      }
      return {
        success: true,
        fromDraft: true,
        taskFile,
        raw: rawConfig,
        normalized: validation.normalized,
        error: null,
        errorCode: null,
        errorDetails: null
      };
    }

    const configResult = await this.loadConfig();
    if (!configResult.exists || !configResult.valid) {
      return {
        success: false,
        fromDraft: false,
        taskFile,
        raw: configResult.raw,
        normalized: null,
        error: configResult.error,
        errorCode: configResult.errorCode || null,
        errorDetails: configResult.errorDetails || null
      };
    }

    return {
      success: true,
      fromDraft: false,
      taskFile,
      raw: configResult.raw,
      normalized: configResult.normalized,
      error: null
    };
  }

  async saveConfig(rawConfig) {
    const validation = await this.validateConfig(rawConfig);
    if (!validation.valid) {
      return {
        success: false,
        filePath: null,
        error: validation.error
      };
    }

    const taskFile = taskPaths.legacyTaskFile(this.projectRoot);
    const sharedDir = taskPaths.sharedDir(this.projectRoot);

    try {
      await fs.mkdir(sharedDir, { recursive: true });
      await atomicWriteText(taskFile, JSON.stringify(rawConfig, null, 2) + '\n', {
        writeFile: fs.writeFile,
        rename: fs.rename,
        unlink: fs.unlink
      });

      return {
        success: true,
        filePath: taskFile,
        normalized: validation.normalized,
        error: null
      };
    } catch (error) {
      return {
        success: false,
        filePath: taskFile,
        error: error.message
      };
    }
  }

  async listPresets() {
    return listPresets({ projectRoot: this.projectRoot });
  }

  async savePreset(presetName) {
    try {
      const result = await savePreset(presetName, { projectRoot: this.projectRoot });
      return {
        success: true,
        presetName: result.presetName,
        presetFile: result.presetFile,
        error: null
      };
    } catch (error) {
      return {
        success: false,
        presetName,
        presetFile: null,
        error: error.message
      };
    }
  }

  async usePreset(presetName) {
    try {
      const result = await usePreset(presetName, { projectRoot: this.projectRoot });
      const configResult = await this.loadConfig();
      return {
        success: true,
        presetName: result.presetName,
        presetFile: result.presetFile,
        taskFile: result.taskFile,
        normalized: configResult.normalized,
        error: null
      };
    } catch (error) {
      return {
        success: false,
        presetName,
        presetFile: null,
        taskFile: null,
        normalized: null,
        error: error.message
      };
    }
  }

  async listRuns() {
    const taskIds = await this.store.listTaskIds();
    const runs = [];

    for (const taskId of taskIds) {
      try {
        const [taskRecord, steps, snapshots] = await Promise.all([
          this.store.readTask(taskId),
          this.store.readSteps(taskId),
          this.store.listArtifacts(taskId, { type: 'worktree-snapshot' })
        ]);

        runs.push(buildRunSummary(taskRecord, {
          snapshotCount: snapshots.length,
          stepCount: steps.length,
          isDamaged: false,
          readError: null
        }));
      } catch (error) {
        runs.push(buildRunSummary(null, {
          runId: taskId,
          snapshotCount: 0,
          stepCount: 0,
          isDamaged: true,
          readError: error.message
        }));
      }
    }

    return runs.sort((a, b) => {
      const left = b.updatedAt || b.createdAt || b.runId || '';
      const right = a.updatedAt || a.createdAt || a.runId || '';
      return left.localeCompare(right);
    });
  }

  async getRunDetails(runId) {
    try {
      const [taskRecord, steps, allArtifacts] = await Promise.all([
        this.store.readTask(runId),
        this.store.readSteps(runId),
        this.store.listArtifacts(runId)
      ]);

      const artifacts = allArtifacts.filter((artifact) => artifact.type !== 'task');
      const snapshotCount = artifacts.filter((artifact) => artifact.type === 'worktree-snapshot').length;
      const summary = buildRunSummary(taskRecord, {
        snapshotCount,
        stepCount: steps.length,
        isDamaged: false,
        readError: null
      });

      return {
        runId,
        exists: true,
        isDamaged: false,
        error: null,
        task: taskRecord.data,
        steps,
        artifacts,
        summary
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {
          runId,
          exists: false,
          isDamaged: false,
          error: null,
          task: null,
          steps: [],
          artifacts: [],
          summary: null
        };
      }

      const summary = buildRunSummary(null, {
        runId,
        snapshotCount: 0,
        stepCount: 0,
        isDamaged: true,
        readError: error.message
      });
      return {
        runId,
        exists: true,
        isDamaged: true,
        error: error.message,
        task: null,
        steps: [],
        artifacts: [],
        summary
      };
    }
  }

  async listArtifacts(runId, { type } = {}) {
    return this.store.listArtifacts(runId, { type });
  }

  async getArtifact(runId, artifactId) {
    try {
      return {
        exists: true,
        artifact: await this.store.readArtifact(runId, artifactId),
        error: null
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {
          exists: false,
          artifact: null,
          error: null
        };
      }

      return {
        exists: true,
        artifact: null,
        error: error.message
      };
    }
  }

  async listTaskDirs() {
    return this.store.listTaskIds();
  }

  async getRunSummaries() {
    return this.listRuns();
  }

  // Internal helper: computes prepared-context status from an already-
  // normalized config, skipping the resolve/validate step. Used on launch
  // paths that already have a normalized draft so we don't re-run
  // normalizeTaskConfig twice per launch.
  async _contextStatusForNormalized(normalizedConfig) {
    const contextConfig = normalizedConfig && normalizedConfig.context ? normalizedConfig.context : null;
    const status = await getPreparedContextStatus(contextConfig, this.projectRoot);
    return {
      ok: true,
      ...status
    };
  }

  async getContextStatus({ rawConfig = null } = {}) {
    const configResult = await this.resolveConfigInput({ rawConfig });
    if (!configResult.success) {
      const invalidContextStatus = buildInvalidContextStatusFromConfigError({
        errorMessage: configResult.error,
        errorCode: configResult.errorCode,
        errorDetails: configResult.errorDetails,
        rawConfig: configResult.raw,
        projectRoot: this.projectRoot
      });
      if (invalidContextStatus) {
        return {
          ok: true,
          ...invalidContextStatus
        };
      }
      if (!configResult.fromDraft && configResult.error === 'Task file not found') {
        return {
          ok: true,
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
      return {
        ok: false,
        status: 'invalid-config',
        state: 'invalid-config',
        contextDir: null,
        cacheDir: null,
        builtAt: null,
        mismatches: [],
        driftedSources: [],
        skippedSources: [],
        manifest: null,
        instructions: null,
        error: configResult.error
      };
    }

    const contextConfig = configResult.normalized.context || null;
    const status = await getPreparedContextStatus(contextConfig, this.projectRoot);
    return {
      ok: true,
      ...status
    };
  }

  async prepareContext({ rawConfig = null } = {}) {
    const configResult = await this.resolveConfigInput({ rawConfig });
    if (!configResult.success) {
      const invalidContextStatus = buildInvalidContextStatusFromConfigError({
        errorMessage: configResult.error,
        errorCode: configResult.errorCode,
        errorDetails: configResult.errorDetails,
        rawConfig: configResult.raw,
        projectRoot: this.projectRoot
      });
      if (invalidContextStatus) {
        return {
          ok: false,
          code: 'CONTEXT_MISSING_DIR',
          contextDir: invalidContextStatus.contextDir,
          cacheDir: invalidContextStatus.cacheDir,
          instructions: invalidContextStatus.instructions,
          statusInfo: invalidContextStatus,
          error: invalidContextStatus.instructions
        };
      }
      return {
        ok: false,
        error: (!configResult.fromDraft && configResult.error === 'Task file not found')
          ? 'No valid task configuration found. Save a valid config with a context folder first.'
          : configResult.error
      };
    }

    const contextConfig = configResult.normalized.context || null;
    if (!contextConfig || !contextConfig.dir) {
      return {
        ok: false,
        error: 'Current task configuration has no context folder configured.'
      };
    }

    try {
      const result = await prepareContextIndex(contextConfig, this.projectRoot);
      const allSources = result.manifest.sources || [];
      const indexedSources = allSources.filter((s) => !s.skipped);
      const skippedSources = allSources
        .filter((s) => s.skipped)
        .map((s) => ({
          sourceRelativePath: s.sourceRelativePath,
          skipReason: s.skipReason || 'Skipped during cache build'
        }));

      return {
        ok: true,
        contextDir: result.rootDir,
        cacheDir: result.cacheDir,
        builtAt: result.builtAt,
        sourceCount: allSources.length,
        indexedCount: indexedSources.length,
        skippedCount: skippedSources.length,
        skippedSources,
        stats: result.manifest.stats,
        error: null
      };
    } catch (error) {
      const result = {
        ok: false,
        error: error.message
      };
      if (error.code) result.code = error.code;
      if (error.contextDir) result.contextDir = error.contextDir;
      if (error.cacheDir) result.cacheDir = error.cacheDir;
      if (error.instructions) result.instructions = error.instructions;
      if (Array.isArray(error.mismatches) && error.mismatches.length > 0) {
        result.mismatches = error.mismatches;
      }
      if (error.statusInfo) result.statusInfo = error.statusInfo;
      return result;
    }
  }

  listRunSessions() {
    return Array.from(this.runSessions.values())
      .map((session) => buildRunSessionSummary(session))
      .sort((a, b) => {
        const left = b.updatedAt || b.startedAt || b.runId || '';
        const right = a.updatedAt || a.startedAt || a.runId || '';
        return left.localeCompare(right);
      });
  }

  getRunSession(runId) {
    const session = this.runSessions.get(runId);
    if (!session) {
      return {
        exists: false,
        session: null
      };
    }

    return {
      exists: true,
      session: buildRunSessionSummary(session)
    };
  }

  // Launch a background run session. Draft validation and persistence are
  // intentionally split so that blocked launches (invalid config, missing
  // context, drifted cache) never overwrite the saved task file. Only after
  // all preflight checks pass does the draft get persisted to disk.
  async launchRunSession({ rawConfig = null, orchestratorOptions = {} } = {}) {
    // Phase 1: validate/normalize draft without persisting
    const resolved = await this.resolveConfigInput({ rawConfig });
    const taskFile = resolved.taskFile;
    let normalized = resolved.normalized;

    if (!resolved.success) {
      const invalidContextStatus = buildInvalidContextStatusFromConfigError({
        errorMessage: resolved.error,
        errorCode: resolved.errorCode,
        errorDetails: resolved.errorDetails,
        rawConfig: resolved.raw,
        projectRoot: this.projectRoot
      });
      if (invalidContextStatus) {
        const contextBlock = buildBlockingContextLaunchError(invalidContextStatus);
        return {
          success: false,
          launched: false,
          runId: null,
          status: null,
          taskFile,
          normalized: null,
          session: null,
          error: contextBlock,
          contextStatus: invalidContextStatus
        };
      }
      return {
        success: false,
        launched: false,
        runId: null,
        status: null,
        taskFile,
        normalized: null,
        session: null,
        error: resolved.error
      };
    }

    // Phase 2: context preflight (before any persistence). Use the already-
    // normalized draft directly so we don't pay a second normalizeTaskConfig
    // pass on every launch. getContextStatus (the public API) still re-
    // resolves from rawConfig for external callers.
    const contextStatus = await this._contextStatusForNormalized(normalized);
    if (!contextStatus.ok) {
      return {
        success: false,
        launched: false,
        runId: null,
        status: null,
        taskFile,
        normalized,
        session: null,
        error: contextStatus.error
      };
    }

    const contextBlock = buildBlockingContextLaunchError(contextStatus);
    if (contextBlock) {
      return {
        success: false,
        launched: false,
        runId: null,
        status: null,
        taskFile,
        normalized,
        session: null,
        error: contextBlock,
        contextStatus
      };
    }

    // Phase 3: persist draft only after preflight is fully green
    if (rawConfig) {
      const saveResult = await this.saveConfig(rawConfig);
      if (!saveResult.success) {
        return {
          success: false,
          launched: false,
          runId: null,
          status: null,
          taskFile,
          normalized,
          session: null,
          error: saveResult.error
        };
      }
    }

    const identity = createRunIdentity();
    const session = {
      runId: identity.runId,
      status: 'starting',
      mode: normalized ? normalized.mode : null,
      prompt: normalized ? normalized.prompt : '',
      startedAt: identity.startedAt,
      finishedAt: null,
      durationMs: null,
      taskFile,
      error: null,
      active: true,
      launchedAt: identity.startedAt,
      updatedAt: identity.startedAt
    };

    let orchestrator = null;
    try {
      orchestrator = this.createOrchestrator({
        ...orchestratorOptions,
        preassignedRunId: identity.runId,
        preassignedStartedAt: identity.startedAt
      });
      await orchestrator.init();
    } catch (error) {
      const initErrorMessage = describeThrownValue(error);
      return {
        success: false,
        launched: false,
        runId: identity.runId,
        status: 'failed',
        taskFile,
        normalized,
        session: {
          ...buildRunSessionSummary({
            ...session,
            status: 'failed',
            error: initErrorMessage,
            active: false,
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          })
        },
        error: initErrorMessage
      };
    }

    this.runSessions.set(identity.runId, session);

    const backgroundRun = Promise.resolve().then(async () => {
      try {
        session.status = 'running';
        session.updatedAt = new Date().toISOString();
        const run = await orchestrator.runTask();
        session.status = run && run.status ? run.status : 'completed';
        session.finishedAt = run && run.finishedAt ? run.finishedAt : new Date().toISOString();
        session.durationMs = run && run.durationMs != null
          ? run.durationMs
          : Date.parse(session.finishedAt) - Date.parse(session.startedAt);
        session.error = run && run.error ? run.error : null;
      } catch (error) {
        finalizeRunSessionFailure(session, { orchestrator, errorLike: error });
      } finally {
        session.active = false;
        session.updatedAt = new Date().toISOString();
      }
    });
    backgroundRun.catch((unexpectedError) => {
      finalizeRunSessionFailure(session, { orchestrator, errorLike: unexpectedError });
      session.active = false;
      session.updatedAt = new Date().toISOString();
      console.error(`Warning: background run session wrapper failed: ${describeThrownValue(unexpectedError)}`);
    });

    return {
      success: true,
      launched: true,
      runId: identity.runId,
      status: session.status,
      taskFile,
      normalized,
      session: buildRunSessionSummary(session),
      error: null
    };
  }

  async launchRun({ rawConfig = null, orchestratorOptions = {} } = {}) {
    // Phase 1: validate/normalize draft without persisting
    const resolved = await this.resolveConfigInput({ rawConfig });
    const taskFile = resolved.taskFile;
    let normalized = resolved.normalized;
    let orchestrator = null;

    if (!resolved.success) {
      const invalidContextStatus = buildInvalidContextStatusFromConfigError({
        errorMessage: resolved.error,
        errorCode: resolved.errorCode,
        errorDetails: resolved.errorDetails,
        rawConfig: resolved.raw,
        projectRoot: this.projectRoot
      });
      if (invalidContextStatus) {
        return buildLaunchRunResult({
          success: false,
          launched: false,
          run: null,
          normalized: null,
          taskFile,
          error: buildBlockingContextLaunchError(invalidContextStatus)
        });
      }
      return buildLaunchRunResult({
        success: false,
        launched: false,
        run: null,
        normalized: null,
        taskFile,
        error: resolved.error
      });
    }

    // Phase 2: context preflight (before any persistence). Reuses the
    // already-normalized draft to avoid a redundant normalizeTaskConfig pass.
    const contextStatus = await this._contextStatusForNormalized(normalized);
    if (!contextStatus.ok) {
      return buildLaunchRunResult({
        success: false,
        launched: false,
        run: null,
        normalized,
        taskFile,
        error: contextStatus.error
      });
    }

    const contextBlock = buildBlockingContextLaunchError(contextStatus);
    if (contextBlock) {
      return buildLaunchRunResult({
        success: false,
        launched: false,
        run: null,
        normalized,
        taskFile,
        error: contextBlock
      });
    }

    // Phase 3: persist draft only after preflight is fully green
    if (rawConfig) {
      const saveResult = await this.saveConfig(rawConfig);
      if (!saveResult.success) {
        return buildLaunchRunResult({
          success: false,
          launched: false,
          run: null,
          normalized,
          taskFile,
          error: saveResult.error
        });
      }
    }

    try {
      orchestrator = this.createOrchestrator(orchestratorOptions);
      await orchestrator.init();
      const run = await orchestrator.runTask();
      return buildLaunchRunResult({
        success: true,
        launched: true,
        run,
        normalized,
        taskFile,
        error: null
      });
    } catch (error) {
      const failedRun = (orchestrator && orchestrator.lastRun) || extractRunFromThrownValue(error) || null;
      const launchErrorMessage = describeThrownValue(error);
      return buildLaunchRunResult({
        success: false,
        launched: Boolean(failedRun),
        run: failedRun,
        normalized,
        taskFile,
        error: launchErrorMessage
      });
    }
  }

  createOrchestrator(options = {}) {
    const { LoopiOrchestrator } = require('../orchestrator');
    return new LoopiOrchestrator({
      projectRoot: this.projectRoot,
      ...options
    });
  }
}

function createControlPlaneService(options = {}) {
  return new ControlPlaneService(options);
}

module.exports = {
  ControlPlaneService,
  createControlPlaneService
};
