const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawn, spawnSync } = require('child_process');
const { normalizeRetryPolicy } = require('../retry-policy');

// ── Provider Capability Registry ────────────────────────────────────────────────

const PROVIDER_REGISTRY = {
  // CLI-based adapters
  claude: {
    family: 'cli',
    supportsChat: true,
    supportsCompletions: false,
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsWriteAccess: true,
    supportsReasoningEffort: true,
    supportsModelListing: false,
    supportsHealthChecks: false
  },
  codex: {
    family: 'cli',
    supportsChat: true,
    supportsCompletions: false,
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsWriteAccess: true,
    supportsReasoningEffort: true,
    supportsModelListing: false,
    supportsHealthChecks: false
  },
  gemini: {
    family: 'cli',
    supportsChat: true,
    supportsCompletions: false,
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsWriteAccess: false,
    supportsReasoningEffort: false,
    supportsModelListing: false,
    supportsHealthChecks: false
  },
  kilo: {
    family: 'cli',
    supportsChat: true,
    supportsCompletions: false,
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsWriteAccess: true,
    supportsReasoningEffort: true,
    supportsModelListing: false,
    supportsHealthChecks: false
  },
  qwen: {
    family: 'cli',
    supportsChat: true,
    supportsCompletions: false,
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsWriteAccess: true,
    supportsReasoningEffort: false,
    supportsModelListing: false,
    supportsHealthChecks: false
  },
  opencode: {
    family: 'cli',
    supportsChat: true,
    supportsCompletions: false,
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsWriteAccess: true,
    supportsReasoningEffort: false,
    supportsModelListing: false,
    supportsHealthChecks: false
  },
  // HTTP-based provider family (for configured providers)
  'openai-compatible': {
    family: 'http',
    supportsChat: true,
    supportsCompletions: false,
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsWriteAccess: false,   // HTTP providers are read-only in v1
    supportsReasoningEffort: false,
    supportsModelListing: true,
    supportsHealthChecks: true
  }
};

// Valid capability keys for checkCapability validation
const VALID_CAPABILITIES = new Set([
  'family',
  'supportsChat',
  'supportsCompletions',
  'supportsStreaming',
  'supportsToolCalling',
  'supportsWriteAccess',
  'supportsReasoningEffort',
  'supportsModelListing',
  'supportsHealthChecks'
]);

/**
 * Returns the capability profile for a given adapter or provider.
 * @param {string} adapterNameOrProviderId - Name like "claude" or provider ID like "nim-local"
 * @returns {Object|null} Capability profile or null if not recognized
 */
function getCapabilityProfile(adapterNameOrProviderId) {
  const key = String(adapterNameOrProviderId).trim().toLowerCase();
  return PROVIDER_REGISTRY[key] || null;
}

/**
 * Checks if a provider supports a specific capability.
 * @param {string} adapterNameOrProviderId - Name like "claude" or provider ID like "nim-local"
 * @param {string} capabilityKey - The capability to check
 * @returns {boolean} True if supported, false otherwise
 */
function checkCapability(adapterNameOrProviderId, capabilityKey) {
  const profile = getCapabilityProfile(adapterNameOrProviderId);
  if (!profile) {
    console.warn(`Warning: Unknown provider "${adapterNameOrProviderId}" in capability check.`);
    return false;
  }

  if (!VALID_CAPABILITIES.has(capabilityKey)) {
    console.warn(`Warning: Unknown capability key "${capabilityKey}". Valid keys: ${[...VALID_CAPABILITIES].join(', ')}.`);
    return false;
  }

  return Boolean(profile[capabilityKey]);
}

// ── Canonical Result Envelope ───────────────────────────────────────────────────

/**
 * Creates a canonical result envelope for both CLI and HTTP adapters.
 * @param {Object} params - Result parameters
 * @returns {Object} Result envelope with standardized fields
 */
function makeResultEnvelope({ ok, providerId, family, outputText, error, warnings, timing, metadata } = {}) {
  const now = Date.now();
  return {
    ok: Boolean(ok),
    providerId: String(providerId || ''),
    family: String(family || 'cli'),
    outputText: String(outputText || ''),
    error: error || null,
    warnings: Array.isArray(warnings) ? warnings : [],
    timing: {
      startedAt: timing?.startedAt || now,
      finishedAt: timing?.finishedAt || now,
      durationMs: timing?.durationMs || 0
    },
    metadata: metadata || {}
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableHttpErrorType(errorType) {
  return errorType === 'server_error'
    || errorType === 'timeout'
    || errorType === 'connection_failure'
    || errorType === 'rate_limited';
}

function attachRetryMetadata(result, retryCount, lastErrorType) {
  return {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      retryCount,
      lastErrorType: lastErrorType || null
    }
  };
}

function splitRequestDefaults(requestDefaults) {
  const defaults = requestDefaults && typeof requestDefaults === 'object' ? requestDefaults : {};
  const transport = {};
  const payload = {};

  for (const [key, value] of Object.entries(defaults)) {
    if (key === 'timeoutMs') {
      transport.timeoutMs = value;
      continue;
    }
    payload[key] = value;
  }

  return { transport, payload };
}

function buildRequestBody(providerConfig, promptText) {
  const { payload } = splitRequestDefaults(providerConfig.requestDefaults);
  const chatTemplateMode = providerConfig.chatTemplateMode || 'openai';

  if (chatTemplateMode === 'raw') {
    const body = {
      model: providerConfig.model,
      prompt: promptText,
      ...payload
    };

    if (!body.model) {
      body.model = providerConfig.model;
    }

    if (typeof body.prompt !== 'string') {
      body.prompt = String(promptText || '');
    }

    return body;
  }

  const body = {
    model: providerConfig.model,
    messages: [{ role: 'user', content: promptText }],
    ...payload
  };

  if (!body.model) {
    body.model = providerConfig.model;
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    body.messages = [{ role: 'user', content: promptText }];
  }

  return body;
}


async function runWithRetry(requestFn, retryPolicy) {
  const retryWarnings = [];
  let lastResult = null;
  let lastErrorType = null;

  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    lastResult = await requestFn(attempt);
    if (lastResult?.ok) {
      if (retryWarnings.length) {
        lastResult.warnings = [...(lastResult.warnings || []), ...retryWarnings];
      }
      return attachRetryMetadata(lastResult, retryWarnings.length, lastErrorType);
    }

    const errorType = lastResult?.error?.type || 'unknown_error';
    lastErrorType = errorType;
    const hasAttemptsRemaining = attempt < retryPolicy.maxAttempts;
    if (!hasAttemptsRemaining || !isRetryableHttpErrorType(errorType)) {
      if (retryWarnings.length) {
        lastResult.warnings = [...(lastResult.warnings || []), ...retryWarnings];
      }
      return attachRetryMetadata(lastResult, retryWarnings.length, lastErrorType);
    }

    retryWarnings.push(`Retried after ${errorType} (attempt ${attempt} of ${retryPolicy.maxAttempts})`);
    const backoffMs = errorType === 'rate_limited'
      ? retryPolicy.backoffMs * 2
      : retryPolicy.backoffMs;
    await delay(backoffMs);
  }

  if (retryWarnings.length && lastResult) {
    lastResult.warnings = [...(lastResult.warnings || []), ...retryWarnings];
  }
  return attachRetryMetadata(lastResult, retryWarnings.length, lastErrorType);
}

// ── HTTP Provider Execution ─────────────────────────────────────────────────────

/**
 * Executes a chat completion request against an OpenAI-compatible HTTP provider.
 * @param {Object} providerConfig - Normalized provider config from config.providers
 * @param {string} promptText - The user prompt to send
 * @returns {Promise<Object>} Result envelope with the response
 */
async function runHttpProviderOnce(providerConfig, promptText, parsedUrl) {
  const providerId = providerConfig.id || 'unknown';
  const startedAt = Date.now();
  const httpModule = parsedUrl.protocol === 'https:' ? https : http;
  const defaultTimeout = 30000;
  const { transport } = splitRequestDefaults(providerConfig.requestDefaults);
  const timeoutMs = transport.timeoutMs || defaultTimeout;
  const chatTemplateMode = providerConfig.chatTemplateMode || 'openai';

  // Build request body based on chatTemplateMode and payload defaults only.
  const requestBody = buildRequestBody(providerConfig, promptText);


  // Build the full path: strip trailing slash from baseUrl path, then append endpoint
  const basePath = parsedUrl.pathname.replace(/\/$/, '');
  const endpointPath = chatTemplateMode === 'raw'
    ? '/completions'
    : '/chat/completions';
  const requestPath = basePath + endpointPath + (parsedUrl.search || '');

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: requestPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    timeout: timeoutMs
  };

  // Add auth header if apiKey is present
  if (providerConfig.apiKey) {
    options.headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const req = httpModule.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        const finishedAt = Date.now();

        // Handle auth failures
        if (res.statusCode === 401 || res.statusCode === 403) {
          settle(makeResultEnvelope({
            ok: false,
            providerId,
            family: 'http',
            outputText: data,
            error: {
              type: 'auth_failure',
              message: `Authentication failed: ${res.statusCode}`,
              statusCode: res.statusCode
            },
            timing: { startedAt, finishedAt, durationMs: finishedAt - startedAt }
          }));
          return;
        }

        // Handle bad requests
        if (res.statusCode === 400) {
          settle(makeResultEnvelope({
            ok: false,
            providerId,
            family: 'http',
            outputText: data,
            error: {
              type: 'bad_request',
              message: `Bad request: ${res.statusCode}`,
              statusCode: res.statusCode
            },
            timing: { startedAt, finishedAt, durationMs: finishedAt - startedAt }
          }));
          return;
        }

        if (res.statusCode === 429) {
          settle(makeResultEnvelope({
            ok: false,
            providerId,
            family: 'http',
            outputText: data,
            error: {
              type: 'rate_limited',
              message: `Rate limited: ${res.statusCode}`,
              statusCode: res.statusCode
            },
            timing: { startedAt, finishedAt, durationMs: finishedAt - startedAt }
          }));
          return;
        }

        // Handle server errors
        if (res.statusCode >= 500) {
          settle(makeResultEnvelope({
            ok: false,
            providerId,
            family: 'http',
            outputText: data,
            error: {
              type: 'server_error',
              message: `Server error: ${res.statusCode}`,
              statusCode: res.statusCode
            },
            timing: { startedAt, finishedAt, durationMs: finishedAt - startedAt }
          }));
          return;
        }

        // Handle success
        if (res.statusCode === 200) {
          try {
            const jsonResponse = JSON.parse(data);
            const outputText = chatTemplateMode === 'raw'
              ? (jsonResponse.choices?.[0]?.text || '')
              : (jsonResponse.choices?.[0]?.message?.content || '');

            settle(makeResultEnvelope({
              ok: true,
              providerId,
              family: 'http',
              outputText,
              timing: { startedAt, finishedAt, durationMs: finishedAt - startedAt },
              metadata: {
                model: jsonResponse.model || providerConfig.model,
                finishReason: jsonResponse.choices?.[0]?.finish_reason || null,
                usage: jsonResponse.usage || null
              }
            }));
          } catch (parseError) {
            settle(makeResultEnvelope({
              ok: false,
              providerId,
              family: 'http',
              outputText: data,
              error: {
                type: 'malformed_response',
                message: `Failed to parse JSON response: ${parseError.message}`
              },
              timing: { startedAt, finishedAt, durationMs: finishedAt - startedAt }
            }));
          }
        } else {
          // Handle other non-200, non-error status codes
          settle(makeResultEnvelope({
            ok: false,
            providerId,
            family: 'http',
            outputText: data,
            error: {
              type: 'bad_request',
              message: `Unexpected status code: ${res.statusCode}`,
              statusCode: res.statusCode
            },
            timing: { startedAt, finishedAt, durationMs: finishedAt - startedAt }
          }));
        }
      });
    });

    // Handle socket timeout
    req.on('socket', (socket) => {
      socket.setTimeout(timeoutMs, () => {
        req.destroy();
      });
    });

    req.on('timeout', () => {
      settle(makeResultEnvelope({
        ok: false,
        providerId,
        family: 'http',
        outputText: '',
        error: {
          type: 'timeout',
          message: `Request timed out after ${timeoutMs}ms`
        },
        timing: { startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt }
      }));
    });

    req.on('error', (error) => {
      const finishedAt = Date.now();
      let errorType = 'connection_failure';

      if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
        errorType = 'timeout';
      } else if (error.code === 'ECONNREFUSED') {
        errorType = 'connection_failure';
      }

      settle(makeResultEnvelope({
        ok: false,
        providerId,
        family: 'http',
        outputText: '',
        error: {
          type: errorType,
          message: error.message,
          code: error.code
        },
        timing: { startedAt, finishedAt, durationMs: finishedAt - startedAt }
      }));
    });

    // Write request body and end
    req.write(JSON.stringify(requestBody));
    req.end();
  });
}

