const { isArtifactType } = require('./artifact-types');
const { CONTEXT_DELIVERY_VALUES } = require('./context-delivery');

function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('Artifact must be a JSON object.');
  }

  if (typeof artifact.type !== 'string' || !isArtifactType(artifact.type)) {
    throw new Error('Artifact must include a supported string "type".');
  }

  if (typeof artifact.id !== 'string' || artifact.id.trim() === '') {
    throw new Error('Artifact must include a non-empty string "id".');
  }

  if (typeof artifact.taskId !== 'string' || artifact.taskId.trim() === '') {
    throw new Error('Artifact must include a non-empty string "taskId".');
  }

  if (typeof artifact.createdAt !== 'string' || artifact.createdAt.trim() === '') {
    throw new Error('Artifact must include a non-empty ISO string "createdAt".');
  }

  if (artifact.cycleNumber !== undefined && artifact.cycleNumber !== null) {
    if (!Number.isInteger(artifact.cycleNumber) || artifact.cycleNumber <= 0) {
      throw new Error('Artifact "cycleNumber" must be a positive integer when present.');
    }
  }

  if (!('data' in artifact)) {
    throw new Error('Artifact must include a "data" field.');
  }

  validateArtifactData(artifact.type, artifact.data);
}

function validateArtifactData(type, data) {
  if (data === undefined) {
    throw new Error('Artifact "data" must not be undefined.');
  }

  switch (type) {
    case 'task':
      return validateTaskData(data);
    case 'proposal':
      return validateProposalData(data);
    case 'review':
      return validateReviewData(data);
    case 'decision':
      return validateDecisionData(data);
    case 'context-pack':
      return validateContextPackData(data);
    case 'provider-readiness':
      return validateProviderReadinessData(data);
    case 'provider-execution':
      return validateProviderExecutionData(data);
    case 'context-selection':
      return validateContextSelectionData(data);
    case 'plan-clarifications':
      return validatePlanClarificationsData(data);
    case 'worktree-snapshot':
      return validateWorktreeSnapshotData(data);
    case 'fork-record':
      return validateForkRecordData(data);
    default:
      throw new Error(`Unsupported artifact type "${type}".`);
  }
}

function validateTaskData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('task artifact "data" must be an object.');
  }
  if (typeof data.mode !== 'string' || data.mode.trim() === '') {
    throw new Error('task artifact "data.mode" must be a non-empty string.');
  }
  if (typeof data.prompt !== 'string') {
    throw new Error('task artifact "data.prompt" must be a string.');
  }
  if (!Array.isArray(data.agents) || data.agents.some((a) => typeof a !== 'string' || a.trim() === '')) {
    throw new Error('task artifact "data.agents" must be an array of non-empty strings.');
  }
  if (!data.startedAt || typeof data.startedAt !== 'string') {
    throw new Error('task artifact "data.startedAt" must be a string.');
  }
}

function validateProposalData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('proposal artifact "data" must be an object.');
  }
  if (typeof data.summary !== 'string') {
    throw new Error('proposal artifact "data.summary" must be a string.');
  }
}

