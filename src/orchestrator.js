const fs = require('fs').promises;
const path = require('path');
const taskPaths = require('./task-paths');
const {
  runAgent,
  runHttpProvider,
  resolveAgents,
  clearAuthCache,
  checkProviderReadiness
} = require('./adapters');
const {
  getModePromptBuilders,
  measureContextSectionChars,
  buildImplementPrompt,
  buildImplementReviewPrompt,
  buildImplementRepairPrompt,
  buildOneShotReviewRequest,
  buildOneShotReplanPrompt
} = require('./prompts');
const {
  extractHandoff,
  modeUsesStructuredHandoff,
  renderHandoffForHumans,
  summarizeReviewHistory
} = require('./handoff');
const { normalizeTaskConfig } = require('./task-config');
const { CollaborationStore } = require('./collaboration-store');
const { serializeTaskConfigForArtifact } = require('./cli-audit');
const { buildContextIndex, validatePreparedContextReadiness } = require('./context-index');
const { selectContextForPhase, collectSkippedSourceDiagnostics } = require('./context-selection');
const { collectPlanAnswers, normalizeClarifications } = require('./plan-questions');
const { acquireLock, releaseLock } = require('./run-lock');
const { captureWorktreeSnapshot } = require('./worktree-audit');
const {
  resolveContextDelivery,
  resolveContextDeliveryForCycle
} = require('./context-delivery');

/**
 * Looks up a provider config by agent name with normalized (lowercase) key.
 * Returns null if the agent is not a configured provider.
 *
 * @param {Object} config - Normalized task config
 * @param {string} agentName - The agent name to look up (may be mixed case)
 * @returns {Object|null} The provider config if present, null otherwise
 */
function getProviderConfig(config, agentName) {
  if (!config.providers) {
    return null;
  }
  const normalizedKey = String(agentName).trim().toLowerCase();
  return config.providers[normalizedKey] || null;
}

/**
 * Validates provider assignments to ensure HTTP providers are not used as implement origin.
 * HTTP providers are read-only in v1 and cannot be used for implement mode.
 *
 * @param {Object} config - Normalized task config
 * @throws {Error} If an HTTP provider is assigned as implement origin
 */
function validateProviderAssignments(config) {
  // Only check implement and one-shot modes
  if (config.mode !== 'implement' && config.mode !== 'one-shot') {
    return;
  }

  // Determine the implement origin agent. The fallback chain is:
  // 1. oneShotOrigins.implement when explicitly configured
  // 2. roles.implementer via getAgentForPhase(...)
  // 3. the first declared agent as the final default
  let implementOrigin;

  if (config.mode === 'one-shot') {
    // For one-shot, check the implement origin from settings
    const origins = config.settings && config.settings.oneShotOrigins;
    implementOrigin = origins && origins.implement
      ? origins.implement
      : getAgentForPhase(config, 'implement', config.agents[0]);
  } else {
    // For implement mode, use the first agent
    implementOrigin = getAgentForPhase(config, 'implement', config.agents[0]);
  }

  // Check if the implement origin is an HTTP provider
  const providerConfig = getProviderConfig(config, implementOrigin);
  if (providerConfig && providerConfig.type === 'openai-compatible') {
    throw new Error(
      `HTTP provider "${implementOrigin}" does not support write access and cannot be used as the implement origin. Use a CLI-backed agent (claude, codex, kilo, etc.) for implement mode.`
    );
  }

  // Some CLI adapters may have supportsWriteAccess: false in their
  // capability profiles, but they are not blocked here. They can be used as implement
  // origin if configured, allowing the user to decide.
}

function getRoleFallbackBlockReason(config, fallbackAgent, executionPolicy) {
  const stepCanWrite = Boolean(executionPolicy && executionPolicy.canWrite);
  if (!stepCanWrite) {
    return null;
  }

  const providerConfig = getProviderConfig(config, fallbackAgent);
  if (providerConfig && providerConfig.type === 'openai-compatible') {
    return `roles.fallback="${fallbackAgent}" is an HTTP provider, so it cannot inherit write access for this failed step.`;
  }

  return null;
}

function fallbackReasonLabel(reason) {
  const reasonLabels = {
    empty_output: 'primary invocation returned empty output',
    cli_parse_error: 'primary invocation failed with a CLI parse error',
    not_logged_in: 'primary invocation failed due to missing CLI authentication',
    rate_limited: 'primary invocation failed because you hit the API rate limit',
    unsupported_write_mode: 'write mode is not supported for this agent',
    missing_api_key: 'missing provider/API key configuration'
  };

  return reasonLabels[reason] || 'primary invocation failed';
}

function describeStepFailure(step) {
  if (!step) {
    return 'failed';
  }

  if (step.timedOut) {
    return 'failed due to timeout';
  }
  if (step.fatalOutputReason) {
    return `failed due to ${fallbackReasonLabel(step.fatalOutputReason)}`;
  }
  if (step.usedFallback && step.fallbackReason) {
    return `failed with exit code ${step.exitCode} (${fallbackReasonLabel(step.fallbackReason)})`;
  }
  if (step.error && (step.error.type || step.error.message) && (step.exitCode === undefined || step.exitCode === null)) {
    const errorParts = [];
    if (step.error.type) {
      errorParts.push(step.error.type);
    }
    if (step.error.message) {
      errorParts.push(step.error.message);
    }
    return `failed due to ${errorParts.join(': ')}`;
  }

  return `failed with exit code ${step.exitCode}`;
}

function logOrchestratorInfo(message) {
  if (process.env.LOOPI_SILENT === '1') {
    return;
  }
  console.log(`[orchestrator] ${message}`);
}

function logOrchestratorWarning(message) {
  if (process.env.LOOPI_SILENT === '1') {
    return;
  }
  console.warn(`[orchestrator] Warning: ${message}`);
}

function buildReviewArtifact({ runId, step }) {
  return {
    type: 'review',
    id: `review-${step.id}`,
    taskId: runId,
    stage: step.stage,
    agent: step.agent,
    createdAt: step.finishedAt,
    cycleNumber: step.cycleNumber != null ? step.cycleNumber : null,
    data: {
      ...step.handoffData,
      handoffParseError: step.handoffParseError,
      timing: step.timing || null,
      exitCode: step.exitCode,
      ok: step.ok
    }
  };
}

function toIsoString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  return new Date().toISOString();
}

function buildProviderReadinessArtifact({ runId, artifactId, providerId, result }) {
  return {
    type: 'provider-readiness',
    id: artifactId,
    taskId: runId,
    createdAt: new Date().toISOString(),
    data: {
      providerId,
      ready: Boolean(result.ready),
      failureReason: result.failureReason || null,
      error: result.error || null,
      modelConfirmed: result.modelConfirmed || null,
      rawModels: Array.isArray(result.rawModels) ? result.rawModels : []
    }
  };
}

function buildProviderExecutionArtifact({ runId, artifactId, providerId, providerConfig, promptText, result }) {
  return {
    type: 'provider-execution',
    id: artifactId,
    taskId: runId,
    createdAt: toIsoString(result?.timing?.finishedAt),
    data: {
      providerId,
      model: result?.metadata?.model || providerConfig.model || null,
      // These timestamps cover the full execution window for the provider call,
      // including retry/backoff time, not a single raw HTTP attempt.
      executionStartedAt: toIsoString(result?.timing?.startedAt),
      executionCompletedAt: toIsoString(result?.timing?.finishedAt),
      durationMs: result?.timing?.durationMs || 0,
      ok: Boolean(result?.ok),
      errorType: result?.error?.type || null,
      retryCount: result?.metadata?.retryCount || 0,
      promptChars: promptText.length,
      outputChars: String(result?.outputText || '').length
    }
  };
}

function buildContextSelectionArtifact({
  runId,
  artifactId,
  phase,
  stageKey,
  delivery,
  suppressed,
  maxFiles,
  maxChars,
  providerMaxInputChars,
  contextPack
}) {
  return {
    type: 'context-selection',
    id: artifactId,
    taskId: runId,
    createdAt: new Date().toISOString(),
    data: {
      phase,
      stageKey,
      delivery,
      suppressed: Boolean(suppressed),
      maxFiles,
      maxChars,
      providerMaxInputChars: providerMaxInputChars || null,
      effectiveMaxChars: contextPack && Number.isInteger(contextPack.effectiveMaxChars)
        ? contextPack.effectiveMaxChars
        : null,
      skippedSourceCount: contextPack && Number.isInteger(contextPack.skippedSourceCount)
        ? contextPack.skippedSourceCount
        : 0,
      selectedFiles: Array.isArray(contextPack?.files)
        ? contextPack.files.map((file) => file.relativePath)
        : [],
      skippedSources: Array.isArray(contextPack?.skippedSources)
        ? contextPack.skippedSources
        : [],
      selectionReasons: Array.isArray(contextPack?.selectionReasons)
        ? contextPack.selectionReasons
        : []
    }
  };
}

function describeContextDelivery({
  stageKey,
  delivery,
  contextPack = null,
  downgradedFrom = null,
  cycleNumber = null
}) {
  const fileCount = Array.isArray(contextPack?.files) ? contextPack.files.length : 0;
  const chars = delivery === 'none' ? 0 : measureContextSectionChars(contextPack);
  const skippedSourceCount = Number.isInteger(contextPack?.skippedSourceCount)
    ? contextPack.skippedSourceCount
    : (Array.isArray(contextPack?.skippedSources) ? contextPack.skippedSources.length : 0);
  const downgradeNote = downgradedFrom && cycleNumber != null
    ? ` (cycle ${cycleNumber} downgrade from ${downgradedFrom})`
    : '';
  return `[context] stage=${stageKey} delivery=${delivery} files=${fileCount} chars=${chars} skippedSources=${skippedSourceCount}${downgradeNote}`;
}

function buildPlanClarificationsArtifact({ runId, artifactId, cycleNumber, clarifications }) {
  return {
    type: 'plan-clarifications',
    id: artifactId,
    taskId: runId,
    createdAt: new Date().toISOString(),
    cycleNumber: cycleNumber != null ? cycleNumber : null,
    data: {
      clarifications: (Array.isArray(clarifications) ? clarifications : []).map((item) => ({
        id: item.id || 'unknown',
        question: item.question || '',
        answer: item.answer || '',
        usedDefault: Boolean(item.usedDefault)
      }))
    }
  };
}

