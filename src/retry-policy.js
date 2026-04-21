const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 2,
  backoffMs: 750
});

const MAX_RETRY_ATTEMPTS = 5;

function normalizeRetryPolicy(retryPolicy, options = {}) {
  const {
    sourceLabel = 'retryPolicy',
    coerceNumbers = false
  } = options;

  if (retryPolicy === undefined || retryPolicy === null) {
    return { ...DEFAULT_RETRY_POLICY };
  }

  if (typeof retryPolicy !== 'object' || Array.isArray(retryPolicy)) {
    throw new Error(`${sourceLabel} must be an object when provided.`);
  }

  const maxAttempts = normalizePositiveIntegerField(
    retryPolicy.maxAttempts,
    `${sourceLabel}.maxAttempts`,
    { coerceNumbers, max: MAX_RETRY_ATTEMPTS, defaultValue: DEFAULT_RETRY_POLICY.maxAttempts }
  );
  const backoffMs = normalizePositiveIntegerField(
    retryPolicy.backoffMs,
    `${sourceLabel}.backoffMs`,
    { coerceNumbers, defaultValue: DEFAULT_RETRY_POLICY.backoffMs }
  );

  return { maxAttempts, backoffMs };
}

function normalizePositiveIntegerField(value, label, options) {
  const {
    coerceNumbers = false,
    max = null,
    defaultValue
  } = options;

  if (value === undefined) {
    return defaultValue;
  }

  const parsed = coerceNumbers ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  if (max !== null && parsed > max) {
    throw new Error(`${label} must not exceed ${max}.`);
  }
  return parsed;
}

module.exports = {
  DEFAULT_RETRY_POLICY,
  MAX_RETRY_ATTEMPTS,
  normalizeRetryPolicy
};
