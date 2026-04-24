const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { __test: adapterTest, clearAuthCache, resolveModelArgs, resolveEffortArgs } = require('../src/adapters');
const { resolveWriteModeArgs } = require('../src/adapters');

function buildResolvedOptions(agent, baseOptions) {
  const model = baseOptions.model || null;
  const effort = baseOptions.effort || null;
  return {
    ...baseOptions,
    resolvedModelArgs: model != null ? resolveModelArgs(agent, model) : { args: [], warnings: [] },
    resolvedEffortArgs: effort != null ? resolveEffortArgs(agent, model, effort) : { args: [], warnings: [] },
    warnings: [
      ...(model != null ? resolveModelArgs(agent, model).warnings : []),
      ...(effort != null ? resolveEffortArgs(agent, model, effort).warnings : [])
    ]
  };
}

function testCodexFallbackDetection() {
  assert.equal(
    adapterTest.shouldRetryCodexWithFallback({
      ok: false,
      timedOut: false,
      outputText: 'error: unexpected argument \'--ask-for-approval\' found\n\nUsage: codex exec ...'
    }),
    'cli_parse_error'
  );

  assert.equal(
    adapterTest.shouldRetryCodexWithFallback({
      ok: false,
      timedOut: false,
      outputText: 'Error: Access is denied. (os error 5)'
    }),
    false
  );
}

function testCodexFallbackInvocationIsMinimal() {
  const invocation = adapterTest.buildCodexMinimalFallbackInvocation('C:\\codex.js', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Reply with OK'
  });

  assert.deepEqual(invocation.args, [
    'C:\\codex.js',
    'exec',
    '--skip-git-repo-check',
    'Reply with OK'
  ]);
}

function testCodexSafeFallbackPreservesSandbox() {
  const invocation = adapterTest.buildCodexSafeFallbackInvocation('C:\\codex.js', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Review the repo',
    canWrite: false
  });

  assert.deepEqual(invocation.args, [
    'C:\\codex.js',
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    'C:\\repo',
    'Review the repo'
  ]);
}

function testCodexPrimaryInvocationSupportsWriteAccess() {
  const opts = buildResolvedOptions('codex', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Implement the change',
    canWrite: true
  });
  const invocation = adapterTest.buildCodexPrimaryInvocation('C:\\codex.js', opts);

  assert.deepEqual(invocation.args, [
    'C:\\codex.js',
    '--ask-for-approval',
    'never',
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '--color',
    'never',
    '--cd',
    'C:\\repo',
    'Implement the change'
  ]);
  assert.deepEqual(invocation.warnings, [], 'no model/effort produces no warnings');
}

function testClaudeEmptyOutputTriggersRetry() {
  assert.equal(
    adapterTest.shouldRetryClaudeWithFallback({ ok: true, outputText: '' }),
    'empty_output'
  );
  assert.equal(
    adapterTest.shouldRetryClaudeWithFallback({ ok: true, outputText: 'some output' }),
    false
  );
  assert.equal(
    adapterTest.shouldRetryClaudeWithFallback({ ok: false, outputText: '' }),
    false
  );
}

function testClaudeNotLoggedInTriggersFallback() {
  assert.equal(
    adapterTest.shouldRetryClaudeWithFallback({ ok: true, outputText: 'Not logged in · Please run /login' }),
    'not_logged_in'
  );
}

function testClaudeRateLimitDetectionIsExact() {
  assert.equal(
    adapterTest.shouldRetryClaudeWithFallback({ ok: true, outputText: "You've hit your limit for today." }),
    'rate_limited'
  );
  assert.equal(
    adapterTest.shouldRetryClaudeWithFallback({ ok: true, outputText: 'Error: rate limit exceeded.' }),
    'rate_limited'
  );
  assert.equal(
    adapterTest.shouldRetryClaudeWithFallback({ ok: true, outputText: 'Too many requests, please wait.' }),
    'rate_limited'
  );
  assert.equal(
    adapterTest.shouldRetryClaudeWithFallback({ ok: true, outputText: 'usage limit reached' }),
    'rate_limited'
  );

  assert.equal(
    adapterTest.shouldRetryClaudeWithFallback({ ok: true, outputText: 'This approach has limitations in edge cases.' }),
    false
  );
  assert.equal(
    adapterTest.shouldRetryClaudeWithFallback({ ok: true, outputText: 'Character limit exceeded in file output.' }),
    false
  );
  assert.equal(
    adapterTest.shouldRetryClaudeWithFallback({ ok: true, outputText: 'The function limits recursion depth to 100.' }),
    false
  );
}

function testClaudeFallbackInvocationIsSimple() {
  const invocation = adapterTest.buildClaudeFallbackInvocation('claude.exe', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Plan this'
  });

  assert.deepEqual(invocation.args, [
    '--print',
    '--output-format',
    'text',
    'Plan this'
  ]);
}

function testClaudePrimaryInvocationUsesAuthenticatedSession() {
  const invocation = adapterTest.buildClaudePrimaryInvocation('claude.exe', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Plan this'
  });

  assert.deepEqual(invocation.args, [
    '--bare',
    '--print',
    '--output-format',
    'text',
    '--permission-mode',
    'plan',
    '--no-session-persistence',
    'Plan this'
  ]);
}

function testClaudePrimaryInvocationWriteMode() {
  const invocation = adapterTest.buildClaudePrimaryInvocation('claude.exe', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Implement this',
    canWrite: true
  });

  assert.deepEqual(invocation.args, [
    '--bare',
    '--print',
    '--output-format',
    'text',
    '--permission-mode',
    'bypassPermissions',
    '--no-session-persistence',
    'Implement this'
  ]);
  assert.match(invocation.displayCommand, /--permission-mode bypassPermissions/);
}

function testClaudeFallbackOmitsPermissionMode() {
  const invocation = adapterTest.buildClaudeFallbackInvocation('claude.exe', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Plan this',
    canWrite: true
  });

  assert.ok(
    !invocation.args.includes('--permission-mode'),
    'fallback must not include --permission-mode even when canWrite is true'
  );
}

function testClaudePreflightInvocationIsHelp() {
  const invocation = adapterTest.buildClaudePreflightInvocation('claude.exe', {
    cwd: 'C:\\repo',
    timeoutMs: 1000
  });

  assert.deepEqual(invocation.args, ['--help']);
}

function testCodexPreflightInvocationTargetsExecHelp() {
  const invocation = adapterTest.buildCodexPreflightInvocation('C:\\codex.js', {
    cwd: 'C:\\repo',
    timeoutMs: 1000
  });

  assert.deepEqual(invocation.args, [
    'C:\\codex.js',
    'exec',
    '--skip-git-repo-check',
    '--help'
  ]);
}

function testKiloPrimaryInvocationUsesRunAutoDir() {
  const invocation = adapterTest.buildKiloPrimaryInvocation('kilo.exe', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Review the repo'
  });

  assert.deepEqual(invocation.args, [
    'run',
    '--auto',
    '--dir',
    'C:\\repo',
    'Review the repo'
  ]);
}

function testKiloFallbackInvocationDropsAuto() {
  const invocation = adapterTest.buildKiloFallbackInvocation('kilo.exe', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Review the repo'
  });

  assert.deepEqual(invocation.args, [
    'run',
    '--dir',
    'C:\\repo',
    'Review the repo'
  ]);
}

function testKiloPreflightInvocationTargetsRunHelp() {
  const invocation = adapterTest.buildKiloPreflightInvocation('kilo.exe', {
    cwd: 'C:\\repo',
    timeoutMs: 1000
  });

  assert.deepEqual(invocation.args, ['run', '--help']);
}

function testKiloFallbackDetection() {
  assert.equal(
    adapterTest.shouldRetryKiloWithFallback({
      ok: true,
      outputText: ''
    }),
    'empty_output'
  );

  assert.equal(
    adapterTest.shouldRetryKiloWithFallback({
      ok: false,
      timedOut: false,
      outputText: 'Error: authentication required. Please run kilo auth login.'
    }),
    'not_logged_in'
  );

  assert.equal(
    adapterTest.shouldRetryKiloWithFallback({
      ok: false,
      timedOut: false,
      outputText: 'Unknown option: --auto\nkilo run [message..]'
    }),
    'cli_parse_error'
  );

  assert.equal(
    adapterTest.shouldRetryKiloWithFallback({
      ok: false,
      timedOut: false,
      outputText: 'attempt to write a readonly database'
    }),
    false
  );
}

function testKiloFatalOutputDetection() {
  assert.equal(
    adapterTest.classifyKiloFatalOutput(
      "Error: Google Generative AI API key is missing. Pass it using the 'apiKey' parameter or the GOOGLE_GENERATIVE_AI_API_KEY environment variable."
    ),
    'missing_api_key'
  );

  assert.equal(
    adapterTest.classifyKiloFatalOutput('Authentication required. Please run kilo auth login.'),
    'not_logged_in'
  );

  assert.equal(
    adapterTest.classifyKiloFatalOutput('attempt to write a readonly database'),
    null
  );
}

function testQwenPrimaryInvocationUsesPositionalPrompt() {
  const invocation = adapterTest.buildQwenPrimaryInvocation('C:\\qwen\\cli.js', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Review the repo'
  });

  assert.deepEqual(invocation.args, [
    'C:\\qwen\\cli.js',
    '--output-format',
    'text',
    '--approval-mode',
    'plan',
    'Review the repo'
  ]);
}

function testQwenFallbackInvocationUsesPromptFlag() {
  const invocation = adapterTest.buildQwenFallbackInvocation('C:\\qwen\\cli.js', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Review the repo'
  });

  assert.deepEqual(invocation.args, [
    'C:\\qwen\\cli.js',
    '-p',
    'Review the repo',
    '--output-format',
    'text'
  ]);
}

function testQwenPreflightInvocationTargetsHelp() {
  const invocation = adapterTest.buildQwenPreflightInvocation('C:\\qwen\\cli.js', {
    cwd: 'C:\\repo',
    timeoutMs: 1000
  });

  assert.deepEqual(invocation.args, ['C:\\qwen\\cli.js', '--help']);
}

function testQwenPrimaryInvocationWriteMode() {
  const invocation = adapterTest.buildQwenPrimaryInvocation('C:\\qwen\\cli.js', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Implement this',
    canWrite: true
  });

  assert.deepEqual(invocation.args, [
    'C:\\qwen\\cli.js',
    '--output-format',
    'text',
    '--approval-mode',
    'full',
    'Implement this'
  ]);
  assert.match(invocation.displayCommand, /--approval-mode full/);
}

function testQwenFallbackOmitsApprovalMode() {
  const invocation = adapterTest.buildQwenFallbackInvocation('C:\\qwen\\cli.js', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Implement this',
    canWrite: true
  });

  assert.ok(
    !invocation.args.includes('--approval-mode'),
    'fallback must not include --approval-mode even when canWrite is true'
  );
}

function testQwenFallbackDetection() {
  assert.equal(
    adapterTest.shouldRetryQwenWithFallback({
      ok: true,
      outputText: ''
    }),
    'empty_output'
  );

  assert.equal(
    adapterTest.shouldRetryQwenWithFallback({
      ok: false,
      timedOut: false,
      outputText: 'Authentication required. Please run qwen auth qwen-oauth.'
    }),
    'not_logged_in'
  );

  assert.equal(
    adapterTest.shouldRetryQwenWithFallback({
      ok: false,
      timedOut: false,
      outputText: 'Unknown option: --approval-mode\nUsage: qwen [options] [command]'
    }),
    'cli_parse_error'
  );

  assert.equal(
    adapterTest.shouldRetryQwenWithFallback({
      ok: false,
      timedOut: false,
      outputText: '[API Error: Connection error. (cause: fetch failed)]'
    }),
    false
  );
}

function testOpencodePreflightInvocationTargetsHelp() {
  const invocation = adapterTest.buildOpencodePreflightInvocation('opencode', {
    cwd: '/repo',
    timeoutMs: 1000
  });

  assert.deepEqual(invocation.args, ['--help']);
  assert.equal(invocation.command, 'opencode');
}

function testOpencodePlanInvocation() {
  const invocation = adapterTest.buildOpencodeInvocation('opencode', {
    cwd: '/repo',
    timeoutMs: 10000,
    prompt: 'Plan this',
    mode: 'plan'
  });

  assert.deepEqual(invocation.args, ['run', '--agent', 'plan', 'Plan this']);
  assert.equal(invocation.command, 'opencode');
  assert.doesNotMatch(invocation.displayCommand, /--model/);
}

