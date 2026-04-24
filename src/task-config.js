const fs = require('fs');
const path = require('path');
const { loadUseCaseSync } = require('./use-case-loader');
const { normalizeRetryPolicy } = require('./retry-policy');
const { SUPPORTED_AGENTS, SUPPORTED_AGENT_SET } = require('./supported-agents');
const { getAdapterConfig } = require('./adapters');
const {
  CONTEXT_DELIVERY_STAGE_KEYS,
  CONTEXT_DELIVERY_DEFAULT_KEY,
  CONTEXT_DELIVERY_VALUES,
  DEFAULT_CONTEXT_DELIVERY_POLICY
} = require('./context-delivery');

const SUPPORTED_MODES = new Set(['plan', 'implement', 'review', 'one-shot']);
const ONE_SHOT_ORIGIN_KEYS = new Set(['plan', 'implement', 'review']);
const SUPPORTED_PROVIDER_TYPES = new Set(['openai-compatible']);
const SUPPORTED_CONTEXT_PHASES = new Set(['plan', 'implement', 'review', 'one-shot']);

function normalizeTaskConfig(rawTask, { projectRoot }) {
  if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
    throw new Error('task.json must contain a JSON object, not an array, string, or null.');
  }

  const mode = normalizeMode(rawTask.mode);
  const prompt = normalizePrompt(rawTask);
  const providers = normalizeProviders(rawTask);
  const roles = normalizeRoles(rawTask, providers);
  const agents = normalizeAgents(rawTask, providers);
  const executionTargets = getExecutionTargets(agents, roles);
  const customPrompts = normalizeCustomPrompts(rawTask, mode);
  const useCase = normalizeUseCase(rawTask, mode, projectRoot);
  const context = normalizeContext(rawTask, projectRoot);
  const fork = normalizeFork(rawTask);

  const planQuestionMode = normalizePlanQuestionMode(rawTask);

  // oneShotOrigins only applies to one-shot mode — reject it elsewhere.
  if (mode !== 'one-shot' && rawTask.settings && rawTask.settings.oneShotOrigins !== undefined) {
    throw new Error('settings.oneShotOrigins is only valid for mode "one-shot".');
  }

  const oneShotOrigins = normalizeOneShotOrigins(rawTask, agents);

  return {
    mode,
    prompt,
    reviewPrompt: customPrompts.reviewPrompt,
    synthesisPrompt: customPrompts.synthesisPrompt,
    customImplementPrompt: customPrompts.customImplementPrompt,
    useCase,
    fork,
    agents,
    executionTargets,
    providers,
    roles,
    context,
    planQuestionMode,
    settings: {
      cwd: normalizeCwd(rawTask, projectRoot),
      timeoutMs: normalizeTimeout(rawTask),
      continueOnError: Boolean(rawTask.settings && rawTask.settings.continueOnError),
      writeScratchpad: rawTask.settings ? rawTask.settings.writeScratchpad !== false : true,
      planLoops: normalizePlanLoops(rawTask),
      qualityLoops: normalizeQualityLoops(rawTask),
      implementLoops: normalizeImplementLoops(rawTask),
      sectionImplementLoops: normalizeSectionImplementLoops(rawTask),
      agentPolicies: normalizeAgentPolicies(rawTask, executionTargets),
      agentOptions: normalizeAgentOptions(rawTask, executionTargets),
      oneShotOrigins
    }
  };
}

function normalizeFork(rawTask) {
  const rawFork = rawTask.fork;

  if (rawFork === undefined || rawFork === null) {
    return null;
  }

  if (typeof rawFork !== 'object' || Array.isArray(rawFork)) {
    throw new Error('"fork" must be an object when provided.');
  }

  if (typeof rawFork.forkedFromRunId !== 'string' || rawFork.forkedFromRunId.trim() === '') {
    throw new Error('fork.forkedFromRunId must be a non-empty string.');
  }

  return {
    forkedFromRunId: rawFork.forkedFromRunId.trim(),
    forkedFromStepId: normalizeOptionalForkString(rawFork.forkedFromStepId, 'fork.forkedFromStepId'),
    baseCommit: normalizeOptionalForkString(rawFork.baseCommit, 'fork.baseCommit'),
    reason: normalizeOptionalForkString(rawFork.reason, 'fork.reason'),
    recordedBy: normalizeOptionalForkString(rawFork.recordedBy, 'fork.recordedBy') || 'manual'
  };
}

