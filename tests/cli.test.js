const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { runCli } = require('../src/cli');
const { buildHelpText } = require('../src/cli-commands');
const { runBeginnerWizard, runAdvancedWizard, resolveWizardMode } = require('../src/cli-wizard');
const { DialecticOrchestrator } = require('../src/orchestrator');
const taskPaths = require('../src/task-paths');

const PROJECT_ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function createCaptureStream() {
  let buffer = '';
  return {
    write(chunk) {
      buffer += String(chunk);
    },
    read() {
      return buffer;
    }
  };
}

function createMockIO(answers) {
  const queue = Array.isArray(answers) ? [...answers] : [];
  let closed = false;
  const lines = [];

  return {
    async prompt() {
      if (queue.length === 0) {
        throw new Error('No more mock answers available.');
      }
      const next = queue.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    writeLine(message = '') {
      lines.push(String(message));
    },
    async close() {
      closed = true;
    },
    getLines() {
      return lines.slice();
    },
    isClosed() {
      return closed;
    }
  };
}

function createAtomicRecorder() {
  const tempContents = new Map();
  const finalWrites = [];

  return {
    finalWrites,
    async writeFile(filePath, content) {
      tempContents.set(filePath, content);
    },
    async rename(fromPath, toPath) {
      finalWrites.push({
        filePath: toPath,
        content: tempContents.get(fromPath)
      });
      tempContents.delete(fromPath);
    },
    async unlink(filePath) {
      tempContents.delete(filePath);
    }
  };
}

function runCliProcess(args, {
  projectRoot,
  input = ''
} = {}) {
  return spawnSync(process.execPath, [path.join('src', 'cli.js'), ...args], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DIALECTIC_PROJECT_ROOT: projectRoot
    },
    input,
    encoding: 'utf8'
  });
}

function quoteForPowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteForPosixShell(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function runCliPipedProcess(args, {
  projectRoot,
  inputLines = []
} = {}) {
  const env = {
    ...process.env,
    DIALECTIC_PROJECT_ROOT: projectRoot
  };
  const timeout = 15000;

  if (process.platform === 'win32') {
    const arrayExpr = `@(${inputLines.map(quoteForPowerShell).join(', ')})`;
    const cliArgs = args.map(quoteForPowerShell).join(' ');
    return spawnSync('powershell', ['-NoProfile', '-Command', `${arrayExpr} | node src/cli.js ${cliArgs}`], {
      cwd: PROJECT_ROOT,
      env,
      encoding: 'utf8',
      timeout
    });
  }

  const linesExpr = inputLines.length > 0
    ? `printf '%s\n' ${inputLines.map(quoteForPosixShell).join(' ')}`
    : `printf ''`;
  const cliArgs = args.map(quoteForPosixShell).join(' ');
  return spawnSync('sh', ['-lc', `${linesExpr} | node src/cli.js ${cliArgs}`], {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf8',
    timeout
  });
}

function allowSandboxedSpawnSkip(result) {
  if (result && result.error && result.error.code === 'EPERM') {
    console.log('  [SKIP] subprocess smoke test skipped because nested process spawning is blocked in this sandbox');
    return true;
  }
  return false;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  [FAIL] ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

console.log('cli: commit 1 wrapper commands');

test('help command prints help text and exits successfully', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(['help'], { stdout, stderr });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.strictEqual(stdout.read(), buildHelpText());
});

test('unknown command prints error and help text', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(['mystery'], { stdout, stderr });

  assert.strictEqual(exitCode, 1);
  assert.match(stderr.read(), /Unknown command "mystery"\./);
  assert.strictEqual(stdout.read(), buildHelpText());
});

test('help text includes the beginner wizard commands', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(['help'], { stdout, stderr });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.match(stdout.read(), /plan\s+Interactive plan-mode wizard/);
  assert.match(stdout.read(), /review\s+Interactive review-mode wizard/);
  assert.match(stdout.read(), /implement\s+Interactive implement-mode wizard/);
  assert.match(stdout.read(), /oneshot\s+Interactive one-shot wizard/);
  assert.match(stdout.read(), /doctor\s+Check the current task file and selected agents/);
  assert.match(stdout.read(), /new\s+Start the opt-in advanced wizard/);
});

