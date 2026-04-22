const fs = require('fs').promises;
const path = require('path');
const taskPaths = require('./task-paths');
const { CollaborationStore } = require('./collaboration-store');

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toRelativeProjectPath(projectRoot, targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    return targetPath;
  }

  const root = path.resolve(projectRoot);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget === root) {
    return '.';
  }

  const relative = path.relative(root, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return targetPath;
  }

  return relative.replace(/\\/g, '/');
}

function serializeTaskConfigForArtifact(config, projectRoot) {
  const settings = cloneJson(config.settings || {});
  if (settings && settings.cwd) {
    settings.cwd = toRelativeProjectPath(projectRoot, settings.cwd);
  }

  return {
    mode: config.mode,
    prompt: config.prompt,
    reviewPrompt: config.reviewPrompt || null,
    synthesisPrompt: config.synthesisPrompt || null,
    customImplementPrompt: config.customImplementPrompt || null,
    useCase: config.useCase && config.useCase.name ? config.useCase.name : null,
    fork: cloneJson(config.fork || null),
    agents: cloneJson(config.agents || []),
    providers: cloneJson(config.providers || {}),
    roles: cloneJson(config.roles || {}),
    context: cloneJson(config.context || null),
    planQuestionMode: config.planQuestionMode || 'autonomous',
    settings
  };
}

function buildReusableTaskConfigFromArtifactData(taskData, {
  forkedFromRunId,
  forkedFromStepId = null,
  baseCommit = null,
  reason = null,
  recordedBy = 'manual'
}) {
  const config = {
    mode: taskData.mode,
    prompt: taskData.prompt,
    agents: cloneJson(taskData.agents || []),
    settings: cloneJson(taskData.settings || {})
  };

  if (taskData.reviewPrompt) {
    config.reviewPrompt = taskData.reviewPrompt;
  }
  if (taskData.synthesisPrompt) {
    config.synthesisPrompt = taskData.synthesisPrompt;
  }
  if (taskData.customImplementPrompt) {
    config.customImplementPrompt = taskData.customImplementPrompt;
  }
  if (taskData.useCase) {
    config.useCase = taskData.useCase;
  }
  if (taskData.providers && Object.keys(taskData.providers).length > 0) {
    config.providers = cloneJson(taskData.providers);
  }
  if (taskData.roles && Object.keys(taskData.roles).length > 0) {
    config.roles = cloneJson(taskData.roles);
  }
  if (taskData.context) {
    config.context = cloneJson(taskData.context);
  }
  if (taskData.planQuestionMode && taskData.planQuestionMode !== 'autonomous') {
    config.planQuestionMode = taskData.planQuestionMode;
  }

  config.fork = {
    forkedFromRunId,
    forkedFromStepId: forkedFromStepId || null,
    baseCommit: baseCommit || null,
    reason: reason || `Manual fork created from ${forkedFromRunId}${forkedFromStepId ? `/${forkedFromStepId}` : ''}`,
    recordedBy: recordedBy || 'manual'
  };

  return config;
}

function isUsableSnapshot(artifact) {
  if (!artifact || !artifact.data) {
    return false;
  }

  const data = artifact.data;
  const hasDiffOrHead = Boolean(data.gitHead || data.patchFile || data.stagedPatchFile);
  const hasMetadataSignals = Boolean(
    data.dirty
    || (Array.isArray(data.statusPorcelain) && data.statusPorcelain.length > 0)
    || (Array.isArray(data.changedFiles) && data.changedFiles.length > 0)
    || (Array.isArray(data.untrackedFiles) && data.untrackedFiles.length > 0)
  );

  return hasDiffOrHead || hasMetadataSignals;
}

function findLatestSnapshotByScopes(artifacts, scopes, predicate = null) {
  const safeArtifacts = Array.isArray(artifacts) ? artifacts : [];
  for (const scope of scopes) {
    const matches = safeArtifacts.filter((artifact) => artifact && artifact.data && artifact.data.scope === scope);
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const artifact = matches[i];
      if (!predicate || predicate(artifact)) {
        return artifact;
      }
    }
  }

  return null;
}

function selectRepresentativeSnapshot(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return null;
  }

  return findLatestSnapshotByScopes(
    artifacts,
    ['run-end', 'post-step', 'pre-step', 'run-start'],
    isUsableSnapshot
  ) || artifacts[artifacts.length - 1] || null;
}

function selectSnapshotForFork(artifacts, sourceRunId, sourceStepId = null) {
  if (!sourceStepId) {
    return selectRepresentativeSnapshot(artifacts);
  }

  const safeArtifacts = Array.isArray(artifacts) ? artifacts : [];
  const stepSnapshots = safeArtifacts
    .filter((artifact) => artifact && artifact.data && artifact.data.stepId === sourceStepId);

  const exactStepSnapshot = findLatestSnapshotByScopes(stepSnapshots, ['post-step', 'pre-step']);
  if (exactStepSnapshot) {
    return exactStepSnapshot;
  }

  throw new Error(
    `Run "${sourceRunId}" does not contain a usable worktree snapshot for step "${sourceStepId}". `
    + 'Expected a persisted post-step or pre-step snapshot for that exact step.'
  );
}

