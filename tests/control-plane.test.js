const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ControlPlaneService, createControlPlaneService } = require('../src/control-plane');
const taskPaths = require('../src/task-paths');

let passed = 0;
let failed = 0;

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

function createTestProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-cp-'));
}

function cleanupProject(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for condition.');
}

function createTaskData(overrides = {}) {
  return {
    mode: 'plan',
    prompt: 'Test prompt',
    agents: ['claude'],
    startedAt: '2026-04-22T12:00:00Z',
    status: 'completed',
    finishedAt: '2026-04-22T12:05:00Z',
    durationMs: 300000,
    ...overrides
  };
}

function createWorktreeSnapshotArtifact(taskId, artifactId = 'snapshot-001') {
  return {
    type: 'worktree-snapshot',
    id: artifactId,
    taskId,
    createdAt: '2026-04-22T12:01:00Z',
    data: {
      scope: 'run-start',
      canWrite: false,
      gitAvailable: true,
      gitHead: 'abc123',
      gitHeadShort: 'abc123',
      statusPorcelain: [],
      changedFiles: [],
      untrackedFiles: [],
      patchFile: null,
      stagedPatchFile: null,
      dirty: false,
      captureError: null
    }
  };
}

console.log('control-plane: service creation and initialization');

test('createControlPlaneService factory returns a service instance', async () => {
  const service = createControlPlaneService();
  assert.ok(service instanceof ControlPlaneService);
  assert.ok(service.projectRoot);
  assert.ok(service.store);
});

test('service accepts custom projectRoot', async () => {
  const customRoot = '/custom/root';
  const service = new ControlPlaneService({ projectRoot: customRoot });
  assert.strictEqual(service.projectRoot, customRoot);
});

console.log('\ncontrol-plane: config load/save/validate');

test('loadConfig returns not-found result when task file does not exist', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const result = await service.loadConfig();
    assert.strictEqual(result.exists, false);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, 'Task file not found');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('loadConfig loads and validates existing task file', async () => {
  const projectRoot = createTestProject();
  try {
    fs.mkdirSync(taskPaths.sharedDir(projectRoot), { recursive: true });
    fs.writeFileSync(taskPaths.legacyTaskFile(projectRoot), JSON.stringify({
      mode: 'plan',
      prompt: 'Test plan',
      agents: ['claude', 'codex']
    }, null, 2) + '\n');

    const service = new ControlPlaneService({ projectRoot });
    const result = await service.loadConfig();
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.normalized.mode, 'plan');
    assert.deepStrictEqual(result.normalized.agents, ['claude', 'codex']);
  } finally {
    cleanupProject(projectRoot);
  }
});

test('loadConfig preserves raw text when the task file contains invalid JSON', async () => {
  const projectRoot = createTestProject();
  try {
    fs.mkdirSync(taskPaths.sharedDir(projectRoot), { recursive: true });
    fs.writeFileSync(taskPaths.legacyTaskFile(projectRoot), '{bad json');

    const service = new ControlPlaneService({ projectRoot });
    const result = await service.loadConfig();
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.raw, null);
    assert.strictEqual(result.rawText, '{bad json');
    assert.ok(String(result.error || '').includes('Invalid JSON'));
  } finally {
    cleanupProject(projectRoot);
  }
});

test('validateConfig returns error for invalid task', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const result = await service.validateConfig({
      mode: 'invalid-mode',
      prompt: 'Test prompt',
      agents: ['claude']
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.normalized, null);
    assert.ok(result.error.includes('Unsupported mode'));
  } finally {
    cleanupProject(projectRoot);
  }
});

test('saveConfig validates and saves a valid config atomically', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const result = await service.saveConfig({
      mode: 'implement',
      prompt: 'Test implementation',
      agents: ['codex']
    });
    assert.strictEqual(result.success, true);
    const saved = JSON.parse(fs.readFileSync(result.filePath, 'utf8'));
    assert.strictEqual(saved.mode, 'implement');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('saveConfig fails for invalid config', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const result = await service.saveConfig({
      mode: 'invalid',
      prompt: '',
      agents: []
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  } finally {
    cleanupProject(projectRoot);
  }
});

console.log('\ncontrol-plane: run listing and artifact listing');

test('listRuns returns empty array when no task records exist', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const runs = await service.listRuns();
    assert.deepStrictEqual(runs, []);
  } finally {
    cleanupProject(projectRoot);
  }
});

