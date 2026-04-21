const fs = require('fs').promises;
const path = require('path');
const { spawnSync } = require('child_process');

const taskPaths = require('./task-paths');

function getLocksDir(projectRoot) {
  return path.join(taskPaths.sharedDir(projectRoot), '.locks');
}

function getLockFilePath(lockKey, projectRoot) {
  const safeLockKey = taskPaths.assertSafePathSegment(lockKey, 'lockKey');
  return path.join(getLocksDir(projectRoot), `${safeLockKey}.lock.json`);
}

function defaultProcessExists(pid, spawnSyncImpl = spawnSync) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (process.platform === 'win32') {
    const result = spawnSyncImpl('tasklist', ['/FI', `PID eq ${pid}`], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (result.error) {
      return true;
    }
    return String(result.stdout || '').includes(String(pid));
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isLockStale(lockFile, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(lockFile, 'utf8'));
  } catch {
    return true;
  }

  const processExists = options.processExists || defaultProcessExists;
  return !processExists(parsed.pid);
}

async function acquireLock(lockKey, runMetadata, options = {}) {
  const projectRoot = taskPaths.getProjectRoot(options.projectRoot);
  const lockFile = getLockFilePath(lockKey, projectRoot);
  const maxStaleRecoveryAttempts = Number.isInteger(options.maxStaleRecoveryAttempts)
    ? options.maxStaleRecoveryAttempts
    : 3;
  await fs.mkdir(path.dirname(lockFile), { recursive: true });

  const payload = {
    lockKey,
    runId: runMetadata.runId,
    pid: Number.isInteger(runMetadata.pid) ? runMetadata.pid : process.pid,
    startedAt: Number.isFinite(runMetadata.startedAt) ? runMetadata.startedAt : Date.now()
  };

  for (let attempt = 0; attempt <= maxStaleRecoveryAttempts; attempt += 1) {
    try {
      await fs.writeFile(lockFile, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      return { acquired: true, lockFile };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }

    const stale = await isLockStale(lockFile, options);
    if (stale) {
      if (attempt >= maxStaleRecoveryAttempts) {
        throw new Error(`Failed to acquire lock "${lockKey}" after ${maxStaleRecoveryAttempts} stale-lock recovery attempts.`);
      }
      await fs.rm(lockFile, { force: true });
      continue;
    }

    const conflictingRun = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    return { acquired: false, conflictingRun, lockFile };
  }

  throw new Error(`Failed to acquire lock "${lockKey}".`);
}

async function releaseLock(lockKey, options = {}) {
  const projectRoot = taskPaths.getProjectRoot(options.projectRoot);
  const lockFile = getLockFilePath(lockKey, projectRoot);
  await fs.rm(lockFile, { force: true });
}

module.exports = {
  acquireLock,
  releaseLock,
  isLockStale,
  __test: {
    getLockFilePath,
    defaultProcessExists
  }
};