async function runHttpProvider(providerConfig, promptText) {
  const providerId = providerConfig.id || 'unknown';
  const startedAt = Date.now();
  let retryPolicy;

  let parsedUrl;
  try {
    parsedUrl = new URL(providerConfig.baseUrl);
  } catch (error) {
    return makeResultEnvelope({
      ok: false,
      providerId,
      family: 'http',
      outputText: '',
      error: {
        type: 'bad_request',
        message: `Invalid baseUrl: ${error.message}`
      },
      timing: { startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt }
    });
  }

  try {
    retryPolicy = normalizeRetryPolicy(providerConfig.retryPolicy);
  } catch (error) {
    return makeResultEnvelope({
      ok: false,
      providerId,
      family: 'http',
      outputText: '',
      error: {
        type: 'bad_request',
        message: error.message
      },
      timing: { startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt }
    });
  }

  const result = await runWithRetry(
    () => runHttpProviderOnce(providerConfig, promptText, parsedUrl),
    retryPolicy
  );
  const finishedAt = Date.now();

  return {
    ...result,
    timing: {
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt
    }
  };
}

// ── HTTP Provider Readiness Checks ───────────────────────────────────────────────

/**
 * Performs a readiness check on an HTTP provider before execution.
 * Checks health endpoint (if configured) and /v1/models endpoint.
 *
 * Readiness logic (per Commit 7):
 * 1. If healthEndpoint is configured, make a GET request to <baseUrl><healthEndpoint>.
 *    A 200 response means ready. Any other result falls through to step 2.
 * 2. Make a GET /v1/models request to <baseUrl>/v1/models. Parse response as JSON.
 *    If it contains a data array that includes the configured model name, provider is ready.
 * 3. If both checks fail, return ready: false with a classified failure reason.
 *
 * @param {Object} providerConfig - Normalized provider config from config.providers
 * @returns {Promise<Object>} Readiness result with status and failure reason if not ready
 */
async function checkProviderReadiness(providerConfig) {
  const providerId = providerConfig.id || 'unknown';
  const checkedAt = Date.now();
  const defaultTimeout = 10000;

  // Parse baseUrl to determine http vs https
  let parsedUrl;
  try {
    parsedUrl = new URL(providerConfig.baseUrl);
  } catch (error) {
    return {
      ready: false,
      providerId,
      checkedAt,
      modelConfirmed: false,
      rawModels: [],
      failureReason: 'connection_failure',
      error: `Invalid baseUrl: ${error.message}`
    };
  }

  const httpModule = parsedUrl.protocol === 'https:' ? https : http;
  const timeoutMs = providerConfig.requestDefaults?.timeoutMs || defaultTimeout;

  // Build the base path from baseUrl (preserves any path component like /v1)
  // For example: http://localhost:8000/v1 -> basePath = '/v1'
  const basePath = parsedUrl.pathname.replace(/\/$/, '');

  /**
   * Makes a GET request to the specified endpoint path.
   * The path is appended to the baseUrl's base path.
   * For example: baseUrl = http://host/v1, endpoint = /health/ready -> /v1/health/ready
   *
   * @param {string} endpoint - The endpoint path (e.g., '/health/ready' or '/v1/models')
   * @returns {Promise<Object>} Result with statusCode, data, and error (if any)
   */
  function makeGetRequest(endpoint) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      // Construct full path by concatenating basePath and endpoint
      // This ensures baseUrl's path is preserved (e.g., /v1 from http://host/v1)
      let requestPath = endpoint;
      if (basePath && !endpoint.startsWith(basePath)) {
        // Remove leading slash from endpoint to avoid double slashes
        const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
        requestPath = `${basePath}/${cleanEndpoint}`;
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: requestPath,
        method: 'GET',
        headers: {},
        timeout: timeoutMs
      };

      // Add auth header if apiKey is present
      if (providerConfig.apiKey) {
        options.headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;
      }

      const req = httpModule.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          finish({
            statusCode: res.statusCode,
            data,
            error: null
          });
        });
      });

      req.on('socket', (socket) => {
        socket.setTimeout(timeoutMs, () => {
          finish({
            statusCode: null,
            data: '',
            error: 'timeout'
          });
          req.destroy();
        });
      });

      req.on('timeout', () => {
        finish({
          statusCode: null,
          data: '',
          error: 'timeout'
        });
      });

      req.on('error', (error) => {
        let failureReason = 'connection_failure';
        if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
          failureReason = 'timeout';
        } else if (error.code === 'ECONNREFUSED') {
          failureReason = 'connection_failure';
        }

        finish({
          statusCode: null,
          data: '',
          error: failureReason
        });
      });

      req.end();
    });
  }

  // Step 1: Check health endpoint if configured
  // Per spec: A 200 response means ready. Any other result falls through to step 2.
  if (providerConfig.healthEndpoint) {
    const healthResult = await makeGetRequest(providerConfig.healthEndpoint);

    if (healthResult.statusCode === 200) {
      return {
        ready: true,
        providerId,
        checkedAt,
        modelConfirmed: false,
        rawModels: [],
        failureReason: null,
        error: null
      };
    }
    // For any non-200 status code (including 5xx, timeout, connection_failure, auth_failure),
    // fall through to /v1/models check as specified in Commit 7.
  }

  // Step 2: Check /v1/models endpoint
  const modelsResult = await makeGetRequest('/v1/models');

  // Determine final result based on /v1/models.
  // Priority of failure reasons (as specified in Commit 7):
  // 1. auth_failure - strongest signal, indicates credential issue
  // 2. malformed_response - server reachable but response is invalid
  // 3. model_not_found - server reachable but model missing
  // 4. timeout - server did not respond in time
  // 5. connection_failure - could not reach the server at all

  if (modelsResult.statusCode === 401 || modelsResult.statusCode === 403) {
    return {
      ready: false,
      providerId,
      checkedAt,
      modelConfirmed: false,
      rawModels: [],
      failureReason: 'auth_failure',
      error: `/v1/models returned ${modelsResult.statusCode}`
    };
  }

  if (modelsResult.error === 'timeout') {
    return {
      ready: false,
      providerId,
      checkedAt,
      modelConfirmed: false,
      rawModels: [],
      failureReason: 'timeout',
      error: '/v1/models check timed out'
    };
  }

  if (modelsResult.error === 'connection_failure') {
    return {
      ready: false,
      providerId,
      checkedAt,
      modelConfirmed: false,
      rawModels: [],
      failureReason: 'connection_failure',
      error: 'Could not reach /v1/models endpoint'
    };
  }

  if (modelsResult.statusCode !== 200) {
    return {
      ready: false,
      providerId,
      checkedAt,
      modelConfirmed: false,
      rawModels: [],
      failureReason: 'malformed_response',
      error: `/v1/models returned unexpected status ${modelsResult.statusCode}`
    };
  }

  // Parse models response
  let modelsData = [];
  let parseError = null;
  try {
    const parsed = JSON.parse(modelsResult.data || '');
    if (!parsed.data || !Array.isArray(parsed.data)) {
      parseError = 'Response JSON did not contain a data array.';
    } else {
      modelsData = parsed.data;
    }
  } catch (e) {
    parseError = e.message;
  }

  if (parseError) {
    return {
      ready: false,
      providerId,
      checkedAt,
      modelConfirmed: false,
      rawModels: [],
      failureReason: 'malformed_response',
      error: `Failed to parse /v1/models response: ${parseError}`
    };
  }

  // Extract model names (handles both { id: "..." } and { model: "..." } formats)
  const rawModels = modelsData.map(m => m.id || m.model || String(m)).filter(Boolean);

  // Check if configured model is in the list
  const configuredModel = providerConfig.model;
  const modelConfirmed = rawModels.some(m => {
    const modelName = String(m).toLowerCase();
    const configured = String(configuredModel).toLowerCase();
    return modelName === configured || modelName.includes(configured) || configured.includes(modelName);
  });

  if (!modelConfirmed) {
    return {
      ready: false,
      providerId,
      checkedAt,
      modelConfirmed: false,
      rawModels,
      failureReason: 'model_not_found',
      error: `Configured model "${configuredModel}" not found in /v1/models response`
    };
  }

  // Ready!
  return {
    ready: true,
    providerId,
    checkedAt,
    modelConfirmed,
    rawModels,
    failureReason: null,
    error: null
  };
}