test('open command prints path and helpful message when scratchpad is missing', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(['open'], {
    projectRoot: PROJECT_ROOT,
    stdout,
    stderr,
    readFile: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
  });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.match(stdout.read(), /Scratchpad path:/);
  assert.match(stdout.read(), /No scratchpad exists yet\./);
});

test('open command prints scratchpad contents when present', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(['open'], {
    projectRoot: PROJECT_ROOT,
    stdout,
    stderr,
    readFile: async () => 'Final result\nMore detail\n'
  });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.match(stdout.read(), /Scratchpad path:/);
  assert.match(stdout.read(), /Final result/);
  assert.match(stdout.read(), /More detail/);
});

test('run command delegates to orchestrator init and runTask', async () => {
  const calls = [];
  let orchestratorProjectRoot = null;

  const exitCode = await runCli(['run'], {
    projectRoot: PROJECT_ROOT,
    stat: async () => ({ isFile: () => true }),
    createOrchestrator: async (projectRoot) => {
      orchestratorProjectRoot = projectRoot;
      return {
        async init() {
          calls.push('init');
        },
        async runTask() {
          calls.push('runTask');
        }
      };
    }
  });

  assert.strictEqual(exitCode, 0);
  assert.deepStrictEqual(calls, ['init', 'runTask']);
  assert.strictEqual(orchestratorProjectRoot, PROJECT_ROOT);
});

test('run command reports a missing task file and does not invoke the orchestrator', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();
  let createOrchestratorCalls = 0;

  const exitCode = await runCli(['run'], {
    projectRoot: PROJECT_ROOT,
    stdout,
    stderr,
    stat: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    createOrchestrator: async () => {
      createOrchestratorCalls += 1;
      return {
        async init() {},
        async runTask() {}
      };
    }
  });

  assert.strictEqual(exitCode, 1);
  assert.strictEqual(stdout.read(), '');
  assert.strictEqual(createOrchestratorCalls, 0);
  assert.match(stderr.read(), /No task file at/);
  assert.match(stderr.read(), /npm run cli -- plan/);
});

test('orchestrator constructor honors an injected projectRoot', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-orchestrator-root-'));
  const orchestrator = new DialecticOrchestrator({ projectRoot });

  assert.strictEqual(orchestrator.projectRoot, projectRoot);
  assert.strictEqual(orchestrator.taskFile, taskPaths.legacyTaskFile(projectRoot));
  assert.strictEqual(orchestrator.scratchpadFile, taskPaths.legacyScratchpadFile(projectRoot));
});

test('plan command runs wizard and does not invoke orchestrator when runNow is false', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();
  const calls = [];

  const exitCode = await runCli(['plan'], {
    stdout,
    stderr,
    runWizard: async (command, { projectRoot }) => {
      calls.push({ type: 'wizard', command, projectRoot });
      return { runNow: false };
    },
    createOrchestrator: async () => ({
      async init() {
        calls.push({ type: 'init' });
      },
      async runTask() {
        calls.push({ type: 'runTask' });
      }
    })
  });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.strictEqual(stdout.read(), '');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].type, 'wizard');
  assert.strictEqual(calls[0].command, 'plan');
});

test('implement command runs wizard and orchestrator when runNow is true', async () => {
  const calls = [];
  let orchestratorProjectRoot = null;
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(['implement'], {
    stdout,
    stderr,
    stat: async () => ({ isFile: () => true }),
    runWizard: async (command, { projectRoot }) => {
      calls.push({ type: 'wizard', command, projectRoot });
      return { runNow: true };
    },
    createOrchestrator: async (projectRoot) => {
      orchestratorProjectRoot = projectRoot;
      return {
        async init() {
          calls.push({ type: 'init' });
        },
        async runTask() {
          calls.push({ type: 'runTask' });
        }
      };
    }
  });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.match(stdout.read(), /Task written\. Starting run\.\.\./);
  assert.deepStrictEqual(
    calls.map((entry) => entry.type),
    ['wizard', 'init', 'runTask']
  );
  assert.strictEqual(calls[0].command, 'implement');
  assert.strictEqual(calls[0].projectRoot, PROJECT_ROOT);
  assert.strictEqual(orchestratorProjectRoot, PROJECT_ROOT);
});