test('listRuns reads runs from the collaboration store instead of runs.ndjson', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const taskId = 'run-2026-04-22T12-00-00-000Z';
    await service.store.writeTask(taskId, createTaskData({
      prompt: 'Stored task record',
      agents: ['claude', 'codex']
    }));
    fs.mkdirSync(taskPaths.sharedDir(projectRoot), { recursive: true });
    fs.writeFileSync(taskPaths.runsNdjsonFile(projectRoot), JSON.stringify({
      runId: 'run-legacy-only',
      prompt: 'Legacy run'
    }) + '\n');

    const runs = await service.listRuns();
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].runId, taskId);
    assert.strictEqual(runs[0].prompt, 'Stored task record');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('listRuns surfaces damaged runs instead of silently dropping them', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const taskId = 'run-damaged';
    fs.mkdirSync(taskPaths.taskDir(projectRoot, taskId), { recursive: true });
    fs.writeFileSync(taskPaths.taskJsonPath(projectRoot, taskId), '{bad json');

    const runs = await service.listRuns();
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].runId, taskId);
    assert.strictEqual(runs[0].isDamaged, true);
    assert.ok(runs[0].readError);
    assert.strictEqual(runs[0].status, 'damaged');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('getRunDetails returns summary, steps, and non-task artifacts for a run', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const taskId = 'run-2026-04-22T12-00-00-000Z';
    await service.store.writeTask(taskId, createTaskData({
      prompt: 'Detailed run',
      agents: ['claude', 'codex']
    }));
    await service.store.appendStep(taskId, {
      id: 'plan-1',
      stage: 'plan',
      agent: 'claude',
      ok: true,
      startedAt: '2026-04-22T12:00:00Z',
      finishedAt: '2026-04-22T12:01:00Z',
      durationMs: 60000,
      exitCode: 0,
      signal: null,
      timedOut: false,
      usedFallback: false,
      fallbackTier: 0,
      fallbackReason: null,
      canWrite: false,
      cycleNumber: 1,
      handoffParseError: null,
      handoffData: null,
      error: null
    });
    await service.store.writeArtifact(taskId, createWorktreeSnapshotArtifact(taskId));

    const details = await service.getRunDetails(taskId);
    assert.strictEqual(details.exists, true);
    assert.strictEqual(details.task.prompt, 'Detailed run');
    assert.strictEqual(details.steps.length, 1);
    assert.strictEqual(details.summary.runId, taskId);
    assert.strictEqual(details.summary.snapshotCount, 1);
    assert.strictEqual(details.artifacts.length, 1);
    assert.strictEqual(details.artifacts[0].type, 'worktree-snapshot');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('getRunDetails returns exists=false for missing runs', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const details = await service.getRunDetails('run-missing');
    assert.strictEqual(details.exists, false);
    assert.strictEqual(details.summary, null);
  } finally {
    cleanupProject(projectRoot);
  }
});

test('getRunDetails returns a safe damaged payload for unreadable runs', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const taskId = 'run-damaged';
    fs.mkdirSync(taskPaths.taskDir(projectRoot, taskId), { recursive: true });
    fs.writeFileSync(taskPaths.taskJsonPath(projectRoot, taskId), '{bad json');

    const details = await service.getRunDetails(taskId);
    assert.strictEqual(details.exists, true);
    assert.strictEqual(details.isDamaged, true);
    assert.ok(details.error);
    assert.ok(details.summary);
    assert.strictEqual(details.summary.runId, taskId);
    assert.strictEqual(details.summary.isDamaged, true);
  } finally {
    cleanupProject(projectRoot);
  }
});

test('listArtifacts filters by artifact type', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const taskId = 'run-2026-04-22T12-00-00-000Z';
    await service.store.writeTask(taskId, createTaskData());
    await service.store.writeArtifact(taskId, createWorktreeSnapshotArtifact(taskId));
    await service.store.writeArtifact(taskId, {
      type: 'fork-record',
      id: 'fork-001',
      taskId,
      createdAt: '2026-04-22T12:02:00Z',
      data: {
        forkedFromRunId: 'run-001',
        forkedFromStepId: null,
        baseCommit: null,
        reason: 'test',
        recordedBy: 'manual'
      }
    });

    const snapshots = await service.listArtifacts(taskId, { type: 'worktree-snapshot' });
    assert.strictEqual(snapshots.length, 1);
    assert.strictEqual(snapshots[0].type, 'worktree-snapshot');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('getArtifact returns structured exists=false for missing artifacts', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const result = await service.getArtifact('run-001', 'missing-artifact');
    assert.deepStrictEqual(result, {
      exists: false,
      artifact: null,
      error: null
    });
  } finally {
    cleanupProject(projectRoot);
  }
});

