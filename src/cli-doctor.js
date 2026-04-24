const fs = require('fs').promises;
const taskPaths = require('./task-paths');
const { normalizeTaskConfig } = require('./task-config');
const { resolveAgents } = require('./adapters');
const { checkAllAdapterStatus, STATUS } = require('./setup-service');
const { checkMultipleProviderStatus } = require('./provider-service');
const { getPreparedContextStatus } = require('./context-index');

const DOCTOR_PREFLIGHT_TIMEOUT_MS = 10000;

async function readJsonFile(filePath, readFile = fs.readFile) {
  const content = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(content);
  } catch (error) {
    error.code = 'INVALID_JSON';
    error.message = `Task file contains invalid JSON: ${error.message}`;
    throw error;
  }
}

function getCliTargets(config) {
  const providers = config.providers || {};
  return config.executionTargets.filter((target) => !providers[target]);
}

/**
 * Runs doctor in environment mode (task-independent).
 * Checks all supported CLI adapters without requiring a task file.
 *
 * @param {Object} options - Configuration options
 * @param {string} [options.projectRoot] - Project root directory
 * @param {number} [options.timeoutMs] - Timeout for preflight checks
 * @returns {Promise<Object>} Doctor result with lines and status
 */
async function runEnvironmentCheck({
  projectRoot = taskPaths.getProjectRoot(),
  timeoutMs = DOCTOR_PREFLIGHT_TIMEOUT_MS
} = {}) {
  const lines = [];

  lines.push('[info] Running environment diagnostics (no task file required)');
  lines.push('');

  // Check all CLI adapters
  const adapterStatuses = await checkAllAdapterStatus({ timeoutMs, cwd: projectRoot });

  const readyAdapters = adapterStatuses.filter(s => s.status === STATUS.READY);
  const needsLogin = adapterStatuses.filter(s => s.status === STATUS.INSTALLED_BUT_NEEDS_LOGIN);
  const missing = adapterStatuses.filter(s => s.status === STATUS.MISSING);
  const unusable = adapterStatuses.filter(s => s.status === STATUS.UNUSABLE);

  if (readyAdapters.length > 0) {
    lines.push('[ok] Ready adapters:');
    for (const adapter of readyAdapters) {
      lines.push(`      ${adapter.metadata.displayName} (${adapter.agentId})`);
      if (adapter.resolvedPath) {
        lines.push(`        → ${adapter.resolvedPath}`);
      }
    }
    lines.push('');
  }

  if (needsLogin.length > 0) {
    lines.push('[warn] Installed but need login:');
    for (const adapter of needsLogin) {
      lines.push(`      ${adapter.metadata.displayName} (${adapter.agentId})`);
      if (adapter.nextAction) {
        lines.push(`        → ${adapter.nextAction.message}: ${adapter.nextAction.command}`);
      }
    }
    lines.push('');
  }

  if (missing.length > 0) {
    lines.push('[info] Not installed:');
    for (const adapter of missing) {
      lines.push(`      ${adapter.metadata.displayName} (${adapter.agentId})`);
      if (adapter.nextAction) {
        lines.push(`        → ${adapter.nextAction.message}: ${adapter.nextAction.command}`);
      }
    }
    lines.push('');
  }

  if (unusable.length > 0) {
    lines.push('[warn] Found but unusable:');
    for (const adapter of unusable) {
      lines.push(`      ${adapter.metadata.displayName} (${adapter.agentId})`);
      if (adapter.error) {
        lines.push(`        → ${adapter.error}`);
      }
    }
    lines.push('');
  }

  // Check for environment overrides
  const overrides = {
    LOOPI_CLAUDE_PATH: 'Claude',
    LOOPI_CODEX_JS: 'Codex',
    LOOPI_GEMINI_JS: 'Gemini',
    LOOPI_KILO_PATH: 'Kilo',
    LOOPI_QWEN_JS: 'Qwen',
    LOOPI_OPENCODE_PATH: 'Opencode'
  };

  const activeOverrides = Object.entries(overrides).filter(([envVar]) => process.env[envVar]);
  if (activeOverrides.length > 0) {
    lines.push('[info] Environment overrides (active):');
    for (const [envVar] of activeOverrides) {
      lines.push(`      ${envVar} = ${process.env[envVar]}`);
    }
    lines.push('');
  }

  if (readyAdapters.length > 0) {
    lines.push(`[ok] ${readyAdapters.length} adapter(s) ready to use`);
    return { ok: true, lines, hasReadyAgents: true };
  }

  lines.push('');
  lines.push('[warn] No adapters are ready. Install and authenticate at least one adapter to begin.');
  return { ok: false, lines, hasReadyAgents: false };
}