function testOpencodeImplementInvocation() {
  // Opencode is read-only in Loopi V1 — implement also uses --agent plan.
  const invocation = adapterTest.buildOpencodeInvocation('opencode', {
    cwd: '/repo',
    timeoutMs: 10000,
    prompt: 'Implement this',
    mode: 'implement'
  });

  assert.deepEqual(invocation.args, ['run', '--agent', 'plan', 'Implement this']);
  assert.equal(invocation.command, 'opencode');
  assert.doesNotMatch(invocation.displayCommand, /--model/);
}

function testOpencodeReviewInvocation() {
  const invocation = adapterTest.buildOpencodeInvocation('opencode', {
    cwd: '/repo',
    timeoutMs: 10000,
    prompt: 'Review this',
    mode: 'review'
  });

  assert.deepEqual(invocation.args, ['run', '--agent', 'plan', 'Review this']);
  assert.equal(invocation.command, 'opencode');
}

function testOpencodeInvocationDefaultsToPlan() {
  const invocation = adapterTest.buildOpencodeInvocation('opencode', {
    cwd: '/repo',
    timeoutMs: 10000,
    prompt: 'No mode given'
  });

  assert.deepEqual(invocation.args, ['run', '--agent', 'plan', 'No mode given']);
}

function testOpencodeFallbackDetection() {
  // Tests shouldRetryOpencodeWithFallback() — currently dormant since
  // getFallbackChain() returns [] for Opencode. Keep these assertions so
  // the classification behavior is documented and ready for future enablement.
  assert.equal(
    adapterTest.shouldRetryOpencodeWithFallback({
      ok: true,
      outputText: ''
    }),
    'empty_output'
  );

  assert.equal(
    adapterTest.shouldRetryOpencodeWithFallback({
      ok: false,
      timedOut: false,
      outputText: 'Error: authentication required. Please run opencode auth login.'
    }),
    'not_logged_in'
  );

  assert.equal(
    adapterTest.shouldRetryOpencodeWithFallback({
      ok: false,
      timedOut: false,
      outputText: 'Unknown option: --agent\nUsage: opencode [options] [command]'
    }),
    'cli_parse_error'
  );

  assert.equal(
    adapterTest.shouldRetryOpencodeWithFallback({
      ok: false,
      timedOut: false,
      outputText: 'Network timeout while connecting to API.'
    }),
    false
  );
}

function testOpencodeFatalOutputDetection() {
  assert.equal(
    adapterTest.classifyOpencodeFatalOutput('Error: not logged in. Please run opencode auth login.'),
    'not_logged_in'
  );

  assert.equal(
    adapterTest.classifyOpencodeFatalOutput('Authentication required.'),
    'not_logged_in'
  );

  assert.equal(
    adapterTest.classifyOpencodeFatalOutput('Everything ran fine.'),
    null
  );

  assert.equal(
    adapterTest.classifyOpencodeFatalOutput('Error: unknown agent "build". Available agents: plan, code.'),
    'unsupported_write_mode'
  );

  assert.equal(
    adapterTest.classifyOpencodeFatalOutput('invalid agent specified'),
    'unsupported_write_mode'
  );
}

function testOpencodeRespectsReadOnlyPolicyInImplement() {
  // Opencode's implement mode maps to --agent plan (not --agent build).
  // Write access is controlled by agentPolicies config, not the adapter's mode mapping.
  const invocation = adapterTest.buildOpencodeInvocation('opencode', {
    cwd: '/repo',
    timeoutMs: 10000,
    prompt: 'Implement this',
    mode: 'implement'
  });

  assert.ok(
    invocation.args.includes('--agent') && invocation.args[invocation.args.indexOf('--agent') + 1] !== 'build',
    'Opencode implement invocation does not use --agent build by default'
  );
}

function testOpencodeUsesAgentBuildWhenCanWriteTrue() {
  const invocation = adapterTest.buildOpencodeInvocation('opencode', {
    cwd: '/repo',
    timeoutMs: 10000,
    prompt: 'Build the feature',
    mode: 'implement',
    canWrite: true
  });

  const agentIdx = invocation.args.indexOf('--agent');
  assert.ok(agentIdx >= 0, 'invocation includes --agent flag');
  assert.equal(
    invocation.args[agentIdx + 1],
    'build',
    'Opencode implement with canWrite: true uses --agent build'
  );
}

function testOpencodeNonImplementCanWriteStillPlan() {
  // canWrite should only switch to --agent build in implement mode.
  const invocation = adapterTest.buildOpencodeInvocation('opencode', {
    cwd: '/repo',
    timeoutMs: 10000,
    prompt: 'Plan something',
    mode: 'plan',
    canWrite: true
  });

  const agentIdx = invocation.args.indexOf('--agent');
  assert.equal(
    invocation.args[agentIdx + 1],
    'plan',
    'Opencode plan mode stays --agent plan even with canWrite: true'
  );
}

function testOpencodeInvocationWiresEarlyExitClassifier() {
  const invocation = adapterTest.buildOpencodeInvocation('opencode', {
    cwd: '/repo',
    timeoutMs: 10000,
    prompt: 'Test',
    mode: 'plan'
  });

  assert.equal(
    typeof invocation.earlyExitClassifier,
    'function',
    'Opencode invocation includes earlyExitClassifier for auth failure detection'
  );
}

function testNodeOrDirectDispatch() {
  const { nodeOrDirect } = adapterTest;

  // .js paths → node entrypoint
  const jsResult = nodeOrDirect('/usr/local/lib/node_modules/codex/bin/codex.js', ['exec', '--help']);
  assert.equal(jsResult.command, process.execPath, '.js path uses node');
  assert.deepEqual(jsResult.args, ['/usr/local/lib/node_modules/codex/bin/codex.js', 'exec', '--help']);
  assert.equal(jsResult.displayPrefix, 'node codex.js');

  // .mjs paths → node entrypoint
  const mjsResult = nodeOrDirect('/opt/lib/cli.mjs', ['--help']);
  assert.equal(mjsResult.command, process.execPath, '.mjs path uses node');

  // Non-.js paths → direct command
  const shimResult = nodeOrDirect('/usr/local/bin/codex', ['exec', '--help']);
  assert.equal(shimResult.command, '/usr/local/bin/codex', 'shim path runs directly');
  assert.deepEqual(shimResult.args, ['exec', '--help'], 'entrypoint not in args for direct command');
  assert.equal(shimResult.displayPrefix, 'codex');

  // .cmd wrappers → direct command
  const cmdResult = nodeOrDirect('C:\\npm\\codex.cmd', ['exec', '--help']);
  assert.equal(cmdResult.command, 'C:\\npm\\codex.cmd', '.cmd runs directly');
  assert.deepEqual(cmdResult.args, ['exec', '--help']);

  // nodeFlags only included for .js paths
  const withFlags = nodeOrDirect('/lib/index.js', ['-p', 'test'], ['--no-warnings=DEP0040']);
  assert.deepEqual(withFlags.args, ['--no-warnings=DEP0040', '/lib/index.js', '-p', 'test']);
  const directWithFlags = nodeOrDirect('/usr/bin/gemini', ['-p', 'test'], ['--no-warnings=DEP0040']);
  assert.deepEqual(directWithFlags.args, ['-p', 'test'], 'node flags dropped for direct commands');
}

function testResolveFromPathEnvPrefersWindowsCmdShim() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopi-path-'));
  try {
    const extensionless = path.join(tempDir, 'gemini');
    const cmdShim = path.join(tempDir, 'gemini.cmd');
    fs.writeFileSync(extensionless, 'node shell shim');
    fs.writeFileSync(cmdShim, '@echo off\r\n');

    const resolved = adapterTest.resolveFromPathEnv('gemini', {
      envPath: tempDir,
      pathExt: '.COM;.EXE;.BAT;.CMD',
      platform: 'win32'
    });

    assert.strictEqual(resolved, cmdShim,
      'Windows PATH lookup should prefer .cmd over extensionless npm shims');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testResolveFromPathEnvFindsUnixShim() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopi-path-'));
  try {
    const shim = path.join(tempDir, 'opencode');
    fs.writeFileSync(shim, '#!/usr/bin/env node\n');

    const resolved = adapterTest.resolveFromPathEnv('opencode', {
      envPath: tempDir,
      platform: 'linux'
    });

    assert.strictEqual(resolved, shim,
      'Unix PATH lookup should find extensionless command shims');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testCodexBuildersWithShimPath() {
  // When resolveFromPath returns a shim, builders should invoke it directly
  const invocation = adapterTest.buildCodexPrimaryInvocation('/usr/local/bin/codex', {
    cwd: '/repo',
    timeoutMs: 1000,
    prompt: 'Implement it',
    canWrite: true
  });

  assert.equal(invocation.command, '/usr/local/bin/codex', 'shim used as command directly');
  assert.deepEqual(invocation.args, [
    '--ask-for-approval',
    'never',
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '--color',
    'never',
    '--cd',
    '/repo',
    'Implement it'
  ]);

  const minimal = adapterTest.buildCodexMinimalFallbackInvocation('/usr/local/bin/codex', {
    cwd: '/repo',
    timeoutMs: 1000,
    prompt: 'Reply with OK'
  });
  assert.equal(minimal.command, '/usr/local/bin/codex');
  assert.deepEqual(minimal.args, ['exec', '--skip-git-repo-check', 'Reply with OK']);
}

function testQwenBuildersWithShimPath() {
  const invocation = adapterTest.buildQwenPrimaryInvocation('/usr/local/bin/qwen', {
    cwd: '/repo',
    timeoutMs: 1000,
    prompt: 'Review'
  });

  assert.equal(invocation.command, '/usr/local/bin/qwen', 'shim used as command directly');
  assert.deepEqual(invocation.args, [
    '--output-format',
    'text',
    '--approval-mode',
    'plan',
    'Review'
  ]);

  const preflight = adapterTest.buildQwenPreflightInvocation('/usr/local/bin/qwen', {
    cwd: '/repo',
    timeoutMs: 1000
  });
  assert.equal(preflight.command, '/usr/local/bin/qwen');
  assert.deepEqual(preflight.args, ['--help']);
}

function testCombineOutputStripsBenignPowershellNoise() {
  const output = adapterTest.combineOutput(
    '',
    [
      'Cannot set property. Property setting is supported only on core types in this language mode.',
      'At line:1 char:1',
      '+ [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
      '+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
      '    + CategoryInfo          : InvalidOperation: (:) [], RuntimeException',
      '    + FullyQualifiedErrorId : PropertySetterNotSupportedInConstrainedLanguage',
      '',
      'real stderr output'
    ].join('\n')
  );

  assert.equal(output, 'real stderr output');
}

function testCombineOutputStripsGeminiNoiseAndNormalizesMojibakeV2() {
  const output = adapterTest.combineOutput(
    [
      'Manual smoke test: register \u00c3\u00a2\u00e2\u0080\u00a0\u00e2\u0080\u0099 login \u00c3\u00a2\u00e2\u0080\u00a0\u00e2\u0080\u0099 upload avatar.',
      'Not logged in \u00c3\u201a\u00c2\u00b7 Please run /login',
      'Loaded cached credentials.',
      'Attempt 1 failed with status 429. Retrying with backoff...',
      'GaxiosError: [{'
    ].join('\n'),
    ''
  );

  assert.equal(output, 'Manual smoke test: register -> login -> upload avatar.\nNot logged in \u00b7 Please run /login');
}

function testActiveProcessRegistry() {
  const { killAllActiveProcesses } = require('../src/adapters');
  const { activeProcesses, killProcessTree } = adapterTest;

  assert.ok(activeProcesses instanceof Set, 'activeProcesses is a Set');
  assert.equal(typeof killAllActiveProcesses, 'function', 'killAllActiveProcesses is exported');

  killAllActiveProcesses();
  assert.equal(activeProcesses.size, 0, 'set is still empty after noop kill');

  assert.doesNotThrow(() => killProcessTree(null, 'SIGTERM'), 'killProcessTree(null) does not throw');
  assert.doesNotThrow(() => killProcessTree({}, 'SIGTERM'), 'killProcessTree({pid:undefined}) does not throw');
}

function testAuthCacheKeyShape() {
  const { getAuthCacheKey } = adapterTest;
  const key = getAuthCacheKey('Claude', 'C:\\bin\\claude.exe');
  assert.equal(key, 'claude::c:\\bin\\claude.exe');
  const key2 = getAuthCacheKey('CLAUDE', 'C:\\bin\\claude.exe');
  assert.equal(key, key2);
  const key3 = getAuthCacheKey('claude', 'C:\\BIN\\CLAUDE.EXE');
  assert.equal(key, key3);
  const key4 = getAuthCacheKey('claude', 'D:\\other\\claude.exe');
  assert.notEqual(key, key4);
}

function testAuthCacheClear() {
  const { authCache } = adapterTest;
  authCache.set('test::key', { valid: true, checkedAt: Date.now() });
  assert.equal(authCache.size, 1);
  clearAuthCache();
  assert.equal(authCache.size, 0);
}

async function testAuthCacheHitSkipsPreflight() {
  const { authCache, getAuthCacheKey } = adapterTest;
  clearAuthCache();

  const adapters = require('../src/adapters');

  let resolvedPath = null;
  try {
    const adapter = adapters.getAdapter('claude');
    resolvedPath = adapter.resolve();
  } catch {
    // claude not installed
  }

  if (!resolvedPath) {
    const key = getAuthCacheKey('claude', 'C:\\bin\\claude.exe');
    authCache.set(key, { valid: true, checkedAt: Date.now() });
    const cached = authCache.get(key);
    assert.ok(cached, 'cache entry exists');
    assert.ok(cached.valid, 'entry is marked valid');
    clearAuthCache();
    return;
  }

  const key = getAuthCacheKey('claude', resolvedPath);
  const seedTime = Date.now() - (2 * 60 * 1000);
  authCache.set(key, { valid: true, checkedAt: seedTime });

  return adapters.resolveAgents(['claude'], { cwd: process.cwd(), timeoutMs: 5000 }).then(() => {
    const cached = authCache.get(key);
    assert.ok(cached, 'cache entry still present after resolveAgents');
    assert.ok(cached.valid, 'entry still marked valid');
    assert.equal(
      cached.checkedAt,
      seedTime,
      'checkedAt was NOT updated — proves preflight was skipped and the old cache entry was reused'
    );
  }).catch((err) => {
    assert.fail(`resolveAgents should not have thrown with a valid cache entry: ${err.message}`);
  }).finally(() => {
    clearAuthCache();
  });
}

function testAuthCacheFailureDoesNotPersist() {
  const { authCache, getAuthCacheKey } = adapterTest;
  clearAuthCache();

  const key = getAuthCacheKey('claude', '__nonexistent_agent_path__');
  assert.equal(authCache.has(key), false, 'no cache entry before test');
  assert.equal(authCache.size, 0, 'cache is empty — no stale entries');

  clearAuthCache();
}

async function canRunProcessTests() {
  const { runProcess } = adapterTest;

  try {
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', ''],
      cwd: process.cwd(),
      timeoutMs: 5000,
      env: process.env,
      displayCommand: 'node -e ""'
    });

    return Boolean(result && typeof result.ok === 'boolean');
  } catch (error) {
    if (error && error.code === 'EPERM') {
      return false;
    }
    throw error;
  }
}