test('getArtifact reports corrupted artifacts as existing with an error', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const taskId = 'run-2026-04-22T12-00-00-000Z';
    fs.mkdirSync(taskPaths.artifactsDir(projectRoot, taskId), { recursive: true });
    fs.writeFileSync(taskPaths.artifactPath(projectRoot, taskId, 'broken-artifact'), '{bad json');

    const result = await service.getArtifact(taskId, 'broken-artifact');
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.artifact, null);
    assert.ok(result.error);
  } finally {
    cleanupProject(projectRoot);
  }
});

console.log('\ncontrol-plane: setup and provider methods');

test('getSetupStatus returns adapter statuses and a summary', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const status = await service.getSetupStatus();
    assert.ok(Array.isArray(status.adapters));
    assert.strictEqual(status.summary.total, status.adapters.length);
  } finally {
    cleanupProject(projectRoot);
  }
});

test('getAllAdapterMetadata returns adapter metadata', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const metadata = service.getAllAdapterMetadata();
    assert.ok(Array.isArray(metadata));
    assert.ok(metadata.length > 0);
    assert.ok(metadata[0].id);
  } finally {
    cleanupProject(projectRoot);
  }
});

test('runAdapterInstall delegates to setup-service with project-root cwd', async () => {
  const projectRoot = createTestProject();
  const setupService = require('../src/setup-service');
  const original = setupService.runAdapterInstall;
  try {
    let callArgs = null;
    setupService.runAdapterInstall = async (agentId, options) => {
      callArgs = { agentId, options };
      return {
        success: true,
        actionType: 'install',
        agentId,
        statusAfter: { status: 'installed_but_needs_login' }
      };
    };
    const service = new ControlPlaneService({ projectRoot });
    const result = await service.runAdapterInstall('claude', { approved: true });
    assert.ok(callArgs, 'setup-service install helper was called');
    assert.strictEqual(callArgs.agentId, 'claude');
    assert.strictEqual(callArgs.options.approved, true);
    assert.strictEqual(callArgs.options.cwd, projectRoot);
    assert.strictEqual(result.statusAfter.status, 'installed_but_needs_login');
  } finally {
    setupService.runAdapterInstall = original;
    cleanupProject(projectRoot);
  }
});

test('runAdapterLogin delegates to setup-service with project-root cwd', async () => {
  const projectRoot = createTestProject();
  const setupService = require('../src/setup-service');
  const original = setupService.runAdapterLogin;
  try {
    let callArgs = null;
    setupService.runAdapterLogin = async (agentId, options) => {
      callArgs = { agentId, options };
      return {
        success: true,
        actionType: 'login',
        agentId,
        statusAfter: { status: 'ready' }
      };
    };
    const service = new ControlPlaneService({ projectRoot });
    const result = await service.runAdapterLogin('codex', { approved: true });
    assert.ok(callArgs, 'setup-service login helper was called');
    assert.strictEqual(callArgs.agentId, 'codex');
    assert.strictEqual(callArgs.options.approved, true);
    assert.strictEqual(callArgs.options.cwd, projectRoot);
    assert.strictEqual(result.statusAfter.status, 'ready');
  } finally {
    setupService.runAdapterLogin = original;
    cleanupProject(projectRoot);
  }
});

test('testProvider returns provider display status', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const status = await service.testProvider('test-provider', {
      type: 'openai-compatible',
      baseUrl: 'http://localhost:8000/v1',
      model: 'test-model'
    });
    assert.strictEqual(status.id, 'test-provider');
    assert.strictEqual(status.baseUrl, 'http://localhost:8000/v1');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('testCurrentProviders surfaces invalid current config errors', async () => {
  const projectRoot = createTestProject();
  try {
    fs.mkdirSync(taskPaths.sharedDir(projectRoot), { recursive: true });
    fs.writeFileSync(taskPaths.legacyTaskFile(projectRoot), '{invalid json');
    const service = new ControlPlaneService({ projectRoot });
    const result = await service.testCurrentProviders();
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.providers, {});
    assert.ok(result.error);
  } finally {
    cleanupProject(projectRoot);
  }
});

test('testProvidersFromTask returns normalized provider results for valid tasks', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const result = await service.testProvidersFromTask({
      mode: 'review',
      prompt: 'Test review',
      agents: ['claude'],
      providers: {
        'test-provider': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'test-model'
        }
      }
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.providers['test-provider']);
    assert.strictEqual(result.providers['test-provider'].baseUrl, 'http://localhost:8000/v1');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('testProvidersFromTask returns validation errors for invalid tasks', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const result = await service.testProvidersFromTask({
      mode: 'review',
      prompt: 'Test review',
      agents: ['claude'],
      providers: {
        bad: {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1'
        }
      }
    });
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.providers, {});
    assert.ok(result.error.includes('model'));
  } finally {
    cleanupProject(projectRoot);
  }
});

