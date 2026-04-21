const assert = require('assert');
const path = require('path');
const { selectContextForPhase } = require('../src/context-selection.js');

const TRUNCATION_MARKER = '\n[...truncated]';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  [FAIL] ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

// Helper to create a mock context index
function createMockIndex(files) {
  return {
    rootDir: '/mock/context',
    files: files.map(f => ({
      ...f,
      filePath: `/mock/context/${f.relativePath.replace(/\//g, path.sep)}`,
      skipped: f.skipped || false,
      skipReason: f.skipReason || null
    })),
    builtAt: Date.now()
  };
}

console.log('context-selection: selectContextForPhase');

test('Phase-matched files are preferred over shared files', () => {
  const index = createMockIndex([
    { relativePath: 'shared/guidelines.md', phase: 'shared', content: 'Shared guidelines.', sizeBytes: 20 },
    { relativePath: 'plan/approach.md', phase: 'plan', content: 'Plan approach.', sizeBytes: 15 },
    { relativePath: 'review/criteria.md', phase: 'review', content: 'Review criteria.', sizeBytes: 16 }
  ]);

  const pack = selectContextForPhase(index, 'plan', { maxFiles: 5, maxChars: 1000 });

  // Only phase, shared, and examples buckets are eligible in v1.
  assert.strictEqual(pack.files.length, 2);
  // Phase-matched file should be first
  assert.strictEqual(pack.files[0].relativePath, 'plan/approach.md');
  assert.strictEqual(pack.selectionReasons[0].reason, 'phase match');
  assert.strictEqual(pack.selectionReasons[0].bucket, 'phase');
  // Shared file should be second
  assert.strictEqual(pack.files[1].relativePath, 'shared/guidelines.md');
  assert.strictEqual(pack.selectionReasons[1].reason, 'shared context');
  assert.strictEqual(pack.selectionReasons[1].bucket, 'shared');
  // Unrelated phase content should not be pulled in during v1 selection.
  assert.ok(!pack.files.some(f => f.relativePath === 'review/criteria.md'));
});

test('Shared files appear when no phase-specific files exist', () => {
  const index = createMockIndex([
    { relativePath: 'shared/guidelines.md', phase: 'shared', content: 'Shared guidelines.', sizeBytes: 20 },
    { relativePath: 'shared/api.md', phase: 'shared', content: 'API docs.', sizeBytes: 10 }
  ]);

  const pack = selectContextForPhase(index, 'plan', { maxFiles: 5, maxChars: 1000 });

  assert.strictEqual(pack.files.length, 2);
  assert.ok(pack.files.every(f => f.phase === 'shared'));
});

test('maxFiles budget is enforced', () => {
  const index = createMockIndex([
    { relativePath: 'shared/file1.md', phase: 'shared', content: 'File 1.', sizeBytes: 10 },
    { relativePath: 'shared/file2.md', phase: 'shared', content: 'File 2.', sizeBytes: 10 },
    { relativePath: 'shared/file3.md', phase: 'shared', content: 'File 3.', sizeBytes: 10 },
    { relativePath: 'shared/file4.md', phase: 'shared', content: 'File 4.', sizeBytes: 10 },
    { relativePath: 'shared/file5.md', phase: 'shared', content: 'File 5.', sizeBytes: 10 }
  ]);

  const pack = selectContextForPhase(index, 'plan', { maxFiles: 3, maxChars: 1000 });

  assert.strictEqual(pack.files.length, 3);
});

test('maxChars budget is enforced (stops adding files once limit is reached)', () => {
  const index = createMockIndex([
    { relativePath: 'shared/small.md', phase: 'shared', content: 'Small.', sizeBytes: 10 },
    { relativePath: 'shared/medium.md', phase: 'shared', content: 'Medium content here.', sizeBytes: 30 },
    { relativePath: 'shared/large.md', phase: 'shared', content: 'Large file with lots of content that exceeds budget.', sizeBytes: 100 }
  ]);

  const pack = selectContextForPhase(index, 'plan', { maxFiles: 10, maxChars: 50 });

  // Should include small (6 chars) and medium (20 chars) = 26 total
  // But large (60 chars) would exceed 50, so skip it
  assert.strictEqual(pack.files.length, 2);
  assert.ok(pack.totalChars <= 50);
});

test('providerMaxInputChars reduces the effective char budget', () => {
  const index = createMockIndex([
    { relativePath: 'shared/file1.md', phase: 'shared', content: 'File 1 content.', sizeBytes: 20 },
    { relativePath: 'shared/file2.md', phase: 'shared', content: 'File 2 content.', sizeBytes: 20 },
    { relativePath: 'shared/file3.md', phase: 'shared', content: 'File 3 content.', sizeBytes: 20 }
  ]);

  // With providerMaxInputChars of 100, effective budget is 60 (60% of 100)
  const pack = selectContextForPhase(index, 'plan', {
    maxFiles: 10,
    maxChars: 1000,
    providerMaxInputChars: 100
  });

  assert.strictEqual(pack.effectiveMaxChars, 60);
  assert.ok(pack.totalChars <= 60);
});