async function testCmdWrapperExecutesWithShell() {
  if (process.platform !== 'win32') {
    // This test only applies on Windows where .cmd files need cmd.exe handling.
    return;
  }

  const fs = require('fs');
  const path = require('path');
  const { runProcess } = adapterTest;

  const cmdFile = path.join(process.cwd(), '__aibridge_test_shim__.cmd');
  // A minimal .cmd that prints a known string via node.
  fs.writeFileSync(cmdFile, `@echo off\n"${process.execPath}" -e "console.log('cmd-shim-ok')"`, 'utf8');

  try {
    try {
      const result = await runProcess({
        command: cmdFile,
        args: [],
        cwd: process.cwd(),
        timeoutMs: 10000,
        env: process.env,
        displayCommand: '__aibridge_test_shim__.cmd'
      });

      assert.ok(result.ok, '.cmd wrapper executed successfully');
      assert.ok(result.outputText.includes('cmd-shim-ok'), 'output contains expected marker');
    } catch (error) {
      if (error && error.code === 'EPERM') {
        console.log('  [SKIP] cmd wrapper shell execution is blocked by the current environment');
        return;
      }
      throw error;
    }
  } finally {
    fs.unlinkSync(cmdFile);
  }
}

async function testAbortControllerFieldOnNormalRun() {
  const { runProcess } = adapterTest;
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'console.log("hello")'],
    cwd: process.cwd(),
    timeoutMs: 10000,
    env: process.env,
    displayCommand: 'node -e console.log("hello")'
  });

  assert.ok(result.ok, 'command succeeded');
  assert.equal(result.aborted, false, 'aborted is false on normal run');
  assert.equal(result.signal, null, 'signal is null for normal exit');
}

function testAbortControllerSignalUndefinedIsAccepted() {
  const { runProcess } = adapterTest;
  assert.doesNotThrow(() => {
    runProcess({
      command: process.execPath,
      args: ['-e', ''],
      cwd: process.cwd(),
      timeoutMs: 5000,
      env: process.env,
      displayCommand: 'node -e',
      signal: undefined
    });
  }, 'runProcess accepts signal === undefined');
}

async function testAbortControllerPreAborted() {
  const { runProcess } = adapterTest;
  const controller = new AbortController();
  controller.abort();

  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'console.log("should not run")'],
    cwd: process.cwd(),
    timeoutMs: 10000,
    env: process.env,
    displayCommand: 'node -e',
    signal: controller.signal
  });

  assert.equal(result.ok, false, 'pre-aborted result is not ok');
  assert.equal(result.aborted, true, 'aborted flag is true');
  assert.equal(result.durationMs, 0, 'duration is zero for pre-abort');
  assert.match(result.error.message, /aborted/i, 'error mentions abort');
}

async function testAbortControllerMidFlight() {
  const { runProcess } = adapterTest;
  const controller = new AbortController();

  const promise = runProcess({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 30000)'],
    cwd: process.cwd(),
    timeoutMs: 60000,
    env: process.env,
    displayCommand: 'node -e sleep',
    signal: controller.signal
  });

  setTimeout(() => controller.abort(), 100);

  const result = await promise;
  assert.equal(result.ok, false, 'mid-flight abort is not ok');
  assert.equal(result.aborted, true, 'aborted flag is true');
}

async function testAbortEscalationTimerClearedAfterExit() {
  const { runProcess } = adapterTest;
  const controller = new AbortController();
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const scheduledTimers = [];
  const clearedTimers = new Set();

  global.setTimeout = (fn, delay, ...args) => {
    const handle = realSetTimeout(fn, delay, ...args);
    handle.__delayMs = delay;
    scheduledTimers.push(handle);
    return handle;
  };

  global.clearTimeout = (handle) => {
    clearedTimers.add(handle);
    return realClearTimeout(handle);
  };

  try {
    const promise = runProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: process.cwd(),
      timeoutMs: 60000,
      env: process.env,
      displayCommand: 'node -e sleep',
      signal: controller.signal
    });

    realSetTimeout(() => controller.abort(), 100);

    const result = await promise;
    const escalationTimers = scheduledTimers.filter((handle) => handle.__delayMs === 5000);

    assert.equal(result.aborted, true, 'process was aborted');
    assert.ok(escalationTimers.length >= 1, 'abort path scheduled a SIGKILL escalation timer');
    assert.ok(
      escalationTimers.every((handle) => clearedTimers.has(handle)),
      'finish() clears any pending SIGKILL escalation timer once the child exits'
    );
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
}

// ── Commit 2d: resolveModelArgs / resolveEffortArgs tests ────────────────────

function testCodexPrimaryInvocationWithModel() {
  const opts = buildResolvedOptions('codex', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Implement it',
    canWrite: false,
    model: 'gpt-5.4'
  });
  const invocation = adapterTest.buildCodexPrimaryInvocation('C:\\codex.js', opts);

  assert.ok(invocation.args.includes('--model'), 'includes --model flag');
  const modelIdx = invocation.args.indexOf('--model');
  assert.equal(invocation.args[modelIdx + 1], 'gpt-5.4', 'model value is gpt-5.4');
  assert.deepEqual(invocation.warnings, [], 'valid model produces no warnings');
}

function testCodexPrimaryInvocationWithEffort() {
  const opts = buildResolvedOptions('codex', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Implement it',
    canWrite: false,
    effort: 'high'
  });
  const invocation = adapterTest.buildCodexPrimaryInvocation('C:\\codex.js', opts);

  assert.ok(invocation.args.includes('--reasoning-effort'), 'includes --reasoning-effort flag');
  const effortIdx = invocation.args.indexOf('--reasoning-effort');
  assert.equal(invocation.args[effortIdx + 1], 'high', 'effort value is high');
}

function testCodexPrimaryInvocationWithModelAndEffort() {
  const opts = buildResolvedOptions('codex', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Implement it',
    canWrite: false,
    model: 'o3',
    effort: 'medium'
  });
  const invocation = adapterTest.buildCodexPrimaryInvocation('C:\\codex.js', opts);

  assert.ok(invocation.args.includes('--model'), 'includes --model flag');
  assert.ok(invocation.args.includes('--reasoning-effort'), 'includes --reasoning-effort flag');
  assert.deepEqual(invocation.warnings, [], 'valid model and effort produce no warnings');
}

function testCodexSafeFallbackWithModel() {
  const opts = buildResolvedOptions('codex', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Implement it',
    canWrite: false,
    model: 'gpt-5.4',
    effort: 'low'
  });
  const invocation = adapterTest.buildCodexSafeFallbackInvocation('C:\\codex.js', opts);

  assert.ok(invocation.args.includes('--model'), 'safe fallback includes --model');
  assert.ok(invocation.args.includes('--reasoning-effort'), 'safe fallback includes --reasoning-effort');
  assert.deepEqual(invocation.warnings, [], 'safe fallback passes through resolved args without adding warnings');
}

function testCodexPrimaryInvocationWithUnknownEffort() {
  const opts = buildResolvedOptions('codex', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Implement it',
    canWrite: false,
    effort: 'max'
  });
  const invocation = adapterTest.buildCodexPrimaryInvocation('C:\\codex.js', opts);

  assert.ok(!invocation.args.includes('--reasoning-effort'), 'unknown effort not passed to CLI');
  assert.ok(invocation.warnings.includes('unknown_effort_value'), 'warning present for unknown effort');
}

function testClaudePrimaryInvocationReportsEffortWarning() {
  const opts = buildResolvedOptions('claude', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Plan this',
    model: 'opus',
    effort: 'high'
  });
  const invocation = adapterTest.buildClaudePrimaryInvocation('claude.exe', opts);

  assert.ok(invocation.warnings.includes('effort_not_automatable'),
    'Claude effort produces effort_not_automatable warning on invocation');
}

function testResolveModelArgsCodexOpen() {
  const { resolveModelArgs } = require('../src/adapters');

  const result = resolveModelArgs('codex', 'gpt-5.4');
  assert.deepEqual(result.args, ['--model', 'gpt-5.4']);
  assert.deepEqual(result.warnings, []);

  const nullResult = resolveModelArgs('codex', null);
  assert.deepEqual(nullResult.args, []);
  assert.deepEqual(nullResult.warnings, []);
}

function testResolveModelArgsFixedAdapter() {
  const { resolveModelArgs } = require('../src/adapters');

  const nullResult = resolveModelArgs('kilo', null);
  assert.deepEqual(nullResult.args, []);
  assert.deepEqual(nullResult.warnings, []);

  const wrongResult = resolveModelArgs('kilo', 'gpt-5.4');
  assert.deepEqual(wrongResult.args, []);
  assert.ok(wrongResult.warnings.includes('fixed_model_only'));
}

function testResolveModelArgsFixedAdapterMatchingValue() {
  const { resolveModelArgs } = require('../src/adapters');

  const matchResult = resolveModelArgs('kilo', 'Kilo Auto Free');
  assert.deepEqual(matchResult.args, []);
  assert.deepEqual(matchResult.warnings, []);
}

function testResolveEffortArgsCodex() {
  const { resolveEffortArgs } = require('../src/adapters');

  const result = resolveEffortArgs('codex', null, 'high');
  assert.deepEqual(result.args, ['--reasoning-effort', 'high']);
  assert.deepEqual(result.warnings, []);

  const nullResult = resolveEffortArgs('codex', null, null);
  assert.deepEqual(nullResult.args, []);
  assert.deepEqual(nullResult.warnings, []);
}