// ── Existing Adapter Configs ───────────────────────────────────────────────────

const adapterConfigs = {
  claude: require('./claude.config'),
  codex: require('./codex.config'),
  gemini: require('./gemini.config'),
  kilo: require('./kilo.config'),
  qwen: require('./qwen.config'),
  opencode: require('./opencode.config')
};

// Returns the declarative config for a supported agent.
// Throws for unknown agents.
function getAdapterConfig(agentName) {
  const agent = String(agentName).trim().toLowerCase();
  const config = adapterConfigs[agent];
  if (!config) {
    throw new Error(`No adapter config found for agent "${agentName}".`);
  }
  return config;
}

// Registry of all child processes currently running under this module.
// Used for graceful cleanup on unexpected exit.
const activeProcesses = new Set();

// TTL cache for preflight auth checks. Keyed by agent name + resolved path
// so environment/path changes don't reuse stale entries.
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Kill a process and its subprocess tree.
// Windows: uses taskkill /T /F for reliable tree termination.
// Non-Windows: direct kill only (no detached process groups to target in this codebase).
function killProcessTree(child, signal) {
  if (!child || !child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      // taskkill failed — fall back to direct kill
      try { child.kill(signal); } catch { /* already dead */ }
    }
    return;
  }

  // Non-Windows: direct kill only.
  // Future enhancement: add negative-PID Unix process-group kill if we later spawn detached groups.
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
}

function killAllActiveProcesses() {
  for (const child of activeProcesses) {
    killProcessTree(child, 'SIGTERM');
  }
}

// Signal cleanup: kill all tracked children, schedule a SIGKILL escalation for
// stragglers, then re-raise so Node exits with the correct signal.
// process.once guarantees the listener is already removed before this runs, so
// re-raising restores the default termination behavior.
// Note: on Windows, process.kill(pid, signal) unconditionally terminates the
// process regardless of the signal name — this is the correct behavior for
// graceful shutdown, even though the exit code won't match Unix signal semantics.
function cleanup(signal) {
  const pending = [...activeProcesses];
  killAllActiveProcesses();

  // Best-effort escalation in case any child ignored SIGTERM.
  // Unref'd so the timer does not prevent the process from exiting.
  if (pending.length > 0) {
    setTimeout(() => {
      for (const child of pending) {
        killProcessTree(child, 'SIGKILL');
      }
    }, 5000).unref();
  }

  // Re-raise to exit with the proper signal now that the listener is removed.
  // On Windows, process.kill(pid, signal) unconditionally terminates the process
  // rather than delivering a Unix signal — the exit code won't reflect the signal,
  // but the process will stop, which is the desired behavior.
  process.kill(process.pid, signal);
}

// Guard against duplicate registration across require.cache evictions (e.g. in tests).
// Module-local variables reset on re-require, so the flag lives on process itself.
if (!process.__aibridgeSignalHandlersRegistered) {
  process.__aibridgeSignalHandlersRegistered = true;
  process.once('SIGINT', () => cleanup('SIGINT'));
  process.once('SIGTERM', () => cleanup('SIGTERM'));
}

const POWER_SHELL_CONSTRAINED_WARNING_PATTERNS = [
  /^Cannot set property\. Property setting is supported only on core types in this language mode\.\s*$/gm,
  /^At line:1 char:1\s*$/gm,
  /^\s*\+\s*\[Console\]::OutputEncoding=\[System\.Text\.Encoding\]::UTF8;\s*$/gm,
  /^\s*\+\s*~+\s*$/gm,
  /^\s*\+\s*CategoryInfo\s+: InvalidOperation: \(:\) \[\], RuntimeException\s*$/gm,
  /^\s*\+\s*FullyQualifiedErrorId\s+: PropertySetterNotSupportedInConstrainedLanguage\s*$/gm
];

const GEMINI_TRANSIENT_NOISE_PATTERNS = [
  /^Loaded cached credentials\.\s*$/gm,
  /^Attempt \d+ failed.*$/gm
];

const KILO_TRANSIENT_NOISE_PATTERNS = [
  /^ERROR .*service=models\.dev error=.*$/gm
];

const DISPLAY_TEXT_REPLACEMENTS = new Map([
  ['→', '->'],
  ['—', '-'],
  ['–', '-'],
  ['“', '"'],
  ['”', '"'],
  ['‘', "'"],
  ['’', "'"]
]);

