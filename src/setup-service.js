const { spawn } = require('child_process');
const { getAdapter } = require('./adapters');

// ── Structured Adapter Metadata Registry ────────────────────────────────────────

const ADAPTER_METADATA = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
    installHint: 'npm install -g @anthropic-ai/claude-cli',
    loginHint: 'claude auth login',
    installCommand: {
      type: 'npm-global',
      packageName: '@anthropic-ai/claude-cli',
      command: 'npm install -g @anthropic-ai/claude-cli'
    },
    loginCommand: {
      type: 'interactive',
      command: 'claude',
      args: ['auth', 'login'],
      shellCommand: 'claude auth login'
    },
    envOverride: 'LOOPI_CLAUDE_PATH',
    family: 'cli',
    supportsWriteAccess: true,
    supportsReasoningEffort: true
  },
  codex: {
    id: 'codex',
    displayName: 'Codex CLI',
    docsUrl: 'https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started',
    installHint: 'npm install -g @openai/codex',
    loginHint: 'codex auth login',
    installCommand: {
      type: 'npm-global',
      packageName: '@openai/codex',
      command: 'npm install -g @openai/codex'
    },
    loginCommand: {
      type: 'interactive',
      command: 'codex',
      args: ['auth', 'login'],
      shellCommand: 'codex auth login'
    },
    envOverride: 'LOOPI_CODEX_JS',
    family: 'cli',
    supportsWriteAccess: true,
    supportsReasoningEffort: true
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini CLI',
    docsUrl: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/index.md',
    installHint: 'npm install -g @google/gemini-cli',
    loginHint: 'gemini auth login',
    installCommand: {
      type: 'npm-global',
      packageName: '@google/gemini-cli',
      command: 'npm install -g @google/gemini-cli'
    },
    loginCommand: {
      type: 'interactive',
      command: 'gemini',
      args: ['auth', 'login'],
      shellCommand: 'gemini auth login'
    },
    envOverride: 'LOOPI_GEMINI_JS',
    family: 'cli',
    supportsWriteAccess: false,
    supportsReasoningEffort: false
  },
  kilo: {
    id: 'kilo',
    displayName: 'Kilo Code CLI',
    docsUrl: 'https://kilocode.ai/cli',
    installHint: 'Check Kilo documentation for installation instructions',
    loginHint: 'kilo auth login',
    installCommand: null,
    loginCommand: {
      type: 'interactive',
      command: 'kilo',
      args: ['auth', 'login'],
      shellCommand: 'kilo auth login'
    },
    envOverride: 'LOOPI_KILO_PATH',
    family: 'cli',
    supportsWriteAccess: false,
    supportsReasoningEffort: false
  },
  qwen: {
    id: 'qwen',
    displayName: 'Qwen Code',
    docsUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview/',
    installHint: 'npm install -g @qwen-code/qwen-code',
    loginHint: 'qwen auth login',
    installCommand: {
      type: 'npm-global',
      packageName: '@qwen-code/qwen-code',
      command: 'npm install -g @qwen-code/qwen-code'
    },
    loginCommand: {
      type: 'interactive',
      command: 'qwen',
      args: ['auth', 'login'],
      shellCommand: 'qwen auth login'
    },
    envOverride: 'LOOPI_QWEN_JS',
    family: 'cli',
    supportsWriteAccess: true,
    supportsReasoningEffort: false
  },
  opencode: {
    id: 'opencode',
    displayName: 'Opencode',
    docsUrl: 'https://opencode.ai/docs/',
    installHint: 'Check Opencode documentation for installation instructions',
    loginHint: 'opencode auth login',
    installCommand: null,
    loginCommand: {
      type: 'interactive',
      command: 'opencode',
      args: ['auth', 'login'],
      shellCommand: 'opencode auth login'
    },
    envOverride: 'LOOPI_OPENCODE_PATH',
    family: 'cli',
    supportsWriteAccess: true,
    supportsReasoningEffort: false
  }
};

// ── Status Constants ─────────────────────────────────────────────────────────────

const STATUS = {
  READY: 'ready',
  INSTALLED_BUT_NEEDS_LOGIN: 'installed_but_needs_login',
  MISSING: 'missing',
  UNUSABLE: 'unusable'
};

// ── Adapter Metadata Lookup ───────────────────────────────────────────────────────

function getAdapterMetadata(agentName) {
  const normalized = String(agentName || '').trim().toLowerCase();
  const metadata = ADAPTER_METADATA[normalized];
  if (!metadata) {
    return null;
  }
  return cloneMetadata(metadata);
}