test('new command requires the --advanced flag', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(['new'], {
    stdout,
    stderr
  });

  assert.strictEqual(exitCode, 1);
  assert.match(stderr.read(), /Usage: npm run cli -- new --advanced/);
});

test('new --advanced runs the advanced wizard and does not invoke orchestrator when runNow is false', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();
  const calls = [];

  const exitCode = await runCli(['new', '--advanced'], {
    stdout,
    stderr,
    runAdvanced: async ({ projectRoot }) => {
      calls.push({ type: 'advanced', projectRoot });
      return { runNow: false };
    },
    createOrchestrator: async () => ({
      async init() {
        calls.push({ type: 'init' });
      },
      async runTask() {
        calls.push({ type: 'runTask' });
      }
    })
  });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.strictEqual(stdout.read(), '');
  assert.deepStrictEqual(calls, [{ type: 'advanced', projectRoot: PROJECT_ROOT }]);
});

test('new --advanced can run the orchestrator immediately', async () => {
  const calls = [];
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(['new', '--advanced'], {
    stdout,
    stderr,
    stat: async () => ({ isFile: () => true }),
    runAdvanced: async ({ projectRoot }) => {
      calls.push({ type: 'advanced', projectRoot });
      return { runNow: true };
    },
    createOrchestrator: async () => ({
      async init() {
        calls.push({ type: 'init' });
      },
      async runTask() {
        calls.push({ type: 'runTask' });
      }
    })
  });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.match(stdout.read(), /Task written\. Starting run\.\.\./);
  assert.deepStrictEqual(calls.map((entry) => entry.type), ['advanced', 'init', 'runTask']);
});

test('preset list prints a helpful message when no presets exist', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(['preset', 'list'], {
    stdout,
    stderr,
    listPresetEntries: async () => []
  });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.match(stdout.read(), /No presets saved yet\./);
});

test('preset save delegates to the preset saver with the provided name', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();
  const calls = [];

  const exitCode = await runCli(['preset', 'save', 'my-review'], {
    stdout,
    stderr,
    savePresetFile: async (name, { projectRoot }) => {
      calls.push({ name, projectRoot });
      return {
        presetFile: path.join(projectRoot, 'shared', 'presets', `${name}.json`)
      };
    }
  });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.deepStrictEqual(calls, [{
    name: 'my-review',
    projectRoot: PROJECT_ROOT
  }]);
  assert.match(stdout.read(), /Preset "my-review" saved to/);
});

test('preset use copies a preset into shared/task.json and prints the run hint', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();
  const calls = [];

  const exitCode = await runCli(['preset', 'use', 'my-review'], {
    stdout,
    stderr,
    usePresetFile: async (name, { projectRoot }) => {
      calls.push({ name, projectRoot });
      return {
        taskFile: path.join(projectRoot, 'shared', 'task.json')
      };
    }
  });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.deepStrictEqual(calls, [{
    name: 'my-review',
    projectRoot: PROJECT_ROOT
  }]);
  assert.match(stdout.read(), /Preset "my-review" copied to/);
  assert.match(stdout.read(), /npm run cli -- run/);
});

test('preset save validates and writes the current task into shared/presets', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-preset-save-'));
  const recorder = createAtomicRecorder();

  const { savePreset } = require('../src/cli-presets');
  const result = await savePreset('safe-plan', {
    projectRoot,
    readFile: async () => JSON.stringify({
      mode: 'plan',
      prompt: 'Plan safely',
      agents: ['claude']
    }),
    mkdir: async () => {},
    writeFile: recorder.writeFile,
    rename: recorder.rename,
    unlink: recorder.unlink
  });

  assert.strictEqual(result.presetName, 'safe-plan');
  assert.strictEqual(recorder.finalWrites.length, 1);
  assert.ok(recorder.finalWrites[0].filePath.endsWith(path.join('shared', 'presets', 'safe-plan.json')));
  assert.deepStrictEqual(JSON.parse(recorder.finalWrites[0].content), {
    mode: 'plan',
    prompt: 'Plan safely',
    agents: ['claude']
  });
});