async function runAgent(agentName, options) {
  const adapter = getAdapter(agentName);
  const resolved = adapter.resolve();

  // Resolve model and effort once here, so both primary and fallback
  // builders share the same intent validation and warning set.
  const resolvedModelArgs = options.model != null
    ? resolveModelArgs(agentName, options.model)
    : { args: [], warnings: [] };
  const resolvedEffortArgs = options.effort != null
    ? resolveEffortArgs(agentName, options.model || null, options.effort)
    : { args: [], warnings: [] };
  const resolvedExtraOptionArgs = resolveExtraOptionArgs(agentName, options.agentOptions || {});
  const invocationWarnings = [
    ...resolvedModelArgs.warnings,
    ...resolvedEffortArgs.warnings,
    ...resolvedExtraOptionArgs.warnings
  ];

  // Emit warnings to console once, before any invocation runs.
  for (const w of invocationWarnings) {
    const msg = formatAgentWarning(agentName, w, options.model || null, options.effort || null);
    if (msg) console.warn(msg);
  }

  // Pass resolved args through options so builders don't need to re-resolve.
  const enhancedOptions = {
    ...options,
    resolvedModelArgs,
    resolvedEffortArgs,
    resolvedExtraOptionArgs,
    warnings: invocationWarnings
  };

  const invocation = adapter.buildInvocation(resolved, enhancedOptions);
  let result = await runProcess({ ...invocation, signal: options.signal });

  const fallbackChain = adapter.getFallbackChain
    ? adapter.getFallbackChain(resolved, enhancedOptions)
    : [];

  let initialAttempt = null;
  let fallbackTier = 0;
  let fallbackReason = null;
  let lastFallbackInvocation = null;

  for (const { invocation: fallbackInvocation, shouldRetry } of fallbackChain) {
    const reason = shouldRetry(result);
    if (!reason) {
      break;
    }

    if (!initialAttempt) {
      fallbackReason = reason;
      initialAttempt = {
        command: result.command,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        outputText: result.outputText,
        error: result.error || null
      };
    }

    fallbackTier += 1;
    lastFallbackInvocation = fallbackInvocation;
    result = await runProcess({ ...fallbackInvocation, signal: options.signal });
  }

  if (initialAttempt) {
    const fallbackDowngrades = (lastFallbackInvocation && lastFallbackInvocation.capabilityDowngrades) || [];

    // Wrap CLI result in envelope, preserving all existing fields
    const envelope = makeResultEnvelope({
      ok: result.ok,
      providerId: agentName,
      family: 'cli',
      outputText: result.outputText,
      error: result.error,
      warnings: invocationWarnings,
      timing: {
        startedAt: Date.now() - result.durationMs,
        finishedAt: Date.now(),
        durationMs: result.durationMs
      },
      metadata: {}
    });

    return {
      ...envelope,
      // Preserve CLI-specific fields
      command: result.command,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      stdout: result.stdout,
      stderr: result.stderr,
      usedFallback: true,
      fallbackTier,
      fallbackReason,
      initialAttempt,
      capabilityDowngrades: fallbackDowngrades
    };
  }

  // Wrap CLI result in envelope, preserving all existing fields
  const envelope = makeResultEnvelope({
    ok: result.ok,
    providerId: agentName,
    family: 'cli',
    outputText: result.outputText,
    error: result.error,
    warnings: invocationWarnings,
    timing: {
      startedAt: Date.now() - result.durationMs,
      finishedAt: Date.now(),
      durationMs: result.durationMs
    },
    metadata: {}
  });

  return {
    ...envelope,
    // Preserve CLI-specific fields
    command: result.command,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function getAuthCacheKey(agentName, resolvedPath) {
  const normalizedPath = process.platform === 'win32'
    ? String(resolvedPath).toLowerCase()
    : String(resolvedPath);
  return `${String(agentName).toLowerCase()}::${normalizedPath}`;
}

function clearAuthCache() {
  authCache.clear();
}

async function resolveAgents(agentNames, options = {}) {
  const uniqueAgents = [...new Set(agentNames)];
  const preflightTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
  const errors = await Promise.all(uniqueAgents.map(async (name) => {
    try {
      const adapter = getAdapter(name);
      const resolved = adapter.resolve();
      if (!adapter.buildPreflightInvocation) {
        return null;
      }

      const cacheKey = getAuthCacheKey(name, resolved);
      const cached = authCache.get(cacheKey);
      if (cached && (Date.now() - cached.checkedAt) < AUTH_CACHE_TTL_MS) {
        if (cached.valid) {
          return null;
        }
        // Stale negative entry — fall through to retry.
        authCache.delete(cacheKey);
      }

      const result = await runProcess(adapter.buildPreflightInvocation(resolved, {
        cwd: options.cwd || process.cwd(),
        timeoutMs: preflightTimeoutMs
      }));

      // Commit 13b: Annotate result with readinessKind before using it
      const annotatedResult = annotatePreflightResult(result, name);
      const { readinessKind } = annotatedResult;

      if (readinessKind === 'ok') {
        // Only cache when actually ok (has usable output)
        authCache.set(cacheKey, { valid: true, checkedAt: Date.now() });
        return null;
      }

      // Do not cache failures — clear immediately so the next call retries.
      authCache.delete(cacheKey);

      // All other readinessKinds are failures - use annotated result for error formatting
      const errorMessage = formatPreflightError(name, readinessKind, annotatedResult);
      return errorMessage || `Agent "${name}" failed preflight. ${summarizePreflightFailure(annotatedResult)}`;
    } catch (error) {
      // Check if this is a command-not-found error from resolve()
      if (error.message.includes('Could not resolve') || error.message.includes('command not found')) {
        const errorMessage = formatPreflightError(name, 'command_not_found', null);
        return errorMessage || error.message;
      }
      // Other errors (unsupported agent, etc.)
      return error.message;
    }
  }));

  const actualErrors = errors.filter(Boolean);
  if (actualErrors.length > 0) {
    throw new Error(`Preflight agent check failed:\n${actualErrors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

function getAdapter(agentName) {
  const agent = String(agentName).trim().toLowerCase();
  const adapter = adapters[agent];

  if (!adapter) {
    throw new Error(`Unsupported agent "${agentName}".`);
  }

  return adapter;
}

function quoteForWindowsCmdArg(value) {
  const text = String(value || '');
  if (!text) {
    return '""';
  }
  if (!/[\s"&<>|^]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

function buildWindowsCommandLine(command, args = []) {
  return [command, ...args].map(quoteForWindowsCmdArg).join(' ');
}

function runProcess({ command, args, cwd, timeoutMs, env, displayCommand, earlyExitClassifier, signal }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    // If the caller already aborted before we started, resolve immediately.
    if (signal && signal.aborted) {
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: true,
        error: { message: 'Aborted before start', code: null },
        stdout: '',
        stderr: '',
        outputText: '',
        command: displayCommand,
        durationMs: 0,
        fatalOutputReason: null
      });
      return;
    }

    // Windows .cmd/.bat wrappers are not directly executable — they require
    // a shell (cmd.exe) to interpret them. This arises when resolveFromPath()
    // finds a .cmd shim on PATH for Codex, Gemini, Qwen, or Kilo.
    const useWindowsCommandWrapper = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const spawnCommand = useWindowsCommandWrapper ? (process.env.ComSpec || 'cmd.exe') : command;
    const spawnArgs = useWindowsCommandWrapper
      ? ['/d', '/s', '/c', buildWindowsCommandLine(command, args)]
      : args;

    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });

    activeProcesses.add(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let earlyExitReason = null;
    let aborted = false;
    let escalationTimer = null;

    const scheduleKillEscalation = () => {
      if (escalationTimer) {
        return;
      }

      escalationTimer = setTimeout(() => {
        escalationTimer = null;
        killProcessTree(child, 'SIGKILL');
      }, 5000);

      escalationTimer.unref();
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      aborted = true;
      killProcessTree(child, 'SIGTERM');
      scheduleKillEscalation();
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (payload) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      if (escalationTimer) {
        clearTimeout(escalationTimer);
        escalationTimer = null;
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      activeProcesses.delete(child);
      resolve({
        ...payload,
        aborted,
        stdout,
        stderr,
        outputText: combineOutput(stdout, stderr),
        command: displayCommand,
        durationMs: Date.now() - startedAt,
        fatalOutputReason: earlyExitReason
      });
    };

    const maybeAbortOnFatalOutput = () => {
      if (timedOut || settled || earlyExitReason || typeof earlyExitClassifier !== 'function') {
        return;
      }

      const combined = combineOutput(stdout, stderr);
      const reason = earlyExitClassifier(combined);
      if (!reason) {
        return;
      }

      earlyExitReason = reason;
      killProcessTree(child, 'SIGTERM');
      scheduleKillEscalation();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGTERM');
      scheduleKillEscalation();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      maybeAbortOnFatalOutput();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      maybeAbortOnFatalOutput();
    });

    child.on('error', (error) => {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        error: {
          message: error.message,
          code: error.code || null
        }
      });
    });

    child.on('close', (exitCode, signalName) => {
      if (earlyExitReason) {
        finish({
          ok: false,
          exitCode: 1,
          signal: signalName,
          timedOut: false,
          error: {
            message: `Process aborted after fatal output (${earlyExitReason})`,
            code: 1
          }
        });
        return;
      }

      finish({
        ok: !timedOut && exitCode === 0 && !aborted,
        exitCode,
        signal: signalName,
        timedOut,
        error: !timedOut && exitCode === 0 && !aborted
          ? null
          : {
              message: aborted
                ? 'Process aborted'
                : timedOut
                ? `Process timed out after ${timeoutMs}ms`
                : `Process exited with code ${exitCode}`,
              code: exitCode
            }
      });
    });
  });
}

function combineOutput(stdout, stderr) {
  const output = [normalizeDisplayText(stripBenignShellNoise(stdout)).trim(), normalizeDisplayText(stripBenignShellNoise(stderr)).trim()]
    .filter(Boolean)
    .join('\n\n');
  return output.trim();
}

function stripBenignShellNoise(text) {
  let cleaned = stripGeminiTransientNoise(String(text || ''));
  cleaned = stripKiloTransientNoise(cleaned);

  for (const pattern of POWER_SHELL_CONSTRAINED_WARNING_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function stripGeminiTransientNoise(text) {
  let cleaned = String(text || '');

  const trailingMarkers = [
    '\nGaxiosError:',
    '\nError when talking to Gemini API',
    '\nAn unexpected critical error occurred:'
  ];

  for (const marker of trailingMarkers) {
    const index = cleaned.indexOf(marker);
    if (index > 0) {
      cleaned = cleaned.slice(0, index);
    }
  }

  for (const pattern of GEMINI_TRANSIENT_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  return cleaned;
}

function stripKiloTransientNoise(text) {
  let cleaned = String(text || '');

  for (const pattern of KILO_TRANSIENT_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  return cleaned;
}

function normalizeDisplayText(text) {
  let normalized = normalizeUnicode(String(text || ''));
  normalized = repairCommonMojibake(normalized);
  normalized = normalized.replace(/\u00c2\u00b7/g, '\u00b7');
  normalized = normalized.replace(/\u00e2\u2020(?:\u2122|\u2019|')/g, '->');

  for (const [needle, replacement] of DISPLAY_TEXT_REPLACEMENTS.entries()) {
    normalized = normalized.split(needle).join(replacement);
  }

  return normalized;
}

function normalizeUnicode(text) {
  const value = String(text || '');
  return typeof value.normalize === 'function' ? value.normalize('NFC') : value;
}

function repairCommonMojibake(text) {
  const value = String(text || '');
  if (!looksLikeMojibake(value)) {
    return value;
  }

  const candidates = [];

  // Attempt 1: latin1 byte reinterpretation.
  try {
    candidates.push(Buffer.from(value, 'latin1').toString('utf8'));
  } catch {
    // ignore
  }

  // Attempt 2: cp1252-like reinterpretation (handles †, ’, “, ”, etc.).
  const cp1252Bytes = tryEncodeCp1252Bytes(value);
  if (cp1252Bytes) {
    try {
      candidates.push(Buffer.from(cp1252Bytes).toString('utf8'));
    } catch {
      // ignore
    }
  }

  return chooseBestMojibakeRepair(value, candidates);
}

function looksLikeMojibake(text) {
  const value = String(text || '');
  // Typical markers for "UTF-8 decoded as latin1/cp1252" damage.
  return /[ÃÂ]/.test(value) || /â€|â€™|â€œ|â€�|â€“|â€”|â†/.test(value);
}

function countMojibakeMarkers(text) {
  const value = String(text || '');
  const matches = value.match(/[ÃÂ]|â€|â€™|â€œ|â€�|â€“|â€”|â†/g);
  return matches ? matches.length : 0;
}

function chooseBestMojibakeRepair(original, candidates) {
  const beforeMarkers = countMojibakeMarkers(original);
  if (beforeMarkers === 0) {
    return original;
  }

  let best = original;
  let bestMarkers = beforeMarkers;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string' || candidate === original) {
      continue;
    }
    if (candidate.includes('�')) {
      continue;
    }
    const afterMarkers = countMojibakeMarkers(candidate);
    if (afterMarkers < bestMarkers) {
      best = candidate;
      bestMarkers = afterMarkers;
    }
  }

  return best;
}

function tryEncodeCp1252Bytes(text) {
  const value = String(text || '');
  const bytes = [];

  // Minimal cp1252 extended mappings needed for common mojibake patterns.
  const cp1252 = new Map([
    ['€', 0x80],
    ['‚', 0x82],
    ['ƒ', 0x83],
    ['„', 0x84],
    ['…', 0x85],
    ['†', 0x86],
    ['‡', 0x87],
    ['ˆ', 0x88],
    ['‰', 0x89],
    ['Š', 0x8A],
    ['‹', 0x8B],
    ['Œ', 0x8C],
    ['Ž', 0x8E],
    ['‘', 0x91],
    ['’', 0x92],
    ['“', 0x93],
    ['”', 0x94],
    ['•', 0x95],
    ['–', 0x96],
    ['—', 0x97],
    ['˜', 0x98],
    ['™', 0x99],
    ['š', 0x9A],
    ['›', 0x9B],
    ['œ', 0x9C],
    ['ž', 0x9E],
    ['Ÿ', 0x9F]
  ]);

  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code <= 0xFF) {
      bytes.push(code);
      continue;
    }
    const mapped = cp1252.get(ch);
    if (mapped === undefined) {
      return null;
    }
    bytes.push(mapped);
  }

  return Uint8Array.from(bytes);
}

function summarizePreflightFailure(result) {
  if (result.timedOut) {
    return `Timed out after ${result.durationMs}ms while running ${result.command}.`;
  }

  const output = String(result.outputText || '').trim();
  const detail = output
    ? `Output: ${output.split(/\r?\n/).slice(0, 4).join(' ').trim()}`
    : (result.error && result.error.message) || 'The process exited without useful output.';

  return `Exit code ${result.exitCode === null ? 'n/a' : result.exitCode} while running ${result.command}. ${detail}`;
}

// Common auth error patterns across CLI adapters
const AUTH_ERROR_PATTERNS = [
  'not logged in',
  'please run /login',
  'authentication required',
  'unauthorized',
  'not authenticated',
  'auth login',
  'api key is missing',
  'google generative ai api key is missing',
  'google_generative_ai_api_key',
  'missing_api_key'
];

/**
 * Classifies a preflight result into a readiness kind.
 * @param {Object} result - The preflight result from runProcess
 * @param {string} agentName - The agent name for specific error patterns
 * @returns {string} One of: "ok", "command_not_found", "auth_failure", "unusable"
 */
function classifyPreflightResult(result, agentName) {
  const output = String(result.outputText || '');
  const outputLower = output.toLowerCase();

  // Check success first - a successful preflight with content is ok,
  // regardless of whether it mentions auth in help text
  if (result.ok && output.trim().length > 0) {
    return 'ok';
  }

  // Empty or whitespace-only output after successful exit is unusable
  if (result.ok) {
    return 'unusable';
  }

  // Only check for auth patterns on failed runs
  for (const pattern of AUTH_ERROR_PATTERNS) {
    if (outputLower.includes(pattern)) {
      return 'auth_failure';
    }
  }

  // Non-zero exit code with no recognizable pattern is unusable
  if (result.exitCode !== null && result.exitCode !== 0) {
    return 'unusable';
  }

  // Error during execution is unusable (not command not found - that's handled elsewhere)
  if (result.error && result.error.code === 'ENOENT') {
    return 'command_not_found';
  }

  return 'unusable';
}

/**
 * Annotates a preflight result with its classified readiness kind.
 * @param {Object} result - The preflight result from runProcess
 * @param {string} agentName - The agent name
 * @returns {Object} The enriched result with readinessKind attached
 */
function annotatePreflightResult(result, agentName) {
  return {
    ...result,
    readinessKind: classifyPreflightResult(result, agentName)
  };
}

/**
 * Formats a helpful error message based on the readiness kind.
 * @param {string} agentName - The agent name (e.g., "claude", "codex")
 * @param {string} readinessKind - The classified readiness kind
 * @param {Object} result - The preflight result for additional context
 * @returns {string} A helpful error message
 */
function formatPreflightError(agentName, readinessKind, result) {
  switch (readinessKind) {
    case 'command_not_found':
      if (agentName === 'claude') {
        return `claude: command not found. Is it installed? Run: npm install -g @anthropic-ai/claude-cli`;
      }
      if (agentName === 'codex') {
        return `codex: command not found. Is it installed? Run: npm install -g @openai/codex`;
      }
      if (agentName === 'gemini') {
        return `gemini: command not found. Is it installed? Run: npm install -g @google/gemini-cli`;
      }
      if (agentName === 'kilo' || agentName === 'kilocode') {
        return `${agentName}: command not found. Is it installed? Check the Kilo documentation for installation instructions.`;
      }
      if (agentName === 'qwen') {
        return `qwen: command not found. Is it installed? Run: npm install -g @qwen-code/qwen-code`;
      }
      if (agentName === 'opencode') {
        return `opencode: command not found. Is it installed? Check the Opencode documentation for installation instructions.`;
      }
      return `${agentName}: command not found. Please check that the agent is installed and available on PATH.`;

    case 'auth_failure':
      if (agentName === 'claude') {
        return `claude: found but not authenticated. Run: claude auth login`;
      }
      if (agentName === 'codex') {
        return `codex: found but not authenticated. Run: codex auth login`;
      }
      if (agentName === 'gemini') {
        return `gemini: found but not authenticated. Run: gemini auth login`;
      }
      if (agentName === 'kilo' || agentName === 'kilocode') {
        return `${agentName}: found but not authenticated. Run: ${agentName} auth login`;
      }
      if (agentName === 'qwen') {
        return `qwen: found but not authenticated. Run: qwen auth login`;
      }
      return `${agentName}: found but not authenticated. Please authenticate the agent.`;

    case 'unusable':
      const detail = result ? summarizePreflightFailure(result) : 'Unknown error.';
      return `${agentName}: found but not usable. ${detail}`;

    case 'ok':
      return '';

    default:
      return `${agentName}: preflight check failed.`;
  }
}

// ── Model / Effort resolution helpers ─────────────────────────────────────────

// Pure helper: returns a human-readable warning string for a given warning code.
// Returns null for effort_not_automatable (expected behavior, not a user error).
function formatAgentWarning(agentName, warningCode, requestedModel, requestedEffort) {
  switch (warningCode) {
    case 'fixed_model_only':
      return `Warning: agent "${agentName}" uses a fixed model. Requested model "${requestedModel}" will be ignored.`;
    case 'unsupported_model_option':
      return `Warning: agent "${agentName}" does not support model selection. Requested model "${requestedModel}" will be ignored.`;
    case 'unknown_model_value':
      return `Warning: agent "${agentName}" does not recognize model "${requestedModel}". The agent will use its default model.`;
    case 'unverified_model_value':
      return `Warning: agent "${agentName}" model "${requestedModel}" is passed through but not verified against known values.`;
    case 'unsupported_effort_option':
      return `Warning: agent "${agentName}" does not support effort selection. Requested effort "${requestedEffort}" will be ignored.`;
    case 'unknown_effort_value':
      return `Warning: agent "${agentName}" does not recognize effort "${requestedEffort}". Effort will not be applied.`;
    case 'unsupported_effort_for_model':
      return `Warning: effort "${requestedEffort}" is not supported for model "${requestedModel || 'default'}" on agent "${agentName}".`;
    case 'effort_not_automatable':
      return null;
    default:
      return `Warning [${agentName}]: ${warningCode}`;
  }
}

// Reads the adapter config for agentName and returns the write-mode CLI args
// based on canWrite. Returns string[].
// If the adapter has no writeMode config, returns [] — the caller must decide
// whether that's acceptable (e.g. Gemini has no write-mode, which is fine).
function resolveWriteModeArgs(agentName, canWrite) {
  const config = getAdapterConfig(agentName);
  const writeMode = config.writeMode;
  if (!writeMode) return [];
  return canWrite ? (writeMode.writable || []) : (writeMode.readOnly || []);
}

// Reads the adapter config for agentName and returns the CLI args needed to
// set the requested model, plus any warnings.
//
// Returns: { args: string[], warnings: string[] }
function resolveModelArgs(agentName, requestedModel) {
  const config = getAdapterConfig(agentName);
  const modelConfig = config.selection && config.selection.model;
  if (!modelConfig) {
    return { args: [], warnings: [] };
  }

  // No model requested → nothing to do
  if (requestedModel == null) {
    return { args: [], warnings: [] };
  }

  const mode = modelConfig.mode;

  // --- fixed mode ---
  if (mode === 'fixed') {
    const fixedValue = modelConfig.fixedValue || '';
    if (String(requestedModel).toLowerCase() !== String(fixedValue).toLowerCase()) {
      return { args: [], warnings: ['fixed_model_only'] };
    }
    return { args: [], warnings: [] };
  }

  // --- unsupported mode ---
  if (mode === 'unsupported') {
    return { args: [], warnings: ['unsupported_model_option'] };
  }

  // --- startup_flag mode ---
  if (mode === 'startup_flag') {
    const flag = modelConfig.flag || '--model';
    const values = modelConfig.values;
    const requestedLower = String(requestedModel).trim().toLowerCase();
    const defaultSentinels = Array.isArray(modelConfig.defaultSentinelValues)
      ? modelConfig.defaultSentinelValues.map((value) => String(value).trim().toLowerCase())
      : [];
    if (defaultSentinels.includes(requestedLower)) {
      return { args: [], warnings: [] };
    }

    // Open values: accept any model string
    if (values === 'open') {
      return { args: [flag, String(requestedModel)], warnings: [] };
    }

    // Enumerated values: values is an object with cliValue keys
    if (values && typeof values === 'object') {
      const matchedKey = Object.keys(values).find(k => k.toLowerCase() === requestedLower);
      if (matchedKey) {
        return { args: [flag, values[matchedKey].cliValue], warnings: [] };
      }
      // Pass through unverified models with a warning when the adapter config
      // declares passThrough (e.g. Claude's model values are pending verification).
      // Otherwise, reject with unknown_model_value.
      if (modelConfig.passThrough) {
        return {
          args: [flag, String(requestedModel)],
          warnings: modelConfig.warnOnPassThrough === false ? [] : ['unverified_model_value']
        };
      }
      return { args: [], warnings: ['unknown_model_value'] };
    }

    // Fallback: treat as open
    return { args: [flag, String(requestedModel)], warnings: [] };
  }

  // Unknown mode — safe default
  return { args: [], warnings: [] };
}

// Reads the adapter config for agentName and returns the CLI args needed to
// set the requested effort level, plus any warnings.
//
// Returns: { args: string[], warnings: string[] }
function resolveEffortArgs(agentName, requestedModel, requestedEffort) {
  const config = getAdapterConfig(agentName);
  const effortConfig = config.selection && config.selection.effort;
  if (!effortConfig) {
    return { args: [], warnings: [] };
  }

  // No effort requested → nothing to do
  if (requestedEffort == null) {
    return { args: [], warnings: [] };
  }

  const mode = effortConfig.mode;

  // --- unsupported mode ---
  if (mode === 'unsupported') {
    return { args: [], warnings: ['unsupported_effort_option'] };
  }

  // --- separate_flag mode ---
  if (mode === 'separate_flag') {
    const flag = effortConfig.flag || '--effort';
    const allowedValues = effortConfig.values || [];
    const effortLower = String(requestedEffort).toLowerCase();
    const isValid = allowedValues.some(v => String(v).toLowerCase() === effortLower);
    if (!isValid) {
      return { args: [], warnings: ['unknown_effort_value'] };
    }
    if (effortConfig.configKey) {
      return { args: [flag, `${effortConfig.configKey}="${String(requestedEffort)}"`], warnings: [] };
    }
    return { args: [flag, String(requestedEffort)], warnings: [] };
  }

  // --- model_dependent mode ---
  if (mode === 'model_dependent') {
    const modelConfig = config.selection && config.selection.model;
    const modelValues = modelConfig && modelConfig.values;

    if (!modelValues || typeof modelValues !== 'object') {
      // Cannot resolve model-dependent effort without model enum
      if (effortConfig.passThrough && effortConfig.flag) {
        return { args: [effortConfig.flag, String(requestedEffort)], warnings: [] };
      }
      return { args: [], warnings: ['effort_not_automatable'] };
    }

    // Resolve which model entry applies
    let modelEntry = null;
    let matchedKnownModel = false;
    if (requestedModel != null) {
      const requestedLower = String(requestedModel).toLowerCase();
      const matchedKey = Object.keys(modelValues).find(k => k.toLowerCase() === requestedLower);
      if (matchedKey) {
        modelEntry = modelValues[matchedKey];
        matchedKnownModel = true;
      }
    }
    // Only fall back to default model entry when no explicit model was requested.
    // If a model WAS requested but not recognized, we cannot validate effort
    // against the default — that would misrepresent effort semantics.
    if (!modelEntry && requestedModel == null && modelConfig && modelConfig.defaultValue) {
      const defaultKey = Object.keys(modelValues).find(k => k.toLowerCase() === String(modelConfig.defaultValue).toLowerCase());
      if (defaultKey) {
        modelEntry = modelValues[defaultKey];
        matchedKnownModel = true; // default IS a known model
      }
    }

    if (!modelEntry) {
      if (effortConfig.passThrough && effortConfig.flag) {
        return { args: [effortConfig.flag, String(requestedEffort)], warnings: [] };
      }
      return { args: [], warnings: ['effort_not_automatable'] };
    }

    // Check if effort is valid for this model
    const modelEfforts = modelEntry.efforts || [];
    const effortLower = String(requestedEffort).toLowerCase();
    const isValid = modelEfforts.some(e => String(e).toLowerCase() === effortLower);
    const flag = effortConfig.flag;

    if (!isValid) {
      if (effortConfig.passThrough && flag) {
        return { args: [flag, String(requestedEffort)], warnings: [] };
      }
      // Only report unsupported_effort_for_model when we matched a known model.
      // For unverified models, just say effort isn't automatable.
      if (matchedKnownModel) {
        return { args: [], warnings: ['unsupported_effort_for_model'] };
      }
      return { args: [], warnings: ['effort_not_automatable'] };
    }

    if (flag) {
      return { args: [flag, String(requestedEffort)], warnings: [] };
    }

    return { args: [], warnings: ['effort_not_automatable'] };
  }

  // Unknown mode — safe default
  return { args: [], warnings: [] };
}

// ── Claude ────────────────────────────────────────────────────────────────────

function resolveExtraOptionArgs(agentName, requestedOptions = {}) {
  const config = getAdapterConfig(agentName);
  const selection = config.selection || {};
  const args = [];
  const warnings = [];

  Object.entries(selection).forEach(([key, optionConfig]) => {
    if (key === 'model' || key === 'effort' || !optionConfig || typeof optionConfig !== 'object') {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(requestedOptions, key)) {
      return;
    }

    const rawValue = requestedOptions[key];
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      return;
    }

    if (optionConfig.mode === 'unsupported') {
      warnings.push(`unsupported_${key}_option`);
      return;
    }

    if (optionConfig.mode === 'fixed') {
      const fixedValue = optionConfig.fixedValue || '';
      if (String(rawValue).toLowerCase() !== String(fixedValue).toLowerCase()) {
        warnings.push(`fixed_${key}_only`);
      }
      return;
    }

    if (optionConfig.mode === 'boolean_flag') {
      if (rawValue === true) {
        args.push(optionConfig.flag || `--${key}`);
      }
      return;
    }

    if (optionConfig.mode === 'startup_flag') {
      const flag = optionConfig.flag || `--${key}`;
      const values = optionConfig.values;
      if (Array.isArray(values)) {
        const requestedLower = String(rawValue).toLowerCase();
        const matchedEntry = values.find((entry) => {
          const entryValue = typeof entry === 'string' ? entry : (entry && (entry.value || entry.id || entry.cliValue));
          return String(entryValue || '').toLowerCase() === requestedLower;
        });
        if (matchedEntry) {
          const cliValue = typeof matchedEntry === 'string'
            ? matchedEntry
            : (matchedEntry.cliValue || matchedEntry.value || matchedEntry.id);
          args.push(flag, cliValue);
          return;
        }
        if (!optionConfig.passThrough) {
          warnings.push(`unknown_${key}_value`);
          return;
        }
        args.push(flag, String(rawValue));
        return;
      }
      if (values && values !== 'open' && typeof values === 'object') {
        const requestedLower = String(rawValue).toLowerCase();
        const matchedKey = Object.keys(values).find(k => k.toLowerCase() === requestedLower);
        if (!matchedKey) {
          if (optionConfig.passThrough) {
            args.push(flag, String(rawValue));
            return;
          }
          warnings.push(`unknown_${key}_value`);
          return;
        }
        const cliValue = values[matchedKey] && values[matchedKey].cliValue
          ? values[matchedKey].cliValue
          : matchedKey;
        args.push(flag, cliValue);
        return;
      }
      args.push(flag, String(rawValue));
    }
  });

  return { args, warnings };
}

function buildClaudePrimaryInvocation(command, options) {
  const writeModeArgs = resolveWriteModeArgs('claude', options.canWrite);
  const modelArgs = options.resolvedModelArgs && options.resolvedModelArgs.args
    ? options.resolvedModelArgs.args
    : [];
  const effortArgs = options.resolvedEffortArgs && options.resolvedEffortArgs.args
    ? options.resolvedEffortArgs.args
    : [];
  const args = [
    '--bare',
    '--print',
    '--output-format',
    'text',
    ...writeModeArgs,
    '--no-session-persistence',
    ...modelArgs,
    ...effortArgs,
    options.prompt
  ];

  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${path.basename(command)} --bare --print --output-format text ${writeModeArgs.join(' ')} --no-session-persistence${modelArgs.length ? ' ' + modelArgs.join(' ') : ''} [prompt]`,
    warnings: options.warnings || []
  };
}

function buildClaudePreflightInvocation(command, options) {
  return {
    command,
    args: ['--help'],
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${path.basename(command)} --help`,
    warnings: []
  };
}

// Minimal fallback that drops --permission-mode and --no-session-persistence to
// isolate whether those flags are the cause of empty output.
function buildClaudeFallbackInvocation(command, options) {
  const args = [
    '--print',
    '--output-format',
    'text',
    options.prompt
  ];

  // This fallback drops write-mode flags and any model selection that the
  // primary invocation would have used. Record what was lost.
  const capabilityDowngrades = [];
  const modelArgs = options.resolvedModelArgs && options.resolvedModelArgs.args || [];
  if (modelArgs.length > 0) {
    capabilityDowngrades.push('model selection (--model dropped in fallback)');
  }
  const writeModeArgs = resolveWriteModeArgs('claude', options.canWrite);
  if (writeModeArgs.length > 0) {
    capabilityDowngrades.push(
      options.canWrite === true
        ? 'write mode (--permission-mode bypassPermissions dropped in fallback)'
        : 'read-only enforcement (--permission-mode plan dropped in fallback)'
    );
  }

  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${path.basename(command)} --print --output-format text [prompt]`,
    warnings: [],
    capabilityDowngrades
  };
}

const CLAUDE_RATE_LIMIT_PHRASES = [
  "you've hit your limit",
  'rate limit',
  'rate_limit',
  'too many requests',
  'usage limit'
];

function shouldRetryClaudeWithFallback(result) {
  const output = String(result && result.outputText || '').toLowerCase();
  const isRateLimited = CLAUDE_RATE_LIMIT_PHRASES.some((phrase) => output.includes(phrase));
  if (output.includes('not logged in') || output.includes('please run /login')) {
    if (isRateLimited) {
      return 'rate_limited';
    }
    return 'not_logged_in';
  }
  if (isRateLimited) {
    return 'rate_limited';
  }
  if (result && result.ok && !result.outputText) {
    return 'empty_output';
  }
  return false;
}

// ── Codex ─────────────────────────────────────────────────────────────────────

// Primary: full flags including --ask-for-approval and sandbox control.
function buildCodexPrimaryInvocation(entrypoint, options) {
  const writeModeArgs = resolveWriteModeArgs('codex', options.canWrite);
  const cliArgs = [
    '--ask-for-approval',
    'never',
    'exec',
    '--skip-git-repo-check',
    ...writeModeArgs,
    '--color',
    'never',
    '--cd',
    options.cwd
  ];
  const modelArgs = options.resolvedModelArgs && options.resolvedModelArgs.args || [];
  const effortArgs = options.resolvedEffortArgs && options.resolvedEffortArgs.args || [];
  cliArgs.push(...modelArgs, ...effortArgs);
  cliArgs.push(options.prompt);
  const { command, args, displayPrefix } = nodeOrDirect(entrypoint, cliArgs);

  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${displayPrefix} --ask-for-approval never exec --skip-git-repo-check ${writeModeArgs.join(' ')} --cd ${options.cwd} [prompt]`,
    warnings: options.warnings || []
  };
}

function buildCodexPreflightInvocation(entrypoint, options) {
  const cliArgs = ['exec', '--skip-git-repo-check', '--help'];
  const { command, args, displayPrefix } = nodeOrDirect(entrypoint, cliArgs);
  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${displayPrefix} exec --skip-git-repo-check --help`,
    warnings: []
  };
}

// Safe fallback: drops unsupported top-level flags but preserves exec-level
// sandbox and working-directory controls, which are the safety-relevant ones.
function buildCodexSafeFallbackInvocation(entrypoint, options) {
  const writeModeArgs = resolveWriteModeArgs('codex', options.canWrite);
  const cliArgs = [
    'exec',
    '--skip-git-repo-check',
    ...writeModeArgs,
    '--cd',
    options.cwd
  ];
  const modelArgs = options.resolvedModelArgs && options.resolvedModelArgs.args || [];
  const effortArgs = options.resolvedEffortArgs && options.resolvedEffortArgs.args || [];
  cliArgs.push(...modelArgs, ...effortArgs);
  cliArgs.push(options.prompt);
  const { command, args, displayPrefix } = nodeOrDirect(entrypoint, cliArgs);

  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${displayPrefix} exec --skip-git-repo-check ${writeModeArgs.join(' ')} --cd ${options.cwd} [prompt]`,
    warnings: [],
    capabilityDowngrades: []
  };
}

// Minimal fallback: last resort, no safety flags. Used only when both the
// primary and safe fallback fail with a CLI parse error, indicating the
// installed Codex version has a significantly different interface.
function buildCodexMinimalFallbackInvocation(entrypoint, options) {
  const cliArgs = [
    'exec',
    '--skip-git-repo-check',
    options.prompt
  ];
  const { command, args, displayPrefix } = nodeOrDirect(entrypoint, cliArgs);

  // This minimal fallback drops write mode, model selection, and effort selection.
  // Record what was lost so the step record stays honest.
  const capabilityDowngrades = [];
  const modelArgs = options.resolvedModelArgs && options.resolvedModelArgs.args || [];
  if (modelArgs.length > 0) {
    capabilityDowngrades.push('model selection (--model dropped in minimal fallback)');
  }
  const effortArgs = options.resolvedEffortArgs && options.resolvedEffortArgs.args || [];
  if (effortArgs.length > 0) {
    capabilityDowngrades.push('effort selection (-c model_reasoning_effort dropped in minimal fallback)');
  }
  const writeModeArgs = resolveWriteModeArgs('codex', options.canWrite);
  if (writeModeArgs.length > 0) {
    capabilityDowngrades.push(
      options.canWrite === true
        ? 'write mode (--sandbox dropped in minimal fallback)'
        : 'read-only enforcement (--sandbox read-only dropped in minimal fallback)'
    );
  }

  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${displayPrefix} exec --skip-git-repo-check [prompt]`,
    warnings: [],
    capabilityDowngrades
  };
}

function shouldRetryCodexWithFallback(result) {
  if (!result || result.ok || result.timedOut) {
    return false;
  }

  const output = String(result.outputText || '').toLowerCase();
  if (!output) {
    return false;
  }

  const isParseError = [
    'unexpected argument',
    'unknown option',
    'unrecognized option',
    'for more information, try',
    'usage: codex'
  ].some((needle) => output.includes(needle));

  return isParseError ? 'cli_parse_error' : false;
}

// ── Gemini standalone invocation builder ─────────────────────────────────────

function buildGeminiPrimaryInvocation(entrypoint, options) {
  const cliArgs = [];
  const modelArgs = options.resolvedModelArgs && options.resolvedModelArgs.args || [];
  cliArgs.push(...modelArgs);
  cliArgs.push('-p', options.prompt);
  const { command, args, displayPrefix } = nodeOrDirect(entrypoint, cliArgs, ['--no-warnings=DEP0040']);

  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${displayPrefix} ${modelArgs.length ? modelArgs.join(' ') + ' ' : ''}-p [prompt]`,
    warnings: options.warnings || []
  };
}

// ── Shared utilities ──────────────────────────────────────────────────────────

function buildKiloPreflightInvocation(command, options) {
  return {
    command,
    args: ['run', '--help'],
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${path.basename(command)} run --help`,
    earlyExitClassifier: classifyKiloFatalOutput,
    warnings: []
  };
}

