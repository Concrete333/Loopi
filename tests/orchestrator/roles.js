const {
  assert,
  PROJECT_ROOT,
  DialecticOrchestrator,
  normalizeTaskConfig
} = require('../orchestrator-test-helpers');
const { startMockHttpServer, startSequentialMockHttpServer } = require('./http-helpers');

module.exports = async function registerRoleTests(test) {
  console.log('\norchestrator: Commit 15 - Role-to-provider mapping');

  await test('Planner role resolves to the configured provider for plan steps', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude', 'codex'],
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'test-model'
        }
      },
      roles: {
        planner: 'nim-local'
      },
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 1
      }
    }, { projectRoot: PROJECT_ROOT });

    const run = orchestrator.createRun(config);
    const originalRunStep = orchestrator.runStep;
    const seenStages = [];

    orchestrator.runStep = async ({ stage, agent }) => {
      seenStages.push({ stage, agent });
      return {
        agent,
        ok: true,
        exitCode: 0,
        outputText: stage === 'plan' ? 'Initial plan draft' : `${stage} output`,
        handoffData: { goal: 'test', units: [], questions: [] },
        handoffText: stage === 'plan' ? 'plan handoff text' : `${stage} handoff`,
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    try {
      await orchestrator.runPlanMode(config, run);
    } finally {
      orchestrator.runStep = originalRunStep;
    }

    const initialPlanStep = seenStages.find((entry) => entry.stage === 'plan');
    assert.ok(initialPlanStep, 'initial plan step should be captured');
    assert.strictEqual(initialPlanStep.agent, 'nim-local');
  });

  await test('Missing role falls back to config.agents list', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude', 'codex'],
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 1
      }
    }, { projectRoot: PROJECT_ROOT });

    const run = orchestrator.createRun(config);
    const originalRunStep = orchestrator.runStep;
    const seenStages = [];

    orchestrator.runStep = async ({ stage, agent }) => {
      seenStages.push({ stage, agent });
      return {
        agent,
        ok: true,
        exitCode: 0,
        outputText: stage === 'plan' ? 'Initial plan draft' : `${stage} output`,
        handoffData: { goal: 'test', units: [], questions: [] },
        handoffText: stage === 'plan' ? 'plan handoff text' : `${stage} handoff`,
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    try {
      await orchestrator.runPlanMode(config, run);
    } finally {
      orchestrator.runStep = originalRunStep;
    }

    const initialPlanStep = seenStages.find((entry) => entry.stage === 'plan');
    assert.ok(initialPlanStep, 'initial plan step should be captured');
    assert.strictEqual(initialPlanStep.agent, 'claude');
  });

  await test('Role-mapped participants do not rewrite run metadata or scratchpad agent lists', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      roles: {
        reviewer: 'codex'
      },
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 1
      }
    }, { projectRoot: PROJECT_ROOT });

    const run = orchestrator.createRun(config);
    const scratchpad = orchestrator.renderScratchpad(run);

    assert.deepStrictEqual(config.executionTargets, ['claude', 'codex']);
    assert.deepStrictEqual(run.agents, ['claude']);
    assert.match(scratchpad, /Agents: claude/);
  });

  await test('roles.fallback retries a failed step once with fallback target', async () => {
    const orchestrator = new DialecticOrchestrator();
    const { port: primaryPort, close: closePrimary } = await startMockHttpServer(500, { error: 'primary down' });
    const { port: fallbackPort, close: closeFallback } = await startMockHttpServer(200, {
      choices: [{ message: { content: 'fallback succeeded' } }],
      model: 'fallback-model'
    });

    try {
      const config = normalizeTaskConfig({
        mode: 'plan',
        prompt: 'Test prompt',
        agents: ['claude'],
        roles: {
          planner: 'nim-primary',
          fallback: 'nim-fallback'
        },
        providers: {
          'nim-primary': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${primaryPort}/v1`,
            model: 'primary-model'
          },
          'nim-fallback': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${fallbackPort}/v1`,
            model: 'fallback-model'
          }
        },
        settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
      }, { projectRoot: PROJECT_ROOT });

      const run = orchestrator.createRun(config);
      const step = await orchestrator.runStep({
        run,
        config,
        stage: 'plan',
        agent: 'nim-primary',
        prompt: 'Test plan prompt',
        cycleNumber: null,
        mode: 'plan',
        executionPolicy: { canWrite: false },
        handoffSchema: 'plan'
      });

      assert.strictEqual(step.agent, 'nim-fallback', 'step should reflect fallback agent result');
      assert.strictEqual(step.id, 'plan-2', 'fallback retry should consume the next step id after the failed primary');
      assert.strictEqual(step.ok, true, 'fallback success should make step succeed');
      assert.ok(Array.isArray(step.warnings), 'warnings list should be present');
      assert.ok(step.warnings.some((w) => /Role fallback executed/i.test(w)), 'fallback execution should be recorded in warnings');
      assert.strictEqual(run.nextStepIndex, 2, 'primary failure and fallback retry should both consume step ids');
      assert.deepStrictEqual(
        run.steps.map((entry) => ({ id: entry.id, agent: entry.agent, ok: entry.ok })),
        [
          { id: 'plan-1', agent: 'nim-primary', ok: false },
          { id: 'plan-2', agent: 'nim-fallback', ok: true }
        ],
        'run should record both the failed primary attempt and the fallback retry'
      );
      assert.ok(
        run.steps[0].warnings.some((w) => /Role fallback scheduled/i.test(w)),
        'primary failure step should record that a role fallback was scheduled'
      );
    } finally {
      await closePrimary();
      await closeFallback();
    }
  });

  await test('failed role fallback preserves the primary failure summary for error reporting', async () => {
    const orchestrator = new DialecticOrchestrator();
    const { port: primaryPort, close: closePrimary } = await startMockHttpServer(500, { error: 'primary down' });
    const { port: fallbackPort, close: closeFallback } = await startMockHttpServer(500, { error: 'fallback down' });

    try {
      const config = normalizeTaskConfig({
        mode: 'plan',
        prompt: 'Test prompt',
        agents: ['claude'],
        roles: {
          planner: 'nim-primary',
          fallback: 'nim-fallback'
        },
        providers: {
          'nim-primary': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${primaryPort}/v1`,
            model: 'primary-model'
          },
          'nim-fallback': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${fallbackPort}/v1`,
            model: 'fallback-model'
          }
        },
        settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
      }, { projectRoot: PROJECT_ROOT });

      const run = orchestrator.createRun(config);
      const step = await orchestrator.runStep({
        run,
        config,
        stage: 'plan',
        agent: 'nim-primary',
        prompt: 'Test plan prompt',
        cycleNumber: null,
        mode: 'plan',
        executionPolicy: { canWrite: false },
        handoffSchema: 'plan'
      });

      assert.strictEqual(step.agent, 'nim-fallback', 'returned step should be the fallback attempt');
      assert.strictEqual(step.ok, false, 'fallback failure should surface as a failed step');
      assert.ok(
        step.warnings.some((warning) => /Primary attempt summary: nim-primary failed due to server_error: Server error: 500/i.test(warning)),
        'fallback failure should retain a compact summary of the primary failure'
      );

      assert.throws(() => {
        orchestrator.assertStepSucceeded(step, config);
      }, /Primary attempt summary: nim-primary failed due to server_error: Server error: 500/i);
    } finally {
      await closePrimary();
      await closeFallback();
    }
  });

  await test('parallel review steps reserve unique step ids', async () => {
    const orchestrator = new DialecticOrchestrator();
    const { port: originPort, close: closeOrigin } = await startSequentialMockHttpServer([
      { choices: [{ message: { content: 'Initial review draft' } }], model: 'origin-model' },
      { choices: [{ message: { content: 'Synthesis summary' } }], model: 'origin-model' }
    ]);
    const { port: reviewerOnePort, close: closeReviewerOne } = await startMockHttpServer(200, {
      choices: [{ message: { content: 'Spec review feedback' } }],
      model: 'reviewer-one-model'
    });
    const { port: reviewerTwoPort, close: closeReviewerTwo } = await startMockHttpServer(200, {
      choices: [{ message: { content: 'Code quality feedback' } }],
      model: 'reviewer-two-model'
    });

    try {
      const config = normalizeTaskConfig({
        mode: 'review',
        prompt: 'Test prompt',
        agents: ['origin-http', 'reviewer-one', 'reviewer-two'],
        providers: {
          'origin-http': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${originPort}/v1`,
            model: 'origin-model'
          },
          'reviewer-one': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${reviewerOnePort}/v1`,
            model: 'reviewer-one-model'
          },
          'reviewer-two': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${reviewerTwoPort}/v1`,
            model: 'reviewer-two-model'
          }
        },
        settings: { cwd: '.', timeoutMs: 10000 }
      }, { projectRoot: PROJECT_ROOT });
      const run = orchestrator.createRun(config);

      orchestrator.collaborationStore.appendStep = async () => {};
      orchestrator.collaborationStore.writeArtifact = async () => {};

      const result = await orchestrator.runCollaborativeMode({
        mode: 'review',
        prompt: config.prompt,
        config,
        run,
        cycleNumber: null
      });

      assert.ok(result.finalOutput);
      assert.strictEqual(run.steps.length, 4, 'review mode should record initial, 2 review, and synthesis steps');
      const stepIds = run.steps.map((step) => step.id);
      assert.strictEqual(new Set(stepIds).size, stepIds.length, 'parallel reviewers should not share a step id');
    } finally {
      await closeOrigin();
      await closeReviewerOne();
      await closeReviewerTwo();
    }
  });
};