test('preset use validates and writes the selected preset into shared/task.json', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-preset-use-'));
  const recorder = createAtomicRecorder();

  const { usePreset } = require('../src/cli-presets');
  const result = await usePreset('safe-plan', {
    projectRoot,
    readFile: async () => JSON.stringify({
      mode: 'review',
      prompt: 'Review safely',
      agents: ['claude', 'codex']
    }),
    mkdir: async () => {},
    writeFile: recorder.writeFile,
    rename: recorder.rename,
    unlink: recorder.unlink
  });

  assert.strictEqual(result.presetName, 'safe-plan');
  assert.strictEqual(recorder.finalWrites.length, 1);
  assert.ok(recorder.finalWrites[0].filePath.endsWith(path.join('shared', 'task.json')));
  assert.deepStrictEqual(JSON.parse(recorder.finalWrites[0].content), {
    mode: 'review',
    prompt: 'Review safely',
    agents: ['claude', 'codex']
  });
});

test('preset use reports a missing preset clearly', async () => {
  const { usePreset } = require('../src/cli-presets');

  await assert.rejects(async () => {
    await usePreset('missing', {
      projectRoot: PROJECT_ROOT,
      readFile: async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
    });
  }, /missing/);
});

test('preset save reports invalid task JSON clearly', async () => {
  const { savePreset } = require('../src/cli-presets');

  await assert.rejects(async () => {
    await savePreset('bad-task', {
      projectRoot: PROJECT_ROOT,
      readFile: async () => '{not json}'
    });
  }, /Invalid JSON in/);
});

test('preset helpers reject unsafe preset names', async () => {
  const { savePreset } = require('../src/cli-presets');

  await assert.rejects(async () => {
    await savePreset('../unsafe', {
      projectRoot: PROJECT_ROOT,
      readFile: async () => JSON.stringify({
        mode: 'plan',
        prompt: 'Plan safely',
        agents: ['claude']
      })
    });
  }, /presetName must not contain path separators|presetName must not contain path traversal/);
});

test('doctor command prints healthy output and exits successfully', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(['doctor'], {
    stdout,
    stderr,
    runDoctor: async () => ({
      ok: true,
      lines: [
        '[ok] Task file found',
        '[ok] Task config loaded'
      ]
    })
  });

  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stderr.read(), '');
  assert.match(stdout.read(), /\[ok] Task file found/);
  assert.match(stdout.read(), /\[ok] Task config loaded/);
});

test('doctor command reports failure output and exits non-zero', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(['doctor'], {
    stdout,
    stderr,
    runDoctor: async () => ({
      ok: false,
      lines: [
        '[fail] Task file is missing'
      ]
    })
  });

  assert.strictEqual(exitCode, 1);
  assert.strictEqual(stderr.read(), '');
  assert.match(stdout.read(), /\[fail] Task file is missing/);
});