function normalizeOptionalForkString(value, label) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function normalizeRoles(rawTask, providers = {}) {
  const rawRoles = rawTask.roles;
  if (rawRoles === undefined || rawRoles === null) {
    return {};
  }

  if (typeof rawRoles !== 'object' || Array.isArray(rawRoles)) {
    throw new Error('"roles" must be an object keyed by role name.');
  }

  const allowedRoles = new Set(['planner', 'implementer', 'reviewer', 'fallback']);
  const providerIds = new Set(Object.keys(providers).map((id) => String(id).trim().toLowerCase()));
  const normalizedRoles = {};

  for (const [rawRole, rawValue] of Object.entries(rawRoles)) {
    const role = String(rawRole || '').trim().toLowerCase();
    if (!allowedRoles.has(role)) {
      throw new Error(`Unknown role "${rawRole}". Supported roles: planner, implementer, reviewer, fallback.`);
    }

    if (typeof rawValue !== 'string' || rawValue.trim() === '') {
      throw new Error(`roles.${role} must be a non-empty string.`);
    }

    const target = rawValue.trim().toLowerCase();
    const isCliAdapter = SUPPORTED_AGENT_SET.has(target);
    const isProvider = providerIds.has(target);
    if (!isCliAdapter && !isProvider) {
      const supportedTargets = [...SUPPORTED_AGENTS, ...providerIds];
      throw new Error(`roles.${role} references unknown provider/agent "${rawValue}". Supported values: ${supportedTargets.join(', ')}.`);
    }

    if (role === 'implementer' && isProvider) {
      const providerConfig = providers[target];
      if (providerConfig && providerConfig.type === 'openai-compatible') {
        throw new Error(`roles.implementer cannot reference HTTP provider "${target}" because HTTP providers are read-only in v1.`);
      }
    }

    normalizedRoles[role] = target;
  }

  return normalizedRoles;
}

function normalizeMode(mode) {
  if (!mode) {
    return 'plan';
  }

  const normalized = String(mode).trim().toLowerCase();
  if (!normalized) {
    return 'plan';
  }

  if (!SUPPORTED_MODES.has(normalized)) {
    throw new Error(`Unsupported mode "${normalized}". Supported modes: ${[...SUPPORTED_MODES].join(', ')}.`);
  }

  return normalized;
}

function normalizePrompt(rawTask) {
  const prompt = rawTask.prompt || rawTask.task;
  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('Task configuration must include a non-empty "prompt" or legacy "task" field.');
  }

  return prompt.trim();
}

// Normalizes optional custom prompts.
// These are top-level fields (not under settings) because they're prompt-family config.
// reviewPrompt / synthesisPrompt are plan-only.
// customImplementPrompt is valid for implement and one-shot.
// Returns { reviewPrompt, synthesisPrompt, customImplementPrompt }.
function normalizeCustomPrompts(rawTask, mode) {
  const reviewPrompt = rawTask.reviewPrompt;
  const synthesisPrompt = rawTask.synthesisPrompt;
  const customImplementPrompt = rawTask.customImplementPrompt;

  // Plan-only prompts
  if (mode !== 'plan') {
    if (reviewPrompt !== undefined) {
      throw new Error('"reviewPrompt" is only valid for mode "plan".');
    }
    if (synthesisPrompt !== undefined) {
      throw new Error('"synthesisPrompt" is only valid for mode "plan".');
    }
  }

  // Implement-specific custom guidance
  if (mode !== 'implement' && mode !== 'one-shot' && customImplementPrompt !== undefined) {
    throw new Error('"customImplementPrompt" is only valid for modes "implement" and "one-shot".');
  }

  let normalizedReviewPrompt = null;
  let normalizedSynthesisPrompt = null;
  let normalizedCustomImplementPrompt = null;

  if (reviewPrompt !== undefined) {
    if (typeof reviewPrompt !== 'string' || reviewPrompt.trim() === '') {
      throw new Error('"reviewPrompt" must be a non-empty string.');
    }
    normalizedReviewPrompt = reviewPrompt.trim();
  }

  if (synthesisPrompt !== undefined) {
    if (typeof synthesisPrompt !== 'string' || synthesisPrompt.trim() === '') {
      throw new Error('"synthesisPrompt" must be a non-empty string.');
    }
    normalizedSynthesisPrompt = synthesisPrompt.trim();
  }

  if (customImplementPrompt !== undefined) {
    if (typeof customImplementPrompt !== 'string' || customImplementPrompt.trim() === '') {
      throw new Error('"customImplementPrompt" must be a non-empty string.');
    }
    normalizedCustomImplementPrompt = customImplementPrompt.trim();
  }

  return {
    reviewPrompt: normalizedReviewPrompt,
    synthesisPrompt: normalizedSynthesisPrompt,
    customImplementPrompt: normalizedCustomImplementPrompt
  };
}

// Normalizes optional useCase for plan and one-shot modes.
// If absent, returns null (legacy plan mode behavior).
// If present and mode is neither "plan" nor "one-shot", throws an explicit error.
// If present and mode is "plan" or "one-shot", loads the use-case config synchronously.
function normalizeUseCase(rawTask, mode, projectRoot) {
  const rawUseCase = rawTask.useCase;

  if (rawUseCase === undefined || rawUseCase === null) {
    if (mode === 'one-shot') {
      throw new Error('mode "one-shot" requires a non-empty "useCase".');
    }
    return null;
  }

  if (typeof rawUseCase !== 'string' || rawUseCase.trim() === '') {
    throw new Error('useCase must be a non-empty string.');
  }

  if (mode !== 'plan' && mode !== 'one-shot') {
    throw new Error('useCase is currently supported only in modes "plan" and "one-shot".');
  }

  const normalizedName = rawUseCase.trim().toLowerCase();
  return loadUseCaseSync(normalizedName, projectRoot);
}

