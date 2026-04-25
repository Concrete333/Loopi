const assert = require('assert');

async function testGetAdapterMetadata() {
  const { getAdapterMetadata } = require('../src/setup-service');

  const claudeMeta = getAdapterMetadata('claude');
  assert.ok(claudeMeta, 'claude metadata exists');
  assert.strictEqual(claudeMeta.id, 'claude');
  assert.strictEqual(claudeMeta.displayName, 'Claude Code');
  assert.strictEqual(claudeMeta.supportsWriteAccess, true);
  assert.ok(claudeMeta.docsUrl);
  assert.ok(claudeMeta.installHint);
  assert.ok(claudeMeta.loginHint);
  assert.strictEqual(claudeMeta.installCommand.type, 'npm-global');
  assert.strictEqual(claudeMeta.installCommand.packageName, '@anthropic-ai/claude-cli');
  assert.strictEqual(claudeMeta.loginCommand.shellCommand, 'claude auth login');

  const codexMeta = getAdapterMetadata('codex');
  assert.ok(codexMeta, 'codex metadata exists');
  assert.strictEqual(codexMeta.id, 'codex');
  assert.strictEqual(codexMeta.displayName, 'Codex CLI');

  const unknownMeta = getAdapterMetadata('unknown');
  assert.strictEqual(unknownMeta, null, 'unknown adapter returns null');
}

async function testGetAllAdapterMetadata() {
  const { getAllAdapterMetadata } = require('../src/setup-service');

  const allMeta = getAllAdapterMetadata();
  assert.ok(Array.isArray(allMeta));
  assert.ok(allMeta.length > 0, 'returns non-empty array');

  const ids = allMeta.map(m => m.id);
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('codex'));
  assert.ok(ids.includes('gemini'));
  assert.ok(ids.includes('kilo'));
  assert.ok(ids.includes('qwen'));
  assert.ok(ids.includes('opencode'));
}

async function testGetAllAdapterOptionMetadata() {
  const { getAllAdapterOptionMetadata } = require('../src/setup-service');

  const allOptions = getAllAdapterOptionMetadata();
  const claudeOptions = allOptions.find((entry) => entry.agentId === 'claude');
  assert.ok(claudeOptions, 'claude option metadata exists');
  assert.deepStrictEqual(claudeOptions.schema.options.model.values, [],
    'claude model values are discovered from the installed CLI instead of hardcoded');
  assert.strictEqual(claudeOptions.schema.options.model.defaultValue, null,
    'claude should not invent a configured default model value');
  assert.deepStrictEqual(claudeOptions.schema.options.model.defaultSentinelValues, ['default']);
  assert.strictEqual(claudeOptions.schema.options.model.defaultOptionMode, 'discovered');
  assert.strictEqual(claudeOptions.schema.options.model.discovery.type, 'claude-bundle-model-options');
  assert.deepStrictEqual(claudeOptions.schema.options.effort.values.map((entry) => entry.value), [
    'low',
    'medium',
    'high',
    'max'
  ]);

  const kiloOptions = allOptions.find((entry) => entry.agentId === 'kilo');
  assert.ok(kiloOptions, 'kilo option metadata exists');
  assert.ok(kiloOptions.schema.options.model.values.some((entry) => entry.value === 'Kilo Auto Frontier'));
  assert.ok(kiloOptions.schema.options.model.values.some((entry) => entry.value === 'Kilo Auto Balanced'));
  assert.ok(kiloOptions.schema.options.model.values.some((entry) => entry.value === 'Kilo Auto Free'));
  assert.strictEqual(kiloOptions.schema.options.model.discovery.command, 'models');
  assert.strictEqual(kiloOptions.schema.options.model.discovery.verbose, true);
  assert.strictEqual(kiloOptions.schema.options.effort.flag, '--variant');
  assert.strictEqual(kiloOptions.schema.options.effort.mode, 'model_dependent');
  assert.strictEqual(kiloOptions.schema.options.agent.flag, '--agent');
  assert.ok(kiloOptions.schema.options.agent.values.some((entry) => entry.value === 'plan'));
  assert.strictEqual(kiloOptions.schema.options.thinking.kind, 'boolean');
  assert.strictEqual(kiloOptions.schema.options.thinking.modelDependent, true);
  assert.ok(!kiloOptions.schema.options.variant, 'Kilo variant should be represented as semantic effort only');

  const codexOptions = allOptions.find((entry) => entry.agentId === 'codex');
  assert.strictEqual(codexOptions.schema.options.effort.flag, '-c');
  assert.strictEqual(codexOptions.schema.options.effort.configKey, 'model_reasoning_effort');
  assert.deepStrictEqual(codexOptions.schema.options.effort.values.map((entry) => entry.value), [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh'
  ]);

  const opencodeOptions = allOptions.find((entry) => entry.agentId === 'opencode');
  assert.ok(opencodeOptions, 'opencode option metadata exists');
  assert.strictEqual(opencodeOptions.schema.options.model.discovery.command, 'models');
  assert.strictEqual(opencodeOptions.schema.options.model.discovery.verbose, true);
  assert.strictEqual(opencodeOptions.schema.options.effort.mode, 'model_dependent');
  assert.strictEqual(opencodeOptions.schema.options.effort.flag, '--variant');
  assert.strictEqual(opencodeOptions.schema.options.agent.discovery.command, 'agents');
  assert.strictEqual(opencodeOptions.schema.options.showThinking.kind, 'boolean');
  assert.strictEqual(opencodeOptions.schema.options.showThinking.flag, '--thinking');
}