test('doctor helper reports missing task file with a useful hint', async () => {
  const { runDoctorCheck } = require('../src/cli-doctor');

  const result = await runDoctorCheck({
    projectRoot: PROJECT_ROOT,
    readFile: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.lines.some((line) => line.includes('Task file is missing')));
  assert.ok(result.lines.some((line) => line.includes('npm run cli -- plan')));
});

test('doctor helper validates config and checks CLI agents', async () => {
  const { runDoctorCheck } = require('../src/cli-doctor');

  const result = await runDoctorCheck({
    projectRoot: PROJECT_ROOT,
    readFile: async () => JSON.stringify({
      mode: 'review',
      prompt: 'Review this safely',
      agents: ['claude']
    }),
    resolveCliAgents: async (agents, options) => {
      assert.deepStrictEqual(agents, ['claude']);
      assert.ok(options.cwd);
      assert.ok(options.timeoutMs > 0);
    }
  });

  assert.strictEqual(result.ok, true);
  assert.ok(result.lines.some((line) => line.includes('Task config loaded')));
  assert.ok(result.lines.some((line) => line.includes('CLI agents available: claude')));
});

test('doctor helper reports invalid task JSON plainly', async () => {
  const { runDoctorCheck } = require('../src/cli-doctor');

  const result = await runDoctorCheck({
    projectRoot: PROJECT_ROOT,
    readFile: async () => '{not json}'
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.lines.some((line) => line.includes('Task file path:')));
  assert.ok(result.lines.some((line) => line.includes('Task file contains invalid JSON')));
});

test('doctor helper reports when only HTTP providers need no CLI preflight', async () => {
  const { runDoctorCheck } = require('../src/cli-doctor');

  const result = await runDoctorCheck({
    projectRoot: PROJECT_ROOT,
    readFile: async () => JSON.stringify({
      mode: 'review',
      prompt: 'Review this safely',
      agents: ['claude']
    }),
    normalizeConfig: () => ({
      mode: 'review',
      agents: ['claude'],
      context: null,
      settings: {
        cwd: PROJECT_ROOT,
        timeoutMs: 1000
      },
      providers: {
        'local-http': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          apiKey: 'dummy',
          model: 'test-model'
        }
      },
      executionTargets: ['local-http']
    }),
    resolveCliAgents: async () => {
      throw new Error('resolveCliAgents should not run when only HTTP providers are selected.');
    }
  });

  assert.strictEqual(result.ok, true);
  assert.ok(result.lines.some((line) => line.includes('only configured HTTP providers')));
});

test('resolveWizardMode maps oneshot command to one-shot config mode', async () => {
  assert.strictEqual(resolveWizardMode('oneshot'), 'one-shot');
});

test('beginner wizard writes a validated plan config and prints run-later guidance', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cli-plan-'));
  fs.mkdirSync(path.join(projectRoot, 'context'), { recursive: true });

  const io = createMockIO([
    '',
    'Review this repo for cleanup opportunities',
    '1,2',
    'y',
    'n'
  ]);

  const recorder = createAtomicRecorder();
  const result = await runBeginnerWizard('plan', {
    io,
    projectRoot,
    mkdir: async () => {},
    writeFile: recorder.writeFile,
    rename: recorder.rename,
    unlink: recorder.unlink
  });

  assert.strictEqual(result.mode, 'plan');
  assert.strictEqual(result.runNow, false);
  assert.strictEqual(recorder.finalWrites.length, 1);
  assert.strictEqual(recorder.finalWrites[0].filePath, taskPaths.legacyTaskFile(projectRoot));

  const writtenConfig = JSON.parse(recorder.finalWrites[0].content);
  assert.strictEqual(writtenConfig.mode, 'plan');
  assert.strictEqual(writtenConfig.prompt, 'Review this repo for cleanup opportunities');
  assert.deepStrictEqual(writtenConfig.agents, ['claude', 'codex']);
  assert.deepStrictEqual(writtenConfig.context, { dir: './context' });
  assert.ok(result.normalizedConfig);
  assert.deepStrictEqual(result.normalizedConfig.agents, ['claude', 'codex']);
  assert.ok(io.getLines().includes('Please enter a non-empty prompt.'));
  assert.ok(io.getLines().some((line) => line.includes('Task written to')));
  assert.ok(io.getLines().some((line) => line.includes('npm run cli -- run')));
  assert.strictEqual(io.isClosed(), true);
});

test('beginner wizard writes one-shot config with explicit write-enabled agent', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cli-oneshot-'));
  const io = createMockIO([
    'Implement this feature safely',
    'codex,claude',
    'y',
    '1',
    'y'
  ]);

  const recorder = createAtomicRecorder();
  const result = await runBeginnerWizard('oneshot', {
    io,
    projectRoot,
    mkdir: async () => {},
    stat: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    writeFile: recorder.writeFile,
    rename: recorder.rename,
    unlink: recorder.unlink
  });

  assert.strictEqual(result.mode, 'one-shot');
  assert.strictEqual(result.runNow, true);
  assert.strictEqual(recorder.finalWrites.length, 1);

  const writtenConfig = JSON.parse(recorder.finalWrites[0].content);
  assert.strictEqual(writtenConfig.mode, 'one-shot');
  assert.deepStrictEqual(writtenConfig.agents, ['codex', 'claude']);
  assert.deepStrictEqual(writtenConfig.settings, {
    agentPolicies: {
      codex: { canWrite: true }
    }
  });
  assert.strictEqual(io.isClosed(), true);
});

