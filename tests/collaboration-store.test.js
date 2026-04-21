const assert = require('assert');
const path = require('path');
const { CollaborationStore } = require('../src/collaboration-store');
const fs = require('fs').promises;

const PROJECT_ROOT = path.join(__dirname, '..');
const TEST_TASK_ID = 'test-run-collaboration-store';

// Helper to clean up test artifacts
async function cleanupTask(taskId = TEST_TASK_ID) {
  const taskPaths = require('../src/task-paths');
  const taskDir = taskPaths.taskDir(PROJECT_ROOT, taskId);

  try {
    await fs.rm(taskDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function test(name, fn) {
  const isAsync = fn.constructor.name === 'AsyncFunction';

  (async () => {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
    } catch (error) {
      console.error(`  [FAIL] ${name}`);
      console.error(`    ${error.message}`);
      if (error.stack) {
        console.error(`    ${error.stack.split('\n').slice(1, 3).join('\n')}`);
      }
      process.exitCode = 1;
    }
  })();
}

console.log('collaboration-store: writeTask error handling');

test('writeTask when file does not exist (ENOENT swallowed, createdAt freshly set)', async () => {
  await cleanupTask('test-enoent');

  const store = new CollaborationStore({ projectRoot: PROJECT_ROOT });
  const testTask = { mode: 'plan', prompt: 'test', agents: ['claude'], startedAt: new Date().toISOString() };

  // This should succeed even though the file doesn't exist yet
  await store.writeTask('test-enoent', testTask);

  // Verify the task was written with a fresh createdAt
  const taskPaths = require('../src/task-paths');
  const content = await fs.readFile(taskPaths.taskJsonPath(PROJECT_ROOT, 'test-enoent'), 'utf8');
  const parsed = JSON.parse(content);

  assert.ok(parsed.createdAt, 'createdAt should be set');
  assert.ok(!parsed.updatedAt, 'updatedAt should not be set on first write');
  assert.strictEqual(parsed.type, 'task');
  assert.strictEqual(parsed.taskId, 'test-enoent');
  assert.deepStrictEqual(parsed.data, testTask);

  await cleanupTask('test-enoent');
});

test('writeTask when file contains invalid JSON (SyntaxError swallowed, createdAt freshly set)', async () => {
  await cleanupTask('test-syntax-error');

  const taskPaths = require('../src/task-paths');
  const taskFile = taskPaths.taskJsonPath(PROJECT_ROOT, 'test-syntax-error');

  // Create directory and write invalid JSON
  await fs.mkdir(path.dirname(taskFile), { recursive: true });
  await fs.writeFile(taskFile, 'this is not valid json {{', 'utf8');

  const store = new CollaborationStore({ projectRoot: PROJECT_ROOT });
  const testTask = { mode: 'implement', prompt: 'test', agents: ['claude'], startedAt: new Date().toISOString() };

  // This should succeed despite invalid existing JSON
  await store.writeTask('test-syntax-error', testTask);

  // Verify the task was written with a fresh createdAt
  const content = await fs.readFile(taskFile, 'utf8');
  const parsed = JSON.parse(content);

  assert.ok(parsed.createdAt, 'createdAt should be set');
  assert.ok(!parsed.updatedAt, 'updatedAt should not be set on first write');
  assert.strictEqual(parsed.type, 'task');
  assert.deepStrictEqual(parsed.data, testTask);

  await cleanupTask('test-syntax-error');
});

test('writeTask re-throws non-ENOENT errors (e.g., EACCES permission error)', async () => {
  await cleanupTask('test-eacces');

  const taskPaths = require('../src/task-paths');
  const taskDir = taskPaths.taskDir(PROJECT_ROOT, 'test-eacces');
  const taskFile = taskPaths.taskJsonPath(PROJECT_ROOT, 'test-eacces');

  // Create directory and a file, then make it read-only
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(taskFile, '{}', 'utf8');

  // On Windows, we need to make the directory read-only, not just the file
  // On Unix, we can make the file read-only
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(taskDir, 0o444);
    } catch {
      // Skip test if we can't change permissions
      await cleanupTask('test-eacces');
      return;
    }

    const store = new CollaborationStore({ projectRoot: PROJECT_ROOT });
    const testTask = { mode: 'plan', prompt: 'test', agents: ['claude'], startedAt: new Date().toISOString() };

    // This should throw due to permission error
    await assert.rejects(
      () => store.writeTask('test-eacces', testTask),
      (err) => {
        // Should be some kind of permission or access error
        return err.code === 'EACCES' || err.code === 'EPERM';
      }
    );

    // Restore permissions for cleanup
    await fs.chmod(taskDir, 0o755);
  }

  await cleanupTask('test-eacces');
});