async function testParseClaudeBundleModelOptions() {
  const { __test } = require('../src/setup-service');

  const discovery = __test.parseClaudeBundleModelOptions([
    'function on8(){return{value:null,label:"Default (recommended)"}}',
    'model:{getOptions:()=>{try{return j4H().filter((H)=>H.value!==null).map((H)=>H.value)}catch{return["alpha","beta","gamma"]}},formatOnRead:(H)=>H===null?"default":H}',
    'function a(){return{value:"alpha",label:"Alpha Model"}}',
    'function b(){return{value:"beta",label:"Beta Model"}}'
  ].join('\n'));

  assert.deepStrictEqual(discovery.values.map((entry) => entry.value), ['alpha', 'beta', 'gamma']);
  assert.deepStrictEqual(discovery.values.map((entry) => entry.label), ['Alpha Model', 'Beta Model', 'Gamma']);
  assert.deepStrictEqual(discovery.defaultOption, { label: 'Default' });
}

async function testDiscoverAdapterOptionsFallsBackToWindowsCommandShim() {
  const { discoverAdapterOptions } = require('../src/setup-service');

  const calls = [];
  const result = await discoverAdapterOptions('kilo', {
    commandRunner: async (invocation) => {
      calls.push(invocation.command);
      if (process.platform === 'win32' && calls.length === 1) {
        throw new Error('spawn EPERM');
      }
      return {
        exitCode: 0,
        stdout: 'google/gemini-2.5-pro\nanthropic/claude-sonnet-4-6\n',
        stderr: ''
      };
    }
  });

  assert.strictEqual(result.options.model.status, 'ready');
  assert.deepStrictEqual(result.options.model.values.map((entry) => entry.id), [
    'google/gemini-2.5-pro',
    'anthropic/claude-sonnet-4-6'
  ]);
  assert.strictEqual(result.options.model.values[0].supportsThinking, false);
  if (process.platform === 'win32') {
    assert.ok(calls.some((command) => command === 'kilo.cmd'),
      'Windows discovery should fall back to the command shim when the resolved binary fails');
  }
}

async function testParseCliModelList() {
  const { __test } = require('../src/setup-service');

  const models = __test.parseCliModelList([
    'anthropic/claude-sonnet-4-6  Claude Sonnet',
    'openai/gpt-5.4',
    'google/gemini-2.5-pro',
    '{',
    '  "id": "gemini-2.5-pro",',
    '  "providerID": "google",',
    '  "name": "Gemini 2.5 Pro",',
    '  "variants": {',
    '    "high": { "thinkingConfig": { "includeThoughts": true } },',
    '    "max": { "thinkingConfig": { "includeThoughts": true } }',
    '  }',
    '}',
    'https://example.test/not-a-model'
  ].join('\n'));
  assert.ok(models.some((model) => model.id === 'anthropic/claude-sonnet-4-6'));
  assert.ok(models.some((model) => model.id === 'openai/gpt-5.4'));
  const gemini = models.find((model) => model.id === 'google/gemini-2.5-pro');
  assert.ok(gemini, 'verbose Kilo model entry should be parsed');
  assert.deepStrictEqual(gemini.efforts, ['high', 'max']);
  assert.strictEqual(gemini.supportsThinking, false);
  assert.strictEqual(gemini.label, 'google/gemini-2.5-pro (Gemini 2.5 Pro)');
}