function getAllAdapterMetadata() {
  return Object.values(ADAPTER_METADATA).map((meta) => cloneMetadata(meta));
}

function getSupportedAgentIds() {
  return Object.keys(ADAPTER_METADATA);
}

// ── Adapter Status Checking ───────────────────────────────────────────────────────

/**
 * Checks the installation and authentication status of a CLI adapter.
 * Returns a structured status object without running a full task.
 *
 * @param {string} agentName - The agent name (e.g., 'claude', 'codex')
 * @param {Object} options - Optional configuration
 * @param {number} [options.timeoutMs=10000] - Timeout for preflight check
 * @param {string} [options.cwd] - Working directory for resolution
 * @returns {Promise<Object>} Status object with readiness information
 */
async function checkAdapterStatus(agentName, { timeoutMs = 10000, cwd } = {}) {
  const normalized = String(agentName || '').trim().toLowerCase();
  const metadata = getAdapterMetadata(normalized);
  const adaptersModule = require('./adapters');

  if (!metadata) {
    return {
      agentId: normalized,
      status: STATUS.UNUSABLE,
      ready: false,
      error: `Unknown agent "${normalized}"`,
      metadata: null,
      resolvedPath: null,
      nextAction: null
    };
  }

  // Try to resolve the adapter
  let resolvedPath = null;
  try {
    const adapter = getAdapter(normalized);
    resolvedPath = adapter.resolve();
  } catch (error) {
    const errorMessage = error.message || String(error);
    if (errorMessage.includes('Could not resolve') || errorMessage.includes('command not found')) {
      return {
        agentId: normalized,
        status: STATUS.MISSING,
        ready: false,
        error: `Command not found`,
        metadata,
        resolvedPath: null,
        nextAction: {
          type: 'install',
          command: metadata.installHint,
          message: `Install ${metadata.displayName}`
        }
      };
    }
    return {
      agentId: normalized,
      status: STATUS.UNUSABLE,
      ready: false,
      error: errorMessage,
      metadata,
      resolvedPath: null,
      nextAction: null
    };
  }

  // Run a quick preflight to check if it's authenticated
  const preflightResult = await runPreflightCheck(adaptersModule, normalized, resolvedPath, {
    timeoutMs,
    cwd: cwd || process.cwd()
  });

  const { readinessKind } = preflightResult;

  if (readinessKind === 'ok') {
    return {
      agentId: normalized,
      status: STATUS.READY,
      ready: true,
      error: null,
      metadata,
      resolvedPath,
      nextAction: null
    };
  }

  if (readinessKind === 'auth_failure') {
    return {
      agentId: normalized,
      status: STATUS.INSTALLED_BUT_NEEDS_LOGIN,
      ready: false,
      error: 'Authentication required',
      metadata,
      resolvedPath,
      nextAction: {
        type: 'login',
        command: metadata.loginHint,
        message: `Authenticate ${metadata.displayName}`
      }
    };
  }

  if (readinessKind === 'command_not_found') {
    return {
      agentId: normalized,
      status: STATUS.MISSING,
      ready: false,
      error: 'Command not found',
      metadata,
      resolvedPath: null,
      nextAction: {
        type: 'install',
        command: metadata.installHint,
        message: `Install ${metadata.displayName}`
      }
    };
  }

  // Unusable
  return {
    agentId: normalized,
    status: STATUS.UNUSABLE,
    ready: false,
    error: formatPreflightError(normalized, readinessKind, preflightResult),
    metadata,
    resolvedPath,
    nextAction: null
  };
}

/**
 * Runs a lightweight preflight check without the full agent resolution.
 * @param {Object} adaptersModule - The adapters module
 * @param {string} agentName - Normalized agent name
 * @param {string} resolvedPath - Resolved executable path
 * @param {Object} options - Preflight options
 * @returns {Promise<Object>} Annotated preflight result
 */
async function runPreflightCheck(adaptersModule, agentName, resolvedPath, { timeoutMs, cwd }) {
  let adapter;
  let runProcess;
  try {
    adapter = adaptersModule.getAdapter(agentName);
    runProcess = adaptersModule.__test.runProcess;
  } catch (error) {
    return {
      ok: false,
      readinessKind: 'unusable',
      exitCode: null,
      outputText: '',
      error
    };
  }

  if (!adapter.buildPreflightInvocation) {
    return {
      ok: false,
      readinessKind: 'unusable'
    };
  }

  const invocation = adapter.buildPreflightInvocation(resolvedPath, {
    cwd: cwd || process.cwd(),
    timeoutMs
  });

  let result;
  try {
    result = await runProcess(invocation);
  } catch (error) {
    return {
      ok: false,
      readinessKind: 'unusable',
      exitCode: null,
      outputText: '',
      error
    };
  }

  return adaptersModule.__test.annotatePreflightResult(result, agentName);
}

