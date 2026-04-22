const assert = require('assert');
const path = require('path');
const taskPaths = require('../src/task-paths');

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

console.log('task-paths');

const PROJECT_ROOT = path.join(__dirname, '..');

test('patchesDir returns a run-local patches directory', () => {
  const actual = taskPaths.patchesDir(PROJECT_ROOT, 'run-001');
  const expected = path.join(PROJECT_ROOT, 'shared', 'tasks', 'run-001', 'patches');
  assert.strictEqual(actual, expected);
});

test('patchFilePath returns a default patch filename', () => {
  const actual = taskPaths.patchFilePath(PROJECT_ROOT, 'run-001', 'snapshot-001');
  const expected = path.join(PROJECT_ROOT, 'shared', 'tasks', 'run-001', 'patches', 'snapshot-001.patch');
  assert.strictEqual(actual, expected);
});

test('patchFilePath supports a suffix for staged patches', () => {
  const actual = taskPaths.patchFilePath(PROJECT_ROOT, 'run-001', 'snapshot-001', 'staged');
  const expected = path.join(PROJECT_ROOT, 'shared', 'tasks', 'run-001', 'patches', 'snapshot-001.staged.patch');
  assert.strictEqual(actual, expected);
});

test('patchFilePath rejects unsafe snapshot ids', () => {
  assert.throws(
    () => taskPaths.patchFilePath(PROJECT_ROOT, 'run-001', '../bad'),
    /snapshotId/
  );
});

test('patchFilePath rejects unsafe suffix values', () => {
  assert.throws(
    () => taskPaths.patchFilePath(PROJECT_ROOT, 'run-001', 'snapshot-001', '../bad'),
    /suffix/
  );
});

setTimeout(() => {
  if (!process.exitCode) {
    console.log('\ntask-paths tests passed');
  }
}, 50);