function validateReviewData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('review artifact "data" must be an object.');
  }
  if (data.summary !== undefined && typeof data.summary !== 'string') {
    throw new Error('review artifact "data.summary" must be a string when present.');
  }
  // Review findings must match the handoff finding shape: severity (string),
  // issue (string), with optional area (string) and recommendation (string).
  if (data.findings !== undefined) {
    if (!Array.isArray(data.findings)) {
      throw new Error('review artifact "data.findings" must be an array when present.');
    }
    for (let i = 0; i < data.findings.length; i += 1) {
      const f = data.findings[i];
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        throw new Error(`review artifact "data.findings[${i}]" must be an object.`);
      }
      if (typeof f.severity !== 'string') {
        throw new Error(`review artifact "data.findings[${i}].severity" must be a string.`);
      }
      if (typeof f.issue !== 'string') {
        throw new Error(`review artifact "data.findings[${i}].issue" must be a string.`);
      }
      if (f.area !== undefined && typeof f.area !== 'string') {
        throw new Error(`review artifact "data.findings[${i}].area" must be a string when present.`);
      }
      if (f.recommendation !== undefined && typeof f.recommendation !== 'string') {
        throw new Error(`review artifact "data.findings[${i}].recommendation" must be a string when present.`);
      }
    }
  }
  if (data.risks !== undefined) {
    if (!Array.isArray(data.risks)) {
      throw new Error('review artifact "data.risks" must be an array when present.');
    }
    for (let i = 0; i < data.risks.length; i += 1) {
      if (typeof data.risks[i] !== 'string') {
        throw new Error(`review artifact "data.risks[${i}]" must be a string.`);
      }
    }
  }
  if (data.recommended_changes !== undefined) {
    if (!Array.isArray(data.recommended_changes)) {
      throw new Error('review artifact "data.recommended_changes" must be an array when present.');
    }
    for (let i = 0; i < data.recommended_changes.length; i += 1) {
      if (typeof data.recommended_changes[i] !== 'string') {
        throw new Error(`review artifact "data.recommended_changes[${i}]" must be a string.`);
      }
    }
  }

  // Metadata fields written by buildReviewArtifact
  if (data.handoffParseError !== undefined && data.handoffParseError !== null && typeof data.handoffParseError !== 'string') {
    throw new Error('review artifact "data.handoffParseError" must be a string or null when present.');
  }
  if (data.timing !== undefined && data.timing !== null) {
    if (typeof data.timing !== 'object' || Array.isArray(data.timing)) {
      throw new Error('review artifact "data.timing" must be an object or null when present.');
    }
    if (typeof data.timing.agentMs !== 'number') {
      throw new Error('review artifact "data.timing.agentMs" must be a number.');
    }
    if (typeof data.timing.parseMs !== 'number') {
      throw new Error('review artifact "data.timing.parseMs" must be a number.');
    }
    if (typeof data.timing.totalMs !== 'number') {
      throw new Error('review artifact "data.timing.totalMs" must be a number.');
    }
  }
  if (data.exitCode !== undefined && data.exitCode !== null && typeof data.exitCode !== 'number') {
    throw new Error('review artifact "data.exitCode" must be a number or null when present.');
  }
  if (data.ok !== undefined && typeof data.ok !== 'boolean') {
    throw new Error('review artifact "data.ok" must be a boolean when present.');
  }
}

function validateDecisionData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('decision artifact "data" must be an object.');
  }
  if (typeof data.summary !== 'string') {
    throw new Error('decision artifact "data.summary" must be a string.');
  }
}

function validateContextPackData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('context-pack artifact "data" must be an object.');
  }
  if (!Array.isArray(data.items)) {
    throw new Error('context-pack artifact "data.items" must be an array.');
  }
}

function validateProviderReadinessData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('provider-readiness artifact "data" must be an object.');
  }
  if (typeof data.providerId !== 'string' || data.providerId.trim() === '') {
    throw new Error('provider-readiness artifact "data.providerId" must be a non-empty string.');
  }
  if (typeof data.ready !== 'boolean') {
    throw new Error('provider-readiness artifact "data.ready" must be a boolean.');
  }
}

function validateProviderExecutionData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('provider-execution artifact "data" must be an object.');
  }
  if (typeof data.providerId !== 'string' || data.providerId.trim() === '') {
    throw new Error('provider-execution artifact "data.providerId" must be a non-empty string.');
  }
  if (typeof data.ok !== 'boolean') {
    throw new Error('provider-execution artifact "data.ok" must be a boolean.');
  }
  if (typeof data.durationMs !== 'number') {
    throw new Error('provider-execution artifact "data.durationMs" must be a number.');
  }
  if (typeof data.promptChars !== 'number') {
    throw new Error('provider-execution artifact "data.promptChars" must be a number.');
  }
  if (typeof data.outputChars !== 'number') {
    throw new Error('provider-execution artifact "data.outputChars" must be a number.');
  }
}