/**
 * Formats a helpful error message based on the readiness kind.
 * @param {string} agentName - The agent name
 * @param {string} readinessKind - The classified readiness kind
 * @param {Object} result - The preflight result for additional context
 * @returns {string} A helpful error message
 */
function formatPreflightError(agentName, readinessKind, result) {
  const metadata = getAdapterMetadata(agentName);

  switch (readinessKind) {
    case 'command_not_found':
      if (metadata) {
        return `${metadata.displayName}: command not found. Install: ${metadata.installHint}`;
      }
      return `${agentName}: command not found. Please check that the agent is installed and available on PATH.`;

    case 'auth_failure':
      if (metadata) {
        return `${metadata.displayName}: found but not authenticated. Run: ${metadata.loginHint}`;
      }
      return `${agentName}: found but not authenticated. Please authenticate the agent.`;

    case 'unusable':
      if (result) {
        const detail = result.outputText
          ? `Output: ${result.outputText.split(/\r?\n/).slice(0, 4).join(' ').trim()}`
          : (result.error && result.error.message) || 'The process exited without useful output.';
        return `${agentName}: found but not usable. Exit code ${result.exitCode === null ? 'n/a' : result.exitCode}. ${detail}`;
      }
      return `${agentName}: found but not usable.`;

    case 'ok':
      return '';

    default:
      return `${agentName}: preflight check failed.`;
  }
}

/**
 * Checks the status of all supported CLI adapters.
 * @param {Object} options - Optional configuration
 * @returns {Promise<Array>} Array of status objects for each adapter
 */
async function checkAllAdapterStatus({ timeoutMs = 10000, cwd } = {}) {
  const agentIds = getSupportedAgentIds();
  const statuses = await Promise.all(
    agentIds.map(id => checkAdapterStatus(id, { timeoutMs, cwd }))
  );
  return statuses;
}

/**
 * Gets only the adapters that are ready to use.
 * @param {Object} options - Optional configuration
 * @returns {Promise<Array>} Array of ready adapter metadata
 */
async function getReadyAdapters({ timeoutMs = 10000, cwd } = {}) {
  const allStatuses = await checkAllAdapterStatus({ timeoutMs, cwd });
  return allStatuses
    .filter(s => s.ready)
    .map(s => ({
      id: s.agentId,
      displayName: s.metadata.displayName,
      resolvedPath: s.resolvedPath,
      metadata: s.metadata
    }));
}

/**
 * Gets adapter status in a format suitable for UI display.
 * @param {string} agentName - The agent name
 * @param {Object} options - Optional configuration
 * @returns {Promise<Object>} UI-friendly status object
 */
async function getAdapterDisplayStatus(agentName, options = {}) {
  const checkStatus = typeof options.checkAdapterStatus === 'function'
    ? options.checkAdapterStatus
    : checkAdapterStatus;
  const status = await checkStatus(agentName, options);
  return {
    id: status.agentId,
    displayName: status.metadata?.displayName || status.agentId,
    status: status.status,
    ready: status.ready,
    hasError: !!status.error,
    errorMessage: status.error,
    metadata: status.metadata ? cloneMetadata(status.metadata) : null,
    docsUrl: status.metadata?.docsUrl,
    nextAction: status.nextAction,
    envOverride: status.metadata?.envOverride,
    resolvedPath: status.resolvedPath
  };
}

function cloneMetadata(metadata) {
  if (!metadata) {
    return null;
  }

  return {
    ...metadata,
    installCommand: metadata.installCommand ? { ...metadata.installCommand } : null,
    loginCommand: metadata.loginCommand ? {
      ...metadata.loginCommand,
      args: Array.isArray(metadata.loginCommand.args) ? [...metadata.loginCommand.args] : []
    } : null
  };
}

function createUnknownAgentActionResult(agentId, actionType) {
  return {
    success: false,
    launched: false,
    completed: false,
    agentId,
    actionType,
    metadata: null,
    approved: false,
    helperAvailable: false,
    command: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    statusAfter: null,
    error: `Unknown agent "${agentId}"`,
    message: `Unknown agent "${agentId}".`
  };
}