function buildKiloPrimaryInvocation(command, options) {
  const modelArgs = options.resolvedModelArgs && options.resolvedModelArgs.args || [];
  const effortArgs = options.resolvedEffortArgs && options.resolvedEffortArgs.args || [];
  const extraOptionArgs = options.resolvedExtraOptionArgs && options.resolvedExtraOptionArgs.args || [];
  const autoArgs = options.canWrite === true ? ['--auto'] : [];
  const displayArgs = [...modelArgs, ...effortArgs, ...extraOptionArgs, ...autoArgs];
  const displayOptions = displayArgs.length > 0 ? `${displayArgs.join(' ')} ` : '';
  const args = [
    'run',
    ...modelArgs,
    ...effortArgs,
    ...extraOptionArgs,
    ...autoArgs,
    '--dir',
    options.cwd,
    options.prompt
  ];

  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${path.basename(command)} run ${displayOptions}--dir ${options.cwd} [prompt]`,
    earlyExitClassifier: classifyKiloFatalOutput,
    warnings: options.warnings || []
  };
}

function buildKiloFallbackInvocation(command, options) {
  const modelArgs = options.resolvedModelArgs && options.resolvedModelArgs.args || [];
  const effortArgs = options.resolvedEffortArgs && options.resolvedEffortArgs.args || [];
  const extraOptionArgs = options.resolvedExtraOptionArgs && options.resolvedExtraOptionArgs.args || [];
  const args = [
    'run',
    ...modelArgs,
    ...effortArgs,
    ...extraOptionArgs,
    '--dir',
    options.cwd,
    options.prompt
  ];

  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${path.basename(command)} run ${[...modelArgs, ...effortArgs, ...extraOptionArgs].join(' ')} --dir ${options.cwd} [prompt]`,
    earlyExitClassifier: classifyKiloFatalOutput,
    warnings: []
  };
}

