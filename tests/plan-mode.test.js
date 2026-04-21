// Aggregate test runner - delegates to focused test files.
// Run with: node tests/plan-mode.test.js
// Or run individual files: node tests/prompts.test.js, etc.

const { execSync } = require('child_process');
const path = require('path');

const testFiles = [
  'prompts.test.js',
  'handoff.test.js',
  'task-config.test.js',
  'adapters.test.js',
  'orchestrator.test.js'
];

let passed = 0;
let failed = 0;

for (const file of testFiles) {
  const filePath = path.join(__dirname, file);
  try {
    execSync(`"${process.execPath}" "${filePath}"`, { stdio: 'inherit' });
    passed += 1;
  } catch {
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed, ${passed} passed.`);
  process.exitCode = 1;
} else {
  console.log(`\nplan-mode tests passed (${passed} files)`);
}