console.log('\ncontrol-plane: preset management');

test('listPresets returns preset names', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const presets = await service.listPresets();
    assert.ok(Array.isArray(presets));
  } finally {
    cleanupProject(projectRoot);
  }
});

test('savePreset saves the current config as a preset', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    await service.saveConfig({
      mode: 'plan',
      prompt: 'Test plan',
      agents: ['claude']
    });
    const result = await service.savePreset('test-preset');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.presetName, 'test-preset');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('usePreset loads a preset into the current task file', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    fs.mkdirSync(taskPaths.presetsDir(projectRoot), { recursive: true });
    fs.writeFileSync(taskPaths.presetPath(projectRoot, 'test-preset'), JSON.stringify({
      mode: 'review',
      prompt: 'Test review preset',
      agents: ['claude', 'codex']
    }, null, 2) + '\n');
    const result = await service.usePreset('test-preset');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.normalized.mode, 'review');
  } finally {
    cleanupProject(projectRoot);
  }
});

console.log('\ncontrol-plane: run launch');

test('launchRunSession returns immediately and tracks a live background session', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const calls = [];
    service.createOrchestrator = (options = {}) => ({
      lastRun: null,
      async init() {
        calls.push(`init:${options.preassignedRunId ? 'with-run-id' : 'missing-run-id'}`);
      },
      async runTask() {
        calls.push('runTask');
        await sleep(60);
        const run = {
          runId: options.preassignedRunId,
          mode: 'plan',
          status: 'completed',
          startedAt: options.preassignedStartedAt,
          finishedAt: '2026-04-22T12:01:00Z',
          durationMs: 60000,
          error: null
        };
        this.lastRun = run;
        return run;
      }
    });

    const launch = await service.launchRunSession({
      rawConfig: {
        mode: 'plan',
        prompt: 'Background launch test',
        agents: ['claude']
      }
    });

    assert.strictEqual(launch.success, true);
    assert.strictEqual(launch.launched, true);
    assert.ok(launch.runId);
    assert.ok(launch.session);
    assert.strictEqual(launch.session.active, true);
    assert.ok(['starting', 'running'].includes(launch.session.status));
    assert.ok(calls.includes('init:with-run-id'));

    await waitFor(async () => {
      const sessionResult = service.getRunSession(launch.runId);
      return sessionResult.exists && sessionResult.session && sessionResult.session.active === false;
    });

    const sessionResult = service.getRunSession(launch.runId);
    assert.strictEqual(sessionResult.exists, true);
    assert.strictEqual(sessionResult.session.status, 'completed');
    assert.strictEqual(sessionResult.session.active, false);
    assert.ok(calls.includes('runTask'));
  } finally {
    cleanupProject(projectRoot);
  }
});

test('launchRunSession surfaces init failures without creating a live session', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    service.createOrchestrator = () => ({
      async init() {
        throw new Error('init boom');
      },
      async runTask() {
        throw new Error('should not run');
      }
    });

    const launch = await service.launchRunSession({
      rawConfig: {
        mode: 'plan',
        prompt: 'Init failure session test',
        agents: ['claude']
      }
    });

    assert.strictEqual(launch.success, false);
    assert.strictEqual(launch.launched, false);
    assert.strictEqual(service.getRunSession(launch.runId).exists, false);
  } finally {
    cleanupProject(projectRoot);
  }
});

