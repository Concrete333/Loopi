const CONTEXT_DELIVERY_STAGE_KEYS = [
  'planInitial',
  'planReview',
  'reviewInitial',
  'reviewParallel',
  'reviewSynthesis',
  'implementInitial',
  'implementReview',
  'implementRepair'
];

const CONTEXT_DELIVERY_DEFAULT_KEY = 'default';

const CONTEXT_DELIVERY_VALUES = ['full', 'digest', 'none'];

const DEFAULT_CONTEXT_DELIVERY_POLICY = {
  planInitial: 'full',
  planReview: 'digest',
  reviewInitial: 'full',
  reviewParallel: 'full',
  reviewSynthesis: 'digest',
  implementInitial: 'full',
  implementReview: 'full',
  implementRepair: 'digest'
};

const CYCLE_AWARE_DOWNGRADE_STAGE_KEYS = new Set([
  'planReview',
  'reviewParallel',
  'implementReview'
]);

function resolveContextDelivery(config, stageKey) {
  if (!CONTEXT_DELIVERY_STAGE_KEYS.includes(stageKey)) {
    throw new Error(`Unknown context delivery stage key "${stageKey}".`);
  }

  if (!config || !config.context || !config.context.deliveryPolicy) {
    return DEFAULT_CONTEXT_DELIVERY_POLICY[stageKey];
  }

  return config.context.deliveryPolicy[stageKey] || DEFAULT_CONTEXT_DELIVERY_POLICY[stageKey];
}

function resolveContextDeliveryForCycle(config, stageKey, cycleNumber) {
  const baseDelivery = resolveContextDelivery(config, stageKey);

  if (cycleNumber === null || cycleNumber === undefined || cycleNumber <= 1) {
    return baseDelivery;
  }

  if (!CYCLE_AWARE_DOWNGRADE_STAGE_KEYS.has(stageKey)) {
    return baseDelivery;
  }

  const explicitOverride = Boolean(
    config
    && config.context
    && config.context.deliveryPolicyOverrides
    && config.context.deliveryPolicyOverrides[stageKey]
  );
  if (explicitOverride) {
    return baseDelivery;
  }

  if (baseDelivery === 'full') {
    return 'digest';
  }

  return baseDelivery;
}

module.exports = {
  CONTEXT_DELIVERY_STAGE_KEYS,
  CONTEXT_DELIVERY_DEFAULT_KEY,
  CONTEXT_DELIVERY_VALUES,
  DEFAULT_CONTEXT_DELIVERY_POLICY,
  resolveContextDelivery,
  resolveContextDeliveryForCycle
};