async function testParseCliModelListTreatsReasoningWithoutEffortAsThinkingToggle() {
  const { __test } = require('../src/setup-service');

  const models = __test.parseCliModelList([
    'anthropic/claude-haiku-4.5',
    '{',
    '  "id": "claude-haiku-4.5",',
    '  "providerID": "anthropic",',
    '  "name": "Claude Haiku 4.5",',
    '  "capabilities": {',
    '    "reasoning": true',
    '  },',
    '  "variants": {',
    '    "thinking": { "reasoning": { "enabled": true } },',
    '    "default": {}',
    '  }',
    '}'
  ].join('\n'));

  const haiku = models.find((model) => model.id === 'anthropic/claude-haiku-4.5');
  assert.ok(haiku, 'verbose Kilo Claude Haiku entry should be parsed');
  assert.deepStrictEqual(haiku.efforts, []);
  assert.strictEqual(haiku.supportsThinking, true);
}

async function testParseCliAgentList() {
  const { __test } = require('../src/setup-service');

  const agents = __test.parseCliAgentList([
    'build (primary)',
    '  [{ "permission": "*", "action": "allow", "pattern": "*" }]',
    'explore (subagent)',
    '  [{ "permission": "read", "action": "allow", "pattern": "*" }]',
    'plan (primary)'
  ].join('\n'));

  assert.deepStrictEqual(agents.map((agent) => agent.value), ['build', 'explore', 'plan']);
  assert.deepStrictEqual(agents.map((agent) => agent.label), [
    'build (primary)',
    'explore (subagent)',
    'plan (primary)'
  ]);
}

async function testDiscoverOpencodeOptionsUsesCliModelsAndAgents() {
  const { discoverAdapterOptions } = require('../src/setup-service');

  const previousPath = process.env.LOOPI_OPENCODE_PATH;
  process.env.LOOPI_OPENCODE_PATH = process.execPath;
  try {
    const calls = [];
    const result = await discoverAdapterOptions('opencode', {
      commandRunner: async (invocation) => {
        calls.push(invocation.args.join(' '));
        if (invocation.args.join(' ') === 'models --verbose') {
          return {
            exitCode: 0,
            stdout: [
              'opencode/claude-haiku-4-5',
              '{',
              '  "id": "claude-haiku-4-5",',
              '  "providerID": "opencode",',
              '  "name": "Claude Haiku 4.5",',
              '  "capabilities": { "reasoning": true },',
              '  "variants": {',
              '    "high": { "thinking": { "type": "enabled" } },',
              '    "max": { "thinking": { "type": "enabled" } }',
              '  }',
              '}'
            ].join('\n'),
            stderr: ''
          };
        }
        if (invocation.args.join(' ') === 'agent list') {
          return {
            exitCode: 0,
            stdout: 'build (primary)\nplan (primary)\nexplore (subagent)\n',
            stderr: ''
          };
        }
        throw new Error(`unexpected discovery args: ${invocation.args.join(' ')}`);
      }
    });

    assert.deepStrictEqual(calls.sort(), ['agent list', 'models --verbose']);
    assert.strictEqual(result.options.model.status, 'ready');
    assert.deepStrictEqual(result.options.model.values[0].efforts, ['high', 'max']);
    assert.strictEqual(result.options.agent.status, 'ready');
    assert.deepStrictEqual(result.options.agent.values.map((entry) => entry.value), ['build', 'plan', 'explore']);
  } finally {
    if (previousPath === undefined) {
      delete process.env.LOOPI_OPENCODE_PATH;
    } else {
      process.env.LOOPI_OPENCODE_PATH = previousPath;
    }
  }
}

async function testGetSupportedAgentIds() {
  const { getSupportedAgentIds } = require('../src/setup-service');

  const ids = getSupportedAgentIds();
  assert.ok(Array.isArray(ids));
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('codex'));
}

async function testStatusConstants() {
  const { STATUS } = require('../src/setup-service');

  assert.strictEqual(STATUS.READY, 'ready');
  assert.strictEqual(STATUS.INSTALLED_BUT_NEEDS_LOGIN, 'installed_but_needs_login');
  assert.strictEqual(STATUS.MISSING, 'missing');
  assert.strictEqual(STATUS.UNUSABLE, 'unusable');
}

async function testFormatPreflightErrorCommandNotFound() {
  const { formatPreflightError } = require('../src/setup-service');

  const error = formatPreflightError('claude', 'command_not_found', null);
  assert.ok(error.includes('command not found'));
  assert.ok(error.includes('install'));
}

