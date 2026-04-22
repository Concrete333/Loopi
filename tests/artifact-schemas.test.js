const assert = require('assert');
const { validateArtifact, validateArtifactSafe } = require('../src/artifact-schemas');

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    console.error(`  [FAIL] ${name}`);
    console.error(`    ${error.message}`);
    if (error.stack) {
      console.error(`    ${error.stack.split('\n').slice(1, 3).join('\n')}`);
    }
    process.exitCode = 1;
  }
}

console.log('artifact-schemas');

test('valid worktree-snapshot artifact passes validation', () => {
  const artifact = {
    type: 'worktree-snapshot',
    id: 'worktree-snapshot-0001',
    taskId: 'run-001',
    createdAt: new Date().toISOString(),
    cycleNumber: 1,
    data: {
      scope: 'post-step',
      stepId: 'implement-2',
      stage: 'implement',
      agent: 'codex',
      canWrite: true,
      gitAvailable: true,
      gitHead: 'abcdef123456',
      gitHeadShort: 'abcdef1',
      statusPorcelain: [' M src/orchestrator.js', '?? shared/tmp.txt'],
      changedFiles: [
        {
          status: 'M',
          path: 'src/orchestrator.js',
          previousPath: null
        }
      ],
      untrackedFiles: ['shared/tmp.txt'],
      patchFile: 'patches/worktree-snapshot-0001.patch',
      stagedPatchFile: null,
      dirty: true,
      captureError: null
    }
  };

  validateArtifact(artifact);
});

test('invalid worktree-snapshot artifact is rejected', () => {
  const artifact = {
    type: 'worktree-snapshot',
    id: 'worktree-snapshot-0001',
    taskId: 'run-001',
    createdAt: new Date().toISOString(),
    data: {
      scope: 'post-step',
      stepId: 'implement-2',
      stage: 'implement',
      agent: 'codex',
      canWrite: 'yes',
      gitAvailable: true,
      gitHead: null,
      gitHeadShort: null,
      statusPorcelain: [],
      changedFiles: [],
      untrackedFiles: [],
      patchFile: null,
      stagedPatchFile: null,
      dirty: false,
      captureError: null
    }
  };

  const result = validateArtifactSafe(artifact);
  assert.strictEqual(result.ok, false);
  assert.match(result.error.message, /canWrite/);
});

test('valid fork-record artifact passes validation', () => {
  const artifact = {
    type: 'fork-record',
    id: 'fork-record-0001',
    taskId: 'run-002',
    createdAt: new Date().toISOString(),
    data: {
      forkedFromRunId: 'run-001',
      forkedFromStepId: 'implement-2',
      baseCommit: 'abcdef123456',
      reason: 'Retry with more review pressure',
      recordedBy: 'manual'
    }
  };

  validateArtifact(artifact);
});

test('invalid fork-record artifact is rejected', () => {
  const artifact = {
    type: 'fork-record',
    id: 'fork-record-0001',
    taskId: 'run-002',
    createdAt: new Date().toISOString(),
    data: {
      forkedFromRunId: '',
      forkedFromStepId: null,
      baseCommit: null,
      reason: null,
      recordedBy: null
    }
  };

  const result = validateArtifactSafe(artifact);
  assert.strictEqual(result.ok, false);
  assert.match(result.error.message, /forkedFromRunId/);
});

setTimeout(() => {
  if (!process.exitCode) {
    console.log('\nartifact-schemas tests passed');
  }
}, 50);