function shouldRetryKiloWithFallback(result) {
  const output = String((result && result.outputText) || '').toLowerCase();

  if (output.includes('not logged in') || output.includes('auth login') || output.includes('authentication required')) {
    return 'not_logged_in';
  }

  if (result && result.ok && !result.outputText) {
    return 'empty_output';
  }

  if (!result || result.ok || result.timedOut || !output) {
    return false;
  }

  const isParseError = [
    'unknown argument',
    'unknown option',
    'unknown command',
    'show help',
    'kilo run [message'
  ].some((needle) => output.includes(needle));

  return isParseError ? 'cli_parse_error' : false;
}

function classifyKiloFatalOutput(outputText) {
  const output = String(outputText || '').toLowerCase();

  if (!output) {
    return null;
  }

  if (
    output.includes('google generative ai api key is missing')
    || output.includes('api key is missing')
    || output.includes('google_generative_ai_api_key environment variable')
  ) {
    return 'missing_api_key';
  }

  if (
    output.includes('not logged in')
    || output.includes('auth login')
    || output.includes('authentication required')
  ) {
    return 'not_logged_in';
  }

  return null;
}

function buildQwenPreflightInvocation(entrypoint, options) {
  const { command, args, displayPrefix } = nodeOrDirect(entrypoint, ['--help']);
  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${displayPrefix} --help`,
    warnings: []
  };
}

function buildQwenPrimaryInvocation(entrypoint, options) {
  const writeModeArgs = resolveWriteModeArgs('qwen', options.canWrite);
  const cliArgs = [
    '--output-format',
    'text',
    ...writeModeArgs,
    options.prompt
  ];
  const { command, args, displayPrefix } = nodeOrDirect(entrypoint, cliArgs);

  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${displayPrefix} --output-format text ${writeModeArgs.join(' ')} [prompt]`,
    warnings: options.warnings || []
  };
}

