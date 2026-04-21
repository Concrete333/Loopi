const fs = require('fs').promises;
const taskPaths = require('./task-paths');
const { normalizeTaskConfig } = require('./task-config');
const { atomicWriteText } = require('./atomic-write');

async function readJsonFile(filePath, readFile = fs.readFile) {
  const content = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(content);
  } catch (error) {
    error.message = `Invalid JSON in ${filePath}: ${error.message}`;
    throw error;
  }
}

async function listPresets({
  projectRoot = taskPaths.getProjectRoot(),
  readdir = fs.readdir
} = {}) {
  const directory = taskPaths.presetsDir(projectRoot);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function savePreset(presetName, {
  projectRoot = taskPaths.getProjectRoot(),
  readFile = fs.readFile,
  writeFile = fs.writeFile,
  rename = fs.rename,
  unlink = fs.unlink,
  mkdir = fs.mkdir,
  normalizeConfig = normalizeTaskConfig
} = {}) {
  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  const presetFile = taskPaths.presetPath(projectRoot, presetName);

  const rawConfig = await readJsonFile(taskFile, readFile);
  normalizeConfig(rawConfig, { projectRoot });

  await mkdir(taskPaths.presetsDir(projectRoot), { recursive: true });
  await atomicWriteText(presetFile, JSON.stringify(rawConfig, null, 2) + '\n', {
    writeFile,
    rename,
    unlink
  });

  return {
    presetName,
    presetFile,
    taskFile
  };
}

async function usePreset(presetName, {
  projectRoot = taskPaths.getProjectRoot(),
  readFile = fs.readFile,
  writeFile = fs.writeFile,
  rename = fs.rename,
  unlink = fs.unlink,
  mkdir = fs.mkdir,
  normalizeConfig = normalizeTaskConfig
} = {}) {
  const presetFile = taskPaths.presetPath(projectRoot, presetName);
  const taskFile = taskPaths.legacyTaskFile(projectRoot);

  const rawConfig = await readJsonFile(presetFile, readFile);
  normalizeConfig(rawConfig, { projectRoot });

  await mkdir(taskPaths.sharedDir(projectRoot), { recursive: true });
  await atomicWriteText(taskFile, JSON.stringify(rawConfig, null, 2) + '\n', {
    writeFile,
    rename,
    unlink
  });

  return {
    presetName,
    presetFile,
    taskFile
  };
}

module.exports = {
  listPresets,
  savePreset,
  usePreset
};