function validateContextSelectionData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('context-selection artifact "data" must be an object.');
  }
  if (typeof data.phase !== 'string' || data.phase.trim() === '') {
    throw new Error('context-selection artifact "data.phase" must be a non-empty string.');
  }
  if (typeof data.stageKey !== 'string' || data.stageKey.trim() === '') {
    throw new Error('context-selection artifact "data.stageKey" must be a non-empty string.');
  }
  if (typeof data.delivery !== 'string' || !CONTEXT_DELIVERY_VALUES.includes(data.delivery)) {
    throw new Error(`context-selection artifact "data.delivery" must be one of: ${CONTEXT_DELIVERY_VALUES.join(', ')}.`);
  }
  if (typeof data.suppressed !== 'boolean') {
    throw new Error('context-selection artifact "data.suppressed" must be a boolean.');
  }
  if (!Array.isArray(data.selectedFiles)) {
    throw new Error('context-selection artifact "data.selectedFiles" must be an array.');
  }
  if (!Array.isArray(data.selectionReasons)) {
    throw new Error('context-selection artifact "data.selectionReasons" must be an array.');
  }
}

function validatePlanClarificationsData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('plan-clarifications artifact "data" must be an object.');
  }
  if (!Array.isArray(data.clarifications)) {
    throw new Error('plan-clarifications artifact "data.clarifications" must be an array.');
  }
  for (let i = 0; i < data.clarifications.length; i += 1) {
    const item = data.clarifications[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`plan-clarifications artifact "data.clarifications[${i}]" must be an object.`);
    }
    if (typeof item.id !== 'string') {
      throw new Error(`plan-clarifications artifact "data.clarifications[${i}].id" must be a string.`);
    }
    if (typeof item.question !== 'string') {
      throw new Error(`plan-clarifications artifact "data.clarifications[${i}].question" must be a string.`);
    }
    if (typeof item.answer !== 'string') {
      throw new Error(`plan-clarifications artifact "data.clarifications[${i}].answer" must be a string.`);
    }
    if (typeof item.usedDefault !== 'boolean') {
      throw new Error(`plan-clarifications artifact "data.clarifications[${i}].usedDefault" must be a boolean.`);
    }
  }
}