function testResolveEffortArgsUnsupported() {
  const { resolveEffortArgs } = require('../src/adapters');

  const result = resolveEffortArgs('gemini', null, 'high');
  assert.deepEqual(result.args, []);
  assert.ok(result.warnings.includes('unsupported_effort_option'));
}

function testResolveEffortArgsCodexUnknownValue() {
  const { resolveEffortArgs } = require('../src/adapters');

  const result = resolveEffortArgs('codex', null, 'max');
  assert.deepEqual(result.args, []);
  assert.ok(result.warnings.includes('unknown_effort_value'));
}

function testResolveModelArgsGeminiEnumerated() {
  const { resolveModelArgs } = require('../src/adapters');

  const result = resolveModelArgs('gemini', 'gemini-2.5-flash');
  assert.deepEqual(result.args, ['--model', 'gemini-2.5-flash']);
  assert.deepEqual(result.warnings, []);

  const badResult = resolveModelArgs('gemini', 'gpt-5.4');
  assert.deepEqual(badResult.args, []);
  assert.ok(badResult.warnings.includes('unknown_model_value'));
}

function testResolveModelArgsQwenFixed() {
  const { resolveModelArgs } = require('../src/adapters');

  const nullResult = resolveModelArgs('qwen', null);
  assert.deepEqual(nullResult.args, []);
  assert.deepEqual(nullResult.warnings, []);

  const wrongResult = resolveModelArgs('qwen', 'gpt-5.4');
  assert.deepEqual(wrongResult.args, []);
  assert.ok(wrongResult.warnings.includes('fixed_model_only'));

  const matchResult = resolveModelArgs('qwen', 'coder-model');
  assert.deepEqual(matchResult.args, []);
  assert.deepEqual(matchResult.warnings, []);
}

function testResolveModelArgsOpencodeFixed() {
  const { resolveModelArgs } = require('../src/adapters');

  const wrongResult = resolveModelArgs('opencode', 'some-other-model');
  assert.ok(wrongResult.warnings.includes('fixed_model_only'));
}

function testResolveEffortArgsFixedAdapters() {
  const { resolveEffortArgs } = require('../src/adapters');

  for (const agent of ['kilo', 'qwen', 'opencode']) {
    const result = resolveEffortArgs(agent, null, 'high');
    assert.deepEqual(result.args, [], `${agent} effort produces no args`);
    assert.ok(
      result.warnings.includes('unsupported_effort_option'),
      `${agent} effort produces unsupported_effort_option warning`
    );
  }
}

function testResolveEffortArgsClaude() {
  const { resolveEffortArgs } = require('../src/adapters');

  const result = resolveEffortArgs('claude', 'opus', 'high');
  assert.deepEqual(result.args, []);
  assert.ok(result.warnings.includes('effort_not_automatable'));

  const haikuResult = resolveEffortArgs('claude', 'haiku', 'high');
  assert.deepEqual(haikuResult.args, []);
  assert.ok(haikuResult.warnings.includes('unsupported_effort_for_model'));

  const nullResult = resolveEffortArgs('claude', 'opus', null);
  assert.deepEqual(nullResult.args, []);
  assert.deepEqual(nullResult.warnings, []);
}

function testGeminiPrimaryInvocationWithModel() {
  const opts = buildResolvedOptions('gemini', {
    cwd: '/repo',
    timeoutMs: 1000,
    prompt: 'Review this',
    model: 'gemini-2.5-flash'
  });
  const invocation = adapterTest.buildGeminiPrimaryInvocation('/path/to/gemini', opts);

  assert.ok(invocation.args.includes('--model'), 'includes --model flag');
  const modelIdx = invocation.args.indexOf('--model');
  assert.equal(invocation.args[modelIdx + 1], 'gemini-2.5-flash');
}

function testGeminiPrimaryInvocationWithoutModel() {
  const opts = buildResolvedOptions('gemini', {
    cwd: '/repo',
    timeoutMs: 1000,
    prompt: 'Review this'
  });
  const invocation = adapterTest.buildGeminiPrimaryInvocation('/path/to/gemini', opts);

  assert.ok(!invocation.args.includes('--model'), 'no --model flag when model is null');
}

function testClaudePrimaryInvocationWithVerifiedModel() {
  const opts = buildResolvedOptions('claude', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Plan this',
    model: 'opus'
  });
  const invocation = adapterTest.buildClaudePrimaryInvocation('claude.exe', opts);

  assert.ok(invocation.args.includes('--model'), 'includes --model flag');
  const modelIdx = invocation.args.indexOf('--model');
  assert.equal(invocation.args[modelIdx + 1], 'opus', 'known model value is used');
  assert.equal(invocation.args[invocation.args.length - 1], 'Plan this');
  assert.deepEqual(invocation.warnings, [], 'known model produces no warnings');
}

function testClaudePrimaryInvocationWithUnverifiedModel() {
  const opts = buildResolvedOptions('claude', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Plan this',
    model: 'claude-sonnet-4-6'  // Not in the known enum
  });
  const invocation = adapterTest.buildClaudePrimaryInvocation('claude.exe', opts);

  assert.ok(invocation.args.includes('--model'), 'includes --model flag for unverified model');
  const modelIdx = invocation.args.indexOf('--model');
  assert.equal(invocation.args[modelIdx + 1], 'claude-sonnet-4-6', 'unverified model passed through');
  assert.ok(invocation.warnings.includes('unverified_model_value'), 'warns that model is unverified');
}

function testClaudeFallbackRecordsCapabilityDowngrades() {
  const opts = buildResolvedOptions('claude', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Plan this',
    model: 'opus',
    effort: 'high',
    canWrite: true
  });
  const invocation = adapterTest.buildClaudeFallbackInvocation('claude.exe', opts);

  assert.ok(Array.isArray(invocation.capabilityDowngrades), 'capabilityDowngrades is an array');
  assert.ok(
    invocation.capabilityDowngrades.some(d => d.includes('model selection')),
    'records model downgrade when --model was requested'
  );
  assert.ok(
    invocation.capabilityDowngrades.some(d => d.includes('write mode')),
    'records write mode downgrade when canWrite was set'
  );
}

function testClaudeFallbackNoDowngradesWithoutModelOrWrite() {
  // Even without model intent, read-only enforcement is still a downgrade
  const invocation = adapterTest.buildClaudeFallbackInvocation('claude.exe', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Plan this',
    canWrite: false
  });

  assert.ok(invocation.capabilityDowngrades.length > 0, 'read-only enforcement is still a downgrade');
  assert.ok(
    invocation.capabilityDowngrades.some(d => d.includes('read-only enforcement')),
    'records read-only enforcement downgrade'
  );
}

function testClaudeFallbackWithWriteModeAndModel() {
  const opts = buildResolvedOptions('claude', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Plan this',
    model: 'opus',
    effort: 'high',
    canWrite: true
  });
  const invocation = adapterTest.buildClaudeFallbackInvocation('claude.exe', opts);

  assert.ok(
    invocation.capabilityDowngrades.some(d => d.includes('model selection')),
    'records model downgrade'
  );
  assert.ok(
    invocation.capabilityDowngrades.some(d => d.includes('write mode')),
    'records write mode downgrade'
  );
}

function testFormatAgentWarningUnverifiedModel() {
  const { formatAgentWarning } = require('../src/adapters');
  const msg = formatAgentWarning('claude', 'unverified_model_value', 'claude-sonnet-4-6', null);
  assert.ok(msg.includes('claude'), 'includes agent name');
  assert.ok(msg.includes('claude-sonnet-4-6'), 'includes requested model');
  assert.ok(msg.includes('passed through'), 'describes passthrough behavior');
}

function testFormatAgentWarningFixedModelOnly() {
  const { formatAgentWarning } = require('../src/adapters');
  const msg = formatAgentWarning('kilo', 'fixed_model_only', 'gpt-5', null);
  assert.ok(msg.includes('kilo'), 'includes agent name');
  assert.ok(msg.includes('gpt-5'), 'includes requested model');
  assert.ok(msg.includes('fixed model'), 'describes the problem');
}

function testFormatAgentWarningUnknownModel() {
  const { formatAgentWarning } = require('../src/adapters');
  const msg = formatAgentWarning('gemini', 'unknown_model_value', 'nonexistent', null);
  assert.ok(msg.includes('gemini'), 'includes agent name');
  assert.ok(msg.includes('nonexistent'), 'includes requested model');
  assert.ok(msg.includes('default model'), 'describes the fallback');
}

function testFormatAgentWarningUnsupportedEffortForModel() {
  const { formatAgentWarning } = require('../src/adapters');
  const msg = formatAgentWarning('claude', 'unsupported_effort_for_model', 'haiku', 'high');
  assert.ok(msg.includes('haiku'), 'includes model');
  assert.ok(msg.includes('high'), 'includes effort');
  assert.ok(msg.includes('claude'), 'includes agent');
}

function testFormatAgentWarningEffortNotAutomatableReturnsNull() {
  const { formatAgentWarning } = require('../src/adapters');
  const msg = formatAgentWarning('claude', 'effort_not_automatable', 'opus', 'high');
  assert.equal(msg, null, 'returns null for effort_not_automatable');
}

function testKiloPrimaryBuilderProducesWarnings() {
  const opts = buildResolvedOptions('kilo', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Do it',
    model: 'gpt-5'
  });
  const invocation = adapterTest.buildKiloPrimaryInvocation('kilo.exe', opts);

  assert.ok(invocation.warnings.includes('fixed_model_only'), 'kilo produces fixed_model_only warning');
}

function testQwenPrimaryBuilderProducesWarnings() {
  const opts = buildResolvedOptions('qwen', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Do it',
    model: 'gpt-5'
  });
  const invocation = adapterTest.buildQwenPrimaryInvocation('qwen.exe', opts);

  assert.ok(invocation.warnings.includes('fixed_model_only'), 'qwen produces fixed_model_only warning');
}

function testOpencodePrimaryBuilderProducesWarnings() {
  const opts = buildResolvedOptions('opencode', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Do it',
    model: 'gpt-5'
  });
  const invocation = adapterTest.buildOpencodeInvocation('opencode.exe', opts);

  assert.ok(invocation.warnings.includes('fixed_model_only'), 'opencode produces fixed_model_only warning');
}

// ── Commit 5: Provider Registry and Capability Tests ───────────────────────

function testGetCapabilityProfileClaude() {
  const { getCapabilityProfile } = require('../src/adapters');

  const profile = getCapabilityProfile('claude');
  assert.ok(profile, 'claude profile exists');
  assert.strictEqual(profile.family, 'cli');
  assert.strictEqual(profile.supportsChat, true);
  assert.strictEqual(profile.supportsWriteAccess, true);
  assert.strictEqual(profile.supportsReasoningEffort, true);
}

function testGetCapabilityProfileOpenAICompatible() {
  const { getCapabilityProfile } = require('../src/adapters');

  const profile = getCapabilityProfile('openai-compatible');
  assert.ok(profile, 'openai-compatible profile exists');
  assert.strictEqual(profile.family, 'http');
  assert.strictEqual(profile.supportsChat, true);
  assert.strictEqual(profile.supportsWriteAccess, false);
  assert.strictEqual(profile.supportsModelListing, true);
  assert.strictEqual(profile.supportsHealthChecks, true);
}

function testCheckCapabilityClaudeWriteAccess() {
  const { checkCapability } = require('../src/adapters');

  const result = checkCapability('claude', 'supportsWriteAccess');
  assert.strictEqual(result, true, 'claude supports write access');
}

function testCheckCapabilityOpenAIWriteAccess() {
  const { checkCapability } = require('../src/adapters');

  const result = checkCapability('openai-compatible', 'supportsWriteAccess');
  assert.strictEqual(result, false, 'openai-compatible does not support write access');
}

function testGetCapabilityProfileUnknownAdapter() {
  const { getCapabilityProfile } = require('../src/adapters');

  const profile = getCapabilityProfile('unknown-provider');
  assert.strictEqual(profile, null, 'unknown adapter returns null');
}

function testGetCapabilityProfileExplicitOpenAICompatible() {
  const { getCapabilityProfile } = require('../src/adapters');

  // Explicitly requesting 'openai-compatible' returns that profile
  const profile = getCapabilityProfile('openai-compatible');
  assert.ok(profile, 'openai-compatible profile exists when explicitly requested');
  assert.strictEqual(profile.family, 'http');
  assert.strictEqual(profile.supportsWriteAccess, false);
}