function resolvePatchDisplayPath(projectRoot, runId, patchFile) {
  if (!patchFile) {
    return null;
  }
  const absolute = path.join(taskPaths.taskDir(projectRoot, runId), patchFile);
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

async function createForkTaskFromRun({
  projectRoot,
  sourceRunId,
  sourceStepId = null,
  reason = null,
  recordedBy = 'manual',
  readTaskArtifact,
  listArtifacts,
  writeFile = fs.writeFile
}) {
  const store = new CollaborationStore({ projectRoot });
  const taskArtifact = await (readTaskArtifact
    ? readTaskArtifact(sourceRunId)
    : store.readTask(sourceRunId));

  const worktreeArtifacts = await (listArtifacts
    ? listArtifacts(sourceRunId, { type: 'worktree-snapshot' })
    : store.listArtifacts(sourceRunId, { type: 'worktree-snapshot' }));

  const sourceTask = taskArtifact && taskArtifact.data ? taskArtifact.data : null;
  if (!sourceTask || typeof sourceTask !== 'object') {
    throw new Error(`Run "${sourceRunId}" does not contain a reusable task record.`);
  }

  if (!sourceTask.mode || !sourceTask.prompt || !Array.isArray(sourceTask.agents)) {
    throw new Error(`Run "${sourceRunId}" task record is missing required fields needed for fork creation.`);
  }

  const baseSnapshot = selectSnapshotForFork(worktreeArtifacts, sourceRunId, sourceStepId);
  const forkConfig = buildReusableTaskConfigFromArtifactData(sourceTask, {
    forkedFromRunId: sourceRunId,
    forkedFromStepId: sourceStepId,
    baseCommit: baseSnapshot && baseSnapshot.data ? baseSnapshot.data.gitHead || null : null,
    reason,
    recordedBy
  });

  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  await writeFile(taskFile, JSON.stringify(forkConfig, null, 2) + '\n', 'utf8');

  return {
    taskFile,
    sourceRunId,
    sourceStepId: sourceStepId || null,
    baseCommit: forkConfig.fork.baseCommit,
    sourceTaskMode: sourceTask.mode
  };
}

async function compareRuns({
  projectRoot,
  leftRunId,
  rightRunId,
  readTaskArtifact,
  listArtifacts
}) {
  const store = new CollaborationStore({ projectRoot });
  const [leftTask, rightTask, leftSnapshots, rightSnapshots] = await Promise.all([
    readTaskArtifact ? readTaskArtifact(leftRunId) : store.readTask(leftRunId),
    readTaskArtifact ? readTaskArtifact(rightRunId) : store.readTask(rightRunId),
    listArtifacts ? listArtifacts(leftRunId, { type: 'worktree-snapshot' }) : store.listArtifacts(leftRunId, { type: 'worktree-snapshot' }),
    listArtifacts ? listArtifacts(rightRunId, { type: 'worktree-snapshot' }) : store.listArtifacts(rightRunId, { type: 'worktree-snapshot' })
  ]);

  const leftSnapshot = selectRepresentativeSnapshot(leftSnapshots);
  const rightSnapshot = selectRepresentativeSnapshot(rightSnapshots);

  const lines = [
    `Comparing runs: ${leftRunId} vs ${rightRunId}`,
    ''
  ];

  for (const entry of [
    { label: 'A', runId: leftRunId, task: leftTask, snapshot: leftSnapshot },
    { label: 'B', runId: rightRunId, task: rightTask, snapshot: rightSnapshot }
  ]) {
    const taskData = entry.task && entry.task.data ? entry.task.data : {};
    const snapshotData = entry.snapshot && entry.snapshot.data ? entry.snapshot.data : null;
    lines.push(`Run ${entry.label}: ${entry.runId}`);
    lines.push(`  Mode: ${taskData.mode || 'unknown'}`);
    lines.push(`  Agents: ${Array.isArray(taskData.agents) ? taskData.agents.join(' -> ') : '(unknown)'}`);
    if (snapshotData) {
      lines.push(`  Snapshot Scope: ${snapshotData.scope}`);
      if (snapshotData.stepId) {
        lines.push(`  Snapshot Step: ${snapshotData.stepId}`);
      }
      lines.push(`  Dirty: ${snapshotData.dirty ? 'yes' : 'no'}`);
      lines.push(`  Changed Files: ${Array.isArray(snapshotData.changedFiles) ? snapshotData.changedFiles.length : 0}`);
      lines.push(`  Patch: ${resolvePatchDisplayPath(projectRoot, entry.runId, snapshotData.patchFile) || '(none)'}`);
      lines.push(`  Staged Patch: ${resolvePatchDisplayPath(projectRoot, entry.runId, snapshotData.stagedPatchFile) || '(none)'}`);
    } else {
      lines.push('  Snapshot Scope: (none recorded)');
      lines.push('  Patch: (none)');
      lines.push('  Staged Patch: (none)');
    }
    lines.push('');
  }

  return { lines, leftSnapshot, rightSnapshot };
}

module.exports = {
  serializeTaskConfigForArtifact,
  buildReusableTaskConfigFromArtifactData,
  createForkTaskFromRun,
  compareRuns,
  __test: {
    toRelativeProjectPath,
    isUsableSnapshot,
    findLatestSnapshotByScopes,
    selectRepresentativeSnapshot,
    selectSnapshotForFork,
    resolvePatchDisplayPath
  }
};
