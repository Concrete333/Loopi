const assert = require('assert');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');
const { buildContextIndex, prepareContextIndex } = require('../src/context-index');
const { selectContextForPhase } = require('../src/context-selection');
const {
  buildPlanPrompt,
  buildReviewPrompt,
  buildImplementPrompt
} = require('../src/prompts');

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

async function createTempDir(prefix = 'tmp-context-use-case-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function cleanupTempDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (_error) {
    // ignore cleanup errors
  }
}

function makeLongMarkdown(title, sectionCount = 36) {
  const sections = [`# ${title}`, ''];
  for (let i = 1; i <= sectionCount; i += 1) {
    sections.push(`## ${title} Section ${i}`);
    sections.push(
      'This section expands on the assignment constraints, academic framing, evidence handling, and evaluation expectations in detail. '.repeat(8).trim()
    );
    sections.push('');
  }
  return sections.join('\n');
}

function makeLongNotebookJson(title, cellCount = 20) {
  const cells = [];
  for (let i = 1; i <= cellCount; i += 1) {
    cells.push({
      cell_type: 'markdown',
      source: [
        `## ${title} Concept ${i}\n`,
        'This markdown cell explains the optimisation objective, implementation tradeoffs, expected outputs, and validation steps in practical detail. '.repeat(6)
      ]
    });
    cells.push({
      cell_type: 'code',
      source: [
        `# ${title} code cell ${i}\n`,
        'for step in range(3):\n',
        `    print("cell ${i}", step)\n`,
        'weights = weights - learning_rate * gradient\n'
      ]
    });
  }

  return JSON.stringify({
    cells,
    metadata: {}
  }, null, 2);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function writeMinimalDocx(filePath, paragraphs) {
  if (!HAS_ADM_ZIP) {
    throw new Error('adm-zip is required to build DOCX fixtures');
  }

  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const docXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    ...paragraphs.map((paragraph) => `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`),
    '</w:body>',
    '</w:document>'
  ].join('');

  zip.addFile('word/document.xml', Buffer.from(docXml, 'utf-8'));
  zip.writeZip(filePath);
}

console.log('context-use-cases: prepared root smoke tests');