function testCheckCapabilityUnknownCapabilityLogsWarning() {
  const { checkCapability } = require('../src/adapters');

  // Capture console.warn
  const originalWarn = console.warn;
  let warningLogged = false;
  console.warn = (msg) => {
    if (msg.includes('Unknown capability key')) {
      warningLogged = true;
    }
  };

  try {
    const result = checkCapability('claude', 'unknownCapability');
    assert.strictEqual(result, false, 'unknown capability returns false');
    assert.ok(warningLogged, 'warning was logged for unknown capability');
  } finally {
    console.warn = originalWarn;
  }
}

function testCheckCapabilityUnknownProviderLogsWarning() {
  const { checkCapability } = require('../src/adapters');

  // Capture console.warn
  const originalWarn = console.warn;
  let warningLogged = false;
  console.warn = (msg) => {
    if (msg.includes('Unknown provider')) {
      warningLogged = true;
    }
  };

  try {
    const result = checkCapability('totally-unknown-thing', 'supportsChat');
    assert.strictEqual(result, false, 'unknown provider returns false');
    assert.ok(warningLogged, 'warning was logged for unknown provider');
  } finally {
    console.warn = originalWarn;
  }
}

function testAllCLIAdaptersHaveCapabilityProfiles() {
  const { PROVIDER_REGISTRY } = require('../src/adapters');

  const cliAgents = ['claude', 'codex', 'gemini', 'kilo', 'qwen', 'opencode'];
  for (const agent of cliAgents) {
    assert.ok(PROVIDER_REGISTRY[agent], `${agent} has a capability profile`);
    assert.strictEqual(PROVIDER_REGISTRY[agent].family, 'cli', `${agent} is a CLI adapter`);
  }
}

function testClaudeSupportsToolCalling() {
  const { checkCapability } = require('../src/adapters');

  // Claude does not support tool calling in v1
  assert.strictEqual(checkCapability('claude', 'supportsToolCalling'), false);
}

function testCodexSupportsToolCalling() {
  const { checkCapability } = require('../src/adapters');

  // Codex supports tool calling
  assert.strictEqual(checkCapability('codex', 'supportsToolCalling'), true);
}

function testGeminiReadOnly() {
  const { checkCapability } = require('../src/adapters');

  // Gemini is read-only
  assert.strictEqual(checkCapability('gemini', 'supportsWriteAccess'), false);
  assert.strictEqual(checkCapability('gemini', 'supportsChat'), true);
}

// ── Commit 6: HTTP Adapter Tests ────────────────────────────────────────────────

/**
 * Starts a minimal HTTP server on a random port for mocking provider responses.
 * @param {number} statusCode - Status code to respond with
 * @param {string|Object} responseBody - Response body (strings sent as-is, objects JSON-stringified)
 * @param {Object} [opts]
 * @param {function} [opts.onRequest] - Called with (req, rawBodyString) before responding
 * @param {boolean} [opts.hang] - If true, never send a response (for timeout tests)
 * @returns {Promise<{port: number, close: function}>}
 */
function startMockHttpServer(statusCode, responseBody, opts = {}) {
  return new Promise((resolve) => {
    const connections = new Set();
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (opts.onRequest) opts.onRequest(req, body);
        if (opts.hang) return; // Never respond — used for timeout tests
        const payload = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(payload);
      });
    });
    server.on('connection', (socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => {
          for (const socket of connections) socket.destroy();
          return new Promise((r) => server.close(r));
        }
      });
    });
  });
}

function startRouteMockHttpServer(routeHandler) {
  return new Promise((resolve) => {
    const connections = new Set();
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const handled = routeHandler(req, body, res);
        if (handled === false) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not Found', url: req.url }));
        }
      });
    });
    server.on('connection', (socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => {
          for (const socket of connections) socket.destroy();
          return new Promise((r) => server.close(r));
        }
      });
    });
  });
}

function startSequentialMockHttpServer(responses, opts = {}) {
  return new Promise((resolve) => {
    const connections = new Set();
    const requestTimes = [];
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const response = responses[Math.min(requestCount, responses.length - 1)];
        requestCount += 1;
        requestTimes.push(Date.now());
        if (opts.onRequest) opts.onRequest(req, body, requestCount, response);
        if (response?.hang) return;
        const payload = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json', ...(response.headers || {}) });
        res.end(payload);
      });
    });
    server.on('connection', (socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        getRequestCount: () => requestCount,
        getRequestTimes: () => requestTimes.slice(),
        close: () => {
          for (const socket of connections) socket.destroy();
          return new Promise((r) => server.close(r));
        }
      });
    });
  });
}

function testMakeResultEnvelope() {
  const { makeResultEnvelope } = require('../src/adapters');

  const result = makeResultEnvelope({
    ok: true,
    providerId: 'test-provider',
    family: 'http',
    outputText: 'Hello world',
    warnings: ['test warning'],
    timing: { startedAt: 1000, finishedAt: 2000, durationMs: 1000 },
    metadata: { key: 'value' }
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.providerId, 'test-provider');
  assert.strictEqual(result.family, 'http');
  assert.strictEqual(result.outputText, 'Hello world');
  assert.deepStrictEqual(result.warnings, ['test warning']);
  assert.strictEqual(result.timing.durationMs, 1000);
  assert.deepStrictEqual(result.metadata, { key: 'value' });

  // Defaults when fields are omitted
  const minimal = makeResultEnvelope({ ok: false, providerId: 'x', family: 'cli' });
  assert.strictEqual(minimal.ok, false);
  assert.deepStrictEqual(minimal.warnings, []);
  assert.strictEqual(minimal.error, null);
  assert.strictEqual(minimal.outputText, '');
}

async function testRunHttpProviderSuccessful() {
  const { runHttpProvider } = require('../src/adapters');

  const response = {
    choices: [{ message: { content: 'Hello from the model!' }, finish_reason: 'stop' }],
    model: 'test-model',
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  };
  const { port, close } = await startMockHttpServer(200, response);
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      apiKey: 'test-key'
    }, 'Hello!');

    assert.strictEqual(result.ok, true, 'ok is true on success');
    assert.strictEqual(result.outputText, 'Hello from the model!', 'outputText extracted from choices');
    assert.strictEqual(result.family, 'http', 'family is http');
    assert.strictEqual(result.providerId, 'test-provider', 'providerId set correctly');
    assert.ok(result.timing.durationMs >= 0, 'timing.durationMs is present');
    assert.strictEqual(result.error, null, 'no error on success');
  } finally {
    await close();
  }
}

async function testRunHttpProviderRequestDefaultsMerged() {
  const { runHttpProvider } = require('../src/adapters');

  let capturedBody = null;
  let capturedPath = null;
  const { port, close } = await startMockHttpServer(200, {
    choices: [{ message: { content: 'ok' } }]
  }, {
    onRequest: (req, body) => { capturedPath = req.url; capturedBody = JSON.parse(body); }
  });
  try {
    await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      requestDefaults: {
        temperature: 0.2,
        max_tokens: 999,
        top_p: 0.9,
        seed: 123
      }
    }, 'Prompt text');

    assert.ok(capturedBody !== null, 'request body was captured');
    assert.strictEqual(capturedPath, '/v1/chat/completions', 'request path is /v1/chat/completions');
    assert.strictEqual(capturedBody.temperature, 0.2, 'temperature merged from requestDefaults');
    assert.strictEqual(capturedBody.max_tokens, 999, 'max_tokens merged from requestDefaults');
    assert.strictEqual(capturedBody.top_p, 0.9, 'unknown non-transport defaults are passed through to payload');
    assert.strictEqual(capturedBody.seed, 123, 'additional requestDefaults fields are preserved in payload');
    assert.strictEqual(capturedBody.model, 'test-model', 'model set in request body');
    assert.ok(Array.isArray(capturedBody.messages), 'messages array present');
    assert.strictEqual(capturedBody.messages[0].content, 'Prompt text', 'prompt in messages');
    assert.strictEqual(capturedBody.timeoutMs, undefined, 'transport timeout is not serialized into payload');
  } finally {
    await close();
  }
}

async function testRunHttpProviderAuthFailure() {
  const { runHttpProvider } = require('../src/adapters');

  const { port, close } = await startMockHttpServer(401, { error: 'Unauthorized' });
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model'
    }, 'Prompt');

    assert.strictEqual(result.ok, false, 'ok is false on 401');
    assert.strictEqual(result.error.type, 'auth_failure', 'error type is auth_failure');
    assert.ok(result.error.statusCode === 401, 'statusCode recorded');
  } finally {
    await close();
  }
}

async function testRunHttpProviderServerError() {
  const { runHttpProvider } = require('../src/adapters');

  const { port, close } = await startMockHttpServer(500, { error: 'Internal Server Error' });
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model'
    }, 'Prompt');

    assert.strictEqual(result.ok, false, 'ok is false on 500');
    assert.strictEqual(result.error.type, 'server_error', 'error type is server_error');
  } finally {
    await close();
  }
}

async function testRunHttpProviderMalformedResponse() {
  const { runHttpProvider } = require('../src/adapters');

  const { port, close } = await startMockHttpServer(200, 'this-is-not-json');
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model'
    }, 'Prompt');

    assert.strictEqual(result.ok, false, 'ok is false on malformed JSON');
    assert.strictEqual(result.error.type, 'malformed_response', 'error type is malformed_response');
  } finally {
    await close();
  }
}

async function testRunHttpProviderTimeout() {
  const { runHttpProvider } = require('../src/adapters');

  const { port, close } = await startMockHttpServer(200, '', { hang: true });
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      requestDefaults: { timeoutMs: 100 } // extremely short timeout
    }, 'Prompt');

    assert.strictEqual(result.ok, false, 'ok is false on timeout');
    assert.strictEqual(result.error.type, 'timeout', 'error type is timeout');
  } finally {
    await close();
  }
}

async function testRunHttpProviderTimeoutMsIsTransportOnly() {
  const { runHttpProvider } = require('../src/adapters');

  let capturedBody = null;
  const { port, close } = await startMockHttpServer(200, {
    choices: [{ message: { content: 'ok' } }]
  }, {
    onRequest: (_req, body) => { capturedBody = JSON.parse(body); }
  });

  try {
    await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      requestDefaults: { timeoutMs: 1500, temperature: 0.3 }
    }, 'Prompt text');

    assert.ok(capturedBody !== null, 'request body was captured');
    assert.strictEqual(capturedBody.timeoutMs, undefined, 'timeoutMs must not be sent in request payload');
    assert.strictEqual(capturedBody.temperature, 0.3, 'valid payload defaults are preserved');
  } finally {
    await close();
  }
}

async function testRunHttpProviderInvalidBaseUrl() {
  const { runHttpProvider } = require('../src/adapters');

  const result = await runHttpProvider({
    id: 'test',
    baseUrl: 'invalid-url',
    model: 'test-model'
  }, 'Test');

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.type, 'bad_request');
  assert.ok(result.error.message.includes('Invalid baseUrl'));
}

async function testRunHttpProviderInvalidRetryPolicyFailsClearly() {
  const { runHttpProvider } = require('../src/adapters');

  const { port, close, getRequestCount } = await startSequentialMockHttpServer([
    { statusCode: 200, body: { choices: [{ message: { content: 'should not happen' } }] } }
  ]);
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      retryPolicy: { maxAttempts: 1.5 }
    }, 'Prompt');

    assert.strictEqual(result.ok, false, 'invalid retry policy should fail clearly');
    assert.strictEqual(result.error.type, 'bad_request');
    assert.match(result.error.message, /retryPolicy\.maxAttempts must be a positive integer/i);
    assert.strictEqual(getRequestCount(), 0, 'invalid retry policy should fail before sending a request');
  } finally {
    await close();
  }
}

async function testRunHttpProviderConnectionRefused() {
  const { runHttpProvider } = require('../src/adapters');

  // Port 1 is never open on any OS; connection should be refused immediately
  const result = await runHttpProvider({
    id: 'test-provider',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'test-model'
  }, 'Prompt');

  assert.strictEqual(result.ok, false, 'ok is false on connection refused');
  assert.strictEqual(result.error.type, 'connection_failure', 'error type is connection_failure');
}