async function testFormatPreflightErrorAuthFailure() {
  const { formatPreflightError } = require('../src/setup-service');

  const error = formatPreflightError('codex', 'auth_failure', null);
  assert.ok(error.includes('not authenticated'));
  assert.ok(error.includes('login'));
}

async function testFormatPreflightErrorUnusable() {
  const { formatPreflightError } = require('../src/setup-service');

  const result = {
    exitCode: 1,
    outputText: 'some error'
  };
  const error = formatPreflightError('claude', 'unusable', result);
  assert.ok(error.includes('not usable'));
  assert.ok(error.includes('Exit code 1'));
}

async function testFormatPreflightErrorUnknownAgent() {
  const { formatPreflightError } = require('../src/setup-service');

  const error = formatPreflightError('totally-unknown', 'command_not_found', null);
  assert.ok(error.includes('unknown'));
  assert.ok(error.includes('command not found'));
}

async function testCheckAdapterStatusUnknownAgent() {
  const { checkAdapterStatus } = require('../src/setup-service');

  const status = await checkAdapterStatus('unknown-agent');
  assert.strictEqual(status.ready, false);
  assert.strictEqual(status.status, 'unusable');
  assert.ok(status.error.includes('Unknown agent'));
}

async function testRunPreflightCheckReturnsStructuredUnusableWhenRunProcessThrows() {
  const { __test } = require('../src/setup-service');

  const spawnError = new Error('Access is denied.');
  spawnError.code = 'EPERM';

  const result = await __test.runPreflightCheck({
    getAdapter() {
      return {
        buildPreflightInvocation() {
          return {
            command: 'node',
            args: ['--help'],
            cwd: process.cwd(),
            timeoutMs: 1000
          };
        }
      };
    },
    __test: {
      runProcess: async () => {
        throw spawnError;
      },
      annotatePreflightResult() {
        throw new Error('annotatePreflightResult should not run when runProcess throws');
      }
    }
  }, 'claude', 'C:\\fake\\claude.exe', {
    timeoutMs: 1000,
    cwd: process.cwd()
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.readinessKind, 'unusable');
  assert.strictEqual(result.exitCode, null);
  assert.strictEqual(result.error, spawnError);
}

async function testGetAdapterDisplayStatus() {
  const { getAdapterDisplayStatus } = require('../src/setup-service');

  const display = await getAdapterDisplayStatus('unknown-agent', {
    checkAdapterStatus: async () => ({
      agentId: 'unknown-agent',
      metadata: null,
      status: 'unusable',
      ready: false,
      error: 'Unknown agent "unknown-agent".',
      nextAction: null,
      resolvedPath: null
    })
  });
  assert.strictEqual(display.id, 'unknown-agent');
  assert.strictEqual(display.ready, false);
  assert.strictEqual(display.hasError, true);
  assert.ok(display.errorMessage);
}

async function testGetAdapterDisplayStatusIncludesMetadata() {
  const { getAdapterDisplayStatus, getAdapterMetadata } = require('../src/setup-service');
  const metadata = getAdapterMetadata('claude');

  const display = await getAdapterDisplayStatus('claude', {
    checkAdapterStatus: async () => ({
      agentId: 'claude',
      metadata,
      status: 'missing',
      ready: false,
      error: 'Command not found',
      nextAction: {
        type: 'install',
        command: metadata.installHint,
        message: 'Install Claude Code'
      },
      resolvedPath: null
    })
  });

  assert.ok(display.metadata, 'display metadata is included');
  assert.strictEqual(display.metadata.installCommand.packageName, '@anthropic-ai/claude-cli');
  assert.strictEqual(display.nextAction.type, 'install');
}

async function testRunAdapterInstallRequiresApproval() {
  const { runAdapterInstall } = require('../src/setup-service');

  const result = await runAdapterInstall('claude', { approved: false });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.helperAvailable, true);
  assert.strictEqual(result.approved, false);
  assert.ok(result.error.includes('explicit approval'));
}

async function testRunAdapterInstallReturnsUnsupportedForManualInstallAgents() {
  const { runAdapterInstall } = require('../src/setup-service');

  const result = await runAdapterInstall('kilo', { approved: true });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.helperAvailable, false);
  assert.ok(result.error.includes('does not have a built-in install helper'));
}

