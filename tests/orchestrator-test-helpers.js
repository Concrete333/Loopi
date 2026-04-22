const assert = require('assert');
const path = require('path');
const { LoopiOrchestrator } = require('../src/orchestrator');
const { normalizeTaskConfig } = require('../src/task-config');

const PROJECT_ROOT = path.join(__dirname, '..');

function createTestHarness(suiteName) {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        await result;
      }
      console.log(`  [PASS] ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  [FAIL] ${name}`);
      console.error(`    ${error.message}`);
      failed += 1;
    }
  }

  function finish() {
    console.log(`${suiteName}: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      process.exitCode = 1;
    }
  }

  return { test, finish };
}

function createConfig(overrides = {}) {
  return normalizeTaskConfig({
    mode: 'implement',
    prompt: 'Test prompt',
    agents: ['claude', 'codex'],
    settings: {
      cwd: '.',
      timeoutMs: 10000,
      implementLoops: 2
    },
    ...overrides
  }, { projectRoot: PROJECT_ROOT });
}

function createRun(config) {
  return {
    runId: 'test-run',
    mode: config.mode,
    prompt: config.prompt,
    agents: config.agents,
    settings: config.settings,
    startedAt: new Date().toISOString(),
    steps: [],
    worktreeSnapshots: []
  };
}

module.exports = {
  assert,
  PROJECT_ROOT,
  LoopiOrchestrator,
  normalizeTaskConfig,
  createTestHarness,
  createConfig,
  createRun
};
