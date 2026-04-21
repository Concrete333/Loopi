const fs = require('fs').promises;
const path = require('path');

const taskPaths = require('./task-paths');
const { validateArtifact } = require('./artifact-schemas');

function nowIso() {
  return new Date().toISOString();
}

class CollaborationStore {
  constructor({ projectRoot } = {}) {
    this.projectRoot = taskPaths.getProjectRoot(projectRoot);
  }

  async ensureTaskDirs(taskId) {
    // artifactsDir is a subdirectory of taskDir, so this single mkdir creates both.
    await fs.mkdir(taskPaths.artifactsDir(this.projectRoot, taskId), { recursive: true });
  }

  async writeTask(taskId, taskObject) {
    await this.ensureTaskDirs(taskId);
    const taskFile = taskPaths.taskJsonPath(this.projectRoot, taskId);

    let existingTask = null;
    try {
      const content = await fs.readFile(taskFile, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed.createdAt) {
        existingTask = parsed;
      }
    } catch (error) {
      // Only swallow ENOENT (file doesn't exist yet) and SyntaxError (invalid JSON).
      // Re-throw all other errors (e.g., permission errors, EACCES, etc.).
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }

    const artifact = {
      type: 'task',
      id: `task-${taskId}`,
      taskId,
      createdAt: existingTask ? existingTask.createdAt : nowIso(),
      data: taskObject
    };

    if (existingTask) {
      artifact.updatedAt = nowIso();
    }

    validateArtifact(artifact);
    await fs.writeFile(taskFile, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  }

  async readTask(taskId) {
    const taskFile = taskPaths.taskJsonPath(this.projectRoot, taskId);
    const content = await fs.readFile(taskFile, 'utf8');
    const parsed = JSON.parse(content);
    try {
      validateArtifact(parsed);
    } catch (error) {
      const relative = path.relative(this.projectRoot, taskFile);
      error.message = `Invalid artifact in ${relative}: ${error.message}`;
      throw error;
    }
    return parsed;
  }

  async appendStep(taskId, stepRecord) {
    await this.ensureTaskDirs(taskId);
    const stepsFile = taskPaths.stepsNdjsonPath(this.projectRoot, taskId);
    const line = JSON.stringify({
      recordedAt: nowIso(),
      ...stepRecord
    }) + '\n';
    await fs.appendFile(stepsFile, line, 'utf8');
  }

  async writeArtifact(taskId, artifact) {
    validateArtifact(artifact);
    if (artifact.taskId !== taskId) {
      throw new Error(`Artifact taskId mismatch: expected "${taskId}", got "${artifact.taskId}".`);
    }

    await this.ensureTaskDirs(taskId);
    const filePath = taskPaths.artifactPath(this.projectRoot, taskId, artifact.id);
    await fs.writeFile(filePath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
    return filePath;
  }

  async readArtifact(taskId, artifactId) {
    const filePath = taskPaths.artifactPath(this.projectRoot, taskId, artifactId);
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    try {
      validateArtifact(parsed);
    } catch (error) {
      const relative = path.relative(this.projectRoot, filePath);
      error.message = `Invalid artifact in ${relative}: ${error.message}`;
      throw error;
    }
    return parsed;
  }

  async listArtifacts(taskId, { type } = {}) {
    const dir = taskPaths.artifactsDir(this.projectRoot, taskId);
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw error;
      }
    }

    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(dir, entry.name));

    const artifacts = [];

    if (!type || type === 'task') {
      try {
        const taskArtifact = await this.readTask(taskId);
        artifacts.push(taskArtifact);
      } catch (error) {
        if (error && error.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    for (const file of files) {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      try {
        validateArtifact(parsed);
      } catch (error) {
        const relative = path.relative(this.projectRoot, file);
        error.message = `Invalid artifact in ${relative}: ${error.message}`;
        throw error;
      }
      if (!type || parsed.type === type) {
        artifacts.push(parsed);
      }
    }

    artifacts.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return artifacts;
  }
}

module.exports = {
  CollaborationStore
};

