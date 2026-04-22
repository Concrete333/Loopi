const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { captureWorktreeSnapshot, __test } = require('../src/worktree-audit');

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

function gitAvailable() {
  const result = spawnSync('git', ['--version'], {
    encoding: 'utf8',
    windowsHide: true
  });
  return !result.error && result.status === 0;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loopi-worktree-audit-'));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error ? result.error.message : result.stderr}`);
  }
  return result;
}

console.log('worktree-audit');

test('parsePorcelainStatus returns non-empty lines only', () => {
  const actual = __test.parsePorcelainStatus(' M a.txt\r\n?? b.txt\r\n\r\n');
  assert.deepStrictEqual(actual, [' M a.txt', '?? b.txt']);
});

test('parseChangedFiles handles normal and rename output', () => {
  const actual = __test.parseChangedFiles('M\tsrc/a.js\nR100\told.txt\tnew.txt\n');
  assert.deepStrictEqual(actual, [
    { status: 'M', previousPath: null, path: 'src/a.js' },
    { status: 'R100', previousPath: 'old.txt', path: 'new.txt' }
  ]);
});

test('extractUntrackedFiles returns only untracked paths', () => {
  const actual = __test.extractUntrackedFiles([' M a.txt', '?? b.txt', 'A  c.txt']);
  assert.deepStrictEqual(actual, ['b.txt']);
});

test('buildSyntheticUntrackedPatch includes file headers and contents for text files', () => {
  const actual = __test.buildSyntheticUntrackedPatch('notes/todo.txt', Buffer.from('first line\nsecond line\n', 'utf8'));
  assert.match(actual, /diff --git a\/notes\/todo.txt b\/notes\/todo.txt/);
  assert.match(actual, /\+\+\+ b\/notes\/todo.txt/);
  assert.match(actual, /\+first line/);
  assert.match(actual, /\+second line/);
});

test('captureWorktreeSnapshot returns an unavailable snapshot when git is missing', () => {
  const spawnSyncImpl = () => ({
    error: new Error('spawn git ENOENT'),
    status: null,
    stdout: '',
    stderr: ''
  });

  const snapshot = captureWorktreeSnapshot({
    projectRoot: process.cwd(),
    scope: 'run-start',
    spawnSyncImpl
  });

  assert.strictEqual(snapshot.gitAvailable, false);
  assert.match(snapshot.captureError, /Git unavailable/);
});

test('captureWorktreeSnapshot reports a non-git directory cleanly', () => {
  const tempDir = makeTempDir();

  try {
    const snapshot = captureWorktreeSnapshot({
      projectRoot: tempDir,
      scope: 'run-start'
    });

    assert.strictEqual(snapshot.gitAvailable, false);
    assert.ok(snapshot.captureError);
  } finally {
    removeDir(tempDir);
  }
});

test('captureWorktreeSnapshot captures repo state in a clean git repo', async () => {
  if (!gitAvailable()) {
    console.log('  [SKIP] captureWorktreeSnapshot captures repo state in a clean git repo (git unavailable)');
    return;
  }

  const tempDir = makeTempDir();

  try {
    runGit(tempDir, ['init']);
    runGit(tempDir, ['config', 'user.email', 'loopi@example.com']);
    runGit(tempDir, ['config', 'user.name', 'Loopi Test']);
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# temp\n', 'utf8');
    runGit(tempDir, ['add', 'README.md']);
    runGit(tempDir, ['commit', '-m', 'init']);

    const snapshot = captureWorktreeSnapshot({
      projectRoot: tempDir,
      scope: 'run-start'
    });

    assert.strictEqual(snapshot.gitAvailable, true);
    assert.ok(snapshot.gitHead);
    assert.ok(snapshot.gitHeadShort);
    assert.deepStrictEqual(snapshot.statusPorcelain, []);
    assert.deepStrictEqual(snapshot.changedFiles, []);
    assert.deepStrictEqual(snapshot.untrackedFiles, []);
    assert.strictEqual(snapshot.dirty, false);
    assert.strictEqual(snapshot.captureError, null);
  } finally {
    removeDir(tempDir);
  }
});