async function testRunAdapterInstallExecutesAndRefreshesStatus() {
  const { runAdapterInstall } = require('../src/setup-service');

  let runnerCall = null;
  let checkCallCount = 0;
  const result = await runAdapterInstall('claude', {
    approved: true,
    cwd: 'C:\\Loopi',
    commandRunner: async (invocation) => {
      runnerCall = invocation;
      return {
        exitCode: 0,
        stdout: 'installed',
        stderr: ''
      };
    },
    checkStatus: async () => {
      checkCallCount += 1;
      return {
        agentId: 'claude',
        status: 'installed_but_needs_login',
        ready: false
      };
    }
  });

  assert.ok(runnerCall, 'install runner was called');
  assert.ok(runnerCall.command === 'npm.cmd' || runnerCall.command === 'npm');
  assert.deepStrictEqual(runnerCall.args.slice(0, 2), ['install', '-g']);
  assert.strictEqual(checkCallCount, 1, 'status re-check runs after install');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.statusAfter.status, 'installed_but_needs_login');
}

async function testInstallCommandUsesShellForWindowsCmdShims() {
  const { __test } = require('../src/setup-service');

  const invocation = __test.buildInstallInvocation({
    type: 'npm-global',
    packageName: '@google/gemini-cli',
    command: 'npm install -g @google/gemini-cli'
  });

  if (process.platform === 'win32') {
    assert.strictEqual(invocation.command, 'npm.cmd');
    assert.strictEqual(__test.shouldUseShellForCommand(invocation.command), true,
      'Windows .cmd install helpers should use cmd.exe wrapper handling');
    assert.strictEqual(
      __test.buildWindowsCommandLine(invocation.command, invocation.args),
      'npm.cmd install -g @google/gemini-cli'
    );
  } else {
    assert.strictEqual(invocation.command, 'npm');
    assert.strictEqual(__test.shouldUseShellForCommand(invocation.command), false);
  }
}

async function testRunAdapterLoginRequiresApproval() {
  const { runAdapterLogin } = require('../src/setup-service');

  const result = await runAdapterLogin('claude', { approved: false });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.helperAvailable, true);
  assert.strictEqual(result.approved, false);
  assert.ok(result.error.includes('explicit approval'));
}

async function testRunAdapterLoginLaunchesAndRefreshesStatus() {
  const { runAdapterLogin } = require('../src/setup-service');

  let launchCall = null;
  let checkCallCount = 0;
  const result = await runAdapterLogin('codex', {
    approved: true,
    cwd: 'C:\\Loopi',
    interactiveLauncher: async (invocation) => {
      launchCall = invocation;
      return {
        exitCode: 0,
        stdout: '',
        stderr: ''
      };
    },
    checkStatus: async () => {
      checkCallCount += 1;
      return {
        agentId: 'codex',
        status: 'ready',
        ready: true
      };
    }
  });

  assert.ok(launchCall, 'login launcher was called');
  assert.strictEqual(launchCall.command, 'codex');
  assert.deepStrictEqual(launchCall.args, ['auth', 'login']);
  assert.strictEqual(launchCall.shellCommand, 'codex auth login');
  assert.strictEqual(checkCallCount, 1, 'status re-check runs after login');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.statusAfter.status, 'ready');
}

async function testRunAdapterLoginRequiresReadyStatusAfterSuccessfulLaunch() {
  const { runAdapterLogin } = require('../src/setup-service');

  const result = await runAdapterLogin('codex', {
    approved: true,
    cwd: 'C:\\Loopi',
    interactiveLauncher: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: ''
    }),
    checkStatus: async () => ({
      agentId: 'codex',
      status: 'installed_but_needs_login',
      ready: false
    })
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.message, 'Codex CLI login window closed, but the adapter is still not ready.');
  assert.ok(String(result.error).includes('still not ready'));
}

async function testBuildWindowsInteractiveLaunchScriptPropagatesChildExitCode() {
  const { __test } = require('../src/setup-service');

  const script = __test.buildWindowsInteractiveLaunchScript('codex auth login', 'C:\\Loopi');
  assert.ok(script.includes('-Wait -PassThru'));
  assert.ok(script.includes('exit $process.ExitCode'));
}

async function testGetAllAdapterDisplayStatus() {
  const { getAllAdapterDisplayStatus } = require('../src/setup-service');

  const allStatus = await getAllAdapterDisplayStatus({
    checkAdapterStatus: async (agentName) => ({
      agentId: agentName,
      metadata: {
        displayName: agentName === 'claude' ? 'Claude Code' : agentName,
        docsUrl: 'https://example.test',
        envOverride: null
      },
      status: 'ready',
      ready: true,
      error: null,
      nextAction: null,
      resolvedPath: `C:\\fake\\${agentName}`
    })
  });
  assert.ok(Array.isArray(allStatus));
  assert.ok(allStatus.length > 0);

  const claudeStatus = allStatus.find(s => s.id === 'claude');
  assert.ok(claudeStatus, 'claude status is included');
  assert.strictEqual(claudeStatus.displayName, 'Claude Code');
  assert.ok('status' in claudeStatus);
  assert.ok('ready' in claudeStatus);
}