test('launchRun validates, saves, and runs via the orchestrator contract', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const calls = [];
    service.createOrchestrator = () => ({
      lastRun: null,
      async init() {
        calls.push('init');
      },
      async runTask() {
        calls.push('runTask');
        const run = {
          runId: 'run-123',
          mode: 'plan',
          status: 'completed',
          startedAt: '2026-04-22T12:00:00Z',
          finishedAt: '2026-04-22T12:01:00Z',
          durationMs: 60000,
          error: null
        };
        this.lastRun = run;
        return run;
      }
    });

    const result = await service.launchRun({
      rawConfig: {
        mode: 'plan',
        prompt: 'Launch test',
        agents: ['claude']
      }
    });

    assert.deepStrictEqual(calls, ['init', 'runTask']);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.launched, true);
    assert.strictEqual(result.runId, 'run-123');
    assert.strictEqual(result.status, 'completed');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('launchRun does not persist a raw draft when context preflight blocks the launch', async () => {
  const projectRoot = createTestProject();
  try {
    const contextDir = path.join(projectRoot, 'context');
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(path.join(contextDir, 'notes.md'), '# Missing prepare\nDirect launch should block.');

    const service = new ControlPlaneService({ projectRoot });
    const taskFilePath = taskPaths.legacyTaskFile(projectRoot);

    const result = await service.launchRun({
      rawConfig: {
        mode: 'plan',
        prompt: 'Blocked direct launch',
        agents: ['claude'],
        context: { dir: './context' }
      }
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.launched, false);
    assert.strictEqual(result.run, null);
    assert.strictEqual(result.error.code, 'CONTEXT_CACHE_MISSING');
    assert.strictEqual(fs.existsSync(taskFilePath), false, 'blocked direct launch must not write task.json');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('launchRun persists the draft only after context preflight passes', async () => {
  const projectRoot = createTestProject();
  try {
    const contextDir = path.join(projectRoot, 'context');
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(path.join(contextDir, 'notes.md'), '# Ready context\nPrepared before direct launch.');

    const draftConfig = {
      mode: 'plan',
      prompt: 'Prepared direct launch',
      agents: ['claude'],
      context: { dir: './context' }
    };

    const service = new ControlPlaneService({ projectRoot });
    const prepareResult = await service.prepareContext({ rawConfig: draftConfig });
    assert.strictEqual(prepareResult.ok, true);

    const calls = [];
    service.createOrchestrator = () => ({
      lastRun: null,
      async init() {
        calls.push('init');
      },
      async runTask() {
        calls.push('runTask');
        const run = {
          runId: 'run-direct-context',
          mode: 'plan',
          status: 'completed',
          startedAt: '2026-04-22T12:00:00Z',
          finishedAt: '2026-04-22T12:01:00Z',
          durationMs: 60000,
          error: null
        };
        this.lastRun = run;
        return run;
      }
    });

    const result = await service.launchRun({ rawConfig: draftConfig });
    assert.deepStrictEqual(calls, ['init', 'runTask']);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.launched, true);

    const taskFilePath = taskPaths.legacyTaskFile(projectRoot);
    assert.strictEqual(fs.existsSync(taskFilePath), true, 'successful direct launch must write task.json');
    const savedContent = JSON.parse(fs.readFileSync(taskFilePath, 'utf8'));
    assert.strictEqual(savedContent.prompt, 'Prepared direct launch');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('launchRun returns validation errors without launching', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const result = await service.launchRun({
      rawConfig: {
        mode: 'bad',
        prompt: '',
        agents: []
      }
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.launched, false);
    assert.ok(result.error);
  } finally {
    cleanupProject(projectRoot);
  }
});

test('launchRun returns failed run information when the orchestrator throws', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    service.createOrchestrator = () => ({
      lastRun: null,
      async init() {},
      async runTask() {
        const error = new Error('run exploded');
        this.lastRun = {
          runId: 'run-failed',
          mode: 'implement',
          status: 'failed',
          startedAt: '2026-04-22T12:00:00Z',
          finishedAt: '2026-04-22T12:02:00Z',
          durationMs: 120000,
          error: { message: 'run exploded' }
        };
        throw error;
      }
    });

    const result = await service.launchRun({
      rawConfig: {
        mode: 'implement',
        prompt: 'Failure path',
        agents: ['codex']
      }
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.launched, true);
    assert.strictEqual(result.runId, 'run-failed');
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.error, 'run exploded');
  } finally {
    cleanupProject(projectRoot);
  }
});

test('launchRun returns a structured error when orchestrator init fails', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    service.createOrchestrator = () => ({
      lastRun: null,
      async init() {
        throw new Error('init boom');
      },
      async runTask() {
        throw new Error('should not run');
      }
    });

    const result = await service.launchRun({
      rawConfig: {
        mode: 'plan',
        prompt: 'Init failure path',
        agents: ['claude']
      }
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.launched, false);
    assert.strictEqual(result.run, null);
    assert.strictEqual(result.error, 'init boom');
  } finally {
    cleanupProject(projectRoot);
  }
});

console.log('\ncontrol-plane: orchestrator creation');

test('createOrchestrator returns an orchestrator instance', async () => {
  const projectRoot = createTestProject();
  try {
    const service = new ControlPlaneService({ projectRoot });
    const orchestrator = service.createOrchestrator();
    assert.ok(orchestrator);
    assert.strictEqual(orchestrator.projectRoot, projectRoot);
  } finally {
    cleanupProject(projectRoot);
  }
});

process.on('beforeExit', () => {
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
});