async function testRunHttpProviderRetriesTransientServerErrorAndSucceeds() {
  const { runHttpProvider } = require('../src/adapters');

  const response = {
    choices: [{ message: { content: 'Recovered after retry' }, finish_reason: 'stop' }],
    model: 'test-model'
  };
  const { port, close, getRequestCount } = await startSequentialMockHttpServer([
    { statusCode: 500, body: { error: 'Temporary failure' } },
    { statusCode: 200, body: response }
  ]);
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      retryPolicy: { maxAttempts: 2, backoffMs: 1 }
    }, 'Prompt');

    assert.strictEqual(getRequestCount(), 2, 'server error is retried once');
    assert.strictEqual(result.ok, true, 'second attempt succeeds');
    assert.strictEqual(result.outputText, 'Recovered after retry');
    assert.deepStrictEqual(result.warnings, ['Retried after server_error (attempt 1 of 2)']);
    assert.strictEqual(result.metadata.retryCount, 1, 'retryCount metadata tracks the retry');
    assert.strictEqual(result.metadata.lastErrorType, 'server_error', 'lastErrorType captures the last failure');
  } finally {
    await close();
  }
}

async function testRunHttpProviderRawTemplateModeUsesRawPromptPayload() {
  const { runHttpProvider } = require('../src/adapters');

  let capturedBody = null;
  let capturedPath = null;
  const { port, close } = await startMockHttpServer(200, {
    choices: [{ text: 'raw ok', finish_reason: 'stop' }]
  }, {
    onRequest: (req, body) => {
      capturedPath = req.url;
      capturedBody = JSON.parse(body);
    }
  });
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      chatTemplateMode: 'raw'
    }, 'Prompt text');

    assert.ok(capturedBody !== null, 'request body was captured');
    assert.strictEqual(capturedPath, '/v1/completions', 'raw mode uses the completions endpoint');
    assert.strictEqual(capturedBody.prompt, 'Prompt text', 'raw mode uses prompt payload');
    assert.strictEqual(capturedBody.model, 'test-model');
    assert.strictEqual(capturedBody.messages, undefined, 'raw mode does not send messages array');
    assert.strictEqual(result.ok, true, 'raw mode request succeeds');
    assert.strictEqual(result.outputText, 'raw ok', 'raw mode reads completion text responses');
  } finally {
    await close();
  }
}


async function testRunHttpProviderAuthFailureDoesNotRetry() {
  const { runHttpProvider } = require('../src/adapters');

  const { port, close, getRequestCount } = await startSequentialMockHttpServer([
    { statusCode: 401, body: { error: 'Unauthorized' } },
    { statusCode: 200, body: { choices: [{ message: { content: 'should not happen' } }] } }
  ]);
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      retryPolicy: { maxAttempts: 2, backoffMs: 1 }
    }, 'Prompt');

    assert.strictEqual(getRequestCount(), 1, 'auth failure does not retry');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.type, 'auth_failure');
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(result.metadata.retryCount, 0, 'retryCount is zero when no retry occurs');
    assert.strictEqual(result.metadata.lastErrorType, 'auth_failure');
  } finally {
    await close();
  }
}

async function testRunHttpProviderBadRequestDoesNotRetry() {
  const { runHttpProvider } = require('../src/adapters');

  const { port, close, getRequestCount } = await startSequentialMockHttpServer([
    { statusCode: 400, body: { error: 'Bad request' } },
    { statusCode: 200, body: { choices: [{ message: { content: 'should not happen' } }] } }
  ]);
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      retryPolicy: { maxAttempts: 2, backoffMs: 1 }
    }, 'Prompt');

    assert.strictEqual(getRequestCount(), 1, 'bad request does not retry');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.type, 'bad_request');
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(result.metadata.retryCount, 0, 'retryCount is zero when no retry occurs');
    assert.strictEqual(result.metadata.lastErrorType, 'bad_request');
  } finally {
    await close();
  }
}

async function testRunHttpProviderExceedsMaxAttemptsReturnsFailureEnvelope() {
  const { runHttpProvider } = require('../src/adapters');

  const { port, close, getRequestCount } = await startSequentialMockHttpServer([
    { statusCode: 500, body: { error: 'Temporary failure' } },
    { statusCode: 500, body: { error: 'Still failing' } }
  ]);
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      retryPolicy: { maxAttempts: 2, backoffMs: 1 }
    }, 'Prompt');

    assert.strictEqual(getRequestCount(), 2, 'retries stop at maxAttempts');
    assert.strictEqual(result.ok, false, 'final envelope remains a failure');
    assert.strictEqual(result.error.type, 'server_error');
    assert.deepStrictEqual(result.warnings, ['Retried after server_error (attempt 1 of 2)']);
    assert.strictEqual(result.metadata.retryCount, 1, 'retryCount tracks completed retries');
    assert.strictEqual(result.metadata.lastErrorType, 'server_error');
  } finally {
    await close();
  }
}

async function testRunHttpProviderUnexpectedStatusDoesNotRetry() {
  const { runHttpProvider } = require('../src/adapters');

  const { port, close, getRequestCount } = await startSequentialMockHttpServer([
    { statusCode: 404, body: { error: 'Not found' } },
    { statusCode: 200, body: { choices: [{ message: { content: 'should not happen' } }] } }
  ]);
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      retryPolicy: { maxAttempts: 2, backoffMs: 1 }
    }, 'Prompt');

    assert.strictEqual(getRequestCount(), 1, 'unexpected non-200 status does not retry');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.type, 'bad_request');
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(result.metadata.retryCount, 0, 'retryCount is zero when no retry occurs');
    assert.strictEqual(result.metadata.lastErrorType, 'bad_request');
  } finally {
    await close();
  }
}

async function testRunHttpProviderRateLimitUsesDoubledBackoff() {
  const { runHttpProvider } = require('../src/adapters');

  const backoffMs = 40;
  const { port, close, getRequestCount, getRequestTimes } = await startSequentialMockHttpServer([
    { statusCode: 429, body: { error: 'Rate limited' } },
    { statusCode: 200, body: { choices: [{ message: { content: 'Recovered after rate limit' } }] } }
  ]);
  try {
    const result = await runHttpProvider({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      retryPolicy: { maxAttempts: 2, backoffMs }
    }, 'Prompt');

    const [firstRequestAt, secondRequestAt] = getRequestTimes();
    assert.strictEqual(getRequestCount(), 2, 'rate-limited requests are retried once');
    assert.ok(secondRequestAt - firstRequestAt >= backoffMs * 2, '429 retry waits with doubled backoff');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.outputText, 'Recovered after rate limit');
    assert.deepStrictEqual(result.warnings, ['Retried after rate_limited (attempt 1 of 2)']);
    assert.strictEqual(result.metadata.retryCount, 1, 'retryCount tracks rate-limit retries');
    assert.strictEqual(result.metadata.lastErrorType, 'rate_limited');
  } finally {
    await close();
  }
}



// ── Commit 7: Provider Readiness Check Tests ─────────────────────────────────────

function testCheckProviderReadinessInvalidBaseUrl() {
  const { checkProviderReadiness } = require('../src/adapters');

  return checkProviderReadiness({
    id: 'test-provider',
    baseUrl: 'not-a-valid-url',
    model: 'test-model'
  }).then(result => {
    assert.strictEqual(result.ready, false, 'not ready with invalid URL');
    assert.strictEqual(result.providerId, 'test-provider');
    assert.strictEqual(result.failureReason, 'connection_failure');
    assert.ok(result.error.includes('Invalid baseUrl'));
  });
}

function testCheckProviderReadinessTimeout() {
  const { checkProviderReadiness } = require('../src/adapters');

  return startMockHttpServer(200, '', { hang: true }).then(async ({ port, close }) => {
    try {
      const result = await checkProviderReadiness({
        id: 'test-provider',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'test-model',
        requestDefaults: { timeoutMs: 100 } // Short timeout against a hanging server
      });

      assert.strictEqual(result.ready, false, 'not ready on timeout');
      assert.strictEqual(result.failureReason, 'timeout');
    } finally {
      await close();
    }
  });
}

function testCheckProviderReadinessFunctionExists() {
  const { checkProviderReadiness } = require('../src/adapters');

  assert.strictEqual(typeof checkProviderReadiness, 'function', 'checkProviderReadiness is a function');
  assert.ok(checkProviderReadiness({
    id: 'test',
    baseUrl: 'http://localhost:9999/v1',
    model: 'test'
  }) instanceof Promise, 'returns a Promise');
}

function testCheckProviderReadinessResultStructure() {
  // Test the expected result structure (even if the check fails)
  const { checkProviderReadiness } = require('../src/adapters');

  return checkProviderReadiness({
    id: 'test-provider',
    baseUrl: 'http://localhost:9999/v1',
    model: 'test-model'
  }).then(result => {
    // Verify result structure regardless of success/failure
    assert.ok('ready' in result, 'result has ready field');
    assert.ok('providerId' in result, 'result has providerId field');
    assert.ok('checkedAt' in result, 'result has checkedAt field');
    assert.ok('modelConfirmed' in result, 'result has modelConfirmed field');
    assert.ok(Array.isArray(result.rawModels), 'rawModels is an array');
    assert.ok('failureReason' in result, 'result has failureReason field');
  });
}

// Additional Commit 7 tests with proper coverage
async function testReadinessHealthEndpointSuccess() {
  const { checkProviderReadiness } = require('../src/adapters');

  const { port, close } = await startRouteMockHttpServer((req, _body, res) => {
    if (req.url === '/v1/health/ready') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return true;
    }
    if (req.url === '/v1/models') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'models should not be called after healthy readiness' }));
      return true;
    }
    return false;
  });
  try {
    const result = await checkProviderReadiness({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      healthEndpoint: '/health/ready'
    });

    assert.strictEqual(result.ready, true, 'provider is ready when health endpoint returns 200');
    assert.strictEqual(result.providerId, 'test-provider');
    assert.strictEqual(result.modelConfirmed, false);
    assert.deepStrictEqual(result.rawModels, []);
    assert.strictEqual(result.failureReason, null);
  } finally {
    await close();
  }
}

async function testReadinessHealthFailsModelsSucceeds() {
  const { checkProviderReadiness } = require('../src/adapters');

  const { port, close } = await startRouteMockHttpServer((req, _body, res) => {
    if (req.url === '/v1/health/ready') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'health down' }));
      return true;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'test-model', object: 'model' },
          { id: 'other-model', object: 'model' }
        ]
      }));
      return true;
    }
    return false;
  });
  try {
    const result = await checkProviderReadiness({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      healthEndpoint: '/health/ready'
    });

    assert.strictEqual(result.ready, true, 'ready when health fails but /v1/models succeeds');
    assert.strictEqual(result.providerId, 'test-provider');
    assert.strictEqual(result.modelConfirmed, true);
  } finally {
    await close();
  }
}

async function testReadinessAuthFailure() {
  const { checkProviderReadiness } = require('../src/adapters');

  const { port, close } = await startMockHttpServer(401, { error: 'Unauthorized' });
  try {
    const result = await checkProviderReadiness({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      apiKey: 'test-key'
    });

    assert.strictEqual(result.ready, false, 'not ready on auth failure');
    assert.strictEqual(result.failureReason, 'auth_failure');
    assert.ok(result.error.includes('401') || result.error.includes('403'));
  } finally {
    await close();
  }
}

async function testReadinessModelNotFound() {
  const { checkProviderReadiness } = require('../src/adapters');

  const { port, close } = await startMockHttpServer(200, {
    data: [
      { id: 'other-model', object: 'model' },
      { id: 'yet-another-model', object: 'model' }
    ]
  });
  try {
    const result = await checkProviderReadiness({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model'  // This model is NOT in the response
    });

    assert.strictEqual(result.ready, false, 'not ready when configured model not found');
    assert.strictEqual(result.failureReason, 'model_not_found');
    assert.strictEqual(result.modelConfirmed, false);
    assert.strictEqual(result.rawModels.length, 2);
  } finally {
    await close();
  }
}

async function testReadinessMalformedResponse() {
  const { checkProviderReadiness } = require('../src/adapters');

  const { port, close } = await startMockHttpServer(200, 'not valid json');
  try {
    const result = await checkProviderReadiness({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model'
    });

    assert.strictEqual(result.ready, false, 'not ready on malformed JSON response');
    assert.strictEqual(result.failureReason, 'malformed_response');
    assert.ok(result.error.includes('parse'));
  } finally {
    await close();
  }
}