test('beginner wizard does not write partial config when prompting is interrupted', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cli-cancel-'));
  const io = createMockIO([new Error('cancelled')]);
  let writeCalls = 0;

  await assert.rejects(async () => {
    await runBeginnerWizard('review', {
      io,
      projectRoot,
      mkdir: async () => {},
      writeFile: async () => {
        writeCalls += 1;
      }
    });
  }, /cancelled/);

  assert.strictEqual(writeCalls, 0);
  assert.strictEqual(io.isClosed(), true);
});

test('advanced wizard writes a plan config with optional review and synthesis prompts', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cli-advanced-plan-'));
  fs.mkdirSync(path.join(projectRoot, 'context'), { recursive: true });

  const io = createMockIO([
    '1',
    'Plan the cleanup in detail',
    '1,2',
    'y',
    'y',
    'Focus on edge cases',
    'y',
    'Keep the final plan concise',
    'n'
  ]);

  const recorder = createAtomicRecorder();
  const result = await runAdvancedWizard({
    io,
    projectRoot,
    mkdir: async () => {},
    writeFile: recorder.writeFile,
    rename: recorder.rename,
    unlink: recorder.unlink
  });

  assert.strictEqual(result.mode, 'plan');
  assert.strictEqual(result.runNow, false);
  assert.strictEqual(recorder.finalWrites.length, 1);
  const writtenConfig = JSON.parse(recorder.finalWrites[0].content);
  assert.strictEqual(writtenConfig.mode, 'plan');
  assert.strictEqual(writtenConfig.reviewPrompt, 'Focus on edge cases');
  assert.strictEqual(writtenConfig.synthesisPrompt, 'Keep the final plan concise');
  assert.deepStrictEqual(writtenConfig.context, { dir: './context' });
  assert.ok(io.getLines().some((line) => line.includes('Task written to')));
  assert.strictEqual(io.isClosed(), true);
});

test('advanced wizard writes implement config with custom implement guidance', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cli-advanced-implement-'));
  const io = createMockIO([
    'implement',
    'Implement the feature safely',
    'codex,claude',
    'y',
    'codex',
    'y',
    'Use small reversible changes',
    'y'
  ]);

  const recorder = createAtomicRecorder();
  const result = await runAdvancedWizard({
    io,
    projectRoot,
    mkdir: async () => {},
    stat: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    writeFile: recorder.writeFile,
    rename: recorder.rename,
    unlink: recorder.unlink
  });

  assert.strictEqual(result.mode, 'implement');
  assert.strictEqual(result.runNow, true);
  assert.strictEqual(recorder.finalWrites.length, 1);
  const writtenConfig = JSON.parse(recorder.finalWrites[0].content);
  assert.strictEqual(writtenConfig.mode, 'implement');
  assert.strictEqual(writtenConfig.customImplementPrompt, 'Use small reversible changes');
  assert.deepStrictEqual(writtenConfig.settings, {
    agentPolicies: {
      codex: { canWrite: true }
    }
  });
  assert.strictEqual(io.isClosed(), true);
});

test('advanced wizard can omit optional prompt overrides cleanly', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cli-advanced-plan-min-'));
  const io = createMockIO([
    'plan',
    'Plan the cleanup',
    'claude',
    'n',
    'n',
    'n',
    'n'
  ]);
  const recorder = createAtomicRecorder();

  const result = await runAdvancedWizard({
    io,
    projectRoot,
    mkdir: async () => {},
    stat: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    writeFile: recorder.writeFile,
    rename: recorder.rename,
    unlink: recorder.unlink
  });

  assert.strictEqual(result.mode, 'plan');
  assert.strictEqual(result.runNow, false);
  const writtenConfig = JSON.parse(recorder.finalWrites[0].content);
  assert.deepStrictEqual(writtenConfig, {
    mode: 'plan',
    prompt: 'Plan the cleanup',
    agents: ['claude']
  });
  assert.strictEqual(io.isClosed(), true);
});