function normalizeAgents(rawTask, providers = {}) {
  const agents = Array.isArray(rawTask.agents) && rawTask.agents.length > 0
    ? rawTask.agents
    : [];

  const normalized = agents
    .map((agent) => String(agent).trim().toLowerCase())
    .filter(Boolean);

  const seen = new Set();
  const deduped = [];
  for (const agent of normalized) {
    if (!seen.has(agent)) {
      seen.add(agent);
      deduped.push(agent);
    }
  }

  if (deduped.length === 0) {
    return ['claude', 'codex', 'gemini'];
  }

  const providerIds = new Set(Object.keys(providers).map((id) => String(id).trim().toLowerCase()));

  for (const agent of deduped) {
    if (!SUPPORTED_AGENT_SET.has(agent) && !providerIds.has(agent)) {
      const supportedNames = [...SUPPORTED_AGENTS, ...providerIds];
      throw new Error(`Unknown agent "${agent}". Supported agents: ${supportedNames.join(', ')}.`);
    }
  }

  return deduped;
}

function getExecutionTargets(agents, roles) {
  const deduped = [];
  const seen = new Set();

  for (const target of [...agents, ...getOrderedRoleTargets(roles)]) {
    const normalizedTarget = String(target).trim().toLowerCase();
    if (!normalizedTarget || seen.has(normalizedTarget)) {
      continue;
    }
    seen.add(normalizedTarget);
    deduped.push(normalizedTarget);
  }

  return deduped;
}

function getOrderedRoleTargets(roles) {
  if (!roles || typeof roles !== 'object') {
    return [];
  }

  const orderedKeys = ['planner', 'implementer', 'reviewer', 'fallback'];
  return orderedKeys
    .map((key) => roles[key])
    .filter(Boolean);
}

function normalizeCwd(rawTask, projectRoot) {
  const configured = rawTask.settings && rawTask.settings.cwd
    ? rawTask.settings.cwd
    : '.';
  const resolved = path.resolve(projectRoot, configured);
  const resolvedRoot = path.resolve(projectRoot);

  if (!isWithinDirectory(resolved, resolvedRoot)) {
    throw new Error(`settings.cwd must be within the project root. "${resolved}" escapes "${resolvedRoot}".`);
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`settings.cwd must exist. "${resolved}" was not found.`);
  }

  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`settings.cwd must be a directory. "${resolved}" is not a directory.`);
  }

  return resolved;
}

// Cross-platform containment check: target must be equal to or a descendant of root.
// Handles Windows drive letters, UNC paths, and relative path edge cases.
function isWithinDirectory(target, root) {
  if (target === root) {
    return true;
  }
  // On Windows, different drive letters are an absolute escape.
  if (process.platform === 'win32') {
    const targetDrive = path.parse(target).root.toLowerCase();
    const rootDrive = path.parse(root).root.toLowerCase();
    if (targetDrive !== rootDrive) {
      return false;
    }
  }
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..')) {
    return false;
  }
  // On Windows, path.relative can return a path like "D:\\other" for
  // cross-drive escapes — the drive letter check above catches most,
  // but isAbsolute guards against any remaining edge cases.
  if (path.isAbsolute(relative)) {
    return false;
  }
  return true;
}

function normalizeTimeout(rawTask) {
  const value = rawTask.settings && rawTask.settings.timeoutMs
    ? rawTask.settings.timeoutMs
    : 180000;
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('settings.timeoutMs must be a positive number.');
  }

  return parsed;
}

function normalizeQualityLoops(rawTask) {
  const rawSettings = rawTask.settings || {};
  if (rawSettings.qualityLoops === undefined) {
    return 1;
  }
  const value = rawSettings.qualityLoops;
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('settings.qualityLoops must be a positive integer.');
  }

  return parsed;
}

// Normalizes implementLoops for standalone implement mode.
// Fallback chain: implementLoops → qualityLoops → 1
function normalizeImplementLoops(rawTask) {
  const rawSettings = rawTask.settings || {};
  if (rawSettings.implementLoops === undefined) {
    // Fallback to qualityLoops, then default 1
    return rawSettings.qualityLoops !== undefined ? normalizeQualityLoops(rawTask) : 1;
  }

  const parsed = Number(rawSettings.implementLoops);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('settings.implementLoops must be a positive integer.');
  }

  return parsed;
}

// Normalizes deprecated implementLoopsPerUnit input for one-shot implement stage.
// Deprecated alias fallback chain: implementLoopsPerUnit → implementLoops → qualityLoops → 1
function normalizeImplementLoopsPerUnit(rawTask) {
  const rawSettings = rawTask.settings || {};
  if (rawSettings.implementLoopsPerUnit === undefined) {
    // Fallback to implementLoops, then qualityLoops, then default 1
    if (rawSettings.implementLoops !== undefined) {
      return normalizeImplementLoops(rawTask);
    }
    return rawSettings.qualityLoops !== undefined ? normalizeQualityLoops(rawTask) : 1;
  }

  const parsed = Number(rawSettings.implementLoopsPerUnit);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('settings.implementLoopsPerUnit must be a positive integer.');
  }

  return parsed;
}