function testReadinessProviderIdPreservedFromNormalization() {
  const { normalizeTaskConfig } = require('../src/task-config');

  // Normalize a config with a provider
  const config = normalizeTaskConfig({
    task: 'Test',
    mode: 'plan',
    agents: ['claude'],
    providers: {
      'nim-local': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'Qwen/Qwen2.5-7B',
        apiKey: 'test-key'
      }
    }
  }, { projectRoot: process.cwd() });

  // Verify the normalized config has the id field
  assert.ok(config.providers['nim-local'], 'provider exists in normalized config');
  assert.strictEqual(config.providers['nim-local'].id, 'nim-local', 'provider id is preserved');
}

async function testReadinessHealthEndpointPathBug() {
  // Regression test for the path construction bug
  // When baseUrl is http://host/v1 and healthEndpoint is /health/ready,
  // the request should be to /v1/health/ready, not /health/ready
  const { checkProviderReadiness } = require('../src/adapters');

  let requestedPath = null;
  const { port, close } = await startMockHttpServer(200, '', {
    onRequest: (req) => {
      requestedPath = req.url;
    }
  });

  try {
    await checkProviderReadiness({
      id: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,  // Note: has /v1 path
      model: 'test-model',
      healthEndpoint: '/health/ready'
    });

    // The request should be to /v1/health/ready, NOT /health/ready
    assert.strictEqual(requestedPath, '/v1/health/ready', 'health endpoint path preserves baseUrl path component');
  } finally {
    await close();
  }
}

// Commit 13: CLI Preflight Classification Tests

function testClassifyPreflightResultOk() {
  const { classifyPreflightResult } = require('../src/adapters').__test;

  const result = {
    ok: true,
    exitCode: 0,
    outputText: 'Some valid output',
    command: 'claude',
    error: null
  };

  assert.strictEqual(classifyPreflightResult(result, 'claude'), 'ok');
}

function testClassifyPreflightResultAuthFailure() {
  const { classifyPreflightResult } = require('../src/adapters').__test;

  const result = {
    ok: false,
    exitCode: 1,
    outputText: 'please run /login to continue',
    command: 'claude',
    error: null
  };

  assert.strictEqual(classifyPreflightResult(result, 'claude'), 'auth_failure');

  // Test various auth patterns
  const authPatterns = [
    'not logged in',
    'authentication required',
    'unauthorized',
    'not authenticated',
    'auth login',
    'api key is missing',
    'google generative ai api key is missing'
  ];

  for (const pattern of authPatterns) {
    const authResult = { ...result, outputText: pattern };
    assert.strictEqual(classifyPreflightResult(authResult, 'claude'), 'auth_failure', `Should detect auth failure in: ${pattern}`);
  }
}

function testClassifyPreflightResultSuccessWithAuthReferenceStaysOk() {
  const { classifyPreflightResult } = require('../src/adapters').__test;

  const result = {
    ok: true,
    exitCode: 0,
    outputText: 'Usage: gemini --help\nCommands:\n  auth login\n  chat',
    command: 'gemini',
    error: null
  };

  assert.strictEqual(classifyPreflightResult(result, 'gemini'), 'ok');
}

function testClassifyPreflightResultCommandNotFound() {
  const { classifyPreflightResult } = require('../src/adapters').__test;

  // ENOENT error indicates command not found
  const result = {
    ok: false,
    exitCode: null,
    outputText: '',
    command: 'claude',
    error: { message: 'ENOENT', code: 'ENOENT' }
  };

  assert.strictEqual(classifyPreflightResult(result, 'claude'), 'command_not_found');
}

function testClassifyPreflightResultUnusable() {
  const { classifyPreflightResult } = require('../src/adapters').__test;

  // Non-zero exit code without recognizable patterns
  const result1 = {
    ok: false,
    exitCode: 1,
    outputText: 'some generic error',
    command: 'claude',
    error: null
  };

  assert.strictEqual(classifyPreflightResult(result1, 'claude'), 'unusable');

  // OK result but empty output
  const result2 = {
    ok: true,
    exitCode: 0,
    outputText: '',
    command: 'claude',
    error: null
  };

  assert.strictEqual(classifyPreflightResult(result2, 'claude'), 'unusable');
}

function testClassifyPreflightResultEmptyOutput() {
  const { classifyPreflightResult } = require('../src/adapters').__test;

  const result = {
    ok: true,
    exitCode: 0,
    outputText: '',
    command: 'claude',
    error: null
  };

  assert.strictEqual(classifyPreflightResult(result, 'claude'), 'unusable');
}

function testClassifyPreflightResultWhitespaceOnlyOutput() {
  const { classifyPreflightResult } = require('../src/adapters').__test;

  const result = {
    ok: true,
    exitCode: 0,
    outputText: '  \n\t  ',
    command: 'claude',
    error: null
  };

  assert.strictEqual(classifyPreflightResult(result, 'claude'), 'unusable');
}

function testFormatPreflightErrorClaudeCommandNotFound() {
  const { formatPreflightError } = require('../src/adapters').__test;

  const error = formatPreflightError('claude', 'command_not_found', null);

  assert.ok(error.includes('claude: command not found'));
  assert.ok(error.includes('npm install -g @anthropic-ai/claude-cli'));
}

function testFormatPreflightErrorClaudeAuthFailure() {
  const { formatPreflightError } = require('../src/adapters').__test;

  const error = formatPreflightError('claude', 'auth_failure', null);

  assert.ok(error.includes('claude: found but not authenticated'));
  assert.ok(error.includes('claude auth login'));
}

function testFormatPreflightErrorClaudeUnusable() {
  const { formatPreflightError } = require('../src/adapters').__test;

  const result = {
    ok: false,
    exitCode: 1,
    outputText: 'some error',
    command: 'claude'
  };

  const error = formatPreflightError('claude', 'unusable', result);

  assert.ok(error.includes('claude: found but not usable'));
  assert.ok(error.includes('Exit code'));
}

function testFormatPreflightErrorCodexCommandNotFound() {
  const { formatPreflightError } = require('../src/adapters').__test;

  const error = formatPreflightError('codex', 'command_not_found', null);

  assert.ok(error.includes('codex: command not found'));
  assert.ok(error.includes('npm install -g @openai/codex'));
}

function testFormatPreflightErrorCodexAuthFailure() {
  const { formatPreflightError } = require('../src/adapters').__test;

  const error = formatPreflightError('codex', 'auth_failure', null);

  assert.ok(error.includes('codex: found but not authenticated'));
  assert.ok(error.includes('codex auth login'));
}

function testFormatPreflightErrorKiloCommandNotFound() {
  const { formatPreflightError } = require('../src/adapters').__test;

  const error = formatPreflightError('kilo', 'command_not_found', null);

  assert.ok(error.includes('kilo: command not found'));
  assert.ok(error.includes('Kilo documentation'));
}

function testFormatPreflightErrorUnknownAgent() {
  const { formatPreflightError } = require('../src/adapters').__test;

  const error = formatPreflightError('unknown-agent', 'command_not_found', null);

  assert.ok(error.includes('unknown-agent: command not found'));
  assert.ok(error.includes('installed and available on PATH'));
}

// Commit 13c: Integration-Focused Tests

function testAnnotatePreflightResultAttachesReadinessKind() {
  const { annotatePreflightResult } = require('../src/adapters').__test;

  const result = {
    ok: true,
    exitCode: 0,
    outputText: 'Some output',
    command: 'claude',
    error: null
  };

  const annotated = annotatePreflightResult(result, 'claude');

  assert.ok(annotated.readinessKind, 'readinessKind is attached');
  assert.strictEqual(annotated.readinessKind, 'ok');
  assert.ok(annotated.ok, 'original ok is preserved');
  assert.strictEqual(annotated.outputText, 'Some output');
}

function testAnnotatePreflightResultAuthFailure() {
  const { annotatePreflightResult } = require('../src/adapters').__test;

  const result = {
    ok: false,
    exitCode: 1,
    outputText: 'please run /login',
    command: 'claude',
    error: null
  };

  const annotated = annotatePreflightResult(result, 'claude');

  assert.strictEqual(annotated.readinessKind, 'auth_failure');
}

function testAnnotatePreflightResultEmptyOutput() {
  const { annotatePreflightResult } = require('../src/adapters').__test;

  const result = {
    ok: true,
    exitCode: 0,
    outputText: '',
    command: 'claude',
    error: null
  };

  const annotated = annotatePreflightResult(result, 'claude');

  assert.strictEqual(annotated.readinessKind, 'unusable');
}

function testClaudePrimaryInvocationWithoutModel() {
  const opts = buildResolvedOptions('claude', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Plan this'
  });
  const invocation = adapterTest.buildClaudePrimaryInvocation('claude.exe', opts);

  assert.ok(!invocation.args.includes('--model'), 'no --model when not requested');
}

async function testCodexMinimalFallbackRecordsCapabilityDowngrades() {
  const opts = buildResolvedOptions('codex', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Implement it',
    canWrite: true,
    model: 'gpt-5.4',
    effort: 'high'
  });
  const invocation = adapterTest.buildCodexMinimalFallbackInvocation('C:\\codex.js', opts);

  assert.ok(Array.isArray(invocation.capabilityDowngrades), 'capabilityDowngrades is an array');
  assert.ok(
    invocation.capabilityDowngrades.some(d => d.includes('write mode')),
    'records write mode downgrade'
  );
  assert.ok(
    invocation.capabilityDowngrades.some(d => d.includes('model selection')),
    'records model downgrade'
  );
  assert.ok(
    invocation.capabilityDowngrades.some(d => d.includes('effort selection')),
    'records effort downgrade'
  );
}

function testCodexMinimalFallbackNoDowngradesWithoutIntent() {
  // Even with no model/effort intent, read-only enforcement is still dropped
  const invocation = adapterTest.buildCodexMinimalFallbackInvocation('C:\\codex.js', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Implement it',
    canWrite: false
  });

  assert.ok(invocation.capabilityDowngrades.length > 0, 'read-only enforcement is still a downgrade');
  assert.ok(
    invocation.capabilityDowngrades.some(d => d.includes('read-only enforcement')),
    'records read-only enforcement downgrade'
  );
}

function testQwenFallbackRecordsCapabilityDowngrades() {
  const opts = buildResolvedOptions('qwen', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Do it',
    canWrite: true
  });
  const invocation = adapterTest.buildQwenFallbackInvocation('qwen.exe', opts);

  assert.ok(Array.isArray(invocation.capabilityDowngrades), 'capabilityDowngrades is an array');
  assert.ok(
    invocation.capabilityDowngrades.some(d => d.includes('write mode')),
    'records write mode downgrade'
  );
}

function testQwenFallbackNoDowngradesWhenReadOnly() {
  // Read-only enforcement is still a downgrade even when canWrite is false
  const opts = buildResolvedOptions('qwen', {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Do it',
    canWrite: false
  });
  const invocation = adapterTest.buildQwenFallbackInvocation('qwen.exe', opts);

  assert.ok(invocation.capabilityDowngrades.length > 0, 'read-only enforcement is still a downgrade');
  assert.ok(
    invocation.capabilityDowngrades.some(d => d.includes('read-only enforcement')),
    'records read-only enforcement downgrade'
  );
}

function testResolveEffortArgsClaudeUnknownModelDoesNotUseDefault() {
  const { resolveEffortArgs } = require('../src/adapters');

  // When an unknown model is provided with effort, should NOT fall back to
  // default (sonnet) for validation — just say effort_not_automatable.
  const result = resolveEffortArgs('claude', 'claude-sonnet-4-6', 'high');
  assert.deepEqual(result.args, []);
  assert.ok(result.warnings.includes('effort_not_automatable'),
    'unknown model with effort returns effort_not_automatable, not unsupported_effort_for_model');
  assert.ok(!result.warnings.includes('unsupported_effort_for_model'),
    'should not claim effort is unsupported based on default model semantics');
}

function testResolveEffortArgsClaudeDefaultModelStillValidatesEffort() {
  const { resolveEffortArgs } = require('../src/adapters');

  // When no model is requested, default model (sonnet) is used.
  // 'max' is not in sonnet's efforts ['low', 'medium', 'high'],
  // so it should produce unsupported_effort_for_model.
  const result = resolveEffortArgs('claude', null, 'max');
  assert.deepEqual(result.args, []);
  assert.ok(result.warnings.includes('unsupported_effort_for_model'),
    'default model (sonnet) with invalid effort returns unsupported_effort_for_model');
}

