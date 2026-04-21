const { createTestHarness } = require('./orchestrator-test-helpers');
const registerPlanImplementTests = require('./orchestrator/plan-implement');
const registerOneShotTests = require('./orchestrator/one-shot');
const registerReadinessTests = require('./orchestrator/readiness');
const registerRoleTests = require('./orchestrator/roles');
const registerArtifactTests = require('./orchestrator/artifacts');
const registerCachingAndE2ETests = require('./orchestrator/caching-e2e');
const registerCheckpointTests = require('./orchestrator/checkpoint');

const { test, finish } = createTestHarness('orchestrator');

async function runTests() {
  await registerPlanImplementTests(test);
  await registerOneShotTests(test);
  await registerReadinessTests(test);
  await registerRoleTests(test);
  await registerArtifactTests(test);
  await registerCachingAndE2ETests(test);
  await registerCheckpointTests(test);
  finish();
}

runTests();