function buildWorktreeSnapshotArtifact({
  runId,
  artifactId,
  cycleNumber = null,
  snapshot,
  patchFile = null,
  stagedPatchFile = null
}) {
  return {
    type: 'worktree-snapshot',
    id: artifactId,
    taskId: runId,
    createdAt: new Date().toISOString(),
    cycleNumber: cycleNumber != null ? cycleNumber : null,
    data: {
      scope: snapshot.scope,
      stepId: snapshot.stepId || null,
      stage: snapshot.stage || null,
      agent: snapshot.agent || null,
      canWrite: Boolean(snapshot.canWrite),
      gitAvailable: Boolean(snapshot.gitAvailable),
      gitHead: snapshot.gitHead || null,
      gitHeadShort: snapshot.gitHeadShort || null,
      statusPorcelain: Array.isArray(snapshot.statusPorcelain) ? snapshot.statusPorcelain : [],
      changedFiles: Array.isArray(snapshot.changedFiles) ? snapshot.changedFiles : [],
      untrackedFiles: Array.isArray(snapshot.untrackedFiles) ? snapshot.untrackedFiles : [],
      dirty: Boolean(snapshot.dirty),
      patchFile: patchFile || null,
      stagedPatchFile: stagedPatchFile || null,
      captureError: snapshot.captureError || null
    }
  };
}

function buildForkRecordArtifact({
  runId,
  artifactId,
  fork
}) {
  return {
    type: 'fork-record',
    id: artifactId,
    taskId: runId,
    createdAt: new Date().toISOString(),
    data: {
      forkedFromRunId: fork.forkedFromRunId,
      forkedFromStepId: fork.forkedFromStepId || null,
      baseCommit: fork.baseCommit || null,
      reason: fork.reason || null,
      recordedBy: fork.recordedBy || 'manual'
    }
  };
}

function serializeTaskRecord(config, run, projectRoot) {
  return {
    ...serializeTaskConfigForArtifact(config, projectRoot),
    taskId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    durationMs: run.durationMs || null,
    status: run.status,
    error: run.error || null
  };
}

function getRoleAssignment(config, role) {
  if (!config || !config.roles) {
    return null;
  }
  return config.roles[role] || null;
}

function getAgentForPhase(config, phase, fallbackAgent) {
  const roleByPhase = {
    plan: 'planner',
    review: 'reviewer',
    implement: 'implementer'
  };
  const role = roleByPhase[phase];
  return (role && getRoleAssignment(config, role)) || fallbackAgent;
}

function getReviewAgents(config, originAgent, fallbackReviewers) {
  const reviewer = getRoleAssignment(config, 'reviewer');
  if (reviewer) {
    return [reviewer];
  }
  const reviewers = Array.isArray(fallbackReviewers) ? fallbackReviewers : [];
  return reviewers.length > 0 ? reviewers : [originAgent];
}

function getContextDeliveryDecision(config, stageKey, cycleNumber = null) {
  const baseDelivery = resolveContextDelivery(config, stageKey);
  const delivery = resolveContextDeliveryForCycle(config, stageKey, cycleNumber);
  const downgradedFrom = baseDelivery !== delivery ? baseDelivery : null;

  return {
    delivery,
    downgradedFrom
  };
}

function getLocalProviderIds(config, providerIds = null) {
  if (!config.providers) {
    return [];
  }

  const allowedIds = providerIds
    ? new Set(Array.from(providerIds, (id) => String(id).trim().toLowerCase()))
    : null;

  return Object.values(config.providers)
    .filter((providerConfig) => {
      if (!providerConfig || providerConfig.type !== 'openai-compatible') {
        return false;
      }
      if (allowedIds && !allowedIds.has(String(providerConfig.id || '').trim().toLowerCase())) {
        return false;
      }
      if (providerConfig.local === true) {
        return true;
      }
      try {
        const parsed = new URL(providerConfig.baseUrl);
        return parsed.hostname === 'localhost'
          || parsed.hostname === '127.0.0.1'
          || parsed.hostname === '0.0.0.0'
          || parsed.hostname === '::1'
          || parsed.hostname === '[::1]';
      } catch {
        return false;
      }
    })
    .map((providerConfig) => providerConfig.id);
}

function getUsedProviderIds(config) {
  if (!config || !config.providers) {
    return new Set();
  }

  const used = new Set();
  const addIfProvider = (name) => {
    const normalized = String(name || '').trim().toLowerCase();
    if (normalized && config.providers[normalized]) {
      used.add(normalized);
    }
  };

  for (const agent of config.agents || []) {
    addIfProvider(agent);
  }

  if (config.roles && typeof config.roles === 'object') {
    for (const roleTarget of Object.values(config.roles)) {
      addIfProvider(roleTarget);
    }
  }

  const oneShotOrigins = config.settings && config.settings.oneShotOrigins;
  if (oneShotOrigins && typeof oneShotOrigins === 'object') {
    for (const origin of Object.values(oneShotOrigins)) {
      addIfProvider(origin);
    }
  }

  return used;
}

// Derives the effective agent order for a one-shot submode.
// If oneShotOrigins has an override for this submode, that agent moves to
// front. All other agents keep their original relative order.
// If not in one-shot mode or no override exists, returns the agents list unchanged.
function getEffectiveAgentsForMode(config, submode) {
  const origins = config.settings && config.settings.oneShotOrigins;
  const roleMappedOrigin = getAgentForPhase(config, submode, null);
  const originAgent = (config.mode === 'one-shot' && origins && origins[submode])
    ? origins[submode]
    : roleMappedOrigin;
  if (!originAgent) {
    return config.agents;
  }
  const remaining = config.agents.filter((a) => a !== originAgent);
  return [originAgent, ...remaining];
}