(async () => {
  let tmpDir = null;

  try {
    await test('Academic paper prepared root flows through cache, selection, and prompting', async () => {
      if (!HAS_ADM_ZIP) {
        console.log('  [SKIP] Academic paper prepared root flows through cache, selection, and prompting (adm-zip not installed)');
        return;
      }

      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'plan'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'review'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'examples'), { recursive: true });

      await writeMinimalDocx(
        path.join(tmpDir, 'shared', '00-assignment-brief.docx'),
        [
          'Assignment Brief',
          'Write a masters-level paper on the role of AI in digital payments.'
        ]
      );
      await fs.writeFile(path.join(tmpDir, 'shared', 'slides.pptx'), 'fake slide deck', 'utf-8');
      await fs.writeFile(
        path.join(tmpDir, 'plan', 'lecture-notes.md'),
        makeLongMarkdown('Fintech Lecture Notes'),
        'utf-8'
      );
      await fs.writeFile(
        path.join(tmpDir, 'plan', 'methodology.md'),
        '# Methodology\nUse a clear thesis, compare competing viewpoints, and ground claims in course material.',
        'utf-8'
      );
      await fs.writeFile(
        path.join(tmpDir, 'review', 'rubric.md'),
        '# Rubric\nAssess argument quality, evidence usage, structure, and academic tone.',
        'utf-8'
      );
      await fs.writeFile(
        path.join(tmpDir, 'examples', 'sample-outline.md'),
        '# Sample Outline\n1. Context\n2. Argument\n3. Evidence\n4. Critique\n5. Conclusion',
        'utf-8'
      );
      await writeJson(path.join(tmpDir, 'context.json'), {
        'shared/00-assignment-brief.docx': { priority: 10, purpose: 'paper prompt' },
        'review/rubric.md': { priority: 8, purpose: 'grading criteria' },
        'plan/methodology.md': { priority: 5, purpose: 'writing method' }
      });

      const contextConfig = { dir: '.', include: ['**/*'], exclude: [] };
      await prepareContextIndex(contextConfig, tmpDir);
      const index = await buildContextIndex(contextConfig, tmpDir);
      assert.ok(index.files.some((file) => file.relativePath === 'shared/00-assignment-brief.docx'));
      const skippedSlides = index.files.find((file) => file.relativePath === 'shared/slides.pptx');
      assert.ok(skippedSlides);
      assert.strictEqual(skippedSlides.skipped, true);
      assert.ok(skippedSlides.skipReason.includes('Unsupported file type'));

      const planPack = await selectContextForPhase(index, 'plan', { maxFiles: 8, maxChars: 12000 });

      const lectureChunks = planPack.files.filter((file) => file.sourceRelativePath === 'plan/lecture-notes.md');
      assert.strictEqual(lectureChunks.length, 2, 'plan selection should cap long academic notes to 2 chunks');
      assert.ok(planPack.files.some((file) => file.relativePath === 'shared/00-assignment-brief.docx'));
      assert.ok(planPack.files.some((file) => file.relativePath === 'plan/methodology.md'));
      assert.ok(planPack.skippedSources.some((entry) => entry.relativePath === 'shared/slides.pptx'));

      const planPrompt = buildPlanPrompt('Draft the paper plan', { contextPack: planPack });
      assert.ok(planPrompt.includes('--- context/shared/00-assignment-brief.docx'));
      assert.ok(planPrompt.includes('--- context/plan/lecture-notes.md [chunk 1/'));
      assert.ok(!planPrompt.includes('lecture-notes.md#chunk-001'));

      const reviewPack = await selectContextForPhase(index, 'review', { maxFiles: 8, maxChars: 12000 });
      assert.ok(reviewPack.files.some((file) => file.relativePath === 'review/rubric.md'));
      assert.ok(reviewPack.files.some((file) => file.relativePath === 'shared/00-assignment-brief.docx'));

      const reviewPrompt = buildReviewPrompt({
        originalPrompt: 'Draft the paper',
        originalPlan: 'Introduction, argument, evidence, critique, conclusion.',
        feedbackEntries: [],
        contextPack: reviewPack
      });
      assert.ok(reviewPrompt.includes('--- context/review/rubric.md'));

      await cleanupTempDir(tmpDir);
      tmpDir = null;
    });

    await test('Coding assignment prepared root flows through cache, selection, and prompting', async () => {
      tmpDir = await createTempDir();
      await fs.mkdir(path.join(tmpDir, 'shared'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'implement'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'schema'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'examples'), { recursive: true });

      await fs.writeFile(
        path.join(tmpDir, 'shared', '00-coding-assignment.md'),
        '# Coding Assignment\nBuild and explain a masters-level fintech coding submission with evidence of validation.',
        'utf-8'
      );
      await fs.writeFile(
        path.join(tmpDir, 'implement', 'gradient-descent.ipynb'),
        makeLongNotebookJson('Gradient Descent'),
        'utf-8'
      );
      await fs.writeFile(
        path.join(tmpDir, 'implement', 'helper.ts'),
        [
          'export function normaliseFeatures(values: number[]): number[] {',
          '  const max = Math.max(...values);',
          '  return values.map((value) => value / max);',
          '}'
        ].join('\n'),
        'utf-8'
      );
      await fs.writeFile(
        path.join(tmpDir, 'schema', 'submission-schema.json'),
        '{\n  "type": "object",\n  "required": ["report", "code", "evidence"]\n}',
        'utf-8'
      );
      await fs.writeFile(
        path.join(tmpDir, 'examples', 'sample-report.md'),
        '# Example Report\nSummarise the model, explain validation, and discuss limitations.',
        'utf-8'
      );
      await writeJson(path.join(tmpDir, 'context.json'), {
        'shared/00-coding-assignment.md': { priority: 10, purpose: 'coding prompt' },
        'implement/helper.ts': { priority: 7, purpose: 'reference implementation' },
        'schema/submission-schema.json': { priority: 6, purpose: 'submission contract' }
      });

      const contextConfig = { dir: '.', include: ['**/*'], exclude: [] };
      await prepareContextIndex(contextConfig, tmpDir);
      const index = await buildContextIndex(contextConfig, tmpDir);
      const implementPack = await selectContextForPhase(index, 'implement', { maxFiles: 10, maxChars: 16000 });

      const notebookChunks = implementPack.files.filter((file) => file.sourceRelativePath === 'implement/gradient-descent.ipynb');
      assert.strictEqual(notebookChunks.length, 3, 'implement selection should cap long notebook sources to 3 chunks');
      assert.ok(implementPack.files.some((file) => file.relativePath === 'implement/helper.ts'));
      assert.ok(implementPack.files.some((file) => file.relativePath === 'schema/submission-schema.json'));
      assert.ok(implementPack.files.some((file) => file.relativePath === 'shared/00-coding-assignment.md'));

      const implementPrompt = buildImplementPrompt('Implement the assignment plan', {
        originalPrompt: 'Complete the coding assignment',
        contextPack: implementPack
      });
      assert.ok(implementPrompt.includes('--- context/implement/gradient-descent.ipynb [chunk 1/'));
      assert.ok(implementPrompt.includes('--- context/implement/helper.ts'));
      assert.ok(implementPrompt.includes('--- context/schema/submission-schema.json'));
      assert.ok(!implementPrompt.includes('gradient-descent.ipynb#chunk-001'));

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