test('advanced wizard does not write partial config when prompting is interrupted', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cli-advanced-cancel-'));
  const io = createMockIO([new Error('cancelled')]);
  let writeCalls = 0;

  await assert.rejects(async () => {
    await runAdvancedWizard({
      io,
      projectRoot,
      mkdir: async () => {},
      writeFile: async () => {
        writeCalls += 1;
      }
    });
  }, /cancelled/);

  assert.strictEqual(writeCalls, 0);
  assert.strictEqual(io.isClosed(), true);
});

test('preset command rejects invalid subcommands and missing names', async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const invalidActionExitCode = await runCli(['preset', 'dance'], { stdout, stderr });
  assert.strictEqual(invalidActionExitCode, 1);
  assert.match(stderr.read(), /Unknown preset action "dance"\./);

  const stdout2 = createCaptureStream();
  const stderr2 = createCaptureStream();
  const missingNameExitCode = await runCli(['preset', 'save'], { stdout: stdout2, stderr: stderr2 });
  assert.strictEqual(missingNameExitCode, 1);
  assert.match(stderr2.read(), /Preset name is required for "save"\./);
});

test('process-level smoke: plan wizard accepts real piped stdin and writes shared/task.json without running immediately', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cli-smoke-plan-'));
  const result = runCliPipedProcess(['plan'], {
    projectRoot,
    inputLines: [
      'Smoke-plan this repo',
      'claude',
      'n'
    ]
  });

  if (allowSandboxedSpawnSkip(result)) {
    return;
  }

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Task written to/);
  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  const rawConfig = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  assert.deepStrictEqual(rawConfig, {
    mode: 'plan',
    prompt: 'Smoke-plan this repo',
    agents: ['claude']
  });
});

test('process-level smoke: open reports a missing scratchpad in a clean project root', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cli-smoke-open-'));
  const result = runCliProcess(['open'], { projectRoot });

  if (allowSandboxedSpawnSkip(result)) {
    return;
  }

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Scratchpad path:/);
  assert.match(result.stdout, /No scratchpad exists yet\./);
});

test('process-level smoke: advanced wizard accepts real piped stdin and writes a config without prompt overrides', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cli-smoke-advanced-'));
  const result = runCliPipedProcess(['new', '--advanced'], {
    projectRoot,
    inputLines: [
      'plan',
      'Advanced smoke plan',
      'claude',
      'n',
      'n',
      'n',
      'n'
    ]
  });

  if (allowSandboxedSpawnSkip(result)) {
    return;
  }

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Task written to/);
  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  const rawConfig = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  assert.deepStrictEqual(rawConfig, {
    mode: 'plan',
    prompt: 'Advanced smoke plan',
    agents: ['claude']
  });
});

test('process-level smoke: preset save and use work end-to-end', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cli-smoke-preset-'));
  fs.mkdirSync(taskPaths.sharedDir(projectRoot), { recursive: true });
  fs.writeFileSync(taskPaths.legacyTaskFile(projectRoot), JSON.stringify({
    mode: 'review',
    prompt: 'Review smoke config',
    agents: ['claude']
  }, null, 2) + '\n');

  const saveResult = runCliProcess(['preset', 'save', 'smoke'], { projectRoot });
  if (allowSandboxedSpawnSkip(saveResult)) {
    return;
  }
  assert.strictEqual(saveResult.status, 0, saveResult.stderr);
  assert.match(saveResult.stdout, /Preset "smoke" saved to/);

  fs.writeFileSync(taskPaths.legacyTaskFile(projectRoot), JSON.stringify({
    mode: 'plan',
    prompt: 'Temporary config',
    agents: ['codex']
  }, null, 2) + '\n');

  const useResult = runCliProcess(['preset', 'use', 'smoke'], { projectRoot });
  assert.strictEqual(useResult.status, 0, useResult.stderr);
  assert.match(useResult.stdout, /Preset "smoke" copied to/);

  const rawConfig = JSON.parse(fs.readFileSync(taskPaths.legacyTaskFile(projectRoot), 'utf8'));
  assert.deepStrictEqual(rawConfig, {
    mode: 'review',
    prompt: 'Review smoke config',
    agents: ['claude']
  });
});

process.on('exit', () => {
  console.log(`cli.test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
});