function createApprovalRequiredResult(agentId, actionType, metadata, commandText) {
  return {
    success: false,
    launched: false,
    completed: false,
    agentId,
    actionType,
    metadata: cloneMetadata(metadata),
    approved: false,
    helperAvailable: true,
    command: commandText,
    exitCode: null,
    stdout: '',
    stderr: '',
    statusAfter: null,
    error: `${metadata.displayName} ${actionType} requires explicit approval.`,
    message: `${metadata.displayName} ${actionType} requires explicit approval.`
  };
}

function createUnsupportedHelperResult(agentId, actionType, metadata) {
  return {
    success: false,
    launched: false,
    completed: false,
    agentId,
    actionType,
    metadata: cloneMetadata(metadata),
    approved: true,
    helperAvailable: false,
    command: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    statusAfter: null,
    error: `Loopi does not have a built-in ${actionType} helper for ${metadata.displayName}.`,
    message: `Loopi does not have a built-in ${actionType} helper for ${metadata.displayName}.`
  };
}

function shouldUseShellForCommand(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));
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

function defaultCommandRunner({ command, args = [], cwd, env, timeoutMs = 0 }) {
  return new Promise((resolve, reject) => {
    const useWindowsCommandWrapper = shouldUseShellForCommand(command);
    const child = spawn(
      useWindowsCommandWrapper ? (process.env.ComSpec || 'cmd.exe') : command,
      useWindowsCommandWrapper ? ['/d', '/s', '/c', buildWindowsCommandLine(command, args)] : args,
      {
        cwd,
        env,
        shell: false,
        windowsHide: true
      }
    );

    let stdout = '';
    let stderr = '';
    let timeoutId = null;

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }

    child.once('error', (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(error);
    });

    child.once('close', (exitCode) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve({
        exitCode,
        stdout,
        stderr
      });
    });

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        child.kill();
      }, timeoutMs);
    }
  });
}

