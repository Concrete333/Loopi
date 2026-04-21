const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { acquireLock, releaseLock, isLockStale, __test } = require('../src/run-lock');
const { DialecticOrchestrator } = require('../src/orchestrator');
const { normalizeTaskConfig } = require('../src/task-config');

const PROJECT_ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  [PASS] ${name}`);
        passed += 1;
      }).catch((error) => {
        console.error(`  [FAIL] ${name}`);
        console.error(`    ${error.message}`);
        failed += 1;
      });
    }

    console.log(`  [PASS] ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  [FAIL] ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

function makeTempProjectRoot() {
  return fs.mkdtempSync(path.join(__dirname, '__tmp_run_lock_'));
}

function cleanupTempProjectRoot(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

async function runTests() {
  console.log('run-lock');

  await test('Acquiring a lock creates a lock file with correct contents', async () => {
    const projectRoot = makeTempProjectRoot();
    try {
      const metadata = { runId: 'run-1', pid: process.pid, startedAt: Date.now() };
      const result = await acquireLock('nim-local', metadata, {
        projectRoot,
        processExists: () => true
      });

      assert.strictEqual(result.acquired, true);
      const content = JSON.parse(fs.readFileSync(result.lockFile, 'utf8'));
      assert.strictEqual(content.lockKey, 'nim-local');
      assert.strictEqual(content.runId, 'run-1');
      assert.strictEqual(content.pid, process.pid);
    } finally {
      cleanupTempProjectRoot(projectRoot);
    }
  });

  await test('Acquiring an already-locked key returns acquired: false with conflict info', async () => {
    const projectRoot = makeTempProjectRoot();
    try {
      await acquireLock('nim-local', { runId: 'run-1', pid: 1234, startedAt: Date.now() }, {
        projectRoot,
        processExists: () => true
      });
      const result = await acquireLock('nim-local', { runId: 'run-2', pid: 5678, startedAt: Date.now() }, {
        projectRoot,
        processExists: () => true
      });

      assert.strictEqual(result.acquired, false);
      assert.strictEqual(result.conflictingRun.runId, 'run-1');
    } finally {
      cleanupTempProjectRoot(projectRoot);
    }
  });

  await test('Releasing a lock removes the lock file', async () => {
    const projectRoot = makeTempProjectRoot();
    try {
      const { lockFile } = await acquireLock('nim-local', { runId: 'run-1', pid: 1234, startedAt: Date.now() }, {
        projectRoot,
        processExists: () => true
      });
      await releaseLock('nim-local', { projectRoot });
      assert.strictEqual(fs.existsSync(lockFile), false);
    } finally {
      cleanupTempProjectRoot(projectRoot);
    }
  });

  await test('Stale lock is cleaned up and new lock is acquired', async () => {
    const projectRoot = makeTempProjectRoot();
    try {
      const lockFile = __test.getLockFilePath('nim-local', projectRoot);
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({
        lockKey: 'nim-local',
        runId: 'stale-run',
        pid: 999999,
        startedAt: Date.now() - 1000
      }), 'utf8');

      const stale = await isLockStale(lockFile, { processExists: () => false });
      assert.strictEqual(stale, true);

      const result = await acquireLock('nim-local', { runId: 'fresh-run', pid: 2222, startedAt: Date.now() }, {
        projectRoot,
        processExists: () => false
      });

      assert.strictEqual(result.acquired, true);
      const content = JSON.parse(fs.readFileSync(result.lockFile, 'utf8'));
      assert.strictEqual(content.runId, 'fresh-run');
    } finally {
      cleanupTempProjectRoot(projectRoot);
    }
  });

  await test('Concurrent lock attempts from the same process return the existing conflict', async () => {
    const projectRoot = makeTempProjectRoot();
    try {
      await acquireLock('nim-local', { runId: 'run-1', pid: process.pid, startedAt: Date.now() }, {
        projectRoot,
        processExists: () => true
      });
      const result = await acquireLock('nim-local', { runId: 'run-1b', pid: process.pid, startedAt: Date.now() }, {
        projectRoot,
        processExists: () => true
      });

      assert.strictEqual(result.acquired, false);
      assert.strictEqual(result.conflictingRun.runId, 'run-1');
    } finally {
      cleanupTempProjectRoot(projectRoot);
    }
  });

  await test('Lock file left by a non-existent PID is cleaned up on the next acquire', async () => {
    const projectRoot = makeTempProjectRoot();
    try {
      const lockFile = __test.getLockFilePath('nim-local', projectRoot);
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({
        lockKey: 'nim-local',
        runId: 'dead-run',
        pid: 654321,
        startedAt: Date.now() - 5000
      }), 'utf8');

      const result = await acquireLock('nim-local', { runId: 'new-run', pid: 1234, startedAt: Date.now() }, {
        projectRoot,
        processExists: () => false
      });

      assert.strictEqual(result.acquired, true);
      const content = JSON.parse(fs.readFileSync(result.lockFile, 'utf8'));
      assert.strictEqual(content.runId, 'new-run');
    } finally {
      cleanupTempProjectRoot(projectRoot);
    }
  });

  await test('Windows process detection treats tasklist errors as still alive to avoid stealing locks', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true
    });

    try {
      const exists = __test.defaultProcessExists(1234, () => ({
        error: new Error('tasklist unavailable'),
        stdout: ''
      }));
      assert.strictEqual(exists, true);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true
      });
    }
  });

  await test('Stale lock recovery stops after a bounded number of retries', async () => {
    const projectRoot = makeTempProjectRoot();
    try {
      const lockFile = __test.getLockFilePath('nim-local', projectRoot);
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({
        lockKey: 'nim-local',
        runId: 'stale-run',
        pid: 654321,
        startedAt: Date.now() - 5000
      }), 'utf8');

      let rmCalls = 0;
      const originalRm = fs.promises.rm;
      fs.promises.rm = async (target, options) => {
        rmCalls += 1;
        await originalRm.call(fs.promises, target, options);
        fs.writeFileSync(lockFile, JSON.stringify({
          lockKey: 'nim-local',
          runId: `stale-run-${rmCalls}`,
          pid: 654321,
          startedAt: Date.now() - 5000
        }), 'utf8');
      };

      try {
        await assert.rejects(
          acquireLock('nim-local', { runId: 'new-run', pid: 1234, startedAt: Date.now() }, {
            projectRoot,
            processExists: () => false,
            maxStaleRecoveryAttempts: 2
          }),
          /Failed to acquire lock "nim-local" after 2 stale-lock recovery attempts\./
        );
        assert.strictEqual(rmCalls, 2);
      } finally {
        fs.promises.rm = originalRm;
      }
    } finally {
      cleanupTempProjectRoot(projectRoot);
    }
  });

  await test('Non-local providers do not trigger the lock', async () => {
    const projectRoot = makeTempProjectRoot();
    try {
      const orchestrator = new DialecticOrchestrator();
      orchestrator.projectRoot = projectRoot;
      orchestrator.sharedDir = path.join(projectRoot, 'shared');
      orchestrator.collaborationStore.projectRoot = projectRoot;
      orchestrator.checkProviderReadiness = async () => ({
        ready: true,
        providerId: 'remote-model',
        modelConfirmed: 'test-model',
        rawModels: ['test-model'],
        failureReason: null,
        error: null
      });
      orchestrator.runPlanMode = async () => ({ finalOutput: 'done', feedbackEntries: [] });

      const config = normalizeTaskConfig({
        mode: 'plan',
        prompt: 'Test prompt',
        agents: ['remote-model'],
        providers: {
          'remote-model': {
            type: 'openai-compatible',
            baseUrl: 'https://api.example.com/v1',
            model: 'test-model'
          }
        },
        settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
      }, { projectRoot: PROJECT_ROOT });
      const run = orchestrator.createRun(config);

      await orchestrator.runMode(config, run);

      const locksDir = path.join(projectRoot, 'shared', '.locks');
      assert.strictEqual(fs.existsSync(locksDir), false);
    } finally {
      cleanupTempProjectRoot(projectRoot);
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests();
