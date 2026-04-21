const fs = require('fs').promises;
const taskPaths = require('./task-paths');
const { normalizeTaskConfig } = require('./task-config');
const { resolveAgents } = require('./adapters');

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

async function runDoctorCheck({
  projectRoot = taskPaths.getProjectRoot(),
  readFile = fs.readFile,
  normalizeConfig = normalizeTaskConfig,
  resolveCliAgents = resolveAgents
} = {}) {
  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  const lines = [];

  let rawConfig;
  try {
    rawConfig = await readJsonFile(taskFile, readFile);
  } catch (error) {
    lines.push(`[info] Task file path: ${taskFile}`);
    if (error && error.code === 'ENOENT') {
      lines.push(`[fail] Task file is missing: ${taskFile}`);
      lines.push('[hint] Create one with `npm run cli -- plan` or write shared/task.json manually.');
      return { ok: false, lines };
    }

    lines.push(`[fail] ${error.message}`);
    return { ok: false, lines };
  }

  lines.push(`[ok] Task file found: ${taskFile}`);

  let config;
  try {
    config = normalizeConfig(rawConfig, { projectRoot });
  } catch (error) {
    lines.push(`[fail] Task config is invalid: ${error.message}`);
    return { ok: false, lines };
  }

  lines.push(`[ok] Task config loaded: mode=${config.mode}, agents=${config.agents.join(', ')}`);

  if (config.context) {
    lines.push(`[ok] Context folder configured: ${config.context.dir}`);
  } else {
    lines.push('[ok] No context folder configured.');
  }

  const cliTargets = getCliTargets(config);
  if (cliTargets.length === 0) {
    if (config.executionTargets.length > 0) {
      lines.push('[ok] No CLI agents need checking; this task currently uses only configured HTTP providers.');
    } else {
      lines.push('[ok] No CLI agents selected for this task.');
    }
    return { ok: true, lines };
  }

  try {
    await resolveCliAgents(cliTargets, {
      cwd: config.settings.cwd,
      timeoutMs: Math.min(config.settings.timeoutMs, DOCTOR_PREFLIGHT_TIMEOUT_MS)
    });
    lines.push(`[ok] CLI agents available: ${cliTargets.join(', ')}`);
  } catch (error) {
    lines.push(`[fail] CLI agent preflight failed: ${error.message}`);
    return { ok: false, lines };
  }

  return { ok: true, lines };
}

module.exports = {
  runDoctorCheck
};