function quoteForWindowsSingleQuotedString(value) {
  return String(value || '').replace(/'/g, "''");
}

function buildWindowsInteractiveLaunchScript(shellCommand, cwd) {
  const escapedCommand = quoteForWindowsSingleQuotedString(shellCommand);
  const escapedCwd = quoteForWindowsSingleQuotedString(cwd || process.cwd());
  return [
    `$command = '${escapedCommand}'`,
    `$workingDir = '${escapedCwd}'`,
    "$process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/s','/c',$command) -WorkingDirectory $workingDir -Wait -PassThru",
    'exit $process.ExitCode'
  ].join('; ');
}

function defaultInteractiveLauncher({ shellCommand, cwd, env }) {
  if (process.platform === 'win32') {
    const script = buildWindowsInteractiveLaunchScript(shellCommand, cwd);
    return defaultCommandRunner({
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', script],
      cwd,
      env,
      timeoutMs: 0
    });
  }

  return defaultCommandRunner({
    command: '/bin/sh',
    args: ['-lc', shellCommand],
    cwd,
    env,
    timeoutMs: 0
  });
}

function buildInstallInvocation(installCommand) {
  if (!installCommand || installCommand.type !== 'npm-global' || !installCommand.packageName) {
    return null;
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install', '-g', installCommand.packageName],
    commandText: installCommand.command
  };
}

async function runAdapterInstall(agentName, {
  approved = false,
  cwd = process.cwd(),
  env = process.env,
  commandRunner = defaultCommandRunner,
  checkStatus = checkAdapterStatus
} = {}) {
  const normalized = String(agentName || '').trim().toLowerCase();
  const metadata = getAdapterMetadata(normalized);

  if (!metadata) {
    return createUnknownAgentActionResult(normalized, 'install');
  }

  if (!metadata.installCommand) {
    return createUnsupportedHelperResult(normalized, 'install', metadata);
  }

  if (!approved) {
    return createApprovalRequiredResult(normalized, 'install', metadata, metadata.installCommand.command);
  }

  const invocation = buildInstallInvocation(metadata.installCommand);
  if (!invocation) {
    return createUnsupportedHelperResult(normalized, 'install', metadata);
  }

  try {
    const execution = await commandRunner({
      command: invocation.command,
      args: invocation.args,
      cwd,
      env,
      timeoutMs: 0
    });
    const statusAfter = await checkStatus(normalized, { cwd });
    const stillMissing = statusAfter && statusAfter.status === STATUS.MISSING;
    const success = execution.exitCode === 0 && !stillMissing;
    return {
      success,
      launched: true,
      completed: true,
      agentId: normalized,
      actionType: 'install',
      metadata: cloneMetadata(metadata),
      approved: true,
      helperAvailable: true,
      command: invocation.commandText,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      statusAfter,
      error: success
        ? null
        : (execution.exitCode !== 0
          ? `Install command exited with code ${execution.exitCode}.`
          : `${metadata.displayName} install finished, but Loopi still could not detect the adapter afterward.`),
      message: success
        ? `${metadata.displayName} install finished. Setup status was refreshed automatically.`
        : (execution.exitCode !== 0
          ? `${metadata.displayName} install failed.`
          : `${metadata.displayName} install finished, but the adapter is still not detected.`)
    };
  } catch (error) {
    const statusAfter = await checkStatus(normalized, { cwd }).catch(() => null);
    return {
      success: false,
      launched: false,
      completed: false,
      agentId: normalized,
      actionType: 'install',
      metadata: cloneMetadata(metadata),
      approved: true,
      helperAvailable: true,
      command: invocation.commandText,
      exitCode: null,
      stdout: '',
      stderr: '',
      statusAfter,
      error: error.message,
      message: `${metadata.displayName} install failed.`
    };
  }
}

async function runAdapterLogin(agentName, {
  approved = false,
  cwd = process.cwd(),
  env = process.env,
  interactiveLauncher = defaultInteractiveLauncher,
  checkStatus = checkAdapterStatus
} = {}) {
  const normalized = String(agentName || '').trim().toLowerCase();
  const metadata = getAdapterMetadata(normalized);

  if (!metadata) {
    return createUnknownAgentActionResult(normalized, 'login');
  }

  if (!metadata.loginCommand) {
    return createUnsupportedHelperResult(normalized, 'login', metadata);
  }

  if (!approved) {
    return createApprovalRequiredResult(normalized, 'login', metadata, metadata.loginCommand.shellCommand);
  }

  try {
    const execution = await interactiveLauncher({
      command: metadata.loginCommand.command,
      args: metadata.loginCommand.args,
      shellCommand: metadata.loginCommand.shellCommand,
      cwd,
      env
    });
    const statusAfter = await checkStatus(normalized, { cwd });
    const readyAfter = Boolean(statusAfter && statusAfter.ready);
    const success = execution.exitCode === 0 && readyAfter;
    return {
      success,
      launched: true,
      completed: true,
      agentId: normalized,
      actionType: 'login',
      metadata: cloneMetadata(metadata),
      approved: true,
      helperAvailable: true,
      command: metadata.loginCommand.shellCommand,
      exitCode: execution.exitCode,
      stdout: execution.stdout || '',
      stderr: execution.stderr || '',
      statusAfter,
      error: success
        ? null
        : (execution.exitCode !== 0
          ? `Login command exited with code ${execution.exitCode}.`
          : `${metadata.displayName} login command finished, but the adapter is still not ready.`),
      message: success
        ? `${metadata.displayName} login command finished and the adapter is ready.`
        : (execution.exitCode !== 0
          ? `${metadata.displayName} login command failed.`
          : `${metadata.displayName} login window closed, but the adapter is still not ready.`)
    };
  } catch (error) {
    const statusAfter = await checkStatus(normalized, { cwd }).catch(() => null);
    return {
      success: false,
      launched: false,
      completed: false,
      agentId: normalized,
      actionType: 'login',
      metadata: cloneMetadata(metadata),
      approved: true,
      helperAvailable: true,
      command: metadata.loginCommand.shellCommand,
      exitCode: null,
      stdout: '',
      stderr: '',
      statusAfter,
      error: error.message,
      message: `${metadata.displayName} login command failed.`
    };
  }
}

/**
 * Gets all adapter statuses in a UI-friendly format.
 * @param {Object} options - Optional configuration
 * @returns {Promise<Array>} Array of UI-friendly status objects
 */
async function getAllAdapterDisplayStatus(options = {}) {
  const agentIds = getSupportedAgentIds();
  return Promise.all(
    agentIds.map(id => getAdapterDisplayStatus(id, options))
  );
}

module.exports = {
  STATUS,
  getAdapterMetadata,
  getAllAdapterMetadata,
  getSupportedAgentIds,
  checkAdapterStatus,
  checkAllAdapterStatus,
  getReadyAdapters,
  getAdapterDisplayStatus,
  getAllAdapterDisplayStatus,
  runAdapterInstall,
  runAdapterLogin,
  formatPreflightError,
  ADAPTER_METADATA,
  __test: {
    cloneMetadata,
    buildInstallInvocation,
    buildWindowsInteractiveLaunchScript,
    shouldUseShellForCommand,
    quoteForWindowsCmdArg,
    buildWindowsCommandLine,
    defaultCommandRunner,
    defaultInteractiveLauncher,
    quoteForWindowsSingleQuotedString,
    runPreflightCheck
  }
};
