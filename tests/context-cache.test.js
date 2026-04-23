const assert = require('assert');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');
const { ensureContextCache, CACHE_DIR_NAME, MANIFEST_FILE, MANIFEST_SCHEMA_VERSION } = require('../src/context-cache');

let passed = 0;
let failed = 0;

function hasOptionalModule(name) {
  try {
    require.resolve(name);
    return true;
  } catch (_error) {
    return false;
  }
}

const HAS_ADM_ZIP = hasOptionalModule('adm-zip');

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

async function createTempDir(prefix = 'tmp-cache-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function cleanupTempDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    // Ignore cleanup errors
  }
}

console.log('context-cache: ensureContextCache');

(async () => {
  let tmpDir = null;

  try {
    await test('Initial cache build creates .loopi-context/manifest.json', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.md'), 'Some notes here.', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };
      const manifest = await ensureContextCache(contextConfig, tmpDir);

      assert.ok(manifest);
      assert.strictEqual(manifest.version, MANIFEST_SCHEMA_VERSION);
      assert.ok(manifest.builtAt);
      assert.deepStrictEqual(manifest.preparedConfig.include, ['**/*.md']);
      assert.deepStrictEqual(manifest.preparedConfig.exclude, []);
      assert.ok(typeof manifest.sourceTreeFingerprint === 'string' && manifest.sourceTreeFingerprint.length > 0);
      assert.strictEqual(manifest.preparedConfig.sourceTreeFingerprint, manifest.sourceTreeFingerprint);
      assert.ok(Array.isArray(manifest.sources));
      assert.ok(manifest.sources.length > 0);

      // Verify manifest file exists on disk
      const manifestPath = path.join(tmpDir, CACHE_DIR_NAME, MANIFEST_FILE);
      const stat = await fs.stat(manifestPath);
      assert.ok(stat.isFile());

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Normalized chunk files are written under .loopi-context/normalized/', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'plan'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'plan', 'approach.md'), 'Plan approach content.', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };
      const manifest = await ensureContextCache(contextConfig, tmpDir);

      const nonSkipped = manifest.sources.filter(s => !s.skipped);
      assert.ok(nonSkipped.length > 0);

      for (const source of nonSkipped) {
        for (const output of source.outputs) {
          const outputPath = path.join(tmpDir, CACHE_DIR_NAME, output.cacheRelativePath);
          const stat = await fs.stat(outputPath);
          assert.ok(stat.isFile());
          assert.ok(output.cacheRelativePath.startsWith('normalized/'));
        }
      }

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Files with the same basename but different extensions keep distinct cache outputs', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.md'), '# Markdown notes', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.txt'), 'Plain text notes', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*'], exclude: [] };
      const manifest = await ensureContextCache(contextConfig, tmpDir);

      const markdownEntry = manifest.sources.find(s => s.sourceRelativePath === 'shared/notes.md');
      const textEntry = manifest.sources.find(s => s.sourceRelativePath === 'shared/notes.txt');

      assert.ok(markdownEntry);
      assert.ok(textEntry);
      assert.strictEqual(markdownEntry.outputs.length, 1);
      assert.strictEqual(textEntry.outputs.length, 1);
      assert.notStrictEqual(
        markdownEntry.outputs[0].cacheRelativePath,
        textEntry.outputs[0].cacheRelativePath
      );

      const markdownChunk = await fs.readFile(
        path.join(tmpDir, CACHE_DIR_NAME, markdownEntry.outputs[0].cacheRelativePath),
        'utf-8'
      );
      const textChunk = await fs.readFile(
        path.join(tmpDir, CACHE_DIR_NAME, textEntry.outputs[0].cacheRelativePath),
        'utf-8'
      );
      assert.strictEqual(markdownChunk, '# Markdown notes');
      assert.strictEqual(textChunk, 'Plain text notes');

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Unchanged sources are reused on a second build', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.md'), 'Persistent notes.', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };

      // First build
      const manifest1 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest1.stats.rebuilt, 1);
      assert.strictEqual(manifest1.stats.reused, 0);

      // Second build - should reuse
      const manifest2 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest2.stats.reused, 1);
      assert.strictEqual(manifest2.stats.rebuilt, 0);

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('One changed source is rebuilt without rebuilding every source', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'plan'), { recursive: true });

      const sharedPath = path.join(tmpDir, 'shared', 'notes.md');
      const planPath = path.join(tmpDir, 'plan', 'approach.md');
      await fs.writeFile(sharedPath, 'Shared notes.', 'utf-8');
      await fs.writeFile(planPath, 'Plan approach.', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };

      // First build
      const manifest1 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest1.stats.rebuilt, 2);

      // Modify one file
      await fs.writeFile(planPath, 'Updated plan approach.', 'utf-8');

      // Second build
      const manifest2 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest2.stats.rebuilt, 1);
      assert.strictEqual(manifest2.stats.reused, 1);

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('.loopi-context/ is excluded from raw source scanning', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.md'), 'Some notes.', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*'], exclude: [] };

      // Build once to create .loopi-context/
      const manifest1 = await ensureContextCache(contextConfig, tmpDir);

      // Build again - should not treat .loopi-context/ files as source files
      const manifest2 = await ensureContextCache(contextConfig, tmpDir);

      // Only the original source file should appear in the manifest
      const allSourcePaths = manifest2.sources.map(s => s.sourceRelativePath);
      for (const p of allSourcePaths) {
        assert.ok(!p.includes(CACHE_DIR_NAME), `Found cache path in sources: ${p}`);
      }

      // Should have exactly one non-manifest source
      const mdSources = manifest2.sources.filter(s => s.sourceRelativePath === 'shared/notes.md');
      assert.strictEqual(mdSources.length, 1);

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Manifest phase, priority, and purpose are inherited into cache entries', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'plan'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.md'), 'Notes content.', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'plan', 'approach.md'), 'Plan content.', 'utf-8');

      // Create context.json manifest with overrides
      const contextManifest = {
        'shared/notes.md': { phase: 'shared', priority: 10, purpose: 'reference' },
        'plan/approach.md': { priority: 5 }
      };
      await fs.writeFile(path.join(tmpDir, 'context.json'), JSON.stringify(contextManifest, null, 2), 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };
      const manifest = await ensureContextCache(contextConfig, tmpDir);

      const sharedEntry = manifest.sources.find(s => s.sourceRelativePath === 'shared/notes.md');
      assert.ok(sharedEntry);
      assert.strictEqual(sharedEntry.priority, 10);
      assert.strictEqual(sharedEntry.purpose, 'reference');

      const planEntry = manifest.sources.find(s => s.sourceRelativePath === 'plan/approach.md');
      assert.ok(planEntry);
      assert.strictEqual(planEntry.priority, 5);

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Changing the manifest invalidates cache reuse and refreshes entry metadata', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.md'), 'Notes content.', 'utf-8');
      await fs.writeFile(
        path.join(tmpDir, 'context.json'),
        JSON.stringify({ 'shared/notes.md': { priority: 1 } }, null, 2),
        'utf-8'
      );

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };

      const manifest1 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest1.stats.rebuilt, 1);
      assert.strictEqual(manifest1.stats.reused, 0);
      assert.strictEqual(manifest1.sources[0].priority, 1);

      const manifest2 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest2.stats.rebuilt, 0);
      assert.strictEqual(manifest2.stats.reused, 1);
      assert.strictEqual(manifest2.sources[0].priority, 1);

      await fs.writeFile(
        path.join(tmpDir, 'context.json'),
        JSON.stringify({ 'shared/notes.md': { priority: 9 } }, null, 2),
        'utf-8'
      );

      const manifest3 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest3.stats.rebuilt, 1);
      assert.strictEqual(manifest3.stats.reused, 0);
      assert.strictEqual(manifest3.sources[0].priority, 9);

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Removing a phase override reverts the cache entry to the inferred phase', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.md'), 'Stable notes.', 'utf-8');
      await fs.writeFile(
        path.join(tmpDir, 'context.json'),
        JSON.stringify({ 'shared/notes.md': { phase: 'plan', priority: 4 } }, null, 2),
        'utf-8'
      );

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };

      const manifest1 = await ensureContextCache(contextConfig, tmpDir);
      const entry1 = manifest1.sources.find((s) => s.sourceRelativePath === 'shared/notes.md');
      assert.ok(entry1);
      assert.strictEqual(entry1.phase, 'plan');
      assert.strictEqual(entry1.priority, 4);

      await fs.writeFile(path.join(tmpDir, 'context.json'), JSON.stringify({}, null, 2), 'utf-8');

      const manifest2 = await ensureContextCache(contextConfig, tmpDir);
      const entry2 = manifest2.sources.find((s) => s.sourceRelativePath === 'shared/notes.md');
      assert.ok(entry2);
      assert.strictEqual(entry2.phase, 'shared');
      assert.strictEqual(entry2.priority, 0);
      assert.strictEqual(manifest2.stats.rebuilt, 1);
      assert.strictEqual(manifest2.stats.reused, 0);

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Configured manifest path is respected and excluded from cache sources', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'meta'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.md'), 'Notes content.', 'utf-8');
      await fs.writeFile(
        path.join(tmpDir, 'meta', 'overrides.json'),
        JSON.stringify({ 'shared/notes.md': { priority: 7, purpose: 'reference' } }, null, 2),
        'utf-8'
      );

      const contextConfig = {
        dir: '.',
        include: ['**/*'],
        exclude: [],
        manifest: './meta/overrides.json'
      };
      const manifest = await ensureContextCache(contextConfig, tmpDir);

      assert.strictEqual(manifest.contextManifestPath, 'meta/overrides.json');
      assert.ok(!manifest.sources.some(s => s.sourceRelativePath === 'meta/overrides.json'));

      const sharedEntry = manifest.sources.find(s => s.sourceRelativePath === 'shared/notes.md');
      assert.ok(sharedEntry);
      assert.strictEqual(sharedEntry.priority, 7);
      assert.strictEqual(sharedEntry.purpose, 'reference');

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Cache build handles docx files correctly', async () => {
      if (!HAS_ADM_ZIP) {
        console.log('  [SKIP] Cache build handles docx files correctly (adm-zip not installed)');
        return;
      }

      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });

      // Create a minimal docx
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      const docXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body>',
        '<w:p><w:r><w:t>Document content here.</w:t></w:r></w:p>',
        '</w:body>',
        '</w:document>'
      ].join('');
      zip.addFile('word/document.xml', Buffer.from(docXml, 'utf-8'));
      zip.writeZip(path.join(tmpDir, 'shared', 'report.docx'));

      const contextConfig = { dir: '.', include: ['**/*.docx'], exclude: [] };
      const manifest = await ensureContextCache(contextConfig, tmpDir);

      const docxEntry = manifest.sources.find(s => s.sourceRelativePath === 'shared/report.docx');
      assert.ok(docxEntry);
      assert.strictEqual(docxEntry.skipped, false);
      assert.strictEqual(docxEntry.extractor, 'docx');
      assert.ok(docxEntry.outputs.length >= 1);

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Cache build handles ipynb files correctly', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });

      const notebook = {
        cells: [
          { cell_type: 'markdown', source: ['# Analysis\n', 'Data exploration.'] },
          { cell_type: 'code', source: ['import pandas as pd'] }
        ],
        metadata: {}
      };
      await fs.writeFile(path.join(tmpDir, 'shared', 'analysis.ipynb'), JSON.stringify(notebook), 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*.ipynb'], exclude: [] };
      const manifest = await ensureContextCache(contextConfig, tmpDir);

      const nbEntry = manifest.sources.find(s => s.sourceRelativePath === 'shared/analysis.ipynb');
      assert.ok(nbEntry);
      assert.strictEqual(nbEntry.skipped, false);
      assert.strictEqual(nbEntry.extractor, 'ipynb');
      assert.ok(nbEntry.outputs.length >= 1);

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Skipped source does not crash the cache build', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.md'), 'Valid notes.', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'shared', 'slides.pptx'), 'fake pptx', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*'], exclude: [] };
      const manifest = await ensureContextCache(contextConfig, tmpDir);

      const pptxEntry = manifest.sources.find(s => s.sourceRelativePath === 'shared/slides.pptx');
      assert.ok(pptxEntry);
      assert.strictEqual(pptxEntry.skipped, true);
      assert.ok(pptxEntry.skipReason);

      const mdEntry = manifest.sources.find(s => s.sourceRelativePath === 'shared/notes.md');
      assert.ok(mdEntry);
      assert.strictEqual(mdEntry.skipped, false);

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Stable skipped sources are reused on subsequent builds', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'slides.pptx'), 'fake pptx', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*'], exclude: [] };

      const manifest1 = await ensureContextCache(contextConfig, tmpDir);
      const entry1 = manifest1.sources.find((s) => s.sourceRelativePath === 'shared/slides.pptx');
      assert.ok(entry1);
      assert.strictEqual(entry1.skipped, true);
      assert.ok(entry1.sourceHash);

      const manifest2 = await ensureContextCache(contextConfig, tmpDir);
      const entry2 = manifest2.sources.find((s) => s.sourceRelativePath === 'shared/slides.pptx');
      assert.ok(entry2);
      assert.strictEqual(entry2.skipped, true);
      assert.strictEqual(manifest2.stats.reused, 1);
      assert.strictEqual(manifest2.stats.rebuilt, 0);

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Malformed context manifest warns clearly and falls back to defaults', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.md'), 'Notes content.', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'context.json'), '{ invalid json', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (message) => warnings.push(String(message));

      try {
        const manifest = await ensureContextCache(contextConfig, tmpDir);
        const entry = manifest.sources.find((s) => s.sourceRelativePath === 'shared/notes.md');
        assert.ok(entry);
        assert.strictEqual(entry.phase, 'shared');
        assert.strictEqual(entry.priority, 0);
      } finally {
        console.warn = originalWarn;
      }

      assert.ok(
        warnings.some((message) => message.includes('Failed to load context manifest at')),
        'Expected a warning about the malformed context manifest'
      );

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Manifest with a mismatched schema version forces a full rebuild', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'notes.md'), 'Version gate content.', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };
      const manifest1 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest1.version, MANIFEST_SCHEMA_VERSION);

      // Corrupt the version tag on disk and verify the next build throws away
      // the old manifest and rebuilds from scratch.
      const manifestPath = path.join(tmpDir, CACHE_DIR_NAME, MANIFEST_FILE);
      const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      raw.version = 999;
      await fs.writeFile(manifestPath, JSON.stringify(raw, null, 2), 'utf-8');

      const manifest2 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest2.stats.rebuilt, 1);
      assert.strictEqual(manifest2.stats.reused, 0);

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Manifest edit reuses chunk files but refreshes metadata', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      const contentPath = path.join(tmpDir, 'shared', 'notes.md');
      await fs.writeFile(contentPath, 'Stable content that should survive metadata edits.', 'utf-8');
      await fs.writeFile(
        path.join(tmpDir, 'context.json'),
        JSON.stringify({ 'shared/notes.md': { priority: 1 } }),
        'utf-8'
      );

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };
      const manifest1 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest1.sources[0].priority, 1);

      const initialChunkPath = path.join(
        tmpDir,
        CACHE_DIR_NAME,
        manifest1.sources[0].outputs[0].cacheRelativePath
      );
      const initialMtime = (await fs.stat(initialChunkPath)).mtimeMs;

      // Wait a hair to guarantee observable mtime drift if the chunk is rewritten.
      await new Promise((resolve) => setTimeout(resolve, 20));

      await fs.writeFile(
        path.join(tmpDir, 'context.json'),
        JSON.stringify({ 'shared/notes.md': { priority: 9, purpose: 'updated' } }),
        'utf-8'
      );

      const manifest2 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest2.sources[0].priority, 9);
      assert.strictEqual(manifest2.sources[0].purpose, 'updated');

      const finalMtime = (await fs.stat(initialChunkPath)).mtimeMs;
      assert.strictEqual(
        finalMtime,
        initialMtime,
        'Chunk file should be reused when only manifest metadata changes'
      );

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Orphaned chunks are pruned when a source disappears', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      const aPath = path.join(tmpDir, 'shared', 'a.md');
      const bPath = path.join(tmpDir, 'shared', 'b.md');
      await fs.writeFile(aPath, 'File A content.', 'utf-8');
      await fs.writeFile(bPath, 'File B content.', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };
      const manifest1 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest1.sources.length, 2);

      const bChunkPath = path.join(
        tmpDir,
        CACHE_DIR_NAME,
        manifest1.sources.find((s) => s.sourceRelativePath === 'shared/b.md').outputs[0].cacheRelativePath
      );

      // Delete the source and rebuild — the chunk should be pruned.
      await fs.unlink(bPath);
      const manifest2 = await ensureContextCache(contextConfig, tmpDir);
      assert.strictEqual(manifest2.sources.length, 1);

      let stillExists = true;
      try {
        await fs.access(bChunkPath);
      } catch (_) {
        stillExists = false;
      }
      assert.strictEqual(stillExists, false, 'Orphaned chunk should be pruned');

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Empty passthrough source is cached as skipped with a clear reason', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'shared', 'empty.md'), '   \n\n', 'utf-8');

      const contextConfig = { dir: '.', include: ['**/*.md'], exclude: [] };
      const manifest = await ensureContextCache(contextConfig, tmpDir);
      const entry = manifest.sources.find((s) => s.sourceRelativePath === 'shared/empty.md');
      assert.ok(entry);
      assert.strictEqual(entry.skipped, true);
      assert.ok(entry.skipReason && entry.skipReason.toLowerCase().includes('no readable text'));

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
  } finally {
    if (tmpDir) {
      await cleanupTempDir(tmpDir);
    }
  }

  process.exitCode = failed > 0 ? 1 : 0;
})();