function validateWorktreeSnapshotData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('worktree-snapshot artifact "data" must be an object.');
  }

  const allowedScopes = new Set(['run-start', 'pre-step', 'post-step', 'run-end', 'manual-fork']);
  if (typeof data.scope !== 'string' || !allowedScopes.has(data.scope)) {
    throw new Error('worktree-snapshot artifact "data.scope" must be one of: run-start, pre-step, post-step, run-end, manual-fork.');
  }

  if (data.stepId !== undefined && data.stepId !== null && typeof data.stepId !== 'string') {
    throw new Error('worktree-snapshot artifact "data.stepId" must be a string or null when present.');
  }
  if (data.stage !== undefined && data.stage !== null && typeof data.stage !== 'string') {
    throw new Error('worktree-snapshot artifact "data.stage" must be a string or null when present.');
  }
  if (data.agent !== undefined && data.agent !== null && typeof data.agent !== 'string') {
    throw new Error('worktree-snapshot artifact "data.agent" must be a string or null when present.');
  }
  if (typeof data.canWrite !== 'boolean') {
    throw new Error('worktree-snapshot artifact "data.canWrite" must be a boolean.');
  }
  if (typeof data.gitAvailable !== 'boolean') {
    throw new Error('worktree-snapshot artifact "data.gitAvailable" must be a boolean.');
  }
  if (data.gitHead !== undefined && data.gitHead !== null && typeof data.gitHead !== 'string') {
    throw new Error('worktree-snapshot artifact "data.gitHead" must be a string or null when present.');
  }
  if (data.gitHeadShort !== undefined && data.gitHeadShort !== null && typeof data.gitHeadShort !== 'string') {
    throw new Error('worktree-snapshot artifact "data.gitHeadShort" must be a string or null when present.');
  }
  if (!Array.isArray(data.statusPorcelain)) {
    throw new Error('worktree-snapshot artifact "data.statusPorcelain" must be an array.');
  }
  for (let i = 0; i < data.statusPorcelain.length; i += 1) {
    if (typeof data.statusPorcelain[i] !== 'string') {
      throw new Error(`worktree-snapshot artifact "data.statusPorcelain[${i}]" must be a string.`);
    }
  }
  if (!Array.isArray(data.changedFiles)) {
    throw new Error('worktree-snapshot artifact "data.changedFiles" must be an array.');
  }
  for (let i = 0; i < data.changedFiles.length; i += 1) {
    const item = data.changedFiles[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`worktree-snapshot artifact "data.changedFiles[${i}]" must be an object.`);
    }
    if (typeof item.status !== 'string' || item.status.trim() === '') {
      throw new Error(`worktree-snapshot artifact "data.changedFiles[${i}].status" must be a non-empty string.`);
    }
    if (typeof item.path !== 'string' || item.path.trim() === '') {
      throw new Error(`worktree-snapshot artifact "data.changedFiles[${i}].path" must be a non-empty string.`);
    }
    if (item.previousPath !== undefined && item.previousPath !== null && typeof item.previousPath !== 'string') {
      throw new Error(`worktree-snapshot artifact "data.changedFiles[${i}].previousPath" must be a string or null when present.`);
    }
  }
  if (!Array.isArray(data.untrackedFiles)) {
    throw new Error('worktree-snapshot artifact "data.untrackedFiles" must be an array.');
  }
  for (let i = 0; i < data.untrackedFiles.length; i += 1) {
    if (typeof data.untrackedFiles[i] !== 'string') {
      throw new Error(`worktree-snapshot artifact "data.untrackedFiles[${i}]" must be a string.`);
    }
  }
  if (data.patchFile !== undefined && data.patchFile !== null && typeof data.patchFile !== 'string') {
    throw new Error('worktree-snapshot artifact "data.patchFile" must be a string or null when present.');
  }
  if (data.stagedPatchFile !== undefined && data.stagedPatchFile !== null && typeof data.stagedPatchFile !== 'string') {
    throw new Error('worktree-snapshot artifact "data.stagedPatchFile" must be a string or null when present.');
  }
  if (typeof data.dirty !== 'boolean') {
    throw new Error('worktree-snapshot artifact "data.dirty" must be a boolean.');
  }
  if (data.captureError !== undefined && data.captureError !== null && typeof data.captureError !== 'string') {
    throw new Error('worktree-snapshot artifact "data.captureError" must be a string or null when present.');
  }
}

function validateForkRecordData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('fork-record artifact "data" must be an object.');
  }
  if (typeof data.forkedFromRunId !== 'string' || data.forkedFromRunId.trim() === '') {
    throw new Error('fork-record artifact "data.forkedFromRunId" must be a non-empty string.');
  }
  if (data.forkedFromStepId !== undefined && data.forkedFromStepId !== null && typeof data.forkedFromStepId !== 'string') {
    throw new Error('fork-record artifact "data.forkedFromStepId" must be a string or null when present.');
  }
  if (data.baseCommit !== undefined && data.baseCommit !== null && typeof data.baseCommit !== 'string') {
    throw new Error('fork-record artifact "data.baseCommit" must be a string or null when present.');
  }
  if (data.reason !== undefined && data.reason !== null && typeof data.reason !== 'string') {
    throw new Error('fork-record artifact "data.reason" must be a string or null when present.');
  }
  if (data.recordedBy !== undefined && data.recordedBy !== null && typeof data.recordedBy !== 'string') {
    throw new Error('fork-record artifact "data.recordedBy" must be a string or null when present.');
  }
}

function validateArtifactSafe(artifact) {
  try {
    validateArtifact(artifact);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

module.exports = {
  validateArtifact,
  validateArtifactSafe
};