/**
 * Runs doctor in task mode (validates an existing task file).
 *
 * @param {Object} options - Configuration options
 * @param {string} [options.projectRoot] - Project root directory
 * @param {Function} [options.readFile] - File read function
 * @param {Function} [options.normalizeConfig] - Config normalization function
 * @param {Function} [options.resolveCliAgents] - Agent resolution function
 * @returns {Promise<Object>} Doctor result with lines and status
 */
async function runTaskCheck({
  projectRoot = taskPaths.getProjectRoot(),
  readFile = fs.readFile,
  normalizeConfig = normalizeTaskConfig,
  resolveCliAgents = resolveAgents,
  checkProviders = checkMultipleProviderStatus,
  checkContextReadiness = getPreparedContextStatus
} = {}) {
  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  const lines = [];

  lines.push('[info] Running task diagnostics');
  lines.push(`[info] Task file path: ${taskFile}`);
  lines.push('');

  let rawConfig;
  try {
    rawConfig = await readJsonFile(taskFile, readFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      lines.push(`[fail] Task file is missing: ${taskFile}`);
      lines.push('[hint] Create one with `npm run cli -- plan` or write shared/task.json manually.');
      return { ok: false, lines, hasTaskFile: false };
    }

    lines.push(`[fail] ${error.message}`);
    return { ok: false, lines, hasTaskFile: true };
  }

  lines.push(`[ok] Task file found`);

  let config;
  try {
    config = normalizeConfig(rawConfig, { projectRoot });
  } catch (error) {
    lines.push(`[fail] Task config is invalid: ${error.message}`);
    return { ok: false, lines, hasTaskFile: true };
  }

  lines.push(`[ok] Task config loaded: mode=${config.mode}, agents=${config.agents.join(', ')}`);

  // Check prepared-context readiness using the same shared status helper the
  // orchestrator and control plane use. This catches drift/mismatch before
  // the user tries to run and gets blocked at launch time.
  let hasContextFailure = false;
  if (config.context) {
    lines.push(`[ok] Context folder configured: ${config.context.dir}`);
    let contextStatus;
    try {
      contextStatus = await checkContextReadiness(config.context, projectRoot);
    } catch (error) {
      hasContextFailure = true;
      lines.push(`[fail] Prepared context readiness check failed: ${error.message}`);
      contextStatus = null;
    }

    if (contextStatus) {
      if (contextStatus.status === 'ready') {
        lines.push('[ok] Prepared context cache is ready.');
      } else if (contextStatus.status === 'ready-with-warnings') {
        const skippedCount = Array.isArray(contextStatus.skippedSources) ? contextStatus.skippedSources.length : 0;
        lines.push(`[warn] Prepared context cache is ready with ${skippedCount} skipped source${skippedCount === 1 ? '' : 's'}.`);
      } else if (contextStatus.status === 'missing') {
        hasContextFailure = true;
        if (!contextStatus.cacheDir) {
          lines.push('[fail] Context folder is missing or invalid.');
        } else {
          lines.push('[fail] Prepared context cache is missing.');
        }
        if (contextStatus.instructions) {
          lines.push(`        → ${contextStatus.instructions}`);
        }
        if (!contextStatus.cacheDir) {
          lines.push('[hint] Fix `context.dir` in `shared/task.json`, then retry doctor.');
        } else {
          lines.push('[hint] Run `npm run cli -- context prepare` to build the cache, then retry doctor.');
        }
      } else if (contextStatus.status === 'config-mismatch') {
        hasContextFailure = true;
        lines.push('[fail] Prepared context cache no longer matches the current task config.');
        if (contextStatus.instructions) {
          lines.push(`        → ${contextStatus.instructions}`);
        }
        lines.push('[hint] Run `npm run cli -- context prepare` to rebuild the cache.');
      } else if (contextStatus.status === 'drifted') {
        hasContextFailure = true;
        const driftCount = Array.isArray(contextStatus.driftedSources) ? contextStatus.driftedSources.length : 0;
        lines.push(`[fail] Prepared context cache is out of date (${driftCount} drifted source${driftCount === 1 ? '' : 's'}).`);
        if (contextStatus.instructions) {
          lines.push(`        → ${contextStatus.instructions}`);
        }
        lines.push('[hint] Run `npm run cli -- context prepare` to rebuild the cache.');
      } else if (contextStatus.status === 'no-context') {
        // Context was configured but resolved to no-context (empty dir value, etc.)
        lines.push('[info] Context readiness returned no-context despite a configured dir; treating as no-op.');
      } else {
        lines.push(`[warn] Unexpected prepared-context status: ${contextStatus.status}`);
      }
    }
  } else {
    lines.push('[info] No context folder configured.');
  }

  lines.push('');

  // Check HTTP providers
  let hasProviderFailures = false;
  if (config.providers && Object.keys(config.providers).length > 0) {
    lines.push('[info] Checking HTTP providers...');
    const providerStatuses = await checkProviders(config.providers);

    for (const [providerId, status] of Object.entries(providerStatuses)) {
      if (status.ready) {
        lines.push(`[ok] Provider "${providerId}": ready (model: ${config.providers[providerId].model})`);
      } else {
        hasProviderFailures = true;
        const statusMsg = status.error || status.failureReason || 'unknown error';
        lines.push(`[fail] Provider "${providerId}": ${statusMsg}`);
      }
    }
    lines.push('');
  }

  // Check CLI agents
  const cliTargets = getCliTargets(config);
  if (cliTargets.length === 0) {
    if (config.executionTargets.length > 0) {
      if (hasProviderFailures) {
        lines.push('[fail] This task uses configured HTTP providers, and at least one provider is not ready.');
        return { ok: false, lines, hasTaskFile: true };
      }
      if (hasContextFailure) {
        lines.push('[fail] Prepared context is not ready; runs will be blocked until it is prepared.');
        return { ok: false, lines, hasTaskFile: true };
      }
      lines.push('[ok] No CLI agents need checking; this task currently uses only configured HTTP providers.');
    } else {
      lines.push('[info] No CLI agents selected for this task.');
    }
    return { ok: !hasContextFailure, lines, hasTaskFile: true };
  }

  lines.push('[info] Checking CLI agents...');
  try {
    await resolveCliAgents(cliTargets, {
      cwd: config.settings.cwd,
      timeoutMs: Math.min(config.settings.timeoutMs, DOCTOR_PREFLIGHT_TIMEOUT_MS)
    });
    lines.push(`[ok] CLI agents available: ${cliTargets.join(', ')}`);
  } catch (error) {
    lines.push(`[fail] CLI agent preflight failed: ${error.message}`);
    return { ok: false, lines, hasTaskFile: true };
  }

  if (hasProviderFailures) {
    lines.push('[fail] One or more configured HTTP providers are not ready.');
    return { ok: false, lines, hasTaskFile: true };
  }

  if (hasContextFailure) {
    lines.push('[fail] Prepared context is not ready; runs will be blocked until it is prepared.');
    return { ok: false, lines, hasTaskFile: true };
  }

  return { ok: true, lines, hasTaskFile: true };
}