function buildQwenFallbackInvocation(entrypoint, options) {
  const cliArgs = [
    '-p',
    options.prompt,
    '--output-format',
    'text'
  ];
  const { command, args, displayPrefix } = nodeOrDirect(entrypoint, cliArgs);

  // This fallback drops write-mode flags. Record the downgrade.
  const capabilityDowngrades = [];
  const writeModeArgs = resolveWriteModeArgs('qwen', options.canWrite);
  if (writeModeArgs.length > 0) {
    capabilityDowngrades.push(
      options.canWrite === true
        ? 'write mode (--approval-mode dropped in fallback)'
        : 'read-only enforcement (--approval-mode plan dropped in fallback)'
    );
  }

  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${displayPrefix} -p [prompt] --output-format text`,
    warnings: [],
    capabilityDowngrades
  };
}

function shouldRetryQwenWithFallback(result) {
  const output = String((result && result.outputText) || '').toLowerCase();

  if (output.includes('qwen auth') || output.includes('not authenticated') || output.includes('authentication required') || output.includes('unauthorized')) {
    return 'not_logged_in';
  }

  if (result && result.ok && !result.outputText) {
    return 'empty_output';
  }

  if (!result || result.ok || result.timedOut || !output) {
    return false;
  }

  const isParseError = [
    'unknown argument',
    'unknown option',
    'show help',
    'usage: qwen'
  ].some((needle) => output.includes(needle));

  return isParseError ? 'cli_parse_error' : false;
}

function resolveFile(label, candidates) {
  const attempted = [];

  for (const candidate of candidates.filter(Boolean)) {
    attempted.push(candidate);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const detail = attempted.length > 0
    ? ` Tried: ${attempted.join(', ')}.`
    : '';
  throw new Error(`Could not resolve ${label}. Set the matching LOOPI_* path override.${detail}`);
}

function getPathEnvValue(env = process.env) {
  return env.PATH || env.Path || env.path || '';
}

function pathExtCandidates(pathExt = process.env.PATHEXT) {
  const raw = pathExt || '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function resolveFromPathEnv(commandName, {
  envPath = getPathEnvValue(),
  pathExt = process.env.PATHEXT,
  platform = process.platform
} = {}) {
  const command = String(commandName || '').trim();
  if (!command) {
    return null;
  }

  const dirs = String(envPath || '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  const hasExtension = path.extname(command) !== '';
  let names = [command];
  if (platform === 'win32' && !hasExtension) {
    // Prefer executable wrappers before extensionless npm shell shims. The
    // extensionless files are useful for Git Bash, but Node cannot reliably
    // spawn them from a normal Windows process.
    names = [
      ...pathExtCandidates(pathExt).map((ext) => `${command}${ext.toLowerCase()}`),
      command
    ];
  }

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveFromPath(commandName) {
  const resolvedFromEnv = resolveFromPathEnv(commandName);
  if (resolvedFromEnv) {
    return resolvedFromEnv;
  }

  const lookupCommand = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookupCommand, [commandName], {
    encoding: 'utf8',
    windowsHide: true
  });

  if (result.status !== 0 || result.error) {
    return null;
  }

  const resolvedLines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (process.platform === 'win32') {
    const executableExts = new Set(pathExtCandidates());
    const executableLine = resolvedLines.find((line) => executableExts.has(path.extname(line).toLowerCase()));
    if (executableLine) {
      return executableLine;
    }
  }

  return resolvedLines[0] || null;
}

// Determines whether the resolved path is a Node.js script that should be
// invoked via process.execPath, or a direct command (shell shim, .cmd wrapper,
// native binary). Returns { command, args, displayPrefix } suitable for
// spreading into an invocation object.
function nodeOrDirect(resolved, cliArgs, nodeFlags) {
  if (/\.[cm]?js$/i.test(resolved)) {
    const flags = nodeFlags || [];
    return {
      command: process.execPath,
      args: [...flags, resolved, ...cliArgs],
      displayPrefix: `node ${path.basename(resolved)}`
    };
  }
  return {
    command: resolved,
    args: cliArgs,
    displayPrefix: path.basename(resolved)
  };
}

// Returns candidate paths for npm-global node_modules on the current platform.
// On Unix there is no single standard location, so we return multiple candidates.
function npmGlobalNodeModulePaths(...parts) {
  if (process.platform === 'win32') {
    return [path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', ...parts)];
  }
  return [
    path.join('/usr', 'local', 'lib', 'node_modules', ...parts),
    path.join('/usr', 'lib', 'node_modules', ...parts),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', ...parts)
  ];
}

// Returns candidate paths for npm-global bin on the current platform.
function npmGlobalBinPaths(...parts) {
  if (process.platform === 'win32') {
    const roots = [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
      process.env.VOLTA_HOME ? path.join(process.env.VOLTA_HOME, 'bin') : null
    ].filter(Boolean);
    return Array.from(new Set(roots)).map((root) => path.join(root, ...parts));
  }
  return [
    process.env.NVM_BIN ? path.join(process.env.NVM_BIN, ...parts) : null,
    process.env.VOLTA_HOME ? path.join(process.env.VOLTA_HOME, 'bin', ...parts) : null,
    path.join('/usr', 'local', 'bin', ...parts),
    path.join('/usr', 'bin', ...parts),
    path.join(os.homedir(), '.npm-global', 'bin', ...parts)
  ].filter(Boolean);
}

// ── Opencode ──────────────────────────────────────────────────────────────────

function buildOpencodePreflightInvocation(command, options) {
  return {
    command,
    args: ['--help'],
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${path.basename(command)} --help`,
    warnings: []
  };
}