test('captureWorktreeSnapshot treats an empty git repo as available and records untracked files', async () => {
  if (!gitAvailable()) {
    console.log('  [SKIP] captureWorktreeSnapshot treats an empty git repo as available and records untracked files (git unavailable)');
    return;
  }

  const tempDir = makeTempDir();

  try {
    runGit(tempDir, ['init']);
    fs.writeFileSync(path.join(tempDir, 'draft.txt'), 'hello empty repo\n', 'utf8');

    const snapshot = captureWorktreeSnapshot({
      projectRoot: tempDir,
      scope: 'run-start'
    });

    assert.strictEqual(snapshot.gitAvailable, true);
    assert.strictEqual(snapshot.gitHead, null);
    assert.strictEqual(snapshot.gitHeadShort, null);
    assert.strictEqual(snapshot.dirty, true);
    assert.ok(snapshot.untrackedFiles.includes('draft.txt'));
    assert.ok(snapshot.changedFiles.some((item) => item.status === '??' && item.path === 'draft.txt'));
    assert.match(snapshot.patchText, /diff --git a\/draft.txt b\/draft.txt/);
    assert.match(snapshot.patchText, /\+hello empty repo/);
    assert.strictEqual(snapshot.captureError, null);
  } finally {
    removeDir(tempDir);
  }
});

test('captureWorktreeSnapshot captures modified and untracked files', async () => {
  if (!gitAvailable()) {
    console.log('  [SKIP] captureWorktreeSnapshot captures modified and untracked files (git unavailable)');
    return;
  }

  const tempDir = makeTempDir();

  try {
    runGit(tempDir, ['init']);
    runGit(tempDir, ['config', 'user.email', 'loopi@example.com']);
    runGit(tempDir, ['config', 'user.name', 'Loopi Test']);
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# temp\n', 'utf8');
    runGit(tempDir, ['add', 'README.md']);
    runGit(tempDir, ['commit', '-m', 'init']);

    fs.writeFileSync(path.join(tempDir, 'README.md'), '# temp\nmore\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'notes.txt'), 'draft\n', 'utf8');

    const snapshot = captureWorktreeSnapshot({
      projectRoot: tempDir,
      scope: 'post-step',
      step: {
        id: 'implement-2',
        stage: 'implement',
        agent: 'codex',
        canWrite: true
      }
    });

    assert.strictEqual(snapshot.gitAvailable, true);
    assert.strictEqual(snapshot.stepId, 'implement-2');
    assert.strictEqual(snapshot.stage, 'implement');
    assert.strictEqual(snapshot.agent, 'codex');
    assert.strictEqual(snapshot.canWrite, true);
    assert.strictEqual(snapshot.dirty, true);
    assert.ok(snapshot.statusPorcelain.some((line) => line.includes('README.md')));
    assert.ok(snapshot.untrackedFiles.includes('notes.txt'));
    assert.ok(snapshot.changedFiles.some((item) => item.path === 'README.md'));
    assert.ok(snapshot.changedFiles.some((item) => item.status === '??' && item.path === 'notes.txt'));
    assert.ok(snapshot.patchText.includes('README.md'));
    assert.ok(snapshot.patchText.includes('notes.txt'));
    assert.ok(snapshot.patchText.includes('+draft'));
    assert.strictEqual(snapshot.stagedPatchText, '');
  } finally {
    removeDir(tempDir);
  }
});

test('captureWorktreeSnapshot pre-step omits patch text by default', async () => {
  if (!gitAvailable()) {
    console.log('  [SKIP] captureWorktreeSnapshot pre-step omits patch text by default (git unavailable)');
    return;
  }

  const tempDir = makeTempDir();

  try {
    runGit(tempDir, ['init']);
    runGit(tempDir, ['config', 'user.email', 'loopi@example.com']);
    runGit(tempDir, ['config', 'user.name', 'Loopi Test']);
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# temp\n', 'utf8');
    runGit(tempDir, ['add', 'README.md']);
    runGit(tempDir, ['commit', '-m', 'init']);

    fs.writeFileSync(path.join(tempDir, 'README.md'), '# temp\nmore\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'notes.txt'), 'draft\n', 'utf8');

    const snapshot = captureWorktreeSnapshot({
      projectRoot: tempDir,
      scope: 'pre-step',
      step: {
        id: 'implement-1',
        stage: 'implement',
        agent: 'codex',
        canWrite: true
      }
    });

    assert.strictEqual(snapshot.gitAvailable, true);
    assert.strictEqual(snapshot.dirty, true);
    assert.ok(snapshot.statusPorcelain.some((line) => line.includes('README.md')));
    assert.ok(snapshot.changedFiles.some((item) => item.path === 'README.md'));
    assert.strictEqual(snapshot.patchText, '');
    assert.strictEqual(snapshot.stagedPatchText, '');
  } finally {
    removeDir(tempDir);
  }
});

setTimeout(() => {
  if (!process.exitCode) {
    console.log('\nworktree-audit tests passed');
  }
}, 150);