/**
 * Main doctor entry point.
 * Automatically selects environment mode if no task file exists,
 * otherwise runs task mode.
 *
 * @param {Object} options - Configuration options
 * @param {string} [options.projectRoot] - Project root directory
 * @param {string} [options.mode] - Explicit mode: 'environment' or 'task'
 * @returns {Promise<Object>} Doctor result with lines and status
 */
async function runDoctorCheck(options = {}) {
  const {
    projectRoot = taskPaths.getProjectRoot(),
    mode = null,
    ...otherOptions
  } = options;

  const taskFile = taskPaths.legacyTaskFile(projectRoot);

  // Explicit mode selection
  if (mode === 'environment') {
    return runEnvironmentCheck({ projectRoot, ...otherOptions });
  }

  if (mode === 'task') {
    return runTaskCheck({ projectRoot, ...otherOptions });
  }

  // Auto-detect: probe the task file via stat, matching the pattern used in cli-commands.js
  // for the same "does the task file exist?" question. Accept an injected stat so tests and
  // sandboxed environments get consistent behavior without double-reading the file contents.
  const stat = otherOptions.stat || fs.stat;
  try {
    await stat(taskFile);
    return runTaskCheck({ projectRoot, ...otherOptions });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return runEnvironmentCheck({ projectRoot, ...otherOptions });
    }
    // Anything else (permission error, etc.) should be surfaced by runTaskCheck with its
    // richer diagnostics rather than falling through to environment mode.
    return runTaskCheck({ projectRoot, ...otherOptions });
  }
}

module.exports = {
  runDoctorCheck,
  runEnvironmentCheck,
  runTaskCheck
};