// Normalizes planLoops for plan and one-shot modes.
// planLoops controls the number of plan cycles within each qualityLoops pass for one-shot,
// or directly for plan mode. When absent, falls back to qualityLoops.
function normalizePlanLoops(rawTask) {
  const rawSettings = rawTask.settings || {};
  if (rawSettings.planLoops === undefined) {
    // Fallback to qualityLoops, then default 1
    return rawSettings.qualityLoops !== undefined ? normalizeQualityLoops(rawTask) : 1;
  }

  const parsed = Number(rawSettings.planLoops);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('settings.planLoops must be a positive integer.');
  }

  return parsed;
}

// Normalizes sectionImplementLoops for one-shot implement stage.
// This is the new canonical name for per-section implement/review/repair cycles.
// Deprecated alias: implementLoopsPerUnit
// Fallback chain: sectionImplementLoops → implementLoopsPerUnit → implementLoops → planLoops → legacy qualityLoops via planLoops → 1
function normalizeSectionImplementLoops(rawTask) {
  const rawSettings = rawTask.settings || {};
  if (rawSettings.sectionImplementLoops === undefined) {
    // Try deprecated alias first
    if (rawSettings.implementLoopsPerUnit !== undefined) {
      return normalizeImplementLoopsPerUnit(rawTask);
    }
    // Then try implementLoops
    if (rawSettings.implementLoops !== undefined) {
      return normalizeImplementLoops(rawTask);
    }
    // Then try planLoops, including the legacy qualityLoops -> planLoops fallback.
    if (rawSettings.planLoops !== undefined || rawSettings.qualityLoops !== undefined) {
      return normalizePlanLoops(rawTask);
    }
    // Finally default to 1
    return 1;
  }

  const parsed = Number(rawSettings.sectionImplementLoops);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('settings.sectionImplementLoops must be a positive integer.');
  }

  return parsed;
}

function normalizeAgentPolicies(rawTask, agents) {
  const rawPolicies = rawTask.settings && rawTask.settings.agentPolicies;
  const normalized = {};

  if (rawPolicies !== undefined && (rawPolicies === null || typeof rawPolicies !== 'object' || Array.isArray(rawPolicies))) {
    throw new Error('settings.agentPolicies must be an object keyed by agent name.');
  }

  // Normalize policy keys to lowercase so "Codex" and "codex" map to the same agent.
  // Reject duplicate keys that collide after normalization (e.g., "Codex" + "codex").
  // Reject keys for agents not in the agents list.
  const agentSet = new Set(agents);
  const normalizedPolicies = {};
  const originalPolicyKeys = {};
  if (rawPolicies && typeof rawPolicies === 'object') {
    for (const agentName of Object.keys(rawPolicies)) {
      const lowerKey = String(agentName).trim().toLowerCase();
      if (!SUPPORTED_AGENT_SET.has(lowerKey)) {
        throw new Error(`Unknown agent policy "${agentName}". Supported agents: ${SUPPORTED_AGENTS.join(', ')}.`);
      }
      if (!agentSet.has(lowerKey)) {
        throw new Error(`Agent policy for "${agentName}" references agent "${lowerKey}" which is not present in the "agents" list.`);
      }
      if (lowerKey in normalizedPolicies) {
        throw new Error(`Duplicate agent policy keys "${originalPolicyKeys[lowerKey]}" and "${agentName}" collide after normalization.`);
      }
      normalizedPolicies[lowerKey] = rawPolicies[agentName];
      originalPolicyKeys[lowerKey] = agentName;
    }
  }

  for (const agent of agents) {
    normalized[agent] = {
      canWrite: normalizeCanWritePolicy(agent, normalizedPolicies[agent])
    };
  }

  return normalized;
}

function normalizeCanWritePolicy(agent, rawPolicy) {
  let canWrite = false;
  let explicitlySet = false;

  if (typeof rawPolicy === 'boolean') {
    canWrite = rawPolicy;
    explicitlySet = true;
  } else if (rawPolicy && typeof rawPolicy === 'object' && 'canWrite' in rawPolicy) {
    canWrite = rawPolicy.canWrite;
    explicitlySet = true;
  } else if (rawPolicy !== undefined && rawPolicy !== null) {
    throw new Error(
      `settings.agentPolicies.${agent} must be a boolean or an object with a "canWrite" key.`
    );
  }

  if (typeof canWrite !== 'boolean') {
    throw new Error(`settings.agentPolicies.${agent}.canWrite must be a boolean.`);
  }

  if (canWrite && explicitlySet) {
    console.warn(
      `Warning: agent "${agent}" is configured with canWrite=true. ` +
      'This agent will be allowed to modify repository files directly during implement mode.'
    );
  }

  return canWrite;
}

