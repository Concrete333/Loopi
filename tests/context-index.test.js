const assert = require('assert');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');
const {
  buildContextIndex,
  prepareContextIndex,
  getPreparedContextStatus,
  validatePreparedContextReadiness,
  PreparedContextError
} = require('../src/context-index');

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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmp-context-'));

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

      await prepareContextIndex(contextConfig, tmpDir);
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

      await prepareContextIndex(contextConfig, tmpDir);
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

      await prepareContextIndex(contextConfig, tmpDir);
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

      await prepareContextIndex(contextConfig, tmpDir);
      const index = await buildContextIndex(contextConfig, tmpDir);
      const fileNames = index.files.map(f => f.relativePath);

      // All files should end with .md
      for (const name of fileNames) {
        assert.ok(name.endsWith('.md'), `${name} does not end with .md`);
      }
    });

    await test('node_modules and .git are excluded from the cache scan', async () => {
      const contextConfig = {
        dir: '.',  // Use relative path from task root
        include: ['**/*'],
        exclude: []
      };

      await prepareContextIndex(contextConfig, tmpDir);
      const index = await buildContextIndex(contextConfig, tmpDir);
      const fileNames = index.files.map(f => f.relativePath);

      // node_modules and .git are excluded by the cache walker
      assert.ok(!fileNames.some(f => f.includes('node_modules')),
        'node_modules files should not appear in cache-built index');
      assert.ok(!fileNames.some(f => f.includes('.git')),
        '.git files should not appear in cache-built index');
    });

    await test('Large text files are chunked via the cache pipeline', async () => {
      // Create a large file
      const largeFile = path.join(tmpDir, 'shared', 'large.md');
      const largeContent = 'x'.repeat(300 * 1024); // 300KB
      await fs.writeFile(largeFile, largeContent);

      const contextConfig = {
        dir: '.',  // Use relative path from task root
        include: ['**/*.md'],
        exclude: []
      };

      await prepareContextIndex(contextConfig, tmpDir);
      const index = await buildContextIndex(contextConfig, tmpDir);
      // With the cache pipeline, a large text file is normalized and chunked
      const largeFileEntries = index.files.filter(f => f.sourceRelativePath === 'shared/large.md');

      assert.ok(largeFileEntries.length > 0, 'Should have at least one entry for the large file');
      // The file should be split into multiple chunks
      assert.ok(largeFileEntries.length > 1, `Expected multiple chunks, got ${largeFileEntries.length}`);
      assert.strictEqual(new Set(largeFileEntries.map(f => f.relativePath)).size, largeFileEntries.length);
      for (const entry of largeFileEntries) {
        assert.strictEqual(entry.skipped, false);
        assert.strictEqual(entry.isChunk, true);
        assert.strictEqual(entry.displayPath, 'shared/large.md');
        assert.strictEqual(entry.content, null);
        assert.strictEqual(entry.deferredContent, true);
        assert.ok(entry.relativePath.startsWith('shared/large.md#chunk-'));
      }

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

      await prepareContextIndex(contextConfig, tmpDir);
      const index = await buildContextIndex(contextConfig, tmpDir);
      const guidelinesEntry = index.files.find(f => f.relativePath === 'shared/guidelines.md');

      assert.ok(guidelinesEntry);
      assert.strictEqual(guidelinesEntry.priority, 5);
      assert.strictEqual(guidelinesEntry.phase, 'shared');
    });

    await test('Default context.json is not exposed as promptable context', async () => {
      const contextConfig = {
        dir: '.',
        include: ['**/*'],
        exclude: []
      };

      await prepareContextIndex(contextConfig, tmpDir);
      const index = await buildContextIndex(contextConfig, tmpDir);
      const fileNames = index.files.map(f => f.relativePath);

      assert.ok(!fileNames.includes('context.json'));
      assert.ok(fileNames.includes('shared/guidelines.md'));
    });

    await test('Configured manifest inside the context root is excluded from promptable context', async () => {
      await fs.mkdir(path.join(tmpDir, 'meta'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'meta', 'overrides.json'),
        JSON.stringify({ 'plan/approach.md': { priority: 11 } }, null, 2)
      );

      const contextConfig = {
        dir: '.',
        include: ['**/*'],
        exclude: [],
        manifest: 'meta/overrides.json'
      };

      await prepareContextIndex(contextConfig, tmpDir);
      const index = await buildContextIndex(contextConfig, tmpDir);
      const fileNames = index.files.map(f => f.relativePath);
      const approachEntry = index.files.find(f => f.relativePath === 'plan/approach.md');

      assert.ok(!fileNames.includes('meta/overrides.json'));
      assert.ok(approachEntry);
      assert.strictEqual(approachEntry.priority, 11);
    });

    await test('Continues safely when manifest file is absent', async () => {
      const contextConfig = {
        dir: '.',  // Use relative path from task root
        include: ['**/*.md'],
        exclude: [],
        manifest: 'nonexistent-manifest.json'
      };

      await prepareContextIndex(contextConfig, tmpDir);
      const index = await buildContextIndex(contextConfig, tmpDir);
      assert.ok(index.files.length > 0);
    });

    await test('Throws a clear error when the prepared context cache has not been built yet', async () => {
      const freshDir = await createTempContext();
      try {
        const contextConfig = {
          dir: '.',
          include: ['**/*.md'],
          exclude: []
        };

        try {
          await buildContextIndex(contextConfig, freshDir);
          assert.fail('Should have thrown an error');
        } catch (error) {
          assert.ok(error.message.includes('Prepared context cache is not ready'));
          assert.ok(error.message.includes('npm run cli -- context prepare'));
        }
      } finally {
        await cleanupTempDir(freshDir);
      }
    });

    await test('Throws a clear error when the prepared cache no longer matches the current context config', async () => {
      const preparedConfig = {
        dir: '.',
        include: ['**/*.md'],
        exclude: []
      };
      await prepareContextIndex(preparedConfig, tmpDir);

      try {
        await buildContextIndex({
          dir: '.',
          include: ['**/*.json'],
          exclude: []
        }, tmpDir);
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.ok(error.message.includes('Prepared context cache is not ready'));
        assert.ok(error.message.includes('npm run cli -- context prepare'));
      }
    });

    await test('Reports ready status for a prepared cache with no drift', async () => {
      const contextConfig = {
        dir: '.',
        include: ['**/*.md'],
        exclude: []
      };

      await prepareContextIndex(contextConfig, tmpDir);
      const status = await getPreparedContextStatus(contextConfig, tmpDir);

      assert.strictEqual(status.status, 'ready');
      assert.strictEqual(status.state, 'ready');
      assert.ok(status.builtAt);
      assert.strictEqual(status.driftedSources.length, 0);
      assert.strictEqual(status.mismatches.length, 0);
    });

    await test('Reports exclude-pattern drift structurally', async () => {
      const preparedConfig = {
        dir: '.',
        include: ['**/*.md'],
        exclude: []
      };
      await prepareContextIndex(preparedConfig, tmpDir);

      const status = await getPreparedContextStatus({
        dir: '.',
        include: ['**/*.md'],
        exclude: ['**/examples/**']
      }, tmpDir);

      assert.strictEqual(status.status, 'config-mismatch');
      assert.ok(status.mismatches.some((m) => m.field === 'exclude'));
      assert.ok(status.instructions.includes('npm run cli -- context prepare'));
    });

    await test('Reports manifest-path drift structurally', async () => {
      await fs.mkdir(path.join(tmpDir, 'meta'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'meta', 'overrides.json'),
        JSON.stringify({ 'plan/approach.md': { priority: 11 } }, null, 2)
      );

      const preparedConfig = {
        dir: '.',
        include: ['**/*.md'],
        exclude: [],
        manifest: 'context.json'
      };
      await prepareContextIndex(preparedConfig, tmpDir);

      const status = await getPreparedContextStatus({
        dir: '.',
        include: ['**/*.md'],
        exclude: [],
        manifest: 'meta/overrides.json'
      }, tmpDir);

      assert.strictEqual(status.status, 'config-mismatch');
      assert.ok(status.mismatches.some((m) => m.field === 'contextManifestPath'));
    });

    await test('Reports source-tree drift when a file is added after prepare', async () => {
      const contextConfig = {
        dir: '.',
        include: ['**/*.md'],
        exclude: []
      };

      await prepareContextIndex(contextConfig, tmpDir);
      await fs.writeFile(path.join(tmpDir, 'shared', 'new-file.md'), 'New context source.', 'utf-8');

      const status = await getPreparedContextStatus(contextConfig, tmpDir);

      assert.strictEqual(status.status, 'drifted');
      assert.ok(status.driftedSources.some((entry) => entry.sourceRelativePath === 'shared/new-file.md' && entry.change === 'added'));
      assert.ok(status.instructions.includes('npm run cli -- context prepare'));
    });

    await test('Reports source-tree drift when a file is removed after prepare', async () => {
      const contextConfig = {
        dir: '.',
        include: ['**/*.md'],
        exclude: []
      };

      await prepareContextIndex(contextConfig, tmpDir);
      await fs.unlink(path.join(tmpDir, 'plan', 'approach.md'));

      const status = await getPreparedContextStatus(contextConfig, tmpDir);

      assert.strictEqual(status.status, 'drifted');
      assert.ok(status.driftedSources.some((entry) => entry.sourceRelativePath === 'plan/approach.md' && entry.change === 'removed'));
    });

    await test('Treats a prepared cache missing source-tree fingerprint metadata as stale', async () => {
      const contextConfig = {
        dir: '.',
        include: ['**/*.md'],
        exclude: []
      };

      const prepared = await prepareContextIndex(contextConfig, tmpDir);
      const manifestPath = path.join(prepared.cacheDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      delete manifest.sourceTreeFingerprint;
      delete manifest.preparedConfig.sourceTreeFingerprint;
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      const status = await getPreparedContextStatus(contextConfig, tmpDir);

      assert.strictEqual(status.status, 'config-mismatch');
      assert.ok(status.mismatches.some((m) => m.field === 'sourceTreeFingerprint'));
    });

    await test('validatePreparedContextReadiness throws PreparedContextError for drifted caches', async () => {
      const contextConfig = {
        dir: '.',
        include: ['**/*.md'],
        exclude: []
      };

      await prepareContextIndex(contextConfig, tmpDir);
      await fs.writeFile(path.join(tmpDir, 'shared', 'late-addition.md'), 'Late addition.', 'utf-8');

      try {
        await validatePreparedContextReadiness(contextConfig, tmpDir);
        assert.fail('Should have thrown PreparedContextError');
      } catch (error) {
        assert.ok(error instanceof PreparedContextError);
        assert.strictEqual(error.code, 'CONTEXT_CACHE_DRIFT');
        assert.ok(Array.isArray(error.mismatches));
        assert.ok(error.mismatches.some((m) => m.field === 'shared/late-addition.md'));
      }
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

    await test('prepareContextIndex throws PreparedContextError with structured details when the context directory is invalid', async () => {
      const contextConfig = {
        dir: './nonexistent',
        include: ['**/*.md'],
        exclude: []
      };

      try {
        await prepareContextIndex(contextConfig, tmpDir);
        assert.fail('Should have thrown PreparedContextError');
      } catch (error) {
        assert.ok(error instanceof PreparedContextError);
        assert.strictEqual(error.code, 'CONTEXT_MISSING_DIR');
        assert.ok(error.contextDir);
        assert.ok(error.message.includes('does not exist'));
        assert.ok(error.statusInfo);
        assert.strictEqual(error.statusInfo.status, 'missing');
        assert.strictEqual(error.statusInfo.cacheDir, null);
        assert.strictEqual(error.statusInfo.contextDir, error.contextDir);
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
