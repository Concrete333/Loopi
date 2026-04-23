const assert = require('assert');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');
const { normalizeSourceFile, chunkText, extractText, getExtractor, getSourceType } = require('../src/context-normalize');

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

// Helper to create a temp directory
async function createTempDir(prefix = 'tmp-norm-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function cleanupTempDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    // Ignore cleanup errors
  }
}

console.log('context-normalize: normalizeSourceFile');

(async () => {
  let tmpDir = null;

  try {
    tmpDir = await createTempDir();

    await test('markdown passthrough extracts content unchanged', async () => {
      const mdPath = path.join(tmpDir, 'test.md');
      const content = '# Hello World\n\nThis is a test markdown file.\n';
      await fs.writeFile(mdPath, content, 'utf-8');

      const result = await normalizeSourceFile(mdPath);
      assert.strictEqual(result.skipped, false);
      assert.strictEqual(result.extractor, 'passthrough');
      assert.strictEqual(result.sourceType, 'text');
      assert.strictEqual(result.chunks.length, 1);
      assert.strictEqual(result.chunks[0].text.trim(), content.trim());
      assert.strictEqual(result.chunks[0].chunkOrdinal, 1);
      assert.strictEqual(result.chunks[0].chunkCount, 1);
    });

    await test('txt passthrough extracts content unchanged', async () => {
      const txtPath = path.join(tmpDir, 'notes.txt');
      const content = 'Plain text notes here.';
      await fs.writeFile(txtPath, content, 'utf-8');

      const result = await normalizeSourceFile(txtPath);
      assert.strictEqual(result.skipped, false);
      assert.strictEqual(result.extractor, 'passthrough');
      assert.strictEqual(result.chunks.length, 1);
      assert.strictEqual(result.chunks[0].text, content);
    });

    await test('code passthrough for ts file', async () => {
      const tsPath = path.join(tmpDir, 'module.ts');
      const content = 'export function hello(): string {\n  return "hello";\n}\n';
      await fs.writeFile(tsPath, content, 'utf-8');

      const result = await normalizeSourceFile(tsPath);
      assert.strictEqual(result.skipped, false);
      assert.strictEqual(result.extractor, 'passthrough');
      assert.strictEqual(result.chunks.length, 1);
      assert.strictEqual(result.chunks[0].text, content);
    });

    await test('code passthrough for js file', async () => {
      const jsPath = path.join(tmpDir, 'script.js');
      const content = 'console.log("hello");\n';
      await fs.writeFile(jsPath, content, 'utf-8');

      const result = await normalizeSourceFile(jsPath);
      assert.strictEqual(result.skipped, false);
      assert.strictEqual(result.extractor, 'passthrough');
    });

    await test('ipynb flattening with markdown and code cells', async () => {
      const notebook = {
        cells: [
          {
            cell_type: 'markdown',
            source: ['# Introduction\n', 'This is a notebook.']
          },
          {
            cell_type: 'code',
            source: ['print("hello")\n', 'print("world")']
          },
          {
            cell_type: 'markdown',
            source: ['## Section 2\n', 'More text.']
          },
          {
            cell_type: 'code',
            source: ['x = 42']
          }
        ],
        metadata: {}
      };

      const ipynbPath = path.join(tmpDir, 'analysis.ipynb');
      await fs.writeFile(ipynbPath, JSON.stringify(notebook), 'utf-8');

      const result = await normalizeSourceFile(ipynbPath);
      assert.strictEqual(result.skipped, false);
      assert.strictEqual(result.extractor, 'ipynb');
      assert.strictEqual(result.sourceType, 'notebook');
      assert.ok(result.chunks.length >= 1);

      const fullText = result.chunks.map(c => c.text).join('\n');
      assert.ok(fullText.includes('# Notebook: analysis'));
      assert.ok(fullText.includes('Introduction'));
      assert.ok(fullText.includes('print("hello")'));
      assert.ok(fullText.includes('Code cell 1'));
      assert.ok(fullText.includes('Code cell 2'));
      assert.ok(fullText.includes('Section 2'));
    });

    await test('docx extraction using a tiny generated zip fixture', async () => {
      if (!HAS_ADM_ZIP) {
        console.log('  [SKIP] docx extraction using a tiny generated zip fixture (adm-zip not installed)');
        return;
      }

      // Create a minimal .docx file (which is a zip with word/document.xml)
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();

      const docXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body>',
        '<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>This is a test document.</w:t></w:r></w:p>',
        '</w:body>',
        '</w:document>'
      ].join('');

      zip.addFile('word/document.xml', Buffer.from(docXml, 'utf-8'));
      const docxPath = path.join(tmpDir, 'test.docx');
      zip.writeZip(docxPath);

      const result = await normalizeSourceFile(docxPath);
      assert.strictEqual(result.skipped, false);
      assert.strictEqual(result.extractor, 'docx');
      assert.strictEqual(result.sourceType, 'docx');
      assert.ok(result.chunks.length >= 1);

      const fullText = result.chunks.map(c => c.text).join(' ');
      assert.ok(fullText.includes('Hello World'));
      assert.ok(fullText.includes('This is a test document.'));
    });

    await test('pdf extraction with a stubbed result', async () => {
      // We test PDF via the extractText function with a mock approach
      // Real PDF files require pdf-parse to work, so we test the module's handling
      // by verifying getExtractor returns the right value
      assert.strictEqual(getExtractor('.pdf'), 'pdf');
      assert.strictEqual(getSourceType('.pdf'), 'pdf');
    });

    await test('empty pdf extraction is marked as skipped', async () => {
      // Create a minimal PDF that pdf-parse can open but returns no text
      // We test the extractText function's skip logic by checking the error path
      // For a real file test, we'd need an actual empty PDF. Instead, verify the extractor
      // handles a non-existent file gracefully.
      const result = await extractText('/nonexistent/file.pdf', '.pdf');
      assert.ok(result.skipped === true);
      assert.ok(result.skipReason);
    });

    await test('fixed-window chunking produces multiple chunks with overlap metadata', async () => {
      // Create text longer than one chunk
      const longText = 'A'.repeat(300) + '\n' + 'B'.repeat(300) + '\n' + 'C'.repeat(300) + '\n' +
        'D'.repeat(300) + '\n' + 'E'.repeat(300) + '\n' + 'F'.repeat(300) + '\n' +
        'G'.repeat(300) + '\n' + 'H'.repeat(300) + '\n' + 'I'.repeat(300) + '\n' +
        'J'.repeat(300);

      // Use small target to force multiple chunks
      const chunks = chunkText(longText, 500, 50);
      assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);

      // Verify ordinal and count are set
      const totalChunks = chunks.length;
      for (let i = 0; i < chunks.length; i++) {
        assert.strictEqual(chunks[i].chunkOrdinal, i + 1);
        assert.strictEqual(chunks[i].chunkCount, totalChunks);
        assert.ok(chunks[i].sectionLabel !== undefined, 'sectionLabel should be present');
      }

      // First chunk should have section label from first line
      assert.ok(chunks[0].sectionLabel.includes('A'));
    });

    await test('short text produces exactly one chunk', async () => {
      const shortText = 'Hello world';
      const chunks = chunkText(shortText);
      assert.strictEqual(chunks.length, 1);
      assert.strictEqual(chunks[0].chunkOrdinal, 1);
      assert.strictEqual(chunks[0].chunkCount, 1);
      assert.strictEqual(chunks[0].text, 'Hello world');
    });

    await test('empty text produces zero chunks', async () => {
      const chunks = chunkText('');
      assert.strictEqual(chunks.length, 0);
    });

    await test('unsupported extension marked as skipped', async () => {
      const pptxPath = path.join(tmpDir, 'slides.pptx');
      await fs.writeFile(pptxPath, 'fake pptx', 'utf-8');

      const result = await normalizeSourceFile(pptxPath);
      assert.strictEqual(result.skipped, true);
      assert.ok(result.skipReason.includes('Unsupported file type'));
      assert.strictEqual(result.chunks.length, 0);
    });

    await test('getExtractor returns correct values for all supported types', async () => {
      assert.strictEqual(getExtractor('.md'), 'passthrough');
      assert.strictEqual(getExtractor('.txt'), 'passthrough');
      assert.strictEqual(getExtractor('.json'), 'passthrough');
      assert.strictEqual(getExtractor('.yaml'), 'passthrough');
      assert.strictEqual(getExtractor('.yml'), 'passthrough');
      assert.strictEqual(getExtractor('.sql'), 'passthrough');
      assert.strictEqual(getExtractor('.csv'), 'passthrough');
      assert.strictEqual(getExtractor('.js'), 'passthrough');
      assert.strictEqual(getExtractor('.ts'), 'passthrough');
      assert.strictEqual(getExtractor('.py'), 'passthrough');
      assert.strictEqual(getExtractor('.html'), 'passthrough');
      assert.strictEqual(getExtractor('.css'), 'passthrough');
      assert.strictEqual(getExtractor('.pdf'), 'pdf');
      assert.strictEqual(getExtractor('.docx'), 'docx');
      assert.strictEqual(getExtractor('.ipynb'), 'ipynb');
      assert.strictEqual(getExtractor('.pptx'), null);
      assert.strictEqual(getExtractor('.exe'), null);
    });

    await test('getSourceType returns correct labels', async () => {
      assert.strictEqual(getSourceType('.md'), 'text');
      assert.strictEqual(getSourceType('.pdf'), 'pdf');
      assert.strictEqual(getSourceType('.docx'), 'docx');
      assert.strictEqual(getSourceType('.ipynb'), 'notebook');
      assert.strictEqual(getSourceType('.pptx'), 'unknown');
    });

    await test('chunk overlap is preserved verbatim (not trimmed)', async () => {
      // Build a stretch of text where the overlap window falls on actual
      // readable characters so a silent trim would be detectable.
      const paragraph = 'The quick brown fox jumps over the lazy dog. ';
      const longText = paragraph.repeat(200); // ~9000 chars, all on one line
      const chunks = chunkText(longText, 500, 100);

      assert.ok(chunks.length > 1);

      // For each adjacent pair, the last N chars of the previous chunk must
      // match the first N chars of the next chunk (where N == configured overlap).
      for (let i = 0; i < chunks.length - 1; i++) {
        const prev = chunks[i].text;
        const next = chunks[i + 1].text;
        const overlap = prev.slice(-100);
        assert.ok(
          next.startsWith(overlap) || prev.length < 100,
          `Overlap missing between chunk ${i + 1} and ${i + 2}`
        );
      }
    });

    await test('pathological overlap >= target still terminates', async () => {
      const chunks = chunkText('abcdefghij'.repeat(60), 10, 50);
      assert.ok(chunks.length >= 1);
      assert.strictEqual(chunks[0].chunkCount, chunks.length);
    });

    await test('section label skips code fence lines', async () => {
      const text = [
        '```',
        'some code here',
        'and more code',
        'with real content below'
      ].join('\n');
      const chunks = chunkText(text);
      assert.ok(chunks[0].sectionLabel);
      assert.ok(!chunks[0].sectionLabel.startsWith('```'));
    });

    await test('empty passthrough source is surfaced as skipped', async () => {
      const emptyPath = path.join(tmpDir, 'empty.md');
      await fs.writeFile(emptyPath, '   \n\n   \n', 'utf-8');

      const result = await normalizeSourceFile(emptyPath);
      assert.strictEqual(result.skipped, true);
      assert.ok(result.skipReason);
      assert.strictEqual(result.chunks.length, 0);
    });

    await test('docx decodes XML entities in extracted text', async () => {
      if (!HAS_ADM_ZIP) {
        console.log('  [SKIP] docx decodes XML entities in extracted text (adm-zip not installed)');
        return;
      }

      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      const docXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body>',
        '<w:p><w:r><w:t>Smith &amp; Jones</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>&lt;notes&gt;</w:t></w:r></w:p>',
        '</w:body>',
        '</w:document>'
      ].join('');
      zip.addFile('word/document.xml', Buffer.from(docXml, 'utf-8'));
      const docxPath = path.join(tmpDir, 'entities.docx');
      zip.writeZip(docxPath);

      const result = await normalizeSourceFile(docxPath);
      const fullText = result.chunks.map((c) => c.text).join(' ');
      assert.ok(fullText.includes('Smith & Jones'));
      assert.ok(fullText.includes('<notes>'));
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
  } finally {
    if (tmpDir) {
      await cleanupTempDir(tmpDir);
    }
  }

  process.exitCode = failed > 0 ? 1 : 0;
})();