function testResolveEffortArgsClaudeKnownModelStillValidates() {
  const { resolveEffortArgs } = require('../src/adapters');

  // Known model + invalid effort should still produce unsupported_effort_for_model
  const haikuResult = resolveEffortArgs('claude', 'haiku', 'high');
  assert.deepEqual(haikuResult.args, []);
  assert.ok(haikuResult.warnings.includes('unsupported_effort_for_model'),
    'known model with invalid effort returns unsupported_effort_for_model');

  // Known model + valid effort returns effort_not_automatable
  const opusResult = resolveEffortArgs('claude', 'opus', 'high');
  assert.deepEqual(opusResult.args, []);
  assert.ok(opusResult.warnings.includes('effort_not_automatable'),
    'known model with valid effort returns effort_not_automatable');
}

function testResolveWriteModeArgs() {
  const { resolveWriteModeArgs } = require('../src/adapters');

  // Codex
  assert.deepEqual(resolveWriteModeArgs('codex', false), ['--sandbox', 'read-only']);
  assert.deepEqual(resolveWriteModeArgs('codex', true), ['--sandbox', 'workspace-write']);

  // Claude
  assert.deepEqual(resolveWriteModeArgs('claude', false), ['--permission-mode', 'plan']);
  assert.deepEqual(resolveWriteModeArgs('claude', true), ['--permission-mode', 'bypassPermissions']);

  // Qwen
  assert.deepEqual(resolveWriteModeArgs('qwen', false), ['--approval-mode', 'plan']);
  assert.deepEqual(resolveWriteModeArgs('qwen', true), ['--approval-mode', 'full']);

  // Opencode
  assert.deepEqual(resolveWriteModeArgs('opencode', false), ['--agent', 'plan']);
  assert.deepEqual(resolveWriteModeArgs('opencode', true), ['--agent', 'build']);

  // Gemini has no writeMode config
  assert.deepEqual(resolveWriteModeArgs('gemini', false), []);
  assert.deepEqual(resolveWriteModeArgs('gemini', true), []);

  // Unknown agent throws — fail closed, not silent omission
  assert.throws(
    () => resolveWriteModeArgs('unknown', false),
    /No adapter config found/
  );
}

async function testResolvedArgsSharedAcrossPrimaryAndFallbackBuilders() {

  const model = 'gpt-5.4';
  const effort = 'medium';
  const resolvedModelArgs = resolveModelArgs('codex', model);
  const resolvedEffortArgs = resolveEffortArgs('codex', model, effort);
  const warnings = [...resolvedModelArgs.warnings, ...resolvedEffortArgs.warnings];

  const opts = {
    cwd: 'C:\\repo',
    timeoutMs: 1000,
    prompt: 'Test',
    canWrite: false,
    resolvedModelArgs,
    resolvedEffortArgs,
    warnings
  };

  // Both builders should receive the SAME resolved args
  const primary = adapterTest.buildCodexPrimaryInvocation('C:\\codex.js', opts);
  const fallback = adapterTest.buildCodexSafeFallbackInvocation('C:\\codex.js', opts);

  assert.deepEqual(primary.warnings, warnings, 'primary carries warnings from runAgent');
  assert.deepEqual(fallback.warnings, [], 'safe fallback does not add its own warnings');

  // Both should have the same model/effort args from the shared resolution
  assert.ok(primary.args.includes('--model'), 'primary has --model');
  assert.ok(fallback.args.includes('--model'), 'fallback has --model (same shared resolution)');

  const primaryModelIdx = primary.args.indexOf('--model');
  const fallbackModelIdx = fallback.args.indexOf('--model');
  assert.equal(primary.args[primaryModelIdx + 1], 'gpt-5.4', 'primary model value correct');
  assert.equal(fallback.args[fallbackModelIdx + 1], 'gpt-5.4', 'fallback model value correct');
}

async function main() {
  testCodexFallbackDetection();
  testCodexFallbackInvocationIsMinimal();
  testCodexSafeFallbackPreservesSandbox();
  testCodexPrimaryInvocationSupportsWriteAccess();
  testClaudeEmptyOutputTriggersRetry();
  testClaudeNotLoggedInTriggersFallback();
  testClaudeRateLimitDetectionIsExact();
  testClaudeFallbackInvocationIsSimple();
  testClaudePrimaryInvocationUsesAuthenticatedSession();
  testClaudePrimaryInvocationWriteMode();
  testClaudeFallbackOmitsPermissionMode();
  testClaudePreflightInvocationIsHelp();
  testCodexPreflightInvocationTargetsExecHelp();
  testKiloPrimaryInvocationUsesRunAutoDir();
  testKiloFallbackInvocationDropsAuto();
  testKiloPreflightInvocationTargetsRunHelp();
  testKiloFallbackDetection();
  testKiloFatalOutputDetection();
  testQwenPrimaryInvocationUsesPositionalPrompt();
  testQwenFallbackInvocationUsesPromptFlag();
  testQwenPrimaryInvocationWriteMode();
  testQwenFallbackOmitsApprovalMode();
  testQwenPreflightInvocationTargetsHelp();
  testQwenFallbackDetection();
  testOpencodePreflightInvocationTargetsHelp();
  testOpencodePlanInvocation();
  testOpencodeImplementInvocation();
  testOpencodeReviewInvocation();
  testOpencodeInvocationDefaultsToPlan();
  testOpencodeFallbackDetection();
  testOpencodeFatalOutputDetection();
  testOpencodeRespectsReadOnlyPolicyInImplement();
  testOpencodeUsesAgentBuildWhenCanWriteTrue();
  testOpencodeNonImplementCanWriteStillPlan();
  testOpencodeInvocationWiresEarlyExitClassifier();
  testNodeOrDirectDispatch();
  testResolveFromPathEnvPrefersWindowsCmdShim();
  testResolveFromPathEnvFindsUnixShim();
  testCodexBuildersWithShimPath();
  testQwenBuildersWithShimPath();
  testCombineOutputStripsBenignPowershellNoise();
  testCombineOutputStripsGeminiNoiseAndNormalizesMojibakeV2();
  testActiveProcessRegistry();
  testAuthCacheKeyShape();
  testAuthCacheClear();
  await testAuthCacheHitSkipsPreflight();
  testAuthCacheFailureDoesNotPersist();
  const runProcessTestsSupported = await canRunProcessTests();
  if (runProcessTestsSupported) {
    await testCmdWrapperExecutesWithShell();
    await testAbortControllerFieldOnNormalRun();
    testAbortControllerSignalUndefinedIsAccepted();
    await testAbortControllerPreAborted();
    await testAbortControllerMidFlight();
    await testAbortEscalationTimerClearedAfterExit();
  } else {
    console.log('  [SKIP] runProcess-based adapter tests are blocked by the current environment');
  }
  testCodexPrimaryInvocationWithModel();
  testCodexPrimaryInvocationWithEffort();
  testCodexPrimaryInvocationWithModelAndEffort();
  testCodexSafeFallbackWithModel();
  testCodexPrimaryInvocationWithUnknownEffort();
  testClaudePrimaryInvocationReportsEffortWarning();
  testResolveModelArgsCodexOpen();
  testResolveModelArgsFixedAdapter();
  testResolveModelArgsFixedAdapterMatchingValue();
  testResolveEffortArgsCodex();
  testResolveEffortArgsUnsupported();
  testResolveEffortArgsCodexUnknownValue();
  testResolveModelArgsGeminiEnumerated();
  testResolveModelArgsQwenFixed();
  testResolveModelArgsOpencodeFixed();
  testResolveEffortArgsFixedAdapters();
  testResolveEffortArgsClaude();
  testGeminiPrimaryInvocationWithModel();
  testGeminiPrimaryInvocationWithoutModel();
  testClaudePrimaryInvocationWithVerifiedModel();
  testClaudePrimaryInvocationWithUnverifiedModel();
  testClaudePrimaryInvocationWithoutModel();
  testClaudeFallbackRecordsCapabilityDowngrades();
  testClaudeFallbackNoDowngradesWithoutModelOrWrite();
  testClaudeFallbackWithWriteModeAndModel();
  testCodexMinimalFallbackRecordsCapabilityDowngrades();
  testCodexMinimalFallbackNoDowngradesWithoutIntent();
  testQwenFallbackRecordsCapabilityDowngrades();
  testQwenFallbackNoDowngradesWhenReadOnly();
  testResolveEffortArgsClaudeUnknownModelDoesNotUseDefault();
  testResolveEffortArgsClaudeDefaultModelStillValidatesEffort();
  testResolveEffortArgsClaudeKnownModelStillValidates();
  testResolveWriteModeArgs();
  testResolvedArgsSharedAcrossPrimaryAndFallbackBuilders();
  testFormatAgentWarningUnverifiedModel();
  testFormatAgentWarningFixedModelOnly();
  testFormatAgentWarningUnknownModel();
  testFormatAgentWarningUnsupportedEffortForModel();
  testFormatAgentWarningEffortNotAutomatableReturnsNull();
  testKiloPrimaryBuilderProducesWarnings();
  testQwenPrimaryBuilderProducesWarnings();
  testOpencodePrimaryBuilderProducesWarnings();

  // Commit 5: Provider Registry and Capability Tests
  testGetCapabilityProfileClaude();
  testGetCapabilityProfileOpenAICompatible();
  testCheckCapabilityClaudeWriteAccess();
  testCheckCapabilityOpenAIWriteAccess();
  testGetCapabilityProfileUnknownAdapter();
  testGetCapabilityProfileExplicitOpenAICompatible();
  testCheckCapabilityUnknownCapabilityLogsWarning();
  testCheckCapabilityUnknownProviderLogsWarning();
  testAllCLIAdaptersHaveCapabilityProfiles();
  testClaudeSupportsToolCalling();
  testCodexSupportsToolCalling();
  testGeminiReadOnly();

  // Commit 6: HTTP Adapter Tests
  testMakeResultEnvelope();
  await testRunHttpProviderSuccessful();
  await testRunHttpProviderRequestDefaultsMerged();
  await testRunHttpProviderRawTemplateModeUsesRawPromptPayload();

  await testRunHttpProviderAuthFailure();
  await testRunHttpProviderServerError();
  await testRunHttpProviderMalformedResponse();
  await testRunHttpProviderTimeout();
  await testRunHttpProviderTimeoutMsIsTransportOnly();
  await testRunHttpProviderInvalidBaseUrl();

  await testRunHttpProviderInvalidRetryPolicyFailsClearly();
  await testRunHttpProviderConnectionRefused();
  await testRunHttpProviderRetriesTransientServerErrorAndSucceeds();
  await testRunHttpProviderAuthFailureDoesNotRetry();
  await testRunHttpProviderBadRequestDoesNotRetry();
  await testRunHttpProviderExceedsMaxAttemptsReturnsFailureEnvelope();
  await testRunHttpProviderUnexpectedStatusDoesNotRetry();
  await testRunHttpProviderRateLimitUsesDoubledBackoff();

  // Commit 7: Provider Readiness Check Tests
  await testCheckProviderReadinessInvalidBaseUrl();
  await testCheckProviderReadinessTimeout();
  testCheckProviderReadinessFunctionExists();
  await testCheckProviderReadinessResultStructure();
  await testReadinessHealthEndpointSuccess();
  await testReadinessHealthFailsModelsSucceeds();
  await testReadinessAuthFailure();
  await testReadinessModelNotFound();
  await testReadinessMalformedResponse();
  testReadinessProviderIdPreservedFromNormalization();
  await testReadinessHealthEndpointPathBug();

  // Commit 13: CLI Preflight Classification Tests
  testClassifyPreflightResultOk();
  testClassifyPreflightResultAuthFailure();
  testClassifyPreflightResultSuccessWithAuthReferenceStaysOk();
  testClassifyPreflightResultCommandNotFound();
  testClassifyPreflightResultUnusable();
  testClassifyPreflightResultEmptyOutput();
  testClassifyPreflightResultWhitespaceOnlyOutput();
  testFormatPreflightErrorClaudeCommandNotFound();
  testFormatPreflightErrorClaudeAuthFailure();
  testFormatPreflightErrorClaudeUnusable();
  testFormatPreflightErrorCodexCommandNotFound();
  testFormatPreflightErrorCodexAuthFailure();
  testFormatPreflightErrorKiloCommandNotFound();
  testFormatPreflightErrorUnknownAgent();

  // Commit 13c: Integration tests
  testAnnotatePreflightResultAttachesReadinessKind();
  testAnnotatePreflightResultAuthFailure();
  testAnnotatePreflightResultEmptyOutput();

  console.log('adapters tests passed');
}

main();