test('writeTask preserves createdAt on subsequent writes', async () => {
  await cleanupTask('test-preserve-created-at');

  const store = new CollaborationStore({ projectRoot: PROJECT_ROOT });
  const testTask1 = { mode: 'plan', prompt: 'test1', agents: ['claude'], startedAt: new Date().toISOString() };

  // First write
  await store.writeTask('test-preserve-created-at', testTask1);

  // Read to get createdAt
  const taskPaths = require('../src/task-paths');
  const content1 = await fs.readFile(taskPaths.taskJsonPath(PROJECT_ROOT, 'test-preserve-created-at'), 'utf8');
  const parsed1 = JSON.parse(content1);
  const originalCreatedAt = parsed1.createdAt;

  // Wait a tiny bit to ensure timestamps would differ
  await new Promise(resolve => setTimeout(resolve, 10));

  // Second write
  const testTask2 = { mode: 'plan', prompt: 'test2', agents: ['claude'], startedAt: new Date().toISOString() };
  await store.writeTask('test-preserve-created-at', testTask2);

  const content2 = await fs.readFile(taskPaths.taskJsonPath(PROJECT_ROOT, 'test-preserve-created-at'), 'utf8');
  const parsed2 = JSON.parse(content2);

  assert.strictEqual(parsed2.createdAt, originalCreatedAt, 'createdAt should be preserved');
  assert.ok(parsed2.updatedAt, 'updatedAt should be set on update');

  await cleanupTask('test-preserve-created-at');
});

test('writeTask handles valid existing task JSON', async () => {
  await cleanupTask('test-valid-json');

  const taskPaths = require('../src/task-paths');
  const taskDir = taskPaths.taskDir(PROJECT_ROOT, 'test-valid-json');
  const taskFile = taskPaths.taskJsonPath(PROJECT_ROOT, 'test-valid-json');

  // Create directory and write valid task JSON
  await fs.mkdir(taskDir, { recursive: true });
  const originalCreatedAt = '2024-01-01T00:00:00.000Z';
  await fs.writeFile(taskFile, JSON.stringify({
    type: 'task',
    id: 'task-test-valid-json',
    taskId: 'test-valid-json',
    createdAt: originalCreatedAt,
    data: { mode: 'plan', prompt: 'original', agents: ['claude'], startedAt: originalCreatedAt }
  }, null, 2) + '\n', 'utf8');

  const store = new CollaborationStore({ projectRoot: PROJECT_ROOT });
  const testTask = { mode: 'plan', prompt: 'updated', agents: ['claude'], startedAt: new Date().toISOString() };

  // This should succeed and preserve createdAt
  await store.writeTask('test-valid-json', testTask);

  const content = await fs.readFile(taskFile, 'utf8');
  const parsed = JSON.parse(content);

  assert.strictEqual(parsed.createdAt, originalCreatedAt, 'createdAt should be preserved from valid JSON');
  assert.ok(parsed.updatedAt, 'updatedAt should be set on update');
  assert.deepStrictEqual(parsed.data, testTask);

  await cleanupTask('test-valid-json');
});

// Run all async tests and exit when done
// Note: Tests are already running via the async function wrapper above
// We just need to ensure we don't exit too early
setTimeout(() => {
  if (!process.exitCode) {
    console.log('\ncollaboration-store tests passed');
  }
}, 100);