function renderOneShotUnitResultSummary(unitResults) {
  if (!Array.isArray(unitResults) || unitResults.length === 0) {
    return '';
  }

  return unitResults.map((entry, index) => {
    const lines = [
      `Unit ${index + 1}: ${entry.id} - ${entry.title}`,
      entry.output ? `Output:\n${entry.output}` : null,
      entry.handoffText ? `Handoff:\n${entry.handoffText}` : null
    ].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n');
}

// Returns a Set of coarse 50-char lowercase keys representing the findings in a review history entry.
// Used by the architecture escape hatch to detect repeated findings across cycles.
// Intentionally coarse — false positives and misses are acceptable because this is advisory-only.
function extractReviewFindingKeys(entry) {
  const keys = new Set();

  if (!entry) {
    return keys;
  }

  if (entry.handoffData && Array.isArray(entry.handoffData.findings)) {
    // Structured path: key each finding by its issue text
    for (const f of entry.handoffData.findings) {
      if (typeof f.issue === 'string') {
        keys.add(f.issue.toLowerCase().slice(0, 50));
      }
    }
    return keys;
  }

  // Prose fallback: find the first substantive line (skip headings and very short labels)
  if (entry.handoffText) {
    let text = entry.handoffText;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.fallback_text === 'string') {
        text = parsed.fallback_text;
      }
    } catch {
      // not JSON — use as-is
    }

    const isHeadingLine = (line) => /^\s*(#+|\d+\.)\s/.test(line) || line.trim().length < 30;
    const substantiveLine = text.split('\n').find((l) => l.trim().length > 0 && !isHeadingLine(l));
    if (substantiveLine) {
      keys.add(substantiveLine.toLowerCase().slice(0, 50));
    }
  }

  return keys;
}

class LoopiOrchestrator {
  constructor({ projectRoot, preassignedRunId = null, preassignedStartedAt = null } = {}) {
    this.projectRoot = taskPaths.getProjectRoot(projectRoot);
    this.sharedDir = taskPaths.sharedDir(this.projectRoot);
    this.taskFile = taskPaths.legacyTaskFile(this.projectRoot);
    this.logFile = taskPaths.legacyLogFile(this.projectRoot);
    this.runsNdjsonFile = taskPaths.runsNdjsonFile(this.projectRoot);
    this.scratchpadFile = taskPaths.legacyScratchpadFile(this.projectRoot);
    this.collaborationStore = new CollaborationStore({ projectRoot: this.projectRoot });
    this._contextIndex = null;
    this._contextPackCache = {};
    this._contextSelectionArtifactKeys = new Set();
    this._providerReadinessCache = {};
    this._artifactSeq = 0;
    this.lastRun = null;
    this.preassignedRunId = preassignedRunId;
    this.preassignedStartedAt = preassignedStartedAt;
    this.buildContextIndex = buildContextIndex;
    this.checkProviderReadiness = checkProviderReadiness;
    this.collectPlanAnswers = collectPlanAnswers;
    this.captureWorktreeSnapshot = captureWorktreeSnapshot;
  }

  async init() {
    await fs.mkdir(this.sharedDir, { recursive: true });
    await this.ensureFile(this.taskFile, JSON.stringify(this.defaultTaskConfig(), null, 2) + '\n');
    await this.ensureFile(this.scratchpadFile, '');
  }

  defaultTaskConfig() {
    return {
      mode: 'plan',
      prompt: 'Describe the work you want the agent loop to plan.',
      agents: ['claude', 'codex', 'gemini'],
      settings: {
        timeoutMs: 180000,
        continueOnError: false,
        writeScratchpad: true,
        qualityLoops: 1
      }
    };
  }

  async ensureFile(filePath, defaultContent) {
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, defaultContent, 'utf8');
    }
  }

  getContextSelectionParams(config, phase, agentName = null, delivery = 'full') {
    const maxFiles = (config.context.maxFilesPerPhase && config.context.maxFilesPerPhase[phase]) || 10;
    const maxChars = (config.context.maxCharsPerPhase && config.context.maxCharsPerPhase[phase]) || 20000;
    const providerConfig = agentName ? getProviderConfig(config, agentName) : null;
    const providerMaxInputChars = providerConfig && providerConfig.maxInputChars
      ? providerConfig.maxInputChars
      : null;
    const effectiveProviderMaxInputChars = delivery === 'digest'
      ? null
      : providerMaxInputChars;

    return {
      maxFiles,
      maxChars,
      providerMaxInputChars,
      effectiveProviderMaxInputChars
    };
  }

  async writeContextSelectionArtifact({
    config,
    phase,
    stageKey,
    agentName = null,
    run = null,
    delivery = 'full',
    contextPack = null,
    suppressed = false
  }) {
    if (!run || !run.runId) {
      return;
    }

    const {
      maxFiles,
      maxChars,
      effectiveProviderMaxInputChars
    } = this.getContextSelectionParams(config, phase, agentName, delivery);
    const artifactSelectionKey = [
      phase,
      stageKey || phase,
      delivery,
      suppressed ? 'suppressed' : 'active',
      maxFiles,
      maxChars,
      effectiveProviderMaxInputChars || 'default'
    ].join('::');

    if (this._contextSelectionArtifactKeys.has(artifactSelectionKey)) {
      return;
    }

    this._contextSelectionArtifactKeys.add(artifactSelectionKey);
    const artifact = buildContextSelectionArtifact({
      runId: run.runId,
      artifactId: this.nextArtifactId('context-selection'),
      phase,
      stageKey: stageKey || phase,
      delivery,
      suppressed,
      maxFiles,
      maxChars,
      providerMaxInputChars: effectiveProviderMaxInputChars,
      contextPack
    });
    await this.writeArtifactSafe(run.runId, artifact, 'context-selection');
  }

  async runTask() {
    const rawTask = await this.readJsonFile(this.taskFile, this.defaultTaskConfig());
    const config = normalizeTaskConfig(rawTask, { projectRoot: this.projectRoot });

    // Validate prepared context readiness before any run artifacts are written.
    // This catches missing, drifted, or config-mismatched caches early so the
    // user can re-prepare without leaving behind a partial run record.
    await validatePreparedContextReadiness(config.context, this.projectRoot);

    const run = this.createRun(config);
    this.lastRun = run;
    this._artifactSeq = 0;
    await this.captureAndPersistWorktreeSnapshot({ run, scope: 'run-start' });
    await this.writeForkRecordIfPresent(run, config);
    const taskId = run.runId;
    let pendingError = null;
    let preflightComplete = false;
    try {
      await this.collaborationStore.writeTask(taskId, serializeTaskRecord(config, run, this.projectRoot));
    } catch (error) {
      console.error('Warning: failed to write v2 task record:', error.message);
    }
    let scratchpadWritten = false;

    try {
      const cliAgents = config.executionTargets.filter((agentName) => !getProviderConfig(config, agentName));
      if (cliAgents.length > 0) {
        await resolveAgents(cliAgents, {
          cwd: config.settings.cwd,
          timeoutMs: Math.min(config.settings.timeoutMs, 10000)
        });
      }
      preflightComplete = true;

      console.log(`Running ${config.mode} mode with agents: ${config.agents.join(' -> ')}`);
      run.result = await this.runMode(config, run);
      run.status = 'completed';
    } catch (error) {
      run.status = 'failed';
      run.error = {
        message: error.message,
        stack: error.stack
      };

      if (!preflightComplete) {
        try {
          await this.collaborationStore.appendStep(run.runId, {
            id: `preflight-${run.steps.length + 1}`,
            stage: 'preflight',
            agent: null,
            ok: false,
            startedAt: run.startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: 0,
            exitCode: null,
            signal: null,
            timedOut: false,
            usedFallback: false,
            fallbackTier: 0,
            fallbackReason: null,
            canWrite: false,
            cycleNumber: null,
            handoffParseError: null,
            handoffData: null,
            error: { message: error.message }
          });
        } catch (stepError) {
          console.error('Warning: failed to append v2 preflight step record:', stepError.message);
        }
      }

      pendingError = error;
    } finally {
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
      try {
        await this.collaborationStore.writeTask(taskId, serializeTaskRecord(config, run, this.projectRoot));
      } catch (error) {
        console.error('Warning: failed to finalize v2 task record:', error.message);
      }
      await this.captureAndPersistWorktreeSnapshot({ run, scope: 'run-end' });
      if (config.settings.writeScratchpad) {
        try {
          await fs.writeFile(this.scratchpadFile, this.renderScratchpad(run), 'utf8');
          scratchpadWritten = true;
        } catch (scratchpadError) {
          console.error('Warning: failed to write scratchpad:', scratchpadError.message);
        }
      }
      try {
        await this.appendRunLog(run);
      } catch (logError) {
        console.error('Warning: failed to write run log:', logError.message);
      }
    }

    const scratchpadRelPath = path.relative(this.projectRoot, this.scratchpadFile);
    if (scratchpadWritten) {
      if (run.status === 'completed') {
        console.log(`Run complete. Final ${config.mode} output written to ${scratchpadRelPath}`);
      } else {
        console.log(`Run failed. Scratchpad written to ${scratchpadRelPath}`);
      }
    } else if (run.status === 'completed') {
      console.log('Run complete. No scratchpad file was written.');
    } else {
      console.log('Run failed. No scratchpad file was written.');
    }

    if (pendingError) {
      pendingError.run = run;
      throw pendingError;
    }

    return run;
  }

  async getContextPackForPhase(config, phase, agentName = null, run = null, delivery = 'full', stageKey = null) {
    if (!this._contextIndex || !config.context) {
      return null;
    }

    const {
      maxFiles,
      maxChars,
      effectiveProviderMaxInputChars
    } = this.getContextSelectionParams(config, phase, agentName, delivery);
    const selectionCacheKey = [
      phase,
      delivery,
      maxFiles,
      maxChars,
      effectiveProviderMaxInputChars || 'default'
    ].join('::');

    // Cache the in-flight promise rather than the resolved value so two
    // concurrent calls for the same selection key share one selection pass.
    if (!this._contextPackCache[selectionCacheKey]) {
      this._contextPackCache[selectionCacheKey] = selectContextForPhase(
        this._contextIndex,
        phase,
        {
          maxFiles,
          maxChars,
          providerMaxInputChars: effectiveProviderMaxInputChars
        }
      );
    }

    const contextPack = await this._contextPackCache[selectionCacheKey];

    await this.writeContextSelectionArtifact({
      config,
      phase,
      stageKey,
      agentName,
      run,
      delivery,
      contextPack,
      suppressed: false
    });

    return contextPack;
  }

  async getPromptContextForPhase(config, phase, {
    agentName = null,
    run = null,
    delivery = 'full',
    stageKey = null,
    downgradedFrom = null,
    cycleNumber = null
  } = {}) {
    if (!config.context || !this._contextIndex) {
      return null;
    }

    if (delivery === 'none') {
      const skippedSources = collectSkippedSourceDiagnostics(this._contextIndex.files);
      await this.writeContextSelectionArtifact({
        config,
        phase,
        stageKey,
        agentName,
        run,
        delivery,
        contextPack: {
          files: [],
          selectionReasons: [],
          effectiveMaxChars: null,
          skippedSourceCount: skippedSources.length,
          skippedSources
        },
        suppressed: true
      });
      logOrchestratorInfo(describeContextDelivery({
        stageKey: stageKey || phase,
        delivery,
        downgradedFrom,
        cycleNumber
      }));
      return null;
    }

    const contextPack = await this.getContextPackForPhase(config, phase, agentName, run, delivery, stageKey);
    if (!contextPack) {
      return null;
    }

    if (delivery === 'digest') {
      const providerConfig = agentName ? getProviderConfig(config, agentName) : null;
      const renderMaxChars = providerConfig && providerConfig.maxInputChars
        ? providerConfig.maxInputChars
        : null;
      const digestContextPack = {
        ...contextPack,
        renderMode: 'digest',
        renderMaxChars
      };
      logOrchestratorInfo(describeContextDelivery({
        stageKey: stageKey || phase,
        delivery,
        contextPack: digestContextPack,
        downgradedFrom,
        cycleNumber
      }));
      return digestContextPack;
    }

    logOrchestratorInfo(describeContextDelivery({
      stageKey: stageKey || phase,
      delivery,
      contextPack,
      downgradedFrom,
      cycleNumber
    }));
    return contextPack;
  }

  nextArtifactId(prefix) {
    this._artifactSeq += 1;
    return `${prefix}-${this._artifactSeq}`;
  }

  async writeArtifactSafe(runId, artifact, label, run = null) {
    try {
      await this.collaborationStore.writeArtifact(runId, artifact);
      return { ok: true };
    } catch (error) {
      const warning = `failed to write ${label} artifact: ${error.message}`;
      console.error('Warning:', warning);
      if (run && Array.isArray(run.auditWarnings)) {
        run.auditWarnings.push(warning);
      }
      return { ok: false, error };
    }
  }

  async captureAndPersistWorktreeSnapshot({
    run,
    scope,
    step = null,
    cycleNumber = null
  }) {
    if (!run || !run.runId) {
      return null;
    }
    try {
      const snapshot = await Promise.resolve(this.captureWorktreeSnapshot({
        projectRoot: this.projectRoot,
        scope,
        step,
        includePatches: scope === 'pre-step' ? false : null
      }));
      if (scope === 'pre-step') {
        snapshot.patchText = '';
        snapshot.stagedPatchText = '';
      }

      const artifactId = this.nextArtifactId('worktree-snapshot');
      const taskDir = taskPaths.taskDir(this.projectRoot, run.runId);
      const patchesDir = taskPaths.patchesDir(this.projectRoot, run.runId);
      let patchFile = null;
      let stagedPatchFile = null;
      let patchWriteError = null;

      try {
        await fs.mkdir(patchesDir, { recursive: true });
        if (snapshot.patchText) {
          const patchPath = taskPaths.patchFilePath(this.projectRoot, run.runId, artifactId);
          await fs.writeFile(patchPath, snapshot.patchText, 'utf8');
          patchFile = path.relative(taskDir, patchPath).replace(/\\/g, '/');
        }
        if (snapshot.stagedPatchText) {
          const stagedPatchPath = taskPaths.patchFilePath(this.projectRoot, run.runId, artifactId, 'staged');
          await fs.writeFile(stagedPatchPath, snapshot.stagedPatchText, 'utf8');
          stagedPatchFile = path.relative(taskDir, stagedPatchPath).replace(/\\/g, '/');
        }
      } catch (error) {
        patchWriteError = `Failed to persist patch files: ${error.message}`;
      }

      if (patchWriteError) {
        snapshot.captureError = snapshot.captureError
          ? `${snapshot.captureError} | ${patchWriteError}`
          : patchWriteError;
      }

      const artifact = buildWorktreeSnapshotArtifact({
        runId: run.runId,
        artifactId,
        cycleNumber,
        snapshot,
        patchFile,
        stagedPatchFile
      });
      const writeResult = await this.writeArtifactSafe(run.runId, artifact, 'worktree-snapshot', run);
      if (!writeResult.ok) {
        return null;
      }

      const summary = {
        artifactId,
        scope: artifact.data.scope,
        stepId: artifact.data.stepId,
        stage: artifact.data.stage,
        agent: artifact.data.agent,
        cycleNumber: cycleNumber != null ? cycleNumber : null,
        patchFile: artifact.data.patchFile,
        stagedPatchFile: artifact.data.stagedPatchFile,
        dirty: artifact.data.dirty,
        capturedAt: artifact.createdAt
      };
      run.worktreeSnapshots.push(summary);
      return summary;
    } catch (error) {
      console.error(`Warning: failed to capture ${scope} worktree snapshot:`, error.message);
      return null;
    }
  }

  async writeForkRecordIfPresent(run, config) {
    if (!config || !config.fork || !run || !run.runId) {
      return null;
    }

    const artifact = buildForkRecordArtifact({
      runId: run.runId,
      artifactId: this.nextArtifactId('fork-record'),
      fork: config.fork
    });
    const writeResult = await this.writeArtifactSafe(run.runId, artifact, 'fork-record', run);
    if (!writeResult.ok) {
      return null;
    }

    run.forkRecord = {
      artifactId: artifact.id,
      ...artifact.data
    };
    return run.forkRecord;
  }

  async ensureContextIndex(config) {
    if (!config.context) {
      this._contextIndex = null;
      return null;
    }

    if (this._contextIndex) {
      logOrchestratorWarning('Prepared context was consumed more than once in a single run. Reusing cached context index.');
      return this._contextIndex;
    }

    this._contextIndex = await this.buildContextIndex(config.context, this.projectRoot);
    return this._contextIndex;
  }

  async ensureProviderReadiness(config, run, providerIds = null) {
    if (!config.providers || Object.keys(config.providers).length === 0) {
      return;
    }

    const allowedIds = providerIds
      ? new Set(Array.from(providerIds, (id) => String(id).trim().toLowerCase()))
      : null;

    for (const [providerId, providerConfig] of Object.entries(config.providers)) {
      if (allowedIds && !allowedIds.has(String(providerId).trim().toLowerCase())) {
        continue;
      }
      if (providerConfig.type !== 'openai-compatible') {
        continue;
      }

      let result = this._providerReadinessCache[providerId];
      let didProbe = false;
      if (!result) {
        result = await this.checkProviderReadiness(providerConfig);
        this._providerReadinessCache[providerId] = result;
        didProbe = true;
      }

      if (didProbe && run && run.runId) {
        const artifact = buildProviderReadinessArtifact({
          runId: run.runId,
          artifactId: this.nextArtifactId('provider-readiness'),
          providerId,
          result
        });
        await this.writeArtifactSafe(run.runId, artifact, 'provider-readiness');
      }

      if (!result.ready) {
        let errorDetails = '';
        if (result.failureReason) {
          errorDetails = ` Reason: ${result.failureReason}.`;
        }
        if (result.error) {
          errorDetails += ` ${result.error}`;
        }

        throw new Error(
          `Provider "${providerId}" is not ready.${errorDetails}`
        );
      }

      if (didProbe) {
        console.log(`Provider "${providerId}" is ready (model confirmed: ${result.modelConfirmed}, models available: ${result.rawModels.length})`);
      }
    }
  }

  async runMode(config, run) {
    // Commit 8: Validate provider assignments before running
    validateProviderAssignments(config);

    this._providerReadinessCache = {};
    this._contextIndex = null;
    this._contextPackCache = {};
    this._contextSelectionArtifactKeys = new Set();
    const acquiredLocks = [];

    try {
      const usedProviderIds = getUsedProviderIds(config);
      const localProviderIds = getLocalProviderIds(config, usedProviderIds);
      for (const providerId of localProviderIds) {
        const lockResult = await acquireLock(providerId, {
          runId: run.runId,
          pid: process.pid,
          startedAt: Date.now()
        }, { projectRoot: this.projectRoot });

        if (!lockResult.acquired) {
          const conflictingRun = lockResult.conflictingRun || {};
          const ageMs = Math.max(0, Date.now() - Number(conflictingRun.startedAt || Date.now()));
          const ageSeconds = Math.floor(ageMs / 1000);
          throw new Error(
            `Cannot start: provider "${providerId}" is already in use by run ${conflictingRun.runId || 'unknown'} ` +
            `(started ${ageSeconds}s ago). Wait for it to finish or delete the lock file at ${taskPaths.sharedDir(this.projectRoot)}\\.locks\\${providerId}.lock.json`
          );
        }

        acquiredLocks.push(providerId);
      }

      // Commit 8 / 17: Check readiness only for providers used by this run.
      await this.ensureProviderReadiness(config, run, usedProviderIds);

      // Commit 10 / 17: Build context index once per run when configured
      await this.ensureContextIndex(config);

      if (config.mode === 'one-shot') {
        return this.runOneShotMode(config, run);
      }

      if (config.mode === 'plan') {
        return this.runPlanMode(config, run);
      }

      if (config.mode === 'implement') {
        return this.runIterativeImplementMode(config, run);
      }

      return this.runCollaborativeMode({
        mode: config.mode,
        prompt: config.prompt,
        config,
        run,
        cycleNumber: null
      });
    } finally {
      for (const providerId of acquiredLocks.reverse()) {
        try {
          await releaseLock(providerId, { projectRoot: this.projectRoot });
        } catch (error) {
          console.error(`Warning: failed to release provider lock for ${providerId}:`, error.message);
        }
      }
    }
  }

  async runPlanReviewAndSynthesis({
    config,
    run,
    cycleNumber,
    originAgent,
    artifactToReview,
    clarifications
  }) {
    clearAuthCache();

    const modeBuilders = getModePromptBuilders('plan', {
      reviewPrompt: config.reviewPrompt,
      synthesisPrompt: config.synthesisPrompt,
      useCase: config.useCase || null
    });
    const reviewers = config.agents.filter((agentName) => agentName !== originAgent);
    const effectiveReviewers = getReviewAgents(config, originAgent, reviewers);
    const feedbackEntries = [];

    for (const reviewer of effectiveReviewers) {
      const reviewerExecutionPolicy = { canWrite: false };
      const reviewDeliveryDecision = getContextDeliveryDecision(config, 'planReview', cycleNumber);
      const reviewContextPack = await this.getPromptContextForPhase(config, 'plan', {
        agentName: reviewer,
        run,
        delivery: reviewDeliveryDecision.delivery,
        stageKey: 'planReview',
        downgradedFrom: reviewDeliveryDecision.downgradedFrom,
        cycleNumber
      });
      const reviewStep = await this.runStep({
        run,
        config,
        stage: modeBuilders.reviewStage,
        agent: reviewer,
        prompt: modeBuilders.buildReviewPrompt({
          prompt: config.prompt,
          initialOutput: artifactToReview,
          feedbackEntries,
          executionPolicy: reviewerExecutionPolicy,
          context: { contextPack: reviewContextPack },
          clarifications
        }),
        cycleNumber,
        mode: 'plan',
        executionPolicy: reviewerExecutionPolicy,
        handoffSchema: modeBuilders.reviewHandoffSchema
      });

      feedbackEntries.push({
        agent: reviewStep.agent,
        text: reviewStep.handoffText,
        outputText: reviewStep.outputText,
        handoffData: reviewStep.handoffData || null,
        ok: reviewStep.ok
      });

      this.assertStepSucceeded(reviewStep, config);
    }

    let synthesisStep = null;
    if (feedbackEntries.length > 0) {
      const synthesisExecutionPolicy = { canWrite: false };
      const synthesisContextPack = await this.getPromptContextForPhase(config, 'plan', {
        agentName: originAgent,
        run,
        delivery: resolveContextDelivery(config, 'reviewSynthesis'),
        stageKey: 'reviewSynthesis'
      });
      synthesisStep = await this.runStep({
        run,
        config,
        stage: modeBuilders.finalStage,
        agent: originAgent,
        prompt: modeBuilders.buildFinalPrompt({
          prompt: config.prompt,
          initialOutput: artifactToReview,
          feedbackEntries,
          executionPolicy: synthesisExecutionPolicy,
          context: { contextPack: synthesisContextPack },
          clarifications
        }),
        cycleNumber,
        mode: 'plan',
        executionPolicy: synthesisExecutionPolicy,
        handoffSchema: modeBuilders.finalHandoffSchema
      });

      this.assertStepSucceeded(synthesisStep, config);
    }

    return {
      feedbackEntries,
      synthesisStep
    };
  }

  async runPlanMode(config, run) {
    const totalLoops = config.settings.planLoops;
    let currentPlan = null;
    let currentHandoffText = null;
    let currentHandoffData = null;
    let clarifications = null;

    for (let loopNumber = 1; loopNumber <= totalLoops; loopNumber += 1) {
      // Loop 1: initial planner draft -> checkpoint -> review -> synthesis
      // Loop 2+: review prior plan, then synthesize (skip initial plan creation)
      const cycleNumber = totalLoops === 1 ? null : loopNumber;
      const originAgent = getAgentForPhase(config, 'plan', config.agents[0]);

      if (loopNumber === 1) {
        // Commit 12a: Run only the initial planner draft first
        const modeBuilders = getModePromptBuilders('plan', {
          reviewPrompt: config.reviewPrompt,
          synthesisPrompt: config.synthesisPrompt,
          useCase: config.useCase || null
        });

        const initialExecutionPolicy = {
          canWrite: false // Plan mode never requires write access
        };
        const initialContextPack = await this.getPromptContextForPhase(config, 'plan', {
          agentName: originAgent,
          run,
          delivery: resolveContextDelivery(config, 'planInitial'),
          stageKey: 'planInitial'
        });

        // Run only the initial planner step (not full collaborative mode)
        const initialStep = await this.runStep({
          run,
          config,
          stage: modeBuilders.initialStage,
          agent: originAgent,
          prompt: modeBuilders.buildInitialPrompt(config.prompt, {
            executionPolicy: initialExecutionPolicy,
            contextPack: initialContextPack
          }),
          cycleNumber,
          mode: 'plan',
          executionPolicy: initialExecutionPolicy,
          handoffSchema: modeBuilders.initialHandoffSchema
        });

        this.assertStepSucceeded(initialStep, config);
        this.assertUsablePlannerOutput(initialStep, config, 'plan');

        currentPlan = initialStep.outputText;
        currentHandoffText = initialStep.handoffText;
        currentHandoffData = initialStep.handoffData;

        // Commit 12a: Interactive planning checkpoint - after first plan draft, before review
        const questionParseFailed = Boolean(
          initialStep.handoffParseError
          && /questions/i.test(initialStep.handoffParseError)
        );
        const planQuestions = currentHandoffData && Array.isArray(currentHandoffData.questions)
          ? currentHandoffData.questions
          : [];

        // Commit 12c: Check for malformed questions and log warning
        const hasMalformedQuestions = planQuestions.some((q) => {
          return !q || typeof q !== 'object' || !q.question || !q.impact || !q.agentDefault;
        });

        if (questionParseFailed) {
          logOrchestratorWarning('invalid question block found in plan handoff. Continuing without the clarification checkpoint.');
          clarifications = [];
        } else if (hasMalformedQuestions) {
          logOrchestratorWarning('malformed or incomplete questions found in plan handoff. Skipping interactive checkpoint.');
          clarifications = [];
        } else if (planQuestions.length > 0) {
          if (config.planQuestionMode === 'interactive') {
            logOrchestratorInfo('Interactive mode: pausing for planning clarifications...');
            clarifications = await this.collectPlanAnswers(planQuestions);
          } else {
            // Autonomous mode: use planner defaults
            clarifications = normalizeClarifications(planQuestions);
            logOrchestratorInfo(`Autonomous mode: using planner defaults for ${clarifications.length} question(s)`);
          }
        } else {
          // No questions means no pause needed
          clarifications = [];
        }

        if (run && run.runId) {
          await this.writeArtifactSafe(
            run.runId,
            buildPlanClarificationsArtifact({
              runId: run.runId,
              artifactId: this.nextArtifactId('plan-clarifications'),
              cycleNumber,
              clarifications
            }),
            'plan-clarifications'
          );
        }

        const artifactToReview = currentHandoffText || currentPlan;
        const { synthesisStep } = await this.runPlanReviewAndSynthesis({
          config,
          run,
          cycleNumber,
          originAgent,
          artifactToReview,
          clarifications
        });

        if (synthesisStep) {
          currentPlan = synthesisStep.outputText;
          currentHandoffText = synthesisStep.handoffText;
          currentHandoffData = synthesisStep.handoffData;
        }
      } else {
        // The artifact to review is plan from the previous loop
        const artifactToReview = currentHandoffText || currentPlan;
        const { synthesisStep } = await this.runPlanReviewAndSynthesis({
          config,
          run,
          cycleNumber,
          originAgent,
          artifactToReview,
          clarifications
        });

        if (synthesisStep) {
          currentPlan = synthesisStep.outputText;
          currentHandoffText = synthesisStep.handoffText;
          currentHandoffData = synthesisStep.handoffData;
        }
      }
    }

    return {
      qualityLoops: totalLoops,
      initialOutput: currentPlan,
      initialHandoffText: currentHandoffText,
      initialHandoffData: currentHandoffData,
      finalOutput: currentPlan,
      finalHandoffText: currentHandoffText,
      finalHandoffData: currentHandoffData,
      feedbackEntries: []
    };
  }

  // Loop engine for implement mode - reusable for both standalone and one-shot unit execution
  // Contract:
  // - initialImplementNeeded: true → run initial implement once, then loopCount review/repair cycles
  // - initialImplementNeeded: false → requires seeded currentImplementation, then loopCount review/repair cycles
  // - Final output is from the last repair step, not the last review step
  // - Failure in any phase stops immediately and returns failure metadata
  async runImplementLoopSequence({
    config,
    run,
    loopCount,
    initialImplementNeeded,
    effectiveAgents = null,
    implementationPlan,
    unitContext = null,
    completedUnitsSummary = null,
    originalPrompt = null,
    customImplementPrompt = null,
    currentImplementation = null,
    currentImplementationHandoffText = null,
    currentImplementationHandoffData = null,
    implementHandoffSchema = 'implement'
  }) {
    const agents = effectiveAgents || config.agents;
    const defaultOriginAgent = agents[0];
    const originAgent = getAgentForPhase(config, 'implement', defaultOriginAgent);
    const reviewers = agents.filter((agentName) => agentName !== originAgent);
    const originAgentPolicy = config.settings.agentPolicies && config.settings.agentPolicies[originAgent];
    const implementExecutionPolicy = {
      canWrite: Boolean(originAgentPolicy && originAgentPolicy.canWrite)
    };
    const reviewerExecutionPolicy = { canWrite: false };

    // Phase tracking for failure metadata
    let currentLoop = 0;
    let currentPhase = null;

    // Track initial implement output separately from final (repaired) output.
    // For resumed runs, the seeded implementation is the initial state.
    let initialOutput = currentImplementation;
    let initialHandoffText = currentImplementationHandoffText;
    let initialHandoffData = currentImplementationHandoffData;
    let lastFeedbackEntries = [];

    try {
      // Validate seeded state when initialImplementNeeded is false
      if (!initialImplementNeeded && currentImplementation === null) {
        throw new Error('runImplementLoopSequence requires currentImplementation when initialImplementNeeded is false.');
      }

      // Build unit context block for prompts
      const unitContextBlock = unitContext ? {
        id: unitContext.id,
        title: unitContext.title,
        unitKind: unitContext.unit_kind || unitContext.unitKind,
        completedUnitsSummary: completedUnitsSummary
      } : null;

      // Initial implement phase (runs once if initialImplementNeeded)
      if (initialImplementNeeded) {
        currentLoop = 1;
        currentPhase = 'implement';

        const implementContextPack = await this.getPromptContextForPhase(config, 'implement', {
          agentName: originAgent,
          run,
          delivery: resolveContextDelivery(config, 'implementInitial'),
          stageKey: 'implementInitial'
        });
        const implementStep = await this.runStep({
          run,
          config,
          stage: 'implement',
          agent: originAgent,
          prompt: buildImplementPrompt(implementationPlan, {
            canWrite: implementExecutionPolicy.canWrite,
            originalPrompt,
            unitContext: unitContextBlock,
            customImplementPrompt,
            handoffSchema: implementHandoffSchema,
            contextPack: implementContextPack
          }),
          cycleNumber: currentLoop,
          mode: 'implement',
          executionPolicy: implementExecutionPolicy,
          handoffSchema: implementHandoffSchema
        });

        this.assertStepSucceeded(implementStep, config);

        // Capture initial implement output separately
        initialOutput = implementStep.outputText;
        initialHandoffText = implementStep.handoffText;
        initialHandoffData = implementStep.handoffData;

        currentImplementation = implementStep.outputText;
        currentImplementationHandoffText = implementStep.handoffText;
        currentImplementationHandoffData = implementStep.handoffData;

        // Check for BLOCKED or NEEDS_CONTEXT status
        if (implementStep.handoffData && implementStep.handoffData.status) {
          const { status, summary } = implementStep.handoffData;
          if (status === 'BLOCKED' || status === 'NEEDS_CONTEXT') {
            logOrchestratorInfo(`Implementer reported ${status}: ${summary || '(no details)'}`);
          }
        }
      }

      // Run review/repair loops: always loopCount iterations regardless of initialImplementNeeded
      for (currentLoop = 1; currentLoop <= loopCount; currentLoop += 1) {
        // Review phase
        currentPhase = 'review';

        // Run reviewers sequentially. Fall back to self-review when only one agent is configured.
        const effectiveReviewers = getReviewAgents(config, originAgent, reviewers);
        const feedbackEntries = [];

        for (const reviewer of effectiveReviewers) {
          const reviewDeliveryDecision = getContextDeliveryDecision(config, 'implementReview', currentLoop);
          const reviewContextPack = await this.getPromptContextForPhase(config, 'review', {
            agentName: reviewer,
            run,
            delivery: reviewDeliveryDecision.delivery,
            stageKey: 'implementReview',
            downgradedFrom: reviewDeliveryDecision.downgradedFrom,
            cycleNumber: currentLoop
          });
          const reviewPrompt = buildImplementReviewPrompt({
            implementationPlan,
            initialImplementation: currentImplementation,
            feedbackEntries,
            canWrite: false,
            originalPrompt,
            unitContext: unitContextBlock,
            contextPack: reviewContextPack
          });

          const reviewStep = await this.runStep({
            run,
            config,
            stage: 'implement-review',
            agent: reviewer,
            prompt: reviewPrompt,
            cycleNumber: currentLoop,
            mode: 'implement',
            executionPolicy: reviewerExecutionPolicy,
            handoffSchema: 'prose' // no schema — reviewers produce prose
          });

          feedbackEntries.push({
            agent: reviewStep.agent,
            text: reviewStep.outputText,
            outputText: reviewStep.outputText,
            handoffData: reviewStep.handoffData || null,
            ok: reviewStep.ok
          });

          this.assertStepSucceeded(reviewStep, config);
        }

        lastFeedbackEntries = feedbackEntries;

        // Repair phase
        currentPhase = 'repair';

        const repairContextPack = await this.getPromptContextForPhase(config, 'implement', {
          agentName: originAgent,
          run,
          delivery: resolveContextDelivery(config, 'implementRepair'),
          stageKey: 'implementRepair'
        });
        const repairPrompt = buildImplementRepairPrompt({
          implementationPlan,
          initialImplementation: currentImplementation,
          feedbackEntries,
          canWrite: implementExecutionPolicy.canWrite,
          originalPrompt,
          unitContext: unitContextBlock,
          customImplementPrompt,
          handoffSchema: implementHandoffSchema,
          contextPack: repairContextPack
        });

        const repairStep = await this.runStep({
          run,
          config,
          stage: 'implement-repair',
          agent: originAgent,
          prompt: repairPrompt,
          cycleNumber: currentLoop,
          mode: 'implement',
          executionPolicy: implementExecutionPolicy,
          handoffSchema: implementHandoffSchema
        });

        this.assertStepSucceeded(repairStep, config);

        currentImplementation = repairStep.outputText;
        currentImplementationHandoffText = repairStep.handoffText;
        currentImplementationHandoffData = repairStep.handoffData;
      }

      return {
        initialOutput,
        initialHandoffText,
        initialHandoffData,
        finalOutput: currentImplementation,
        finalHandoffText: currentImplementationHandoffText,
        finalHandoffData: currentImplementationHandoffData,
        feedbackEntries: lastFeedbackEntries,
        failure: null
      };

    } catch (error) {
      return {
        initialOutput,
        initialHandoffText,
        initialHandoffData,
        finalOutput: currentImplementation,
        finalHandoffText: currentImplementationHandoffText,
        finalHandoffData: currentImplementationHandoffData,
        feedbackEntries: lastFeedbackEntries,
        failure: {
          loopNumber: currentLoop,
          phase: currentPhase,
          error: error.message,
          stack: error.stack
        }
      };
    }
  }

  // Standalone implement mode - wraps the loop engine for the entire task
  async runIterativeImplementMode(config, run) {
    const loopCount = config.settings.implementLoops;

    const result = await this.runImplementLoopSequence({
      config,
      run,
      loopCount,
      initialImplementNeeded: true,
      implementationPlan: config.prompt,
      unitContext: null,
      completedUnitsSummary: null,
      originalPrompt: config.prompt,
      customImplementPrompt: config.customImplementPrompt || null,
      currentImplementation: null,
      currentImplementationHandoffText: null,
      currentImplementationHandoffData: null,
      implementHandoffSchema: 'implement'
    });

    // If there was a failure, throw to stop the run
    if (result.failure) {
      const { loopNumber, phase, error } = result.failure;
      throw new Error(`Implement mode failed at loop ${loopNumber}, phase ${phase}: ${error}`);
    }

    return {
      implementLoops: loopCount,
      initialOutput: result.initialOutput,
      initialHandoffText: result.initialHandoffText,
      initialHandoffData: result.initialHandoffData,
      finalOutput: result.finalOutput,
      finalHandoffText: result.finalHandoffText,
      finalHandoffData: result.finalHandoffData,
      feedbackEntries: result.feedbackEntries
    };
  }

  async runCollaborativeMode({ mode, prompt, config, run, cycleNumber = null, effectiveAgents, modeBuilderOptions = {} }) {
    const modeBuilders = getModePromptBuilders(mode, modeBuilderOptions);
    const useStructuredHandoff = modeUsesStructuredHandoff(mode);
    const agents = effectiveAgents || config.agents;
    const defaultOriginAgent = agents[0];
    const originAgent = getAgentForPhase(config, mode, defaultOriginAgent);
    const reviewers = agents.filter((agentName) => agentName !== originAgent);
    const originAgentPolicy = config.settings.agentPolicies && config.settings.agentPolicies[originAgent];
    const originExecutionPolicy = {
      canWrite: mode === 'implement' && Boolean(originAgentPolicy && originAgentPolicy.canWrite)
    };
    const initialContextPack = await this.getPromptContextForPhase(config, mode, {
      agentName: originAgent,
      run,
      delivery: resolveContextDelivery(config, 'reviewInitial'),
      stageKey: 'reviewInitial'
    });
    const initialStep = await this.runStep({
      run,
      config,
      stage: modeBuilders.initialStage,
      agent: originAgent,
      prompt: modeBuilders.buildInitialPrompt(prompt, {
        executionPolicy: originExecutionPolicy,
        contextPack: initialContextPack
      }),
      cycleNumber,
      mode,
      executionPolicy: originExecutionPolicy,
      handoffSchema: modeBuilders.initialHandoffSchema
    });

    this.assertStepSucceeded(initialStep, config);
    this.assertUsablePlannerOutput(initialStep, config, mode);

    const initialOutput = initialStep.outputText;
    // implement mode: reviewers need to full prose output, not the status JSON blob.
    // For all other structured-handoff modes (plan, review), handoffText is the right artifact.
    const initialArtifact = (useStructuredHandoff && mode !== 'implement')
      ? initialStep.handoffText
      : initialStep.outputText;

    if (mode === 'implement' && initialStep.handoffData && initialStep.handoffData.status) {
      const { status, summary } = initialStep.handoffData;
      if (status === 'BLOCKED' || status === 'NEEDS_CONTEXT') {
        logOrchestratorInfo(`Implementer reported ${status}: ${summary || '(no details)'}`);
      }
    }
    const feedbackEntries = [];

    if (modeBuilders.parallelReviews) {
      const reviewerReadOnly = { canWrite: false };
      const reviewerAgents = getReviewAgents(config, originAgent, reviewers);
      const reviewerContexts = reviewerAgents.map((reviewer) => ({
        reviewer,
        executionPolicy: reviewerReadOnly
      }));

      const useRoleSplit = modeBuilders.specializedParallelReviews && reviewerContexts.length >= 2;

      const reviewSteps = await Promise.all(reviewerContexts.map(async ({ reviewer, executionPolicy }, index) => {
        let stage;
        let reviewPrompt;

        if (useRoleSplit) {
          // Reviewer 0 → spec compliance; all others → code quality
          const isSpecReviewer = index === 0;
          stage = isSpecReviewer ? modeBuilders.specComplianceStage : modeBuilders.codeQualityStage;
          const buildFn = isSpecReviewer
            ? modeBuilders.buildSpecCompliancePrompt
            : modeBuilders.buildCodeQualityPrompt;
          const reviewDeliveryDecision = getContextDeliveryDecision(config, 'reviewParallel', cycleNumber);
          const reviewContextPack = await this.getPromptContextForPhase(config, mode, {
            agentName: reviewer,
            run,
            delivery: reviewDeliveryDecision.delivery,
            stageKey: 'reviewParallel',
            downgradedFrom: reviewDeliveryDecision.downgradedFrom,
            cycleNumber
          });
          reviewPrompt = buildFn({ prompt, initialOutput: initialArtifact, executionPolicy, context: { contextPack: reviewContextPack } });
        } else {
          stage = modeBuilders.reviewStage;
          const reviewDeliveryDecision = getContextDeliveryDecision(config, 'reviewParallel', cycleNumber);
          const reviewContextPack = await this.getPromptContextForPhase(config, mode, {
            agentName: reviewer,
            run,
            delivery: reviewDeliveryDecision.delivery,
            stageKey: 'reviewParallel',
            downgradedFrom: reviewDeliveryDecision.downgradedFrom,
            cycleNumber
          });
          reviewPrompt = modeBuilders.buildReviewPrompt({
            prompt,
            initialOutput: initialArtifact,
            feedbackEntries,
            executionPolicy,
            context: { contextPack: reviewContextPack }
          });
        }

        return this.runStep({
          run,
          config,
          stage,
          agent: reviewer,
          prompt: reviewPrompt,
          cycleNumber,
          mode,
          executionPolicy,
          handoffSchema: modeBuilders.reviewHandoffSchema
        });
      }));

      for (const reviewStep of reviewSteps) {
        feedbackEntries.push({
          agent: reviewStep.agent,
          text: (useStructuredHandoff && mode !== 'implement') ? reviewStep.handoffText : reviewStep.outputText,
          outputText: reviewStep.outputText,
          handoffData: reviewStep.handoffData || null,
          ok: reviewStep.ok
        });

        this.assertStepSucceeded(reviewStep, config);
      }
    } else {
      // Fall back to self-review when no other agents are configured.
      const effectiveReviewers = getReviewAgents(config, originAgent, reviewers);
      for (const reviewer of effectiveReviewers) {
        const reviewerExecutionPolicy = { canWrite: false };
        const reviewDeliveryDecision = getContextDeliveryDecision(config, 'reviewParallel', cycleNumber);
        const reviewContextPack = await this.getPromptContextForPhase(config, mode, {
          agentName: reviewer,
          run,
          delivery: reviewDeliveryDecision.delivery,
          stageKey: 'reviewParallel',
          downgradedFrom: reviewDeliveryDecision.downgradedFrom,
          cycleNumber
        });
        const reviewStep = await this.runStep({
          run,
          config,
          stage: modeBuilders.reviewStage,
          agent: reviewer,
          prompt: modeBuilders.buildReviewPrompt({
            prompt,
            initialOutput: initialArtifact,
            feedbackEntries,
            executionPolicy: reviewerExecutionPolicy,
            context: { contextPack: reviewContextPack }
          }),
          cycleNumber,
          mode,
          executionPolicy: reviewerExecutionPolicy,
          handoffSchema: modeBuilders.reviewHandoffSchema
        });

        feedbackEntries.push({
          agent: reviewer,
          text: (useStructuredHandoff && mode !== 'implement') ? reviewStep.handoffText : reviewStep.outputText,
          outputText: reviewStep.outputText,
          handoffData: reviewStep.handoffData || null,
          ok: reviewStep.ok
        });

        this.assertStepSucceeded(reviewStep, config);
      }
    }

    if (feedbackEntries.length === 0) {
      return {
        initialOutput,
        initialHandoffText: initialStep.handoffText,
        initialHandoffData: initialStep.handoffData || null,
        finalOutput: initialOutput,
        finalHandoffText: initialStep.handoffText,
        finalHandoffData: initialStep.handoffData || null,
        feedbackEntries
      };
    }

    const synthesisExecutionPolicy = {
      canWrite: mode === 'implement' && Boolean(originAgentPolicy && originAgentPolicy.canWrite)
    };
    const synthesisContextPack = await this.getPromptContextForPhase(config, mode, {
      agentName: originAgent,
      run,
      delivery: resolveContextDelivery(config, 'reviewSynthesis'),
      stageKey: 'reviewSynthesis'
    });
    const synthesisStep = await this.runStep({
      run,
      config,
      stage: modeBuilders.finalStage,
      agent: originAgent,
      prompt: modeBuilders.buildFinalPrompt({
        prompt,
        initialOutput: initialArtifact,
        feedbackEntries,
        executionPolicy: synthesisExecutionPolicy,
        context: { contextPack: synthesisContextPack }
      }),
      cycleNumber,
      mode,
      executionPolicy: synthesisExecutionPolicy,
      handoffSchema: modeBuilders.finalHandoffSchema
    });

    this.assertStepSucceeded(synthesisStep, config);

    return {
      initialOutput,
      initialHandoffText: initialStep.handoffText,
      initialHandoffData: initialStep.handoffData || null,
      finalOutput: synthesisStep.outputText,
      finalHandoffText: synthesisStep.handoffText,
      finalHandoffData: synthesisStep.handoffData || null,
      feedbackEntries
    };
  }

  // One-shot unit-by-unit implement: executes plan units in strict order,
  // each with its own review/repair loop count. State carries forward
  // between units (repository/content is cumulative). Failure in any unit stops.
  async runOneShotUnitImplement({ config, run, handoffData, renderedPlanText, effectiveAgents }) {
    // Fail fast if structured units are unavailable
    if (!handoffData || typeof handoffData !== 'object') {
      throw new Error('One-shot implement stage requires plan handoff data, but none was provided.');
    }
    if (!handoffData.unit_kind || typeof handoffData.unit_kind !== 'string') {
      throw new Error('One-shot implement stage requires unit_kind in plan handoff data.');
    }
    if (!Array.isArray(handoffData.units) || handoffData.units.length === 0) {
      throw new Error('One-shot implement stage requires non-empty units array in plan handoff data.');
    }

    const units = handoffData.units;
    const loopCount = config.settings.sectionImplementLoops;

    // Track state across units
    const completedUnits = [];
    const completedUnitResults = [];

    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i];

      // Build completed units summary for context
      const completedUnitsSummary = completedUnits.length > 0
        ? completedUnits.map((u, idx) => `${idx + 1}. ${u.id}: ${u.title}`).join('\n')
        : 'None (this is first unit)';

      // Build unit context block for prompts
      const unitContext = {
        id: unit.id,
        title: unit.title,
        unitKind: handoffData.unit_kind
      };

      try {
        // Each unit starts with a fresh implementation loop
        // Note: initialImplementNeeded is always true for each unit because
        // each unit represents new work to be implemented, not a continuation
        // of the previous unit's loop sequence.
        const unitResult = await this.runImplementLoopSequence({
          config,
          run,
          loopCount,
          initialImplementNeeded: true,
          effectiveAgents,
          implementationPlan: renderedPlanText,
          unitContext,
          completedUnitsSummary,
          originalPrompt: config.prompt,
          customImplementPrompt: config.customImplementPrompt || null,
          currentImplementation: null,
          currentImplementationHandoffText: null,
          currentImplementationHandoffData: null,
          implementHandoffSchema: 'implement-unit'
        });

        if (unitResult.failure) {
          throw new Error(
            `One-shot implement failed at unit ${unit.id} (${unit.title}), ` +
            `loop ${unitResult.failure.loopNumber}, phase ${unitResult.failure.phase}: ${unitResult.failure.error}`
          );
        }

        // Track this unit as completed for the next unit's context
        completedUnits.push(unit);
        completedUnitResults.push({
          id: unit.id,
          title: unit.title,
          unit_kind: handoffData.unit_kind,
          output: unitResult.finalOutput || '',
          handoffText: unitResult.finalHandoffText || '',
          handoffData: unitResult.finalHandoffData || null
        });

      } catch (error) {
        // Re-throw the inner error directly — the inner throw already produced
        // the full message with unit id, title, loop number, phase, and error.
        throw error;
      }
    }

    const finalOutput = renderOneShotUnitResultSummary(completedUnitResults);
    const finalHandoffText = finalOutput;
    const nonDoneStatus = completedUnitResults
      .map((entry) => entry.handoffData && entry.handoffData.status)
      .find((status) => status && status !== 'DONE');
    const finalHandoffData = {
      status: nonDoneStatus || 'DONE',
      summary: `Completed ${completedUnitResults.length} ${handoffData.unit_kind} unit(s).`,
      unit_kind: handoffData.unit_kind,
      units: completedUnitResults
    };

    return {
      finalOutput,
      finalHandoffText,
      finalHandoffData
    };
  }

  async runOneShotMode(config, run) {
    if (!config.useCase) {
      throw new Error('One-shot mode requires "useCase" so the plan stage can produce structured units for unit-by-unit implement.');
    }

    const cycles = [];
    let currentPlanHandoffData = null;
    let currentPlanRendered = null;
    let currentImplementation = null;
    let currentImplementationHandoff = null;
    const reviewHistory = [];

    for (let cycleNumber = 1; cycleNumber <= config.settings.qualityLoops; cycleNumber += 1) {
      const planAgents = getEffectiveAgentsForMode(config, 'plan');
      const implementAgents = getEffectiveAgentsForMode(config, 'implement');

      const planPrompt = cycleNumber === 1
        ? config.prompt
        : buildOneShotReplanPrompt({
            originalPrompt: config.prompt,
            priorPlan: currentPlanRendered,
            implementationSummary: currentImplementation,
            reviewSummary: summarizeReviewHistory(reviewHistory),
            cycleNumber,
            totalCycles: config.settings.qualityLoops
          });

      let planResult = null;
      let currentPlanPrompt = planPrompt;
      for (let planLoopNumber = 1; planLoopNumber <= config.settings.planLoops; planLoopNumber += 1) {
        planResult = await this.runCollaborativeMode({
          mode: 'plan',
          prompt: currentPlanPrompt,
          config,
          run,
          cycleNumber,
          effectiveAgents: planAgents,
          modeBuilderOptions: {
            useCase: config.useCase || null
          }
        });

        currentPlanPrompt = planResult.finalOutput
          || renderHandoffForHumans(planResult.finalHandoffData)
          || planResult.finalHandoffText
          || currentPlanPrompt;
      }

      // Retain structured handoff data as source of truth
      currentPlanHandoffData = planResult.finalHandoffData || null;
      // Keep rendered plan text as supplemental context only
      currentPlanRendered = planResult.finalOutput
        || renderHandoffForHumans(planResult.finalHandoffData)
        || planResult.finalHandoffText
        || '';

      // One-shot implement: consume structured plan handoff data directly
      const implementResult = await this.runOneShotUnitImplement({
        config,
        run,
        handoffData: currentPlanHandoffData,
        renderedPlanText: currentPlanRendered,
        effectiveAgents: implementAgents
      });

      currentImplementation = implementResult.finalOutput;
      currentImplementationHandoff = implementResult.finalHandoffText || implementResult.finalOutput;

      const cycleRecord = {
        cycleNumber,
        planOutput: planResult.finalOutput,
        planHandoff: planResult.finalHandoffText || null,
        implementOutput: currentImplementation,
        implementHandoff: currentImplementationHandoff,
        reviewOutput: null
      };

      if (cycleNumber < config.settings.qualityLoops) {
        const reviewAgents = getEffectiveAgentsForMode(config, 'review');
        const reviewResult = await this.runCollaborativeMode({
          mode: 'review',
          prompt: buildOneShotReviewRequest({
            originalPrompt: config.prompt,
            currentPlan: currentPlanRendered,
            implementationSummary: currentImplementation,
            cycleNumber,
            totalCycles: config.settings.qualityLoops
          }),
          config,
          run,
          cycleNumber,
          effectiveAgents: reviewAgents
        });

        const reviewHistoryEntry = {
          cycleNumber,
          handoffData: reviewResult.finalHandoffData || null,
          handoffText: reviewResult.finalHandoffText || reviewResult.finalOutput
        };

        reviewHistory.push(reviewHistoryEntry);

        // Architecture escape hatch: advisory warning when same findings keep recurring.
        // Intentionally coarse (50-char prefix key) — do not overbuild this.
        if (reviewHistory.length >= 3) {
          const recentEntries = reviewHistory.slice(-3);
          const findingCounts = {};
          for (const entry of recentEntries) {
            for (const key of extractReviewFindingKeys(entry)) {
              findingCounts[key] = (findingCounts[key] || 0) + 1;
            }
          }
          const repeatedFindings = Object.keys(findingCounts).filter((k) => findingCounts[k] >= 2);
          if (repeatedFindings.length > 0) {
            logOrchestratorWarning(
              'Repeated findings detected across the last 3 review cycles. This may indicate an architectural problem rather than an implementation bug.'
            );
          }
        }

        cycleRecord.reviewOutput = reviewResult.finalOutput;
        cycleRecord.reviewHandoff = reviewHistoryEntry.handoffText;
      }

      cycles.push(cycleRecord);
    }

    return {
      qualityLoops: config.settings.qualityLoops,
      cycles,
      finalOutput: currentImplementation,
      finalHandoffText: currentImplementationHandoff
    };
  }

  async runStep({
    run,
    config,
    stage,
    agent,
    prompt,
    cycleNumber = null,
    mode,
    executionPolicy,
    handoffSchema,
    allowRoleFallback = true,
    fallbackFromRole = null,
    primaryFailureSummary = null
  }) {
    const resolvedHandoffSchema = handoffSchema || mode;
    const stepStartedAt = new Date().toISOString();
    const stepIndex = Number.isInteger(run.nextStepIndex) && run.nextStepIndex >= 0
      ? run.nextStepIndex + 1
      : run.steps.length + 1;
    const stepId = `${stage}-${stepIndex}`;
    run.nextStepIndex = stepIndex;
    const stepCanWrite = Boolean(executionPolicy && executionPolicy.canWrite);
    const writeLabel = stepCanWrite ? ' (write-enabled)' : '';
    console.log(`Running ${agent} for ${stage}${writeLabel}`);

    const preStepSnapshot = stepCanWrite
      ? await this.captureAndPersistWorktreeSnapshot({
        run,
        scope: 'pre-step',
        step: {
          id: stepId,
          stage,
          agent,
          canWrite: true
        },
        cycleNumber
      })
      : null;

    const promptReadyAt = Date.now();
    const agentOpts = config.settings.agentOptions && config.settings.agentOptions[agent];
    const providerConfig = getProviderConfig(config, agent);
    let result;
    if (providerConfig) {
      result = await runHttpProvider(providerConfig, prompt);
      await this.writeArtifactSafe(
        run.runId,
        buildProviderExecutionArtifact({
          runId: run.runId,
          artifactId: this.nextArtifactId('provider-execution'),
          providerId: providerConfig.id || agent,
          providerConfig,
          promptText: prompt,
          result
        }),
        'provider-execution'
      );
    } else {
      result = await runAgent(agent, {
        prompt,
        cwd: config.settings.cwd,
        timeoutMs: config.settings.timeoutMs,
        canWrite: Boolean(executionPolicy && executionPolicy.canWrite),
        mode,
        model: (agentOpts && agentOpts.model) || null,
        effort: (agentOpts && agentOpts.effort) || null,
        agentOptions: agentOpts || {}
      });
    }

    const agentFinishedAt = Date.now();

    const handoff = extractHandoff(
      resolvedHandoffSchema,
      result.outputText,
      mode === 'plan' ? { useCase: config.useCase || null } : {}
    );
    const parseFinishedAt = Date.now();

    const stepWarnings = Array.isArray(result.warnings) ? [...result.warnings] : [];
    if (fallbackFromRole) {
      stepWarnings.push(`Role fallback executed from ${fallbackFromRole} to ${agent}`);
      if (primaryFailureSummary) {
        stepWarnings.push(`Primary attempt summary: ${primaryFailureSummary}`);
      }
    }

    const stepFinishedAt = new Date().toISOString();
    const timing = {
      agentMs: agentFinishedAt - promptReadyAt,
      parseMs: parseFinishedAt - agentFinishedAt,
      totalMs: parseFinishedAt - promptReadyAt
    };
    const step = {
      id: stepId,
      stage,
      agent,
      ok: result.ok,
      startedAt: stepStartedAt,
      finishedAt: stepFinishedAt,
      durationMs: Date.parse(stepFinishedAt) - Date.parse(stepStartedAt),
      exitCode: result.exitCode ?? null,
      signal: result.signal || null,
      timedOut: Boolean(result.timedOut || result?.error?.type === 'timeout'),
      command: result.command,
      outputText: handoff.proseText,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error || null,
      usedFallback: result.usedFallback || false,
      fallbackTier: result.fallbackTier || 0,
      fallbackReason: result.fallbackReason || null,
      fatalOutputReason: result.fatalOutputReason || null,
      initialAttempt: result.initialAttempt || null,
      handoffData: handoff.handoffData,
      handoffText: handoff.handoffText,
      handoffParseError: handoff.handoffParseError,
      canWrite: stepCanWrite,
      cycleNumber,
      timing,
      warnings: stepWarnings,
      capabilityDowngrades: result.capabilityDowngrades || null,
      fallbackFromRole
    };

    let fallbackAgent = null;
    if (!result.ok && allowRoleFallback) {
      fallbackAgent = getRoleAssignment(config, 'fallback');
      if (fallbackAgent && fallbackAgent !== agent) {
        const fallbackBlockReason = getRoleFallbackBlockReason(config, fallbackAgent, executionPolicy);
        if (fallbackBlockReason) {
          step.warnings = [
            ...(step.warnings || []),
            `Role fallback not scheduled from ${agent} to ${fallbackAgent}: ${fallbackBlockReason}`
          ];
          fallbackAgent = null;
        } else {
          step.warnings = [
            ...(step.warnings || []),
            `Role fallback scheduled from ${agent} to ${fallbackAgent}`
          ];
        }
      } else {
        fallbackAgent = null;
      }
    }

    run.steps.push(step);
    let worktreeAfterSnapshot = null;
    if (step.canWrite) {
      worktreeAfterSnapshot = await this.captureAndPersistWorktreeSnapshot({
        run,
        scope: 'post-step',
        step,
        cycleNumber: step.cycleNumber
      });
      step.worktreeBeforeSnapshot = preStepSnapshot;
      step.worktreeAfterSnapshot = worktreeAfterSnapshot;
    }

    try {
      await this.collaborationStore.appendStep(run.runId, {
        id: step.id,
        stage: step.stage,
        agent: step.agent,
        ok: step.ok,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        durationMs: step.durationMs,
        exitCode: step.exitCode,
        signal: step.signal,
        timedOut: step.timedOut,
        usedFallback: step.usedFallback,
        fallbackTier: step.fallbackTier,
        fallbackReason: step.fallbackReason,
        fatalOutputReason: step.fatalOutputReason,
        canWrite: step.canWrite,
        cycleNumber: step.cycleNumber,
        handoffParseError: step.handoffParseError || null,
        handoffData: step.handoffData || null,
        timing: step.timing || null,
        warnings: step.warnings || [],
        capabilityDowngrades: step.capabilityDowngrades || null,
        fallbackFromRole: step.fallbackFromRole || null,
        worktreeBeforeSnapshotArtifactId: preStepSnapshot ? preStepSnapshot.artifactId : null,
        worktreeBeforeSnapshotPatchFile: preStepSnapshot ? preStepSnapshot.patchFile || null : null,
        worktreeBeforeSnapshotStagedPatchFile: preStepSnapshot ? preStepSnapshot.stagedPatchFile || null : null,
        worktreeBeforeSnapshotDirty: preStepSnapshot ? Boolean(preStepSnapshot.dirty) : null,
        worktreeAfterSnapshotArtifactId: worktreeAfterSnapshot ? worktreeAfterSnapshot.artifactId : null,
        worktreeAfterSnapshotPatchFile: worktreeAfterSnapshot ? worktreeAfterSnapshot.patchFile || null : null,
        worktreeAfterSnapshotStagedPatchFile: worktreeAfterSnapshot ? worktreeAfterSnapshot.stagedPatchFile || null : null,
        worktreeAfterSnapshotDirty: worktreeAfterSnapshot ? Boolean(worktreeAfterSnapshot.dirty) : null
      });
    } catch (error) {
      console.error('Warning: failed to append v2 step record:', error.message);
    }

    if (config.settings.writeScratchpad) {
      try {
        await fs.writeFile(this.scratchpadFile, this.renderScratchpad(run), 'utf8');
      } catch (scratchpadError) {
        console.error('Warning: failed to write intermediate scratchpad:', scratchpadError.message);
      }
    }

    if (fallbackAgent) {
      logOrchestratorWarning(`Stage ${stage} failed on ${agent}; retrying once with roles.fallback=${fallbackAgent}.`);
      return this.runStep({
        run,
        config,
        stage,
        agent: fallbackAgent,
        prompt,
        cycleNumber,
        mode,
        executionPolicy,
        handoffSchema,
        allowRoleFallback: false,
        fallbackFromRole: agent,
        primaryFailureSummary: `${agent} ${describeStepFailure(step)}`
      });
    }

    // Write a structured review artifact for any step that produced review-schema handoff data.
    // The trigger is the handoff schema itself, not stage naming conventions.
    // Non-fatal: errors are logged and do not affect orchestration flow.
    if (step.handoffData && resolvedHandoffSchema === 'review') {
      try {
        const reviewArtifact = buildReviewArtifact({ runId: run.runId, step });
        await this.collaborationStore.writeArtifact(run.runId, reviewArtifact);
      } catch (error) {
        console.error('Warning: failed to write review artifact:', error.message);
      }
    }

    return step;
  }

  assertStepSucceeded(step, config) {
    if (step.ok || config.settings.continueOnError) {
      return;
    }

    let detail = describeStepFailure(step).replace(/^failed /, '');
    const primaryAttemptWarning = Array.isArray(step.warnings)
      ? step.warnings.find((warning) => /^Primary attempt summary: /i.test(warning))
      : null;
    if (primaryAttemptWarning) {
      detail += `; ${primaryAttemptWarning}`;
    }

    let outputPreview = '';
    if (step.outputText) {
      // Strip ANSI codes so we don't accidentally print invisible "\x1b[0m" as first line
      const cleanOutput = step.outputText.replace(/\x1B\[\d+m/g, '');
      const outputLines = cleanOutput.split(/\r?\n/).filter(line => line.trim().length > 0);
      if (outputLines.length > 0) {
        outputPreview = `\nOutput: ${outputLines[0]}`;
      }
    }

    const reason = `${step.agent} failed during ${step.stage} ${detail}${outputPreview}`;
    throw new Error(reason);
  }

  assertUsablePlannerOutput(step, config, mode) {
    if (!step.ok) {
      return;
    }

    if (!modeUsesStructuredHandoff(mode)) {
      return;
    }

    if (step.outputText || step.handoffData) {
      return;
    }

    const message = `${step.agent} completed ${step.stage} with no usable output (exit ${step.exitCode}, empty prose and no structured handoff)`;
    if (config.settings.continueOnError) {
      console.error(`Warning: ${message}`);
      return;
    }

    throw new Error(message);
  }

  createRun(config) {
    const startedAt = this.preassignedStartedAt || new Date().toISOString();
    return {
      runId: this.preassignedRunId || `run-${startedAt.replace(/[:.]/g, '-')}`,
      mode: config.mode,
      prompt: config.prompt,
      fork: config.fork || null,
      agents: config.agents,
      nextStepIndex: 0,
      settings: config.settings,
      startedAt,
      finishedAt: null,
      durationMs: null,
      status: 'running',
      steps: [],
      worktreeSnapshots: [],
      forkRecord: null,
      auditWarnings: [],
      result: null,
      error: null
    };
  }

  renderScratchpad(run) {
    const lines = [
      `Run ID: ${run.runId}`,
      `Status: ${run.status}`,
      `Mode: ${run.mode}`,
      `Agents: ${run.agents.join(' -> ')}`,
      '',
      'Original Prompt:',
      run.prompt,
      ''
    ];

    if (run.forkRecord) {
      lines.push('## FORK LINEAGE');
      lines.push(`Artifact: ${run.forkRecord.artifactId}`);
      lines.push(`Forked From Run: ${run.forkRecord.forkedFromRunId}`);
      if (run.forkRecord.forkedFromStepId) {
        lines.push(`Forked From Step: ${run.forkRecord.forkedFromStepId}`);
      }
      if (run.forkRecord.baseCommit) {
        lines.push(`Base Commit: ${run.forkRecord.baseCommit}`);
      }
      if (run.forkRecord.reason) {
        lines.push(`Reason: ${run.forkRecord.reason}`);
      }
      lines.push(`Recorded By: ${run.forkRecord.recordedBy || 'manual'}`);
      lines.push('');
    }

    if (Array.isArray(run.auditWarnings) && run.auditWarnings.length > 0) {
      lines.push('## AUDIT WARNINGS');
      for (const warning of run.auditWarnings) {
        lines.push(`- ${warning}`);
      }
      lines.push('');
    }

    if (Array.isArray(run.worktreeSnapshots) && run.worktreeSnapshots.length > 0) {
      lines.push('## WORKTREE SNAPSHOTS');
      for (const snapshot of run.worktreeSnapshots) {
        const parts = [
          `Scope: ${snapshot.scope || 'unknown'}`,
          `Captured: ${snapshot.capturedAt || 'unknown'}`,
          `Dirty: ${snapshot.dirty ? 'yes' : 'no'}`
        ];
        if (snapshot.stepId) {
          parts.push(`Step: ${snapshot.stepId}`);
        }
        if (snapshot.stage) {
          parts.push(`Stage: ${snapshot.stage}`);
        }
        if (snapshot.agent) {
          parts.push(`Agent: ${snapshot.agent}`);
        }
        if (snapshot.cycleNumber !== null && snapshot.cycleNumber !== undefined) {
          parts.push(`Cycle: ${snapshot.cycleNumber}`);
        }
        if (snapshot.patchFile) {
          parts.push(`Patch: ${snapshot.patchFile}`);
        }
        if (snapshot.stagedPatchFile) {
          parts.push(`Staged Patch: ${snapshot.stagedPatchFile}`);
        }
        lines.push(parts.join(' | '));
      }
      lines.push('');
    }

    let lastCycleNumber = null;
    for (const step of run.steps) {
      if (step.cycleNumber !== null && step.cycleNumber !== lastCycleNumber) {
        lines.push(`=== CYCLE ${step.cycleNumber} ===`);
        lines.push('');
        lastCycleNumber = step.cycleNumber;
      }

      lines.push(`## ${step.stage.toUpperCase()} | ${step.agent}`);
      lines.push(`Status: ${step.ok ? 'ok' : 'failed'}`);
      lines.push(`Duration: ${step.durationMs}ms`);
      if (step.timing) {
        lines.push(`Timing: agent ${step.timing.agentMs}ms, parse ${step.timing.parseMs}ms, total ${step.timing.totalMs}ms`);
      }
      lines.push(`Exit Code: ${step.exitCode === null ? 'n/a' : step.exitCode}`);
      if (step.signal) {
        lines.push(`Signal: ${step.signal}`);
      }
      if (step.timedOut) {
        lines.push('Timed Out: yes');
      }
      if (step.canWrite) {
        lines.push('Write Access: enabled');
      }
      if (step.handoffData) {
        lines.push('Handoff: structured');
      } else if (step.handoffParseError) {
        lines.push(`Handoff: fallback (${step.handoffParseError})`);
      }
      if (step.usedFallback) {
        const tierLabel = step.fallbackTier > 1 ? ` (tier ${step.fallbackTier})` : '';
        lines.push(`Fallback: yes${tierLabel} (${fallbackReasonLabel(step.fallbackReason)})`);
      }
      if (step.fatalOutputReason) {
        lines.push(`Fatal Output: ${fallbackReasonLabel(step.fatalOutputReason)}`);
      }
      if (step.warnings && step.warnings.length > 0) {
        lines.push(`Warnings: ${step.warnings.join(', ')}`);
      }
      if (step.usedFallback && step.capabilityDowngrades && step.capabilityDowngrades.length > 0) {
        lines.push(`Fallback Downgrades: ${step.capabilityDowngrades.join(', ')}`);
      }
      if (step.worktreeAfterSnapshot) {
        if (step.worktreeAfterSnapshot.patchFile) {
          lines.push(`Worktree After Patch: ${step.worktreeAfterSnapshot.patchFile}`);
        }
      }
      lines.push('');

      const stepOutput = step.outputText || renderHandoffForHumans(step.handoffData);
      lines.push(stepOutput || '(no output)');
      lines.push('');
    }

    if (run.result && (run.result.finalOutput || run.result.finalHandoffData)) {
      lines.push(`## FINAL ${run.mode.toUpperCase()} OUTPUT`);
      const displayText = run.result.finalOutput || renderHandoffForHumans(run.result.finalHandoffData);
      lines.push(displayText || '(no output)');
      lines.push('');
    }

    if (run.error) {
      lines.push('## ERROR');
      lines.push(run.error.message);
      lines.push('');
    }

    return lines.join('\n');
  }

  async appendRunLog(run) {
    const line = JSON.stringify(run) + '\n';
    await fs.appendFile(this.runsNdjsonFile, line, 'utf8');
  }

  async readJsonFile(filePath, fallbackValue) {
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return fallbackValue;
      }

      throw error;
    }

    try {
      return JSON.parse(content);
    } catch (error) {
      error.message = `Invalid JSON in ${path.relative(this.projectRoot, filePath)}: ${error.message}`;
      throw error;
    }
  }
}

async function main() {
  const orchestrator = new LoopiOrchestrator({
    projectRoot: process.env.LOOPI_PROJECT_ROOT
  });
  await orchestrator.init();
  await orchestrator.runTask();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  LoopiOrchestrator,
  validateProviderAssignments,
  __test: {
    getProviderConfig,
    getAgentForPhase,
    getReviewAgents,
    getLocalProviderIds,
    getUsedProviderIds,
    getEffectiveAgentsForMode,
    extractReviewFindingKeys,
    fallbackReasonLabel,
    buildReviewArtifact,
    buildProviderReadinessArtifact,
    buildProviderExecutionArtifact,
    buildContextSelectionArtifact,
    buildPlanClarificationsArtifact,
    buildWorktreeSnapshotArtifact,
    buildForkRecordArtifact
  }
};