async function main() {
  console.log('setup-service: running tests...');

  await testGetAdapterMetadata();
  console.log('  [PASS] getAdapterMetadata returns correct metadata');

  await testGetAllAdapterMetadata();
  console.log('  [PASS] getAllAdapterMetadata returns all adapters');

  await testGetAllAdapterOptionMetadata();
  console.log('  [PASS] getAllAdapterOptionMetadata returns adapter option schemas');

  await testParseClaudeBundleModelOptions();
  console.log('  [PASS] parseClaudeBundleModelOptions extracts local CLI model options');

  await testDiscoverAdapterOptionsFallsBackToWindowsCommandShim();
  console.log('  [PASS] discoverAdapterOptions falls back to Windows command shims for model discovery');

  await testParseCliModelList();
  console.log('  [PASS] parseCliModelList extracts provider/model IDs');

  await testParseCliModelListTreatsReasoningWithoutEffortAsThinkingToggle();
  console.log('  [PASS] parseCliModelList treats reasoning-without-effort models as thinking toggles');

  await testParseCliAgentList();
  console.log('  [PASS] parseCliAgentList extracts OpenCode agent IDs');

  await testDiscoverOpencodeOptionsUsesCliModelsAndAgents();
  console.log('  [PASS] discoverAdapterOptions uses OpenCode CLI model and agent discovery');

  await testGetSupportedAgentIds();
  console.log('  [PASS] getSupportedAgentIds returns supported agent IDs');

  await testStatusConstants();
  console.log('  [PASS] STATUS constants are defined correctly');

  await testFormatPreflightErrorCommandNotFound();
  console.log('  [PASS] formatPreflightError handles command_not_found');

  await testFormatPreflightErrorAuthFailure();
  console.log('  [PASS] formatPreflightError handles auth_failure');

  await testFormatPreflightErrorUnusable();
  console.log('  [PASS] formatPreflightError handles unusable');

  await testFormatPreflightErrorUnknownAgent();
  console.log('  [PASS] formatPreflightError handles unknown agents');

  await testCheckAdapterStatusUnknownAgent();
  console.log('  [PASS] checkAdapterStatus handles unknown agents');

  await testRunPreflightCheckReturnsStructuredUnusableWhenRunProcessThrows();
  console.log('  [PASS] runPreflightCheck returns structured unusable result when process spawning fails');

  await testGetAdapterDisplayStatus();
  console.log('  [PASS] getAdapterDisplayStatus returns display-friendly status');

  await testGetAdapterDisplayStatusIncludesMetadata();
  console.log('  [PASS] getAdapterDisplayStatus includes metadata for helper-driven UI actions');

  await testGetAllAdapterDisplayStatus();
  console.log('  [PASS] getAllAdapterDisplayStatus returns all display statuses');

  await testRunAdapterInstallRequiresApproval();
  console.log('  [PASS] runAdapterInstall requires explicit approval');

  await testRunAdapterInstallReturnsUnsupportedForManualInstallAgents();
  console.log('  [PASS] runAdapterInstall reports unsupported helpers for manual-only agents');

  await testRunAdapterInstallExecutesAndRefreshesStatus();
  console.log('  [PASS] runAdapterInstall executes the helper and refreshes status');

  await testInstallCommandUsesShellForWindowsCmdShims();
  console.log('  [PASS] install helper uses shell-safe handling for Windows command shims');

  await testRunAdapterLoginRequiresApproval();
  console.log('  [PASS] runAdapterLogin requires explicit approval');

  await testRunAdapterLoginLaunchesAndRefreshesStatus();
  console.log('  [PASS] runAdapterLogin launches the helper and refreshes status');

  await testRunAdapterLoginRequiresReadyStatusAfterSuccessfulLaunch();
  console.log('  [PASS] runAdapterLogin only succeeds when the adapter is actually ready afterward');

  await testBuildWindowsInteractiveLaunchScriptPropagatesChildExitCode();
  console.log('  [PASS] Windows login launcher script propagates the child process exit code');

  console.log('setup-service: all tests passed');
}

main();
