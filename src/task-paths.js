const path = require('path');

function getProjectRoot(explicitProjectRoot) {
  if (explicitProjectRoot) {
    return explicitProjectRoot;
  }
  return path.join(__dirname, '..');
}

function assertSafePathSegment(value, label) {
  const segment = String(value || '');
  if (!segment || segment.trim() === '') {
    throw new Error(`${label} is required to build task paths.`);
  }

  // Disallow path separators and traversal. This module returns paths that are
  // assumed safe to use for mkdir/read/write.
  if (segment.includes('/') || segment.includes('\\')) {
    throw new Error(`${label} must not contain path separators.`);
  }
  if (segment === '.' || segment === '..' || segment.includes('..')) {
    throw new Error(`${label} must not contain path traversal ("..").`);
  }

  // Keep IDs reasonably portable across OS/filesystems.
  if (!/^[a-zA-Z0-9._-]+$/.test(segment)) {
    throw new Error(`${label} contains unsupported characters. Allowed: letters, numbers, ".", "_", "-".`);
  }

  return segment;
}

function sharedDir(projectRoot) {
  return path.join(getProjectRoot(projectRoot), 'shared');
}

function legacyTaskFile(projectRoot) {
  return path.join(sharedDir(projectRoot), 'task.json');
}

function legacyLogFile(projectRoot) {
  return path.join(sharedDir(projectRoot), 'log.json');
}

function legacyScratchpadFile(projectRoot) {
  return path.join(sharedDir(projectRoot), 'scratchpad.txt');
}

function runsNdjsonFile(projectRoot) {
  return path.join(sharedDir(projectRoot), 'runs.ndjson');
}

function presetsDir(projectRoot) {
  return path.join(sharedDir(projectRoot), 'presets');
}

function presetPath(projectRoot, presetName) {
  const safePresetName = assertSafePathSegment(presetName, 'presetName');
  return path.join(presetsDir(projectRoot), `${safePresetName}.json`);
}

function tasksRootDir(projectRoot) {
  return path.join(sharedDir(projectRoot), 'tasks');
}

function taskDir(projectRoot, taskId) {
  const safeTaskId = assertSafePathSegment(taskId, 'taskId');
  return path.join(tasksRootDir(projectRoot), safeTaskId);
}

function taskJsonPath(projectRoot, taskId) {
  return path.join(taskDir(projectRoot, taskId), 'task.json');
}

function stepsNdjsonPath(projectRoot, taskId) {
  return path.join(taskDir(projectRoot, taskId), 'steps.ndjson');
}

function artifactsDir(projectRoot, taskId) {
  return path.join(taskDir(projectRoot, taskId), 'artifacts');
}

function artifactPath(projectRoot, taskId, artifactId) {
  const safeArtifactId = assertSafePathSegment(artifactId, 'artifactId');
  return path.join(artifactsDir(projectRoot, taskId), `${safeArtifactId}.json`);
}

module.exports = {
  getProjectRoot,
  assertSafePathSegment,
  sharedDir,
  legacyTaskFile,
  legacyLogFile,
  legacyScratchpadFile,
  runsNdjsonFile,
  presetsDir,
  presetPath,
  tasksRootDir,
  taskDir,
  taskJsonPath,
  stepsNdjsonPath,
  artifactsDir,
  artifactPath
};
