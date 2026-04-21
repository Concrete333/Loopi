const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const { buildContextIndex } = require('../src/context-index');

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

// Helper to create a temp directory with files
async function createTempContext() {
  const tmpDir = path.join(__dirname, 'tmp-context-' + Date.now());

  // Create directory structure
  await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'plan'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'implement'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'review'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'examples'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'rubric'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'schema'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });

  // Create test files
  await fs.writeFile(path.join(tmpDir, 'shared', 'guidelines.md'), 'This is shared guidelines.');
  await fs.writeFile(path.join(tmpDir, 'plan', 'approach.md'), 'This is the plan approach.');
  await fs.writeFile(path.join(tmpDir, 'implement', 'steps.md'), 'Implementation steps.');
  await fs.writeFile(path.join(tmpDir, 'review', 'rubric.md'), 'Review criteria.');
  await fs.writeFile(path.join(tmpDir, 'examples', 'sample.md'), 'Sample content.');
  await fs.writeFile(path.join(tmpDir, 'rubric', 'detailed.md'), 'Detailed rubric.');
  await fs.writeFile(path.join(tmpDir, 'schema', 'schema.json'), '{"type": "object"}');
  await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'console.log("test");');
  await fs.writeFile(path.join(tmpDir, '.git', 'config'), '[core]\nrepositoryformatversion = 0');

  // Create a manifest file
  const manifest = {
    'shared/guidelines.md': { phase: 'shared', priority: 5 },
    'plan/approach.md': { priority: 3 }
  };
  await fs.writeFile(path.join(tmpDir, 'context.json'), JSON.stringify(manifest, null, 2));

  return tmpDir;
}

// Helper to clean up temp directory
async function cleanupTempDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
}

console.log('context-index: buildContextIndex');

(async () => {
  let tmpDir = null;

  try {
    tmpDir = await createTempContext();

    await test('Scans a simple folder and returns correct file entries', async () => {
      const contextConfig = {
        dir: '.',  // Use relative path from task root
        include: ['**/*.md', '**/*.json'],
        exclude: []
      };

      const index = await buildContextIndex(contextConfig, tmpDir);
      assert.ok(index.rootDir);
      assert.ok(Array.isArray(index.files));
      assert.ok(index.builtAt);

      // Should have md and json files, excluding node_modules and .git
      const fileNames = index.files.map(f => f.relativePath);
      assert.ok(fileNames.includes('shared/guidelines.md'));
      assert.ok(fileNames.includes('plan/approach.md'));
      assert.ok(fileNames.includes('schema/schema.json'));
      // Should not include files in excluded directories
      assert.ok(!fileNames.includes('node_modules/pkg/index.js'));
    });

    await test('Infers phase correctly from subfolder names (plan/, review/, schema/, etc.)', async () => {
      const contextConfig = {
        dir: '.',  // Use relative path from task root
        include: ['**/*.md', '**/*.json'],
        exclude: []
      };

      const index = await buildContextIndex(contextConfig, tmpDir);
      const fileMap = Object.fromEntries(index.files.map(f => [f.relativePath, f.phase]));

      assert.strictEqual(fileMap['shared/guidelines.md'], 'shared');
      assert.strictEqual(fileMap['plan/approach.md'], 'plan');
      assert.strictEqual(fileMap['implement/steps.md'], 'implement');
      assert.strictEqual(fileMap['review/rubric.md'], 'review');
      assert.strictEqual(fileMap['examples/sample.md'], 'examples');
      assert.strictEqual(fileMap['rubric/detailed.md'], 'review'); // rubric -> review
      assert.strictEqual(fileMap['schema/schema.json'], 'implement'); // schema -> implement
    });

    await test('Skips files matching exclude patterns', async () => {
      const contextConfig = {
        dir: '.',  // Use relative path from task root
        include: ['**/*'],
        exclude: ['**/node_modules/**', '**/.git/**']
      };

      const index = await buildContextIndex(contextConfig, tmpDir);
      const fileNames = index.files.map(f => f.relativePath);

      assert.ok(!fileNames.some(f => f.includes('node_modules')));
      assert.ok(!fileNames.some(f => f.includes('.git')));
    });

    await test('Only includes files matching include patterns', async () => {
      const contextConfig = {
        dir: '.',  // Use relative path from task root
        include: ['**/*.md'],
        exclude: []
      };

      const index = await buildContextIndex(contextConfig, tmpDir);
      const fileNames = index.files.map(f => f.relativePath);

      // All files should end with .md
      for (const name of fileNames) {
        assert.ok(name.endsWith('.md'), `${name} does not end with .md`);
      }
    });

    await test('Source-code files matched by broad include patterns are still skipped by the text-file heuristic', async () => {
      const contextConfig = {
        dir: '.',  // Use relative path from task root
        include: ['**/*'],
        exclude: []
      };

      const index = await buildContextIndex(contextConfig, tmpDir);
      const sourceEntry = index.files.find(f => f.relativePath === 'node_modules/pkg/index.js');

      assert.ok(sourceEntry);
      assert.strictEqual(sourceEntry.skipped, true);
      assert.strictEqual(sourceEntry.skipReason, 'Likely binary file');
      assert.strictEqual(sourceEntry.content, null);
    });

    await test('Large files are recorded as skipped with metadata', async () => {
      // Create a large file
      const largeFile = path.join(tmpDir, 'shared', 'large.md');
      const largeContent = 'x'.repeat(300 * 1024); // 300KB
      await fs.writeFile(largeFile, largeContent);

      const contextConfig = {
        dir: '.',  // Use relative path from task root
        include: ['**/*.md'],
        exclude: []
      };

      const index = await buildContextIndex(contextConfig, tmpDir);
      const largeFileEntry = index.files.find(f => f.relativePath === 'shared/large.md');

      assert.ok(largeFileEntry);
      assert.strictEqual(largeFileEntry.skipped, true);
      assert.ok(largeFileEntry.skipReason.includes('too large'));
      assert.strictEqual(largeFileEntry.content, null);

      // Clean up
      await fs.unlink(largeFile);
    });

    await test('Loads and merges manifest annotations when manifest file is present', async () => {
      const contextConfig = {
        dir: '.',  // Use relative path from task root
        include: ['**/*.md'],
        exclude: [],
        manifest: 'context.json'
      };

      const index = await buildContextIndex(contextConfig, tmpDir);
      const guidelinesEntry = index.files.find(f => f.relativePath === 'shared/guidelines.md');

      assert.ok(guidelinesEntry);
      assert.strictEqual(guidelinesEntry.priority, 5);
      assert.strictEqual(guidelinesEntry.phase, 'shared');
    });

    await test('Continues safely when manifest file is absent', async () => {
      const contextConfig = {
        dir: '.',  // Use relative path from task root
        include: ['**/*.md'],
        exclude: [],
        manifest: 'nonexistent-manifest.json'
      };

      const index = await buildContextIndex(contextConfig, tmpDir);
      assert.ok(index.files.length > 0);
    });

    await test('Throws a clear error when the context directory does not exist', async () => {
      const contextConfig = {
        dir: './nonexistent',  // Use relative path from task root
        include: ['**/*.md'],
        exclude: []
      };

      try {
        await buildContextIndex(contextConfig, tmpDir);
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.ok(error.message.includes('does not exist'));
      }
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
  } finally {
    if (tmpDir) {
      await cleanupTempDir(tmpDir);
    }
  }

  process.exitCode = failed > 0 ? 1 : 0;
})();