function buildOpencodeInvocation(command, options) {
  const mode = options.mode || 'plan';
  const useWriteAgent = mode === 'implement' && options.canWrite;
  const explicitAgent = options.agentOptions && options.agentOptions.agent;
  const writeModeArgs = explicitAgent ? [] : resolveWriteModeArgs('opencode', useWriteAgent);
  const modelArgs = options.resolvedModelArgs && options.resolvedModelArgs.args || [];
  const extraOptionArgs = options.resolvedExtraOptionArgs && options.resolvedExtraOptionArgs.args || [];
  const args = [
    'run',
    ...writeModeArgs,
    ...modelArgs,
    ...extraOptionArgs,
    options.prompt
  ];

  return {
    command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: process.env,
    displayCommand: `${path.basename(command)} run ${[...writeModeArgs, ...modelArgs, ...extraOptionArgs].join(' ')} [prompt]`,
    earlyExitClassifier: classifyOpencodeFatalOutput,
    warnings: options.warnings || []
  };
}

function classifyOpencodeFatalOutput(outputText) {
  const output = String(outputText || '').toLowerCase();

  if (
    output.includes('not logged in')
    || output.includes('auth login')
    || output.includes('authentication required')
  ) {
    return 'not_logged_in';
  }

  if (output.includes('unknown agent') || output.includes('invalid agent')) {
    return 'unsupported_write_mode';
  }

  return null;
}

function shouldRetryOpencodeWithFallback(result) {
  const output = String((result && result.outputText) || '').toLowerCase();

  if (output.includes('not logged in') || output.includes('auth login') || output.includes('authentication required')) {
    return 'not_logged_in';
  }

  if (result && result.ok && !result.outputText) {
    return 'empty_output';
  }

  if (!result || result.ok || result.timedOut || !output) {
    return false;
  }

  const isParseError = [
    'unknown argument',
    'unknown option',
    'unknown command',
    'show help',
    'usage: opencode'
  ].some((needle) => output.includes(needle));

  return isParseError ? 'cli_parse_error' : false;
}

// ── Adapter registry ──────────────────────────────────────────────────────────

const adapters = {
  claude: {
    resolve() {
      const candidates = [
        process.env.LOOPI_CLAUDE_PATH,
        path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
      ];
      if (process.platform === 'win32') {
        candidates.push(
          ...npmGlobalBinPaths('claude.cmd'),
          ...npmGlobalBinPaths('claude.exe'),
          resolveFromPath('claude.cmd'),
          resolveFromPath('claude.exe'),
          resolveFromPath('claude')
        );
      } else {
        candidates.push(
          ...npmGlobalBinPaths('claude'),
          resolveFromPath('claude')
        );
      }
      return resolveFile('Claude executable', candidates);
    },
    buildPreflightInvocation(command, options) {
      return buildClaudePreflightInvocation(command, options);
    },
    buildInvocation(command, options) {
      return buildClaudePrimaryInvocation(command, options);
    },
    getFallbackChain(command, options) {
      return [
        {
          invocation: buildClaudeFallbackInvocation(command, options),
          shouldRetry: shouldRetryClaudeWithFallback
        }
      ];
    }
  },
  codex: {
    resolve() {
      const candidates = [
        process.env.LOOPI_CODEX_JS,
        ...npmGlobalNodeModulePaths('@openai', 'codex', 'bin', 'codex.js'),
      ];
      if (process.platform === 'win32') {
        candidates.push(
          ...npmGlobalBinPaths('codex.cmd'),
          resolveFromPath('codex.cmd'),
          resolveFromPath('codex')
        );
      } else {
        candidates.push(
          ...npmGlobalBinPaths('codex'),
          resolveFromPath('codex')
        );
      }
      return resolveFile('Codex entrypoint', candidates);
    },
    buildPreflightInvocation(entrypoint, options) {
      return buildCodexPreflightInvocation(entrypoint, options);
    },
    buildInvocation(entrypoint, options) {
      return buildCodexPrimaryInvocation(entrypoint, options);
    },
    getFallbackChain(entrypoint, options) {
      return [
        {
          invocation: buildCodexSafeFallbackInvocation(entrypoint, options),
          shouldRetry: shouldRetryCodexWithFallback
        },
        {
          invocation: buildCodexMinimalFallbackInvocation(entrypoint, options),
          shouldRetry: shouldRetryCodexWithFallback
        }
      ];
    }
  },
  gemini: {
    resolve() {
      const candidates = [
        process.env.LOOPI_GEMINI_JS,
        ...npmGlobalNodeModulePaths('@google', 'gemini-cli', 'dist', 'index.js')
      ];
      if (process.platform === 'win32') {
        candidates.push(
          ...npmGlobalBinPaths('gemini.cmd'),
          resolveFromPath('gemini.cmd'),
          resolveFromPath('gemini')
        );
      } else {
        candidates.push(
          ...npmGlobalBinPaths('gemini'),
          resolveFromPath('gemini')
        );
      }
      return resolveFile('Gemini entrypoint', candidates);
    },
    buildPreflightInvocation(entrypoint, options) {
      const { command, args, displayPrefix } = nodeOrDirect(entrypoint, ['--help'], ['--no-warnings=DEP0040']);
      return {
        command,
        args,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: process.env,
        displayCommand: `${displayPrefix} --help`
      };
    },
    buildInvocation(entrypoint, options) {
      return buildGeminiPrimaryInvocation(entrypoint, options);
    }
  },
  kilo: {
    resolve() {
      const candidates = [
        process.env.LOOPI_KILO_PATH,
        ...npmGlobalNodeModulePaths('@kilocode', 'cli', 'node_modules', '@kilocode', 'cli-windows-x64', 'bin', 'kilo.exe'),
        ...npmGlobalNodeModulePaths('@kilocode', 'cli', 'node_modules', '@kilocode', 'cli-windows-x64-baseline', 'bin', 'kilo.exe'),
      ];
      if (process.platform === 'win32') {
        candidates.push(
          ...npmGlobalBinPaths('kilo.cmd'),
          ...npmGlobalBinPaths('kilocode.cmd'),
          resolveFromPath('kilo.exe'),
          resolveFromPath('kilocode.exe'),
          resolveFromPath('kilo.cmd'),
          resolveFromPath('kilocode.cmd')
        );
      } else {
        candidates.push(
          ...npmGlobalBinPaths('kilo'),
          ...npmGlobalBinPaths('kilocode'),
          resolveFromPath('kilo'),
          resolveFromPath('kilocode')
        );
      }
      return resolveFile('Kilo executable', candidates);
    },
    buildPreflightInvocation(command, options) {
      return buildKiloPreflightInvocation(command, options);
    },
    buildInvocation(command, options) {
      return buildKiloPrimaryInvocation(command, options);
    },
    getFallbackChain(command, options) {
      return [
        {
          invocation: buildKiloFallbackInvocation(command, options),
          shouldRetry: shouldRetryKiloWithFallback
        }
      ];
    }
  },
  qwen: {
    resolve() {
      const candidates = [
        process.env.LOOPI_QWEN_JS,
        ...npmGlobalNodeModulePaths('@qwen-code', 'qwen-code', 'cli.js')
      ];
      if (process.platform === 'win32') {
        candidates.push(
          ...npmGlobalBinPaths('qwen.cmd'),
          resolveFromPath('qwen.cmd'),
          resolveFromPath('qwen')
        );
      } else {
        candidates.push(
          ...npmGlobalBinPaths('qwen'),
          resolveFromPath('qwen')
        );
      }
      return resolveFile('Qwen entrypoint', candidates);
    },
    buildPreflightInvocation(entrypoint, options) {
      return buildQwenPreflightInvocation(entrypoint, options);
    },
    buildInvocation(entrypoint, options) {
      return buildQwenPrimaryInvocation(entrypoint, options);
    },
    getFallbackChain(entrypoint, options) {
      return [
        {
          invocation: buildQwenFallbackInvocation(entrypoint, options),
          shouldRetry: shouldRetryQwenWithFallback
        }
      ];
    }
  },
  opencode: {
    resolve() {
      const candidates = [
        process.env.LOOPI_OPENCODE_PATH
      ];
      if (process.platform === 'win32') {
        candidates.push(
          ...npmGlobalBinPaths('opencode.cmd'),
          resolveFromPath('opencode.cmd'),
          resolveFromPath('opencode')
        );
      } else {
        candidates.push(
          ...npmGlobalBinPaths('opencode'),
          resolveFromPath('opencode')
        );
      }
      return resolveFile('Opencode executable', candidates);
    },
    buildPreflightInvocation(command, options) {
      return buildOpencodePreflightInvocation(command, options);
    },
    buildInvocation(command, options) {
      return buildOpencodeInvocation(command, options);
    },
    getFallbackChain() {
      // No meaningful fallback for Opencode — any failure (auth, CLI parse, etc.)
      // would retry with the same command. Let the error surface immediately.
      return [];
    }
  }
};

module.exports = {
  runAgent,
  resolveAgents,
  killAllActiveProcesses,
  clearAuthCache,
  getAdapter,
  getAdapterConfig,
  resolveModelArgs,
  resolveEffortArgs,
  resolveExtraOptionArgs,
  resolveWriteModeArgs,
  formatAgentWarning,
  getCapabilityProfile,
  checkCapability,
  makeResultEnvelope,
  runHttpProvider,
  checkProviderReadiness,
  PROVIDER_REGISTRY,
  __test: {
    activeProcesses,
    authCache,
    getAuthCacheKey,
    killProcessTree,
    runProcess,
    combineOutput,
    normalizeDisplayText,
    resolveModelArgs,
    resolveEffortArgs,
    resolveExtraOptionArgs,
    resolveWriteModeArgs,
    formatAgentWarning,
    classifyPreflightResult,
    annotatePreflightResult,
    formatPreflightError,
    buildGeminiPrimaryInvocation,
    buildClaudePreflightInvocation,
    buildClaudePrimaryInvocation,
    buildClaudeFallbackInvocation,
    shouldRetryClaudeWithFallback,
    buildCodexPreflightInvocation,
    buildCodexPrimaryInvocation,
    buildCodexSafeFallbackInvocation,
    buildCodexMinimalFallbackInvocation,
    shouldRetryCodexWithFallback,
    buildKiloPreflightInvocation,
    buildKiloPrimaryInvocation,
    buildKiloFallbackInvocation,
    shouldRetryKiloWithFallback,
    classifyKiloFatalOutput,
    buildQwenPreflightInvocation,
    buildQwenPrimaryInvocation,
    buildQwenFallbackInvocation,
    shouldRetryQwenWithFallback,
    buildOpencodePreflightInvocation,
    buildOpencodeInvocation,
    classifyOpencodeFatalOutput,
    shouldRetryOpencodeWithFallback,
    nodeOrDirect,
    getPathEnvValue,
    pathExtCandidates,
    resolveFromPathEnv,
    resolveFromPath,
    npmGlobalBinPaths,
    splitRequestDefaults,
    buildRequestBody
  }
};