// Normalizes optional per-agent runtime options declared by each adapter.
// Shape: { [agent]: { [optionKey]: string|boolean|null } }
// Keys are normalized to lowercase and must match an agent in the agents list.
// Values are passed through to the adapter; no model-name validation happens here.
function normalizeAgentOptions(rawTask, agents) {
  const rawOptions = rawTask.settings && rawTask.settings.agentOptions;

  if (rawOptions === undefined) {
    return {};
  }

  if (rawOptions === null || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    throw new Error('settings.agentOptions must be an object keyed by agent name.');
  }

  const agentSet = new Set(agents);
  const normalized = {};

  for (const agentName of Object.keys(rawOptions)) {
    const lowerKey = String(agentName).trim().toLowerCase();
    if (!SUPPORTED_AGENT_SET.has(lowerKey)) {
      throw new Error(`Unknown agent option key "${agentName}". Supported agents: ${SUPPORTED_AGENTS.join(', ')}.`);
    }
    if (!agentSet.has(lowerKey)) {
      throw new Error(
        `Agent option key "${agentName}" references an agent not present in the "agents" list.`
      );
    }

    const rawValue = rawOptions[agentName];
    if (rawValue === null || rawValue === undefined || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      throw new Error(`settings.agentOptions.${agentName} must be an object.`);
    }

    const allowedKeys = adapterAgentOptionKeys(lowerKey);
    const rawKeys = Object.keys(rawValue);
    const unknownKeys = rawKeys.filter(k => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `settings.agentOptions.${agentName} contains unknown key(s): ${unknownKeys.join(', ')}. ` +
        `Allowed keys: ${Array.from(allowedKeys).join(', ')}.`
      );
    }

    const adapterConfig = safeAdapterConfig(lowerKey);
    const selection = adapterConfig && adapterConfig.selection ? adapterConfig.selection : {};
    const normalizedValue = {};
    for (const optionKey of allowedKeys) {
      const optionConfig = selection[optionKey] || {};
      const rawOption = Object.prototype.hasOwnProperty.call(rawValue, optionKey)
        ? rawValue[optionKey]
        : null;

      if (optionConfig.mode === 'boolean_flag') {
        if (rawOption !== null && typeof rawOption !== 'boolean') {
          throw new Error(`settings.agentOptions.${agentName}.${optionKey} must be a boolean or null.`);
        }
        if (rawOption === true || rawOption === false) {
          normalizedValue[optionKey] = rawOption;
        }
        continue;
      }

      if (rawOption !== null && typeof rawOption !== 'string') {
        throw new Error(`settings.agentOptions.${agentName}.${optionKey} must be a string or null.`);
      }
      if (typeof rawOption === 'string' && rawOption.trim().length > 0) {
        normalizedValue[optionKey] = rawOption.trim();
      } else if (optionKey === 'model' || optionKey === 'effort') {
        normalizedValue[optionKey] = null;
      }
    }

    normalized[lowerKey] = normalizedValue;
  }

  return normalized;
}

function safeAdapterConfig(agentName) {
  try {
    return getAdapterConfig(agentName);
  } catch {
    return null;
  }
}

function adapterAgentOptionKeys(agentName) {
  const config = safeAdapterConfig(agentName);
  const keys = new Set(['model', 'effort']);
  if (config && config.selection && typeof config.selection === 'object') {
    Object.keys(config.selection).forEach((key) => keys.add(key));
  }
  return keys;
}

function normalizeOneShotOrigins(rawTask, agents) {
  const rawOrigins = rawTask.settings && rawTask.settings.oneShotOrigins;

  if (rawOrigins === undefined) {
    return null;
  }

  if (rawOrigins === null || typeof rawOrigins !== 'object' || Array.isArray(rawOrigins)) {
    throw new Error('settings.oneShotOrigins must be an object with keys "plan", "implement", and/or "review".');
  }

  const agentSet = new Set(agents);
  const normalized = {};

  for (const key of Object.keys(rawOrigins)) {
    const lowerKey = String(key).trim().toLowerCase();
    if (!ONE_SHOT_ORIGIN_KEYS.has(lowerKey)) {
      throw new Error(
        `Unknown one-shot origin key "${key}". Allowed keys: ${[...ONE_SHOT_ORIGIN_KEYS].join(', ')}.`
      );
    }

    const originAgent = String(rawOrigins[key]).trim().toLowerCase();
    if (!agentSet.has(originAgent)) {
      throw new Error(
        `One-shot origin agent "${originAgent}" is not present in the top-level "agents" list.`
      );
    }

    normalized[lowerKey] = originAgent;
  }

  return normalized;
}

