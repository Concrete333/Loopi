const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {
  assert,
  PROJECT_ROOT,
  LoopiOrchestrator,
  normalizeTaskConfig
} = require('../orchestrator-test-helpers');
const taskPaths = require('../../src/task-paths');
const { validateArtifactSafe } = require('../../src/artifact-schemas');
const { measureContextSectionChars } = require('../../src/prompts');
const { startMockHttpServer } = require('./http-helpers');

module.exports = async function registerArtifactTests(test) {
  console.log('\norchestrator: Commit 16 - Artifact logging');

  await test('Readiness check writes a provider-readiness artifact', async () => {
    const orchestrator = new LoopiOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'test-model'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };
    orchestrator.checkProviderReadiness = async () => ({
      ready: true,
      providerId: 'nim-local',
      modelConfirmed: 'test-model',
      rawModels: ['test-model'],
      failureReason: null,
      error: null
    });
    orchestrator.runPlanMode = async () => ({ finalOutput: 'done', feedbackEntries: [] });

    await orchestrator.runMode(config, run);

    const readinessArtifact = artifacts.find((artifact) => artifact.type === 'provider-readiness');
    assert.ok(readinessArtifact, 'provider-readiness artifact should be written');
    assert.strictEqual(readinessArtifact.data.providerId, 'nim-local');
    assert.strictEqual(readinessArtifact.data.ready, true);
  });

  await test('HTTP execution writes a provider-execution artifact with correct fields', async () => {
    const orchestrator = new LoopiOrchestrator();
    const artifacts = [];
    const response = {
      choices: [{ message: { content: 'Hello from provider' }, finish_reason: 'stop' }],
      model: 'test-model'
    };
    const { port, close } = await startMockHttpServer(200, response);
    try {
      const config = normalizeTaskConfig({
        mode: 'review',
        prompt: 'Test prompt',
        agents: ['nim-local'],
        providers: {
          'nim-local': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: 'test-model'
          }
        },
        settings: { cwd: '.', timeoutMs: 10000 }
      }, { projectRoot: PROJECT_ROOT });
      const run = orchestrator.createRun(config);

      orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
        artifacts.push(artifact);
      };

      const step = await orchestrator.runStep({
        run,
        config,
        stage: 'review',
        agent: 'nim-local',
        prompt: 'Hello!',
        cycleNumber: null,
        mode: 'review',
        executionPolicy: { canWrite: false },
        handoffSchema: 'review'
      });

      const executionArtifact = artifacts.find((artifact) => artifact.type === 'provider-execution');
      assert.ok(executionArtifact, 'provider-execution artifact should be written');
      assert.strictEqual(executionArtifact.data.providerId, 'nim-local');
      assert.strictEqual(executionArtifact.data.model, 'test-model');
      assert.strictEqual(executionArtifact.data.ok, true);
      assert.strictEqual(executionArtifact.data.errorType, null);
      assert.ok(executionArtifact.data.executionStartedAt);
      assert.ok(executionArtifact.data.executionCompletedAt);
      assert.strictEqual(executionArtifact.data.promptChars, 'Hello!'.length);
      assert.strictEqual(executionArtifact.data.outputChars, step.outputText.length);
    } finally {
      await close();
    }
  });

  await test('runTask writes run-start and run-end worktree snapshot artifacts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loopi-audit-'));
    try {
      const orchestrator = new LoopiOrchestrator({ projectRoot: tempRoot });
      const artifacts = [];
      const appendedSteps = [];
      await orchestrator.init();
      await fs.writeFile(orchestrator.taskFile, JSON.stringify({
        mode: 'plan',
        prompt: 'Test prompt',
        agents: ['nim-local'],
        providers: {
          'nim-local': {
            type: 'openai-compatible',
            baseUrl: 'http://localhost:8000/v1',
            model: 'test-model'
          }
        },
        settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
      }, null, 2) + '\n', 'utf8');

      orchestrator.captureWorktreeSnapshot = ({ scope }) => ({
        scope,
        stepId: null,
        stage: null,
        agent: null,
        canWrite: false,
        gitAvailable: true,
        gitHead: 'abcdef1234567890',
        gitHeadShort: 'abcdef1',
        statusPorcelain: [],
        changedFiles: [],
        untrackedFiles: [],
        patchText: scope === 'run-start' ? 'diff --git a/file.txt b/file.txt\n' : '',
        stagedPatchText: '',
        dirty: scope === 'run-start',
        captureError: null
      });
      orchestrator.runMode = async () => ({ finalOutput: 'done' });
      orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
        artifacts.push(artifact);
      };

      await orchestrator.runTask();

      const snapshotArtifacts = artifacts.filter((artifact) => artifact.type === 'worktree-snapshot');
      assert.strictEqual(snapshotArtifacts.length, 2, 'expected run-start and run-end snapshot artifacts');
      assert.deepStrictEqual(
        snapshotArtifacts.map((artifact) => artifact.data.scope),
        ['run-start', 'run-end']
      );
      const runStartArtifact = snapshotArtifacts[0];
      assert.ok(runStartArtifact.data.patchFile, 'run-start snapshot should reference a patch file');
      const patchPath = path.join(
        taskPaths.taskDir(tempRoot, runStartArtifact.taskId),
        runStartArtifact.data.patchFile
      );
      const patchText = await fs.readFile(patchPath, 'utf8');
      assert.ok(patchText.includes('diff --git a/file.txt b/file.txt'));
      const scratchpadText = await fs.readFile(orchestrator.scratchpadFile, 'utf8');
      assert.match(scratchpadText, /## WORKTREE SNAPSHOTS/);
      assert.match(scratchpadText, /Scope: run-start/);
      assert.match(scratchpadText, /Patch: patches\/worktree-snapshot-1\.patch/);
      const runsLogText = await fs.readFile(orchestrator.runsNdjsonFile, 'utf8');
      const loggedRunLines = runsLogText.trim().split(/\r?\n/);
      const loggedRun = JSON.parse(loggedRunLines[loggedRunLines.length - 1]);
      assert.strictEqual(loggedRun.worktreeSnapshots.length, 2, 'run log should include both worktree snapshots');
      assert.deepStrictEqual(
        loggedRun.worktreeSnapshots.map((item) => item.scope),
        ['run-start', 'run-end']
      );
      for (const artifact of snapshotArtifacts) {
        const schemaResult = validateArtifactSafe(artifact);
        assert.strictEqual(schemaResult.ok, true, schemaResult.error && schemaResult.error.message);
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  await test('runTask writes a run-end worktree snapshot even when the run fails', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loopi-audit-fail-'));
    try {
      const orchestrator = new LoopiOrchestrator({ projectRoot: tempRoot });
      const artifacts = [];
      await orchestrator.init();
      await fs.writeFile(orchestrator.taskFile, JSON.stringify({
        mode: 'plan',
        prompt: 'Test prompt',
        agents: ['nim-local'],
        providers: {
          'nim-local': {
            type: 'openai-compatible',
            baseUrl: 'http://localhost:8000/v1',
            model: 'test-model'
          }
        },
        settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
      }, null, 2) + '\n', 'utf8');

      orchestrator.captureWorktreeSnapshot = ({ scope }) => ({
        scope,
        stepId: null,
        stage: null,
        agent: null,
        canWrite: false,
        gitAvailable: false,
        gitHead: null,
        gitHeadShort: null,
        statusPorcelain: [],
        changedFiles: [],
        untrackedFiles: [],
        patchText: '',
        stagedPatchText: '',
        dirty: false,
        captureError: 'git unavailable in test'
      });
      orchestrator.runMode = async () => {
        throw new Error('boom');
      };
      orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
        artifacts.push(artifact);
      };

      await assert.rejects(() => orchestrator.runTask(), /boom/);

      const snapshotArtifacts = artifacts.filter((artifact) => artifact.type === 'worktree-snapshot');
      assert.strictEqual(snapshotArtifacts.length, 2, 'expected run-start and run-end snapshot artifacts on failure');
      assert.deepStrictEqual(
        snapshotArtifacts.map((artifact) => artifact.data.scope),
        ['run-start', 'run-end']
      );
      assert.deepStrictEqual(
        snapshotArtifacts.map((artifact) => artifact.data.captureError),
        ['git unavailable in test', 'git unavailable in test']
      );
      const runsLogText = await fs.readFile(orchestrator.runsNdjsonFile, 'utf8');
      const loggedRunLines = runsLogText.trim().split(/\r?\n/);
      const loggedRun = JSON.parse(loggedRunLines[loggedRunLines.length - 1]);
      assert.strictEqual(loggedRun.worktreeSnapshots.length, 2, 'failed run log should still include both worktree snapshots');
      for (const artifact of snapshotArtifacts) {
        const schemaResult = validateArtifactSafe(artifact);
        assert.strictEqual(schemaResult.ok, true, schemaResult.error && schemaResult.error.message);
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  await test('runTask writes a fork-record artifact when fork lineage is configured', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loopi-fork-record-'));
    try {
      const orchestrator = new LoopiOrchestrator({ projectRoot: tempRoot });
      const artifacts = [];
      await orchestrator.init();
      await fs.writeFile(orchestrator.taskFile, JSON.stringify({
        mode: 'implement',
        prompt: 'Retry the prior attempt.',
        agents: ['nim-local'],
        fork: {
          forkedFromRunId: 'run-2026-04-21T12-34-56-789Z',
          forkedFromStepId: 'implement-4',
          baseCommit: 'abc123def456',
          reason: 'Retry with different reviewer feedback',
          recordedBy: 'manual'
        },
        providers: {
          'nim-local': {
            type: 'openai-compatible',
            baseUrl: 'http://localhost:8000/v1',
            model: 'test-model'
          }
        },
        settings: {
          cwd: '.',
          timeoutMs: 10000,
          implementLoops: 1
        }
      }, null, 2) + '\n', 'utf8');

      orchestrator.captureWorktreeSnapshot = ({ scope }) => ({
        scope,
        stepId: null,
        stage: null,
        agent: null,
        canWrite: false,
        gitAvailable: true,
        gitHead: 'abcdef1234567890',
        gitHeadShort: 'abcdef1',
        statusPorcelain: [],
        changedFiles: [],
        untrackedFiles: [],
        patchText: '',
        stagedPatchText: '',
        dirty: false,
        captureError: null
      });
      orchestrator.runMode = async () => ({ finalOutput: 'done' });
      orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
        artifacts.push(artifact);
      };

      await orchestrator.runTask();

      const forkArtifact = artifacts.find((artifact) => artifact.type === 'fork-record');
      assert.ok(forkArtifact, 'fork-record artifact should be written');
      assert.strictEqual(forkArtifact.data.forkedFromRunId, 'run-2026-04-21T12-34-56-789Z');
      assert.strictEqual(forkArtifact.data.forkedFromStepId, 'implement-4');
      assert.strictEqual(forkArtifact.data.baseCommit, 'abc123def456');
      assert.strictEqual(forkArtifact.data.reason, 'Retry with different reviewer feedback');
      assert.strictEqual(forkArtifact.data.recordedBy, 'manual');
      const schemaResult = validateArtifactSafe(forkArtifact);
      assert.strictEqual(schemaResult.ok, true, schemaResult.error && schemaResult.error.message);

      const scratchpadText = await fs.readFile(orchestrator.scratchpadFile, 'utf8');
      assert.match(scratchpadText, /## FORK LINEAGE/);
      assert.match(scratchpadText, /Forked From Run: run-2026-04-21T12-34-56-789Z/);
      assert.match(scratchpadText, /Forked From Step: implement-4/);
      assert.match(scratchpadText, /Base Commit: abc123def456/);

      const runsLogText = await fs.readFile(orchestrator.runsNdjsonFile, 'utf8');
      const loggedRunLines = runsLogText.trim().split(/\r?\n/);
      const loggedRun = JSON.parse(loggedRunLines[loggedRunLines.length - 1]);
      assert.strictEqual(loggedRun.fork.forkedFromRunId, 'run-2026-04-21T12-34-56-789Z');
      assert.strictEqual(loggedRun.forkRecord.forkedFromRunId, 'run-2026-04-21T12-34-56-789Z');
      assert.strictEqual(loggedRun.forkRecord.artifactId, forkArtifact.id);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  await test('runTask keeps audit trail honest when artifact writes fail', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loopi-audit-write-fail-'));
    try {
      const orchestrator = new LoopiOrchestrator({ projectRoot: tempRoot });
      await orchestrator.init();
      await fs.writeFile(orchestrator.taskFile, JSON.stringify({
        mode: 'implement',
        prompt: 'Retry the prior attempt.',
        agents: ['nim-local'],
        fork: {
          forkedFromRunId: 'run-older',
          forkedFromStepId: 'implement-3',
          baseCommit: 'abc123def456',
          reason: 'Retry after failed artifact write',
          recordedBy: 'manual'
        },
        providers: {
          'nim-local': {
            type: 'openai-compatible',
            baseUrl: 'http://localhost:8000/v1',
            model: 'test-model'
          }
        },
        settings: {
          cwd: '.',
          timeoutMs: 10000,
          implementLoops: 1
        }
      }, null, 2) + '\n', 'utf8');

      orchestrator.captureWorktreeSnapshot = ({ scope }) => ({
        scope,
        stepId: null,
        stage: null,
        agent: null,
        canWrite: false,
        gitAvailable: true,
        gitHead: 'abcdef1234567890',
        gitHeadShort: 'abcdef1',
        statusPorcelain: [],
        changedFiles: [],
        untrackedFiles: [],
        patchText: 'diff --git a/file.txt b/file.txt\n',
        stagedPatchText: '',
        dirty: scope === 'run-start',
        captureError: null
      });
      orchestrator.runMode = async () => ({ finalOutput: 'done' });
      orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
        if (artifact.type === 'worktree-snapshot' || artifact.type === 'fork-record') {
          throw new Error('disk full');
        }
      };

      await orchestrator.runTask();

      const runsLogText = await fs.readFile(orchestrator.runsNdjsonFile, 'utf8');
      const loggedRunLines = runsLogText.trim().split(/\r?\n/);
      const loggedRun = JSON.parse(loggedRunLines[loggedRunLines.length - 1]);
      assert.deepStrictEqual(loggedRun.worktreeSnapshots, [], 'run log should not reference unpersisted snapshot artifacts');
      assert.strictEqual(loggedRun.forkRecord, null, 'run log should not reference unpersisted fork record artifacts');
      assert.ok(Array.isArray(loggedRun.auditWarnings));
      assert.ok(loggedRun.auditWarnings.some((warning) => warning.includes('failed to write worktree-snapshot artifact')));
      assert.ok(loggedRun.auditWarnings.some((warning) => warning.includes('failed to write fork-record artifact')));

      const scratchpadText = await fs.readFile(orchestrator.scratchpadFile, 'utf8');
      assert.match(scratchpadText, /## AUDIT WARNINGS/);
      assert.doesNotMatch(scratchpadText, /## WORKTREE SNAPSHOTS/);
      assert.doesNotMatch(scratchpadText, /## FORK LINEAGE/);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  await test('runStep writes pre-step and post-step worktree snapshots for write-enabled steps', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loopi-post-step-'));
    const response = {
      choices: [{ message: { content: 'Implemented successfully' }, finish_reason: 'stop' }],
      model: 'test-model'
    };
    const { port, close } = await startMockHttpServer(200, response);
    try {
      const orchestrator = new LoopiOrchestrator({ projectRoot: tempRoot });
      const artifacts = [];
      const appendedSteps = [];
      await orchestrator.init();
      const config = normalizeTaskConfig({
        mode: 'implement',
        prompt: 'Test prompt',
        agents: ['nim-local'],
        providers: {
          'nim-local': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: 'test-model'
          }
        },
        settings: { cwd: '.', timeoutMs: 10000, writeScratchpad: true }
      }, { projectRoot: tempRoot });
      const run = orchestrator.createRun(config);

      orchestrator.captureWorktreeSnapshot = ({ scope, step }) => ({
        scope,
        stepId: step && step.id ? step.id : null,
        stage: step && step.stage ? step.stage : null,
        agent: step && step.agent ? step.agent : null,
        canWrite: Boolean(step && step.canWrite),
        gitAvailable: true,
        gitHead: 'abcdef1234567890',
        gitHeadShort: 'abcdef1',
        statusPorcelain: [' M src/app.js'],
        changedFiles: [{ status: 'M', previousPath: null, path: 'src/app.js' }],
        untrackedFiles: [],
        patchText: 'diff --git a/src/app.js b/src/app.js\n',
        stagedPatchText: '',
        dirty: true,
        captureError: null
      });
      orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
        artifacts.push(artifact);
      };
      orchestrator.collaborationStore.appendStep = async (_taskId, stepRecord) => {
        appendedSteps.push(stepRecord);
      };

      const step = await orchestrator.runStep({
        run,
        config,
        stage: 'implement',
        agent: 'nim-local',
        prompt: 'Implement the feature.',
        cycleNumber: 2,
        mode: 'implement',
        executionPolicy: { canWrite: true },
        handoffSchema: 'prose'
      });

      const snapshotArtifacts = artifacts.filter((artifact) => artifact.type === 'worktree-snapshot');
      assert.strictEqual(snapshotArtifacts.length, 2, 'write-enabled step should emit pre-step and post-step snapshots');
      assert.deepStrictEqual(
        snapshotArtifacts.map((artifact) => artifact.data.scope),
        ['pre-step', 'post-step']
      );
      const preStepArtifact = snapshotArtifacts[0];
      const postStepArtifact = snapshotArtifacts[1];
      assert.strictEqual(preStepArtifact.data.stepId, step.id);
      assert.strictEqual(preStepArtifact.data.patchFile, null, 'pre-step snapshot should not persist a patch file');
      assert.strictEqual(postStepArtifact.data.stepId, step.id);
      assert.strictEqual(postStepArtifact.data.stage, 'implement');
      assert.strictEqual(postStepArtifact.data.agent, 'nim-local');
      assert.strictEqual(postStepArtifact.cycleNumber, 2);
      assert.ok(postStepArtifact.data.patchFile, 'post-step snapshot should persist a patch file');
      const patchPath = path.join(
        taskPaths.taskDir(tempRoot, postStepArtifact.taskId),
        postStepArtifact.data.patchFile
      );
      const patchText = await fs.readFile(patchPath, 'utf8');
      assert.ok(patchText.includes('diff --git a/src/app.js b/src/app.js'));
      assert.strictEqual(run.worktreeSnapshots.length, 2, 'run summary should record both pre-step and post-step snapshots');
      assert.deepStrictEqual(
        run.worktreeSnapshots.map((snapshot) => snapshot.scope),
        ['pre-step', 'post-step']
      );
      assert.strictEqual(appendedSteps.length, 1, 'step record should be appended once');
      assert.strictEqual(appendedSteps[0].worktreeBeforeSnapshotArtifactId, preStepArtifact.id);
      assert.strictEqual(appendedSteps[0].worktreeAfterSnapshotArtifactId, postStepArtifact.id);
      assert.strictEqual(appendedSteps[0].worktreeBeforeSnapshotPatchFile, null);
      assert.strictEqual(appendedSteps[0].worktreeAfterSnapshotPatchFile, postStepArtifact.data.patchFile);
      assert.strictEqual(appendedSteps[0].worktreeBeforeSnapshotDirty, true);
      assert.strictEqual(appendedSteps[0].worktreeAfterSnapshotDirty, true);
      const scratchpadText = await fs.readFile(orchestrator.scratchpadFile, 'utf8');
      assert.match(scratchpadText, /Scope: pre-step/);
      assert.match(scratchpadText, /Scope: post-step/);
      assert.match(scratchpadText, /Stage: implement/);
      assert.match(scratchpadText, /Agent: nim-local/);
      assert.match(scratchpadText, /Cycle: 2/);
      assert.match(scratchpadText, /Worktree Before Snapshot: worktree-snapshot-/);
      assert.match(scratchpadText, /Worktree After Snapshot: worktree-snapshot-/);
      assert.doesNotMatch(scratchpadText, /Worktree Before Patch:/);
      assert.match(scratchpadText, /Worktree After Patch: patches\/worktree-snapshot-/);
      for (const artifact of snapshotArtifacts) {
        const schemaResult = validateArtifactSafe(artifact);
        assert.strictEqual(schemaResult.ok, true, schemaResult.error && schemaResult.error.message);
      }
    } finally {
      await close();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  await test('runStep does not write a post-step worktree snapshot for read-only steps', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loopi-post-step-readonly-'));
    const response = {
      choices: [{ message: { content: 'Reviewed successfully' }, finish_reason: 'stop' }],
      model: 'test-model'
    };
    const { port, close } = await startMockHttpServer(200, response);
    try {
      const orchestrator = new LoopiOrchestrator({ projectRoot: tempRoot });
      const artifacts = [];
      const appendedSteps = [];
      await orchestrator.init();
      const config = normalizeTaskConfig({
        mode: 'review',
        prompt: 'Test prompt',
        agents: ['nim-local'],
        providers: {
          'nim-local': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: 'test-model'
          }
        },
        settings: { cwd: '.', timeoutMs: 10000, writeScratchpad: true }
      }, { projectRoot: tempRoot });
      const run = orchestrator.createRun(config);

      let snapshotCalls = 0;
      orchestrator.captureWorktreeSnapshot = () => {
        snapshotCalls += 1;
        return {
          scope: 'post-step',
          stepId: null,
          stage: null,
          agent: null,
          canWrite: false,
          gitAvailable: true,
          gitHead: 'abcdef1234567890',
          gitHeadShort: 'abcdef1',
          statusPorcelain: [],
          changedFiles: [],
          untrackedFiles: [],
          patchText: '',
          stagedPatchText: '',
          dirty: false,
          captureError: null
        };
      };
      orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
        artifacts.push(artifact);
      };
      orchestrator.collaborationStore.appendStep = async (_taskId, stepRecord) => {
        appendedSteps.push(stepRecord);
      };

      await orchestrator.runStep({
        run,
        config,
        stage: 'review',
        agent: 'nim-local',
        prompt: 'Review the feature.',
        cycleNumber: null,
        mode: 'review',
        executionPolicy: { canWrite: false },
        handoffSchema: 'prose'
      });

      const snapshotArtifacts = artifacts.filter((artifact) => artifact.type === 'worktree-snapshot');
      assert.strictEqual(snapshotArtifacts.length, 0, 'read-only step should not emit a post-step snapshot');
      assert.strictEqual(snapshotCalls, 0, 'snapshot capture should not be invoked for read-only steps');
      assert.strictEqual(run.worktreeSnapshots.length, 0, 'run summary should remain empty for read-only step');
      assert.strictEqual(appendedSteps.length, 1, 'read-only step should still append one step record');
      assert.strictEqual(appendedSteps[0].worktreeBeforeSnapshotArtifactId, null);
      assert.strictEqual(appendedSteps[0].worktreeAfterSnapshotArtifactId, null);
      assert.strictEqual(appendedSteps[0].worktreeBeforeSnapshotPatchFile, null);
      assert.strictEqual(appendedSteps[0].worktreeAfterSnapshotPatchFile, null);
      assert.strictEqual(appendedSteps[0].worktreeBeforeSnapshotDirty, null);
      assert.strictEqual(appendedSteps[0].worktreeAfterSnapshotDirty, null);
    } finally {
      await close();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  await test('Context selection artifact records stage and delivery for full context', async () => {
    const orchestrator = new LoopiOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'plan/guide.md',
          phase: 'plan',
          sizeBytes: 10,
          content: 'Guide',
          skipped: false
        }
      ]
    };
    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };
    const originalLog = console.log;
    const logs = [];
    console.log = (message) => logs.push(message);
    let contextPack;

    try {
      contextPack = await orchestrator.getPromptContextForPhase(config, 'plan', {
        agentName: 'claude',
        run,
        delivery: 'full',
        stageKey: 'planInitial'
      });
    } finally {
      console.log = originalLog;
    }

    const contextArtifact = artifacts.find((artifact) => artifact.type === 'context-selection');
    assert.ok(contextArtifact, 'context-selection artifact should be written');
    assert.strictEqual(contextArtifact.data.stageKey, 'planInitial');
    assert.strictEqual(contextArtifact.data.delivery, 'full');
    assert.strictEqual(contextArtifact.data.suppressed, false);
    assert.strictEqual(contextArtifact.data.maxFiles, 10);
    assert.strictEqual(contextArtifact.data.maxChars, 20000);
    assert.strictEqual(contextArtifact.data.providerMaxInputChars, null);
    assert.strictEqual(contextArtifact.data.effectiveMaxChars, contextPack.effectiveMaxChars);
    assert.deepStrictEqual(logs, [
      `[orchestrator] [context] stage=planInitial delivery=full files=1 chars=${measureContextSectionChars(contextPack)}`
    ]);
    assert.ok(Array.isArray(contextArtifact.data.selectionReasons));
    assert.ok(contextArtifact.data.selectionReasons.length > 0);
    assert.strictEqual(contextArtifact.data.selectedFiles[0], contextPack.files[0].relativePath);
    const schemaResult = validateArtifactSafe(contextArtifact);
    assert.strictEqual(schemaResult.ok, true, schemaResult.error && schemaResult.error.message);
  });

  await test('getContextPackForPhase respects mixed-case phase cap keys after normalization', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'implement',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context',
        maxFilesPerPhase: {
          Implement: 1
        },
        maxCharsPerPhase: {
          Implement: 30
        }
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'implement/first.md',
          phase: 'implement',
          sizeBytes: 10,
          content: 'First implement note',
          skipped: false
        },
        {
          relativePath: 'implement/second.md',
          phase: 'implement',
          sizeBytes: 10,
          content: 'Second implement note',
          skipped: false
        }
      ]
    };

    const contextPack = await orchestrator.getContextPackForPhase(config, 'implement', 'claude', run);

    assert.strictEqual(contextPack.effectiveMaxChars, 30, 'lowercased maxCharsPerPhase key should be applied at lookup time');
    assert.strictEqual(contextPack.files.length, 1, 'phase file cap should limit the selected files');
    assert.strictEqual(contextPack.files[0].relativePath, 'implement/first.md');
  });

  await test('Cached context selection reuse does not write duplicate context-selection artifacts', async () => {
    const orchestrator = new LoopiOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'plan/guide.md',
          phase: 'plan',
          sizeBytes: 10,
          content: '# Guide\nBody',
          skipped: false
        }
      ]
    };
    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };

    const firstPack = await orchestrator.getContextPackForPhase(config, 'plan', 'claude', run);
    const secondPack = await orchestrator.getContextPackForPhase(config, 'plan', 'claude', run);

    assert.strictEqual(firstPack, secondPack, 'context pack should be reused from the run cache');
    const contextArtifacts = artifacts.filter((artifact) => artifact.type === 'context-selection');
    assert.strictEqual(contextArtifacts.length, 1, 'cached context reuse should not log duplicate selection artifacts');
  });

  await test('Context pack cache keys include delivery mode explicitly', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'plan/guide.md',
          phase: 'plan',
          sizeBytes: 10,
          content: '# Guide\nBody',
          skipped: false
        }
      ]
    };

    const fullPack = await orchestrator.getContextPackForPhase(config, 'plan', 'claude', null, 'full');
    const digestPack = await orchestrator.getContextPackForPhase(config, 'plan', 'claude', null, 'digest');

    assert.notStrictEqual(
      fullPack,
      digestPack,
      'full and digest deliveries should not share the same cached context-pack entry implicitly'
    );
  });

  await test('Digest and full context selections write distinct stage-aware artifacts', async () => {
    const orchestrator = new LoopiOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['nim-local'],
      context: {
        dir: './context'
      },
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'test-model',
          maxInputChars: 100
        }
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'plan/guide.md',
          phase: 'plan',
          sizeBytes: 10,
          content: '# Guide\nBody',
          skipped: false
        }
      ]
    };
    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };
    const originalLog = console.log;
    const logs = [];
    console.log = (message) => logs.push(message);
    let fullContextPack;
    let digestContextPack;

    try {
      fullContextPack = await orchestrator.getPromptContextForPhase(config, 'plan', {
        agentName: 'nim-local',
        run,
        delivery: 'full',
        stageKey: 'planInitial'
      });
      digestContextPack = await orchestrator.getPromptContextForPhase(config, 'plan', {
        agentName: 'nim-local',
        run,
        delivery: 'digest',
        stageKey: 'planReview'
      });
    } finally {
      console.log = originalLog;
    }

    const contextArtifacts = artifacts.filter((artifact) => artifact.type === 'context-selection');
    assert.strictEqual(contextArtifacts.length, 2);
    assert.deepStrictEqual(
      contextArtifacts.map((artifact) => artifact.data.stageKey),
      ['planInitial', 'planReview']
    );
    assert.deepStrictEqual(
      contextArtifacts.map((artifact) => artifact.data.delivery),
      ['full', 'digest']
    );
    assert.deepStrictEqual(
      contextArtifacts.map((artifact) => artifact.data.providerMaxInputChars),
      [100, null]
    );
    assert.deepStrictEqual(
      contextArtifacts.map((artifact) => artifact.data.effectiveMaxChars),
      [60, 20000]
    );
    assert.deepStrictEqual(logs, [
      `[orchestrator] [context] stage=planInitial delivery=full files=1 chars=${measureContextSectionChars(fullContextPack)}`,
      `[orchestrator] [context] stage=planReview delivery=digest files=1 chars=${measureContextSectionChars(digestContextPack)}`
    ]);
    for (const artifact of contextArtifacts) {
      const schemaResult = validateArtifactSafe(artifact);
      assert.strictEqual(schemaResult.ok, true, schemaResult.error && schemaResult.error.message);
    }
  });

  await test('None delivery writes a suppressed context-selection artifact and log entry', async () => {
    const orchestrator = new LoopiOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'review/rubric.md',
          phase: 'review',
          sizeBytes: 10,
          content: '# Rubric\nBody',
          skipped: false
        }
      ]
    };
    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };
    const originalLog = console.log;
    const logs = [];
    console.log = (message) => logs.push(message);
    let contextPack;

    try {
      contextPack = await orchestrator.getPromptContextForPhase(config, 'review', {
        agentName: 'claude',
        run,
        delivery: 'none',
        stageKey: 'reviewInitial'
      });
    } finally {
      console.log = originalLog;
    }

    assert.strictEqual(contextPack, null);
    const contextArtifact = artifacts.find((artifact) => artifact.type === 'context-selection');
    assert.ok(contextArtifact, 'suppressed context-selection artifact should be written');
    assert.strictEqual(contextArtifact.data.phase, 'review');
    assert.strictEqual(contextArtifact.data.stageKey, 'reviewInitial');
    assert.strictEqual(contextArtifact.data.delivery, 'none');
    assert.strictEqual(contextArtifact.data.suppressed, true);
    assert.deepStrictEqual(contextArtifact.data.selectedFiles, []);
    assert.deepStrictEqual(contextArtifact.data.selectionReasons, []);
    assert.deepStrictEqual(logs, ['[orchestrator] [context] stage=reviewInitial delivery=none files=0 chars=0']);
    const schemaResult = validateArtifactSafe(contextArtifact);
    assert.strictEqual(schemaResult.ok, true, schemaResult.error && schemaResult.error.message);
  });

  await test('Context delivery logs respect LOOPI_SILENT', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'plan/guide.md',
          phase: 'plan',
          sizeBytes: 10,
          content: '# Guide\nBody',
          skipped: false
        }
      ]
    };

    const originalLog = console.log;
    const originalSilent = process.env.LOOPI_SILENT;
    const logs = [];
    console.log = (message) => logs.push(message);
    process.env.LOOPI_SILENT = '1';

    try {
      await orchestrator.getPromptContextForPhase(config, 'plan', {
        agentName: 'claude',
        run: null,
        delivery: 'digest',
        stageKey: 'planReview'
      });
    } finally {
      console.log = originalLog;
      if (originalSilent === undefined) {
        delete process.env.LOOPI_SILENT;
      } else {
        process.env.LOOPI_SILENT = originalSilent;
      }
    }

    assert.deepStrictEqual(logs, []);
  });

  await test('Equivalent selections reused across agents write one context-selection artifact', async () => {
    const orchestrator = new LoopiOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['claude', 'codex'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'review/rubric.md',
          phase: 'review',
          sizeBytes: 10,
          content: '# Rubric\nBody',
          skipped: false
        }
      ]
    };
    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };

    await orchestrator.getContextPackForPhase(config, 'review', 'claude', run, 'full');
    await orchestrator.getContextPackForPhase(config, 'review', 'codex', run, 'full');

    const contextArtifacts = artifacts.filter((artifact) => artifact.type === 'context-selection');
    assert.strictEqual(contextArtifacts.length, 1, 'equivalent selections should log one artifact');
  });

  await test('Plan clarifications write a plan-clarifications artifact with usedDefault', async () => {
    const orchestrator = new LoopiOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      planQuestionMode: 'autonomous',
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);
    const originalRunStep = orchestrator.runStep;

    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };
    orchestrator.runStep = async ({ stage, agent }) => {
      if (stage === 'plan') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Initial plan draft',
          handoffData: {
            goal: 'test goal',
            units: [{ id: '1', title: 'Commit 1' }],
            questions: [
              {
                id: 'q1',
                question: 'Should we batch the migration?',
                impact: 'Changes rollout strategy',
                agentDefault: 'Yes, batch it'
              }
            ]
          },
          handoffText: 'plan handoff text',
          timedOut: false,
          usedFallback: false,
          fallbackReason: null,
          fatalOutputReason: null,
          handoffParseError: null
        };
      }

      return {
        agent,
        ok: true,
        exitCode: 0,
        outputText: `${stage} output`,
        handoffData: { goal: 'test goal', units: [{ id: '1', title: 'Commit 1' }], questions: [] },
        handoffText: `${stage} handoff`,
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    try {
      await orchestrator.runPlanMode(config, run);
    } finally {
      orchestrator.runStep = originalRunStep;
    }

    const clarificationsArtifact = artifacts.find((artifact) => artifact.type === 'plan-clarifications');
    assert.ok(clarificationsArtifact, 'plan-clarifications artifact should be written');
    assert.strictEqual(clarificationsArtifact.data.clarifications[0].usedDefault, true);
    assert.strictEqual(clarificationsArtifact.data.clarifications[0].answer, 'Yes, batch it');
  });

  await test('Failed HTTP execution artifact has ok false and errorType', async () => {
    const orchestrator = new LoopiOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          model: 'test-model'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };

    await orchestrator.runStep({
      run,
      config,
      stage: 'review',
      agent: 'nim-local',
      prompt: 'Hello!',
      cycleNumber: null,
      mode: 'review',
      executionPolicy: { canWrite: false },
      handoffSchema: 'review'
    });

    const executionArtifact = artifacts.find((artifact) => artifact.type === 'provider-execution');
    assert.ok(executionArtifact, 'provider-execution artifact should be written');
    assert.strictEqual(executionArtifact.data.ok, false);
    assert.strictEqual(executionArtifact.data.errorType, 'connection_failure');
  });

  await test('HTTP review failure surfaces provider error details instead of undefined exit code', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          model: 'test-model'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    const step = await orchestrator.runStep({
      run,
      config,
      stage: 'review',
      agent: 'nim-local',
      prompt: 'Hello!',
      cycleNumber: null,
      mode: 'review',
      executionPolicy: { canWrite: false },
      handoffSchema: 'review'
    });

    assert.throws(() => {
      orchestrator.assertStepSucceeded(step, config);
    }, (error) => {
      assert.match(error.message, /connection_failure/i);
      assert.doesNotMatch(error.message, /exit code undefined/i);
      return true;
    });
  });
};
