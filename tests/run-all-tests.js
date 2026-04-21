const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testsDir = __dirname;
const thisFile = path.basename(__filename);

function listTestFiles() {
  return fs.readdirSync(testsDir)
    .filter((entry) => entry.endsWith('.test.js') && entry !== thisFile)
    .sort((a, b) => a.localeCompare(b));
}

function runTestFile(fileName) {
  const fullPath = path.join(testsDir, fileName);
  const result = spawnSync(process.execPath, [fullPath], {
    stdio: 'inherit',
    cwd: path.join(testsDir, '..')
  });

  return result.status === 0;
}

function main() {
  const files = listTestFiles();
  let failed = false;

  for (const file of files) {
    if (!runTestFile(file)) {
      failed = true;
      break;
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

main();