function normalizeContextPhaseBudgetMap(rawValue, fieldName) {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }

  if (typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    throw new Error(`${fieldName} must be an object if provided.`);
  }

  const normalized = {};
  for (const [phase, value] of Object.entries(rawValue)) {
    const normalizedPhase = String(phase).trim().toLowerCase();
    if (!SUPPORTED_CONTEXT_PHASES.has(normalizedPhase)) {
      throw new Error(
        `${fieldName}.${phase} is invalid. Allowed phases: ${[...SUPPORTED_CONTEXT_PHASES].join(', ')}.`
      );
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${fieldName}.${phase} must be a positive integer.`);
    }

    normalized[normalizedPhase] = parsed;
  }

  return normalized;
}

function normalizeContextDeliveryPolicy(rawDeliveryPolicy) {
  let deliveryPolicy = { ...DEFAULT_CONTEXT_DELIVERY_POLICY };
  const deliveryPolicyOverrides = {};

  if (rawDeliveryPolicy === undefined || rawDeliveryPolicy === null) {
    return { deliveryPolicy, deliveryPolicyOverrides };
  }

  if (typeof rawDeliveryPolicy !== 'object' || Array.isArray(rawDeliveryPolicy)) {
    throw new Error('context.deliveryPolicy must be an object if provided.');
  }

  const allowedKeys = [CONTEXT_DELIVERY_DEFAULT_KEY, ...CONTEXT_DELIVERY_STAGE_KEYS];
  const normalizeDeliveryValue = (rawKey, rawValue) => {
    const normalizedValue = String(rawValue || '').trim().toLowerCase();
    if (!CONTEXT_DELIVERY_VALUES.includes(normalizedValue)) {
      throw new Error(
        `context.deliveryPolicy.${rawKey} must be one of: ${CONTEXT_DELIVERY_VALUES.join(', ')}.`
      );
    }
    return normalizedValue;
  };

  const hasDefaultValue = Object.prototype.hasOwnProperty.call(rawDeliveryPolicy, CONTEXT_DELIVERY_DEFAULT_KEY);
  if (hasDefaultValue) {
    const defaultValue = normalizeDeliveryValue(CONTEXT_DELIVERY_DEFAULT_KEY, rawDeliveryPolicy[CONTEXT_DELIVERY_DEFAULT_KEY]);
    deliveryPolicy = Object.fromEntries(
      CONTEXT_DELIVERY_STAGE_KEYS.map((stageKey) => [stageKey, defaultValue])
    );
  }

  for (const [rawKey, rawValue] of Object.entries(rawDeliveryPolicy)) {
    const stageKey = String(rawKey).trim();
    if (!allowedKeys.includes(stageKey)) {
      const typoHint = stageKey === 'planSynthesis'
        ? ' Plan-mode synthesis is governed by "reviewSynthesis".'
        : '';
      throw new Error(
        `Unknown context.deliveryPolicy key "${rawKey}".${typoHint} Allowed keys: ${allowedKeys.join(', ')}.`
      );
    }
    if (stageKey === CONTEXT_DELIVERY_DEFAULT_KEY) {
      continue;
    }

    const normalizedValue = normalizeDeliveryValue(stageKey, rawValue);
    deliveryPolicy[stageKey] = normalizedValue;
    deliveryPolicyOverrides[stageKey] = true;
  }

  return { deliveryPolicy, deliveryPolicyOverrides };
}

// Normalizes context folder configuration for providing reference material.
// Returns a normalized context object or null if no context is configured.
function normalizeContext(rawTask, projectRoot) {
  const rawContext = rawTask.context;

  if (rawContext === undefined || rawContext === null) {
    return null;
  }

  if (typeof rawContext !== 'object' || Array.isArray(rawContext)) {
    throw new Error('"context" must be an object.');
  }

  // Validate dir (required if context key exists)
  if (!rawContext.dir || typeof rawContext.dir !== 'string') {
    throw new Error('context.dir is required when context is configured and must be a non-empty string.');
  }
  const dir = String(rawContext.dir).trim();
  if (dir === '') {
    throw new Error('context.dir must be a non-empty string.');
  }

  const resolvedContextDir = path.resolve(projectRoot || process.cwd(), dir);
  if (!fs.existsSync(resolvedContextDir)) {
    const missingError = new Error(`context.dir does not exist: "${resolvedContextDir}"`);
    missingError.code = 'CONTEXT_DIR_MISSING';
    missingError.contextDir = resolvedContextDir;
    throw missingError;
  }
  const contextStats = fs.statSync(resolvedContextDir);
  if (!contextStats.isDirectory()) {
    const notDirError = new Error(`context.dir must resolve to a directory: "${resolvedContextDir}"`);
    notDirError.code = 'CONTEXT_DIR_NOT_DIRECTORY';
    notDirError.contextDir = resolvedContextDir;
    throw notDirError;
  }

  // Validate include (optional)
  let include = null;
  if (rawContext.include !== undefined && rawContext.include !== null) {
    if (!Array.isArray(rawContext.include) || rawContext.include.length === 0) {
      throw new Error('context.include must be a non-empty array of strings if provided.');
    }
    for (const pattern of rawContext.include) {
      if (typeof pattern !== 'string' || pattern.trim() === '') {
        throw new Error('context.include must contain only non-empty strings.');
      }
    }
    include = rawContext.include.map(p => p.trim());
  }

  // Validate exclude (optional)
  let exclude = null;
  if (rawContext.exclude !== undefined && rawContext.exclude !== null) {
    if (!Array.isArray(rawContext.exclude)) {
      throw new Error('context.exclude must be an array of strings if provided.');
    }
    exclude = rawContext.exclude.map(p => {
      if (typeof p !== 'string') {
        throw new Error('context.exclude must contain only strings.');
      }
      return p.trim();
    });
  }

  const maxFilesPerPhase = normalizeContextPhaseBudgetMap(
    rawContext.maxFilesPerPhase,
    'context.maxFilesPerPhase'
  );

  const maxCharsPerPhase = normalizeContextPhaseBudgetMap(
    rawContext.maxCharsPerPhase,
    'context.maxCharsPerPhase'
  );

  // Validate manifest (optional)
  let manifest = null;
  if (rawContext.manifest !== undefined && rawContext.manifest !== null) {
    if (typeof rawContext.manifest !== 'string') {
      throw new Error('context.manifest must be a string if provided.');
    }
    manifest = String(rawContext.manifest).trim();
    if (manifest === '') {
      throw new Error('context.manifest must be a non-empty string.');
    }
  }

  const { deliveryPolicy, deliveryPolicyOverrides } = normalizeContextDeliveryPolicy(rawContext.deliveryPolicy);

  return {
    dir,
    include,
    exclude,
    maxFilesPerPhase,
    maxCharsPerPhase,
    manifest,
    deliveryPolicy,
    deliveryPolicyOverrides
  };
}

// Normalizes the planQuestionMode field.
// "autonomous" (default): planner questions are answered using agentDefault without pausing.
// "interactive": run pauses after the first plan draft to collect answers from the user.
function normalizePlanQuestionMode(rawTask) {
  const raw = rawTask.planQuestionMode;

  if (raw === undefined || raw === null) {
    return 'autonomous';
  }

  if (typeof raw !== 'string') {
    throw new Error('"planQuestionMode" must be a string ("autonomous" or "interactive").');
  }

  const value = raw.trim().toLowerCase();
  if (value !== 'autonomous' && value !== 'interactive') {
    throw new Error(`"planQuestionMode" must be "autonomous" or "interactive", got "${raw}".`);
  }

  return value;
}

// Normalizes provider definitions for HTTP/OpenAI-compatible providers.
// Each provider is keyed by a user-chosen ID and contains connection and runtime config.
// Returns a map of normalized provider configs, or empty object if none configured.
function normalizeProviders(rawTask) {
  const rawProviders = rawTask.providers;

  if (rawProviders === undefined || rawProviders === null) {
    return {};
  }

  if (typeof rawProviders !== 'object' || Array.isArray(rawProviders)) {
    throw new Error('"providers" must be an object keyed by provider ID (e.g., "nim-local").');
  }

  const normalized = {};
  const normalizedIds = new Set();

  for (const providerId of Object.keys(rawProviders)) {
    const providerConfig = rawProviders[providerId];
    const normalizedId = String(providerId).trim().toLowerCase();

    // Reject empty provider IDs after normalization (e.g., whitespace-only keys)
    if (normalizedId === '') {
      throw new Error(`Provider ID "${providerId}" is empty after normalization. Provider IDs must be non-empty strings.`);
    }

    // Reject duplicate provider IDs after normalization
    if (normalizedIds.has(normalizedId)) {
      throw new Error(
        `Provider ID collision: "${providerId}" and another provider ID both normalize to "${normalizedId}". Provider IDs must be unique case-insensitively.`
      );
    }
    normalizedIds.add(normalizedId);

    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
      throw new Error(`Provider "${providerId}" must be an object.`);
    }

    // Validate and normalize type
    if (!providerConfig.type || typeof providerConfig.type !== 'string') {
      throw new Error(`Provider "${providerId}" must have a "type" field.`);
    }
    const type = String(providerConfig.type).trim();
    if (!SUPPORTED_PROVIDER_TYPES.has(type)) {
      throw new Error(
        `Provider "${providerId}" has unsupported type "${type}". ` +
        `Supported types: ${[...SUPPORTED_PROVIDER_TYPES].join(', ')}.`
      );
    }

    // Validate baseUrl (required)
    if (!providerConfig.baseUrl || typeof providerConfig.baseUrl !== 'string') {
      throw new Error(`Provider "${providerId}" must have a "baseUrl" field.`);
    }
    const baseUrl = String(providerConfig.baseUrl).trim();
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      throw new Error(
        `Provider "${providerId}" has invalid baseUrl "${baseUrl}". ` +
        `baseUrl must start with "http://" or "https://".`
      );
    }
    let parsedBaseUrl;
    try {
      parsedBaseUrl = new URL(baseUrl);
    } catch (_error) {
      throw new Error(
        `Provider "${providerId}" has invalid baseUrl "${baseUrl}". ` +
        'baseUrl must be a valid absolute URL.'
      );
    }
    if (!parsedBaseUrl.hostname) {
      throw new Error(
        `Provider "${providerId}" has invalid baseUrl "${baseUrl}". ` +
        'baseUrl must include a hostname.'
      );
    }

    // Validate model (required)
    if (!providerConfig.model || typeof providerConfig.model !== 'string') {
      throw new Error(`Provider "${providerId}" must have a "model" field.`);
    }
    const model = String(providerConfig.model).trim();
    if (model === '') {
      throw new Error(`Provider "${providerId}" model must be a non-empty string.`);
    }

    // Validate apiKey (optional)
    let apiKey = null;
    if (providerConfig.apiKey !== undefined && providerConfig.apiKey !== null) {
      if (typeof providerConfig.apiKey !== 'string') {
        throw new Error(`Provider "${providerId}" apiKey must be a string if provided.`);
      }
      apiKey = providerConfig.apiKey;
    }

    // Validate healthEndpoint (optional)
    let healthEndpoint = null;
    if (providerConfig.healthEndpoint !== undefined && providerConfig.healthEndpoint !== null) {
      if (typeof providerConfig.healthEndpoint !== 'string') {
        throw new Error(`Provider "${providerId}" healthEndpoint must be a string if provided.`);
      }
      healthEndpoint = String(providerConfig.healthEndpoint).trim();
      if (healthEndpoint !== '' && !healthEndpoint.startsWith('/')) {
        throw new Error(
          `Provider "${providerId}" healthEndpoint must start with "/" if provided.`
        );
      }
    }

    // Validate maxInputChars (optional)
    let maxInputChars = null;
    if (providerConfig.maxInputChars !== undefined && providerConfig.maxInputChars !== null) {
      const parsed = Number(providerConfig.maxInputChars);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Provider "${providerId}" maxInputChars must be a positive integer.`);
      }
      maxInputChars = parsed;
    }

    // Validate local (optional)
    let local = false;
    if (providerConfig.local !== undefined && providerConfig.local !== null) {
      if (typeof providerConfig.local !== 'boolean') {
        throw new Error(`Provider "${providerId}" local must be a boolean if provided.`);
      }
      local = providerConfig.local;
    }

    // Validate chatTemplateMode (optional)
    let chatTemplateMode = null;
    if (providerConfig.chatTemplateMode !== undefined && providerConfig.chatTemplateMode !== null) {
      if (typeof providerConfig.chatTemplateMode !== 'string') {
        throw new Error(`Provider "${providerId}" chatTemplateMode must be a string if provided.`);
      }
      const mode = String(providerConfig.chatTemplateMode).trim().toLowerCase();
      if (mode !== 'openai' && mode !== 'raw') {
        throw new Error(
          `Provider "${providerId}" chatTemplateMode must be "openai" or "raw".`
        );
      }
      chatTemplateMode = mode;
    }

    // Validate and normalize requestDefaults (optional)
    let requestDefaults = null;
    if (providerConfig.requestDefaults !== undefined && providerConfig.requestDefaults !== null) {
      if (typeof providerConfig.requestDefaults !== 'object' || Array.isArray(providerConfig.requestDefaults)) {
        throw new Error(`Provider "${providerId}" requestDefaults must be an object if provided.`);
      }

      const rd = providerConfig.requestDefaults;
      const normalizedRequestDefaults = { ...rd };

      if (rd.temperature !== undefined) {
        const temp = Number(rd.temperature);
        if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
          throw new Error(
            `Provider "${providerId}" requestDefaults.temperature must be a number between 0 and 2.`
          );
        }
        normalizedRequestDefaults.temperature = temp;
      }

      if (rd.max_tokens !== undefined) {
        const maxTok = Number(rd.max_tokens);
        if (!Number.isInteger(maxTok) || maxTok <= 0) {
          throw new Error(
            `Provider "${providerId}" requestDefaults.max_tokens must be a positive integer.`
          );
        }
        normalizedRequestDefaults.max_tokens = maxTok;
      }

      if (rd.timeoutMs !== undefined) {
        const timeout = Number(rd.timeoutMs);
        if (!Number.isInteger(timeout) || timeout <= 0) {
          throw new Error(
            `Provider "${providerId}" requestDefaults.timeoutMs must be a positive integer.`
          );
        }
        normalizedRequestDefaults.timeoutMs = timeout;
      }

      requestDefaults = normalizedRequestDefaults;
    }

    // Validate and normalize retryPolicy. The normalized config always carries
    // a complete retry policy so runtime execution does not need to merge defaults.
    let retryPolicy;
    try {
      retryPolicy = normalizeRetryPolicy(providerConfig.retryPolicy, {
        sourceLabel: `Provider "${providerId}" retryPolicy`,
        coerceNumbers: true
      });
    } catch (error) {
      throw new Error(error.message);
    }

    normalized[normalizedId] = {
      id: normalizedId,  // Store the normalized (lowercase) ID
      type,
      baseUrl,
      model,
      apiKey,
      healthEndpoint,
      maxInputChars,
      local,
      chatTemplateMode,
      requestDefaults,
      retryPolicy
    };
  }

  return normalized;
}

module.exports = {
  normalizeTaskConfig
};
