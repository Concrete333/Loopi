const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const taskPaths = require('../src/task-paths');
const { CollaborationStore } = require('../src/collaboration-store');
const {
  serializeTaskConfigForArtifact,
  createForkTaskFromRun,
  compareRuns,
  __test
} = require('../src/cli-audit');

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  [PASS] ${name}`);
    })
    .catch((error) => {
      console.error(`  [FAIL] ${name}`);
      console.error(`    ${error.message}`);
      process.exitCode = 1;
    });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loopi-cli-audit-'));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('cli-audit');

test('serializeTaskConfigForArtifact stores cwd relative to the project root', () => {
  const projectRoot = makeTempDir();
  try {
    const serialized = serializeTaskConfigForArtifact({
      mode: 'implement',
      prompt: 'Test prompt',
      reviewPrompt: null,
      synthesisPrompt: null,
      customImplementPrompt: null,
      useCase: null,
      fork: null,
      agents: ['codex'],
      providers: {},
      roles: {},
      context: null,
      planQuestionMode: 'autonomous',
      settings: {
        cwd: projectRoot,
        timeoutMs: 10000
      }
    }, projectRoot);

    assert.strictEqual(serialized.settings.cwd, '.');
  } finally {
    removeDir(projectRoot);
  }
});

test('createForkTaskFromRun writes a reusable shared/task.json with fork lineage', async () => {
  const projectRoot = makeTempDir();
  try {
    const store = new CollaborationStore({ projectRoot });
    const runId = 'run-001';

    await store.writeTask(runId, {
      mode: 'implement',
      prompt: 'Retry the work.',
      agents: ['codex', 'gemini'],
      reviewPrompt: null,
      synthesisPrompt: null,
      customImplementPrompt: 'Keep scope tight.',
      useCase: null,
      fork: null,
      providers: {},
      roles: {},
      context: null,
      planQuestionMode: 'autonomous',
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        continueOnError: false,
        writeScratchpad: true,
        qualityLoops: 1,
        implementLoops: 2,
        implementLoopsPerUnit: 2,
        agentPolicies: {
          codex: { canWrite: true },
          gemini: { canWrite: false }
        },
        agentOptions: {},
        oneShotOrigins: {}
      },
      startedAt: new Date().toISOString(),
      status: 'completed'
    });

    await store.writeArtifact(runId, {
      type: 'worktree-snapshot',
      id: 'worktree-snapshot-1',
      taskId: runId,
      createdAt: new Date().toISOString(),
      data: {
        scope: 'post-step',
        stepId: 'implement-4',
        stage: 'implement',
        agent: 'codex',
        canWrite: true,
        gitAvailable: true,
        gitHead: 'abc123def456',
        gitHeadShort: 'abc123d',
        statusPorcelain: [],
        changedFiles: [],
        untrackedFiles: [],
        patchFile: 'patches/worktree-snapshot-1.patch',
        stagedPatchFile: null,
        dirty: false,
        captureError: null
      }
    });

    const result = await createForkTaskFromRun({
      projectRoot,
      sourceRunId: runId,
      sourceStepId: 'implement-4',
      reason: 'Retry with different reviewer feedback'
    });

    const taskConfig = JSON.parse(fs.readFileSync(taskPaths.legacyTaskFile(projectRoot), 'utf8'));
    assert.strictEqual(result.sourceRunId, runId);
    assert.strictEqual(result.sourceStepId, 'implement-4');
    assert.strictEqual(result.baseCommit, 'abc123def456');
    assert.strictEqual(taskConfig.mode, 'implement');
    assert.strictEqual(taskConfig.prompt, 'Retry the work.');
    assert.strictEqual(taskConfig.customImplementPrompt, 'Keep scope tight.');
    assert.strictEqual(taskConfig.fork.forkedFromRunId, runId);
    assert.strictEqual(taskConfig.fork.forkedFromStepId, 'implement-4');
    assert.strictEqual(taskConfig.fork.baseCommit, 'abc123def456');
    assert.strictEqual(taskConfig.fork.reason, 'Retry with different reviewer feedback');
  } finally {
    removeDir(projectRoot);
  }
});

test('compareRuns reports representative patch paths for both runs', async () => {
  const projectRoot = makeTempDir();
  try {
    const store = new CollaborationStore({ projectRoot });
    for (const runId of ['run-a', 'run-b']) {
      await store.writeTask(runId, {
        mode: 'implement',
        prompt: `Prompt for ${runId}`,
        agents: ['codex'],
        startedAt: new Date().toISOString(),
        status: 'completed'
      });
      await store.writeArtifact(runId, {
        type: 'worktree-snapshot',
        id: `worktree-snapshot-${runId}`,
        taskId: runId,
        createdAt: new Date().toISOString(),
        data: {
          scope: 'run-end',
          stepId: null,
          stage: null,
          agent: null,
          canWrite: false,
          gitAvailable: true,
          gitHead: `${runId}-head`,
          gitHeadShort: `${runId}-hd`,
          statusPorcelain: [' M src/file.js'],
          changedFiles: [{ status: 'M', path: 'src/file.js', previousPath: null }],
          untrackedFiles: [],
          patchFile: `patches/${runId}.patch`,
          stagedPatchFile: null,
          dirty: true,
          captureError: null
        }
      });
    }

    const result = await compareRuns({
      projectRoot,
      leftRunId: 'run-a',
      rightRunId: 'run-b'
    });

    assert.match(result.lines.join('\n'), /Comparing runs: run-a vs run-b/);
    assert.match(result.lines.join('\n'), /shared\/tasks\/run-a\/patches\/run-a\.patch/);
    assert.match(result.lines.join('\n'), /shared\/tasks\/run-b\/patches\/run-b\.patch/);
  } finally {
    removeDir(projectRoot);
  }
});

test('selectRepresentativeSnapshot prefers run-end over earlier scopes', () => {
  const snapshot = __test.selectRepresentativeSnapshot([
    { data: { scope: 'run-start', gitHead: 'start', patchFile: null, stagedPatchFile: null } },
    { data: { scope: 'post-step', gitHead: 'mid', patchFile: 'patches/mid.patch', stagedPatchFile: null } },
    { data: { scope: 'run-end', gitHead: 'end', patchFile: 'patches/end.patch', stagedPatchFile: null } }
  ]);

  assert.strictEqual(snapshot.data.scope, 'run-end');
});

test('selectSnapshotForFork with step id prefers post-step for that step', () => {
  const snapshot = __test.selectSnapshotForFork([
    { data: { scope: 'post-step', stepId: 'implement-1', gitHead: 'a1', patchFile: 'patches/a1.patch', stagedPatchFile: null } },
    { data: { scope: 'pre-step', stepId: 'implement-2', gitHead: 'a2-pre', patchFile: null, stagedPatchFile: null } },
    { data: { scope: 'post-step', stepId: 'implement-2', gitHead: 'a2-post', patchFile: 'patches/a2.patch', stagedPatchFile: null } }
  ], 'run-200', 'implement-2');

  assert.strictEqual(snapshot.data.scope, 'post-step');
  assert.strictEqual(snapshot.data.stepId, 'implement-2');
  assert.strictEqual(snapshot.data.gitHead, 'a2-post');
});

test('selectSnapshotForFork with step id falls back to pre-step', () => {
  const snapshot = __test.selectSnapshotForFork([
    { data: { scope: 'pre-step', stepId: 'implement-2', gitHead: 'a2-pre', patchFile: null, stagedPatchFile: null } },
    { data: { scope: 'run-end', stepId: null, gitHead: 'run-end', patchFile: 'patches/end.patch', stagedPatchFile: null } }
  ], 'run-201', 'implement-2');

  assert.strictEqual(snapshot.data.scope, 'pre-step');
  assert.strictEqual(snapshot.data.stepId, 'implement-2');
});

test('selectSnapshotForFork with step id rejects run-level fallback when step snapshots are missing', () => {
  assert.throws(
    () => __test.selectSnapshotForFork([
      { data: { scope: 'run-start', stepId: null, gitHead: 'start', patchFile: null, stagedPatchFile: null } },
      { data: { scope: 'run-end', stepId: null, gitHead: 'end', patchFile: 'patches/end.patch', stagedPatchFile: null } }
    ], 'run-202', 'implement-9'),
    /does not contain a usable worktree snapshot for step "implement-9"/
  );
});

test('createForkTaskFromRun rejects missing step snapshot when step id is requested', async () => {
  const projectRoot = makeTempDir();
  try {
    const store = new CollaborationStore({ projectRoot });
    const runId = 'run-404';

    await store.writeTask(runId, {
      mode: 'implement',
      prompt: 'Retry the work.',
      agents: ['codex'],
      startedAt: new Date().toISOString(),
      status: 'completed'
    });

    await assert.rejects(
      () => createForkTaskFromRun({
        projectRoot,
        sourceRunId: runId,
        sourceStepId: 'implement-9',
        reason: 'Need exact step base'
      }),
      /does not contain a usable worktree snapshot for step "implement-9"/
    );
  } finally {
    removeDir(projectRoot);
  }
});

test('selectSnapshotForFork accepts metadata-only pre-step snapshots', () => {
  const snapshot = __test.selectSnapshotForFork([
    {
      data: {
        scope: 'pre-step',
        stepId: 'implement-2',
        gitHead: null,
        patchFile: null,
        stagedPatchFile: null,
        dirty: true,
        statusPorcelain: ['?? draft.txt'],
        changedFiles: [{ status: '??', path: 'draft.txt', previousPath: null }],
        untrackedFiles: ['draft.txt']
      }
    }
  ], 'run-empty', 'implement-2');

  assert.strictEqual(snapshot.data.scope, 'pre-step');
  assert.strictEqual(snapshot.data.stepId, 'implement-2');
});

test('selectSnapshotForFork accepts clean exact-step snapshots without head, patch, or dirty metadata', () => {
  const snapshot = __test.selectSnapshotForFork([
    {
      data: {
        scope: 'pre-step',
        stepId: 'implement-2',
        gitHead: null,
        patchFile: null,
        stagedPatchFile: null,
        dirty: false,
        statusPorcelain: [],
        changedFiles: [],
        untrackedFiles: []
      }
    }
  ], 'run-clean-empty', 'implement-2');

  assert.strictEqual(snapshot.data.scope, 'pre-step');
  assert.strictEqual(snapshot.data.stepId, 'implement-2');
});

setTimeout(() => {
  if (!process.exitCode) {
    console.log('\ncli-audit tests passed');
  }
}, 80);