test('Files over 4000 chars are truncated with [...truncated] marker', () => {
  const longContent = 'x'.repeat(5000);
  const index = createMockIndex([
    { relativePath: 'shared/long.md', phase: 'shared', content: longContent, sizeBytes: 5000 }
  ]);

  const pack = selectContextForPhase(index, 'plan', { maxFiles: 10, maxChars: 10000 });

  assert.strictEqual(pack.files.length, 1);
  assert.strictEqual(pack.files[0].truncated, true);
  assert.strictEqual(pack.files[0].content.length, 4000 + TRUNCATION_MARKER.length);
  assert.ok(pack.files[0].content.endsWith(TRUNCATION_MARKER));
});

test('Budget checks use truncated excerpts instead of full file length', () => {
  const longContent = 'x'.repeat(5000);
  const index = createMockIndex([
    { relativePath: 'shared/long.md', phase: 'shared', content: longContent, sizeBytes: 5000 }
  ]);

  const pack = selectContextForPhase(index, 'plan', {
    maxFiles: 10,
    maxChars: 4500
  });

  assert.strictEqual(pack.files.length, 1);
  assert.strictEqual(pack.files[0].truncated, true);
  assert.ok(pack.totalChars <= 4500);
});

test('Empty index returns an empty pack without error', () => {
  const index = { rootDir: '/mock/context', files: [], builtAt: Date.now() };

  const pack = selectContextForPhase(index, 'plan', { maxFiles: 10, maxChars: 1000 });

  assert.strictEqual(pack.files.length, 0);
  assert.strictEqual(pack.totalChars, 0);
  assert.strictEqual(pack.skippedCount, 0);
});

test('selectionReasons correctly explains each selected file', () => {
  const index = createMockIndex([
    { relativePath: 'plan/outline.md', phase: 'plan', content: 'Plan outline.', sizeBytes: 15, priority: 2 },
    { relativePath: 'shared/guidelines.md', phase: 'shared', content: 'Guidelines.', sizeBytes: 12 },
    { relativePath: 'examples/sample.md', phase: 'examples', content: 'Example.', sizeBytes: 10 }
  ]);

  const pack = selectContextForPhase(index, 'plan', { maxFiles: 10, maxChars: 1000 });

  assert.strictEqual(pack.selectionReasons.length, 3);

  const planReason = pack.selectionReasons.find(r => r.relativePath === 'plan/outline.md');
  assert.ok(planReason);
  assert.strictEqual(planReason.bucket, 'phase');
  assert.ok(planReason.reason.includes('phase match'));
  assert.ok(planReason.reason.includes('priority(2)'));

  const sharedReason = pack.selectionReasons.find(r => r.relativePath === 'shared/guidelines.md');
  assert.ok(sharedReason);
  assert.strictEqual(sharedReason.bucket, 'shared');
  assert.strictEqual(sharedReason.reason, 'shared context');
});

test('skippedCount tracks files dropped due to budget', () => {
  const index = createMockIndex([
    { relativePath: 'shared/file1.md', phase: 'shared', content: 'File 1.', sizeBytes: 10 },
    { relativePath: 'shared/file2.md', phase: 'shared', content: 'File 2.', sizeBytes: 10 },
    { relativePath: 'shared/file3.md', phase: 'shared', content: 'File 3.', sizeBytes: 10 },
    { relativePath: 'shared/file4.md', phase: 'shared', content: 'File 4.', sizeBytes: 10 },
    { relativePath: 'shared/file5.md', phase: 'shared', content: 'File 5.', sizeBytes: 10 }
  ]);

  // Only allow 2 files
  const pack = selectContextForPhase(index, 'plan', { maxFiles: 2, maxChars: 1000 });

  assert.strictEqual(pack.files.length, 2);
  assert.strictEqual(pack.skippedCount, 3); // 5 total - 2 selected = 3 skipped
});

test('Files with manifest-provided priority are ranked above unscored files', () => {
  const index = createMockIndex([
    { relativePath: 'shared/low-priority.md', phase: 'shared', content: 'Low.', sizeBytes: 10 },
    { relativePath: 'shared/high-priority.md', phase: 'shared', content: 'High.', sizeBytes: 10, priority: 5 },
    { relativePath: 'shared/no-priority.md', phase: 'shared', content: 'None.', sizeBytes: 10 }
  ]);

  const pack = selectContextForPhase(index, 'plan', { maxFiles: 10, maxChars: 1000 });

  assert.strictEqual(pack.files[0].relativePath, 'shared/high-priority.md');
  assert.strictEqual(pack.selectionReasons[0].bucket, 'shared');
  assert.ok(pack.selectionReasons[0].reason.includes('priority(5)'));
});

test('When providerMaxInputChars is very small, effective budget is correctly reduced', () => {
  const index = createMockIndex([
    { relativePath: 'shared/file.md', phase: 'shared', content: 'x'.repeat(100), sizeBytes: 100 }
  ]);

  // providerMaxInputChars of 50 means effective budget is 30 (60%)
  const pack = selectContextForPhase(index, 'plan', {
    maxFiles: 10,
    maxChars: 10000,
    providerMaxInputChars: 50
  });

  assert.strictEqual(pack.effectiveMaxChars, 30);
  // File is 100 chars, exceeds 30, so should be skipped
  assert.strictEqual(pack.files.length, 0);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
