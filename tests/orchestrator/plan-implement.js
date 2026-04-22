const {
  assert,
  PROJECT_ROOT,
  LoopiOrchestrator,
  normalizeTaskConfig,
  createConfig,
  createRun
} = require('../orchestrator-test-helpers');

module.exports = async function registerPlanImplementTests(test) {
  console.log('orchestrator: plan mode');

  await test('runMode routes plan mode through runPlanMode', async () => {
    const orchestrator = new LoopiOrchestrator();
    assert.strictEqual(typeof orchestrator.runMode, 'function');
    assert.strictEqual(typeof orchestrator.runPlanMode, 'function');
  });

  await test('runCollaborativeMode accepts modeBuilderOptions parameter', async () => {
    const orchestrator = new LoopiOrchestrator();
    const fnString = orchestrator.runCollaborativeMode.toString();
    assert.ok(fnString.includes('modeBuilderOptions'));
  });

  await test('runPlanMode uses useCase-aware initial prompt on first loop', async () => {
    const orchestrator = new LoopiOrchestrator();
    const originalRunStep = orchestrator.runStep;
    const capturedPrompts = [];

    orchestrator.runStep = async ({ stage, agent, prompt }) => {
      capturedPrompts.push({ stage, prompt });

      if (stage === 'plan') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Initial plan draft',
          handoffData: {
            goal: 'test goal',
            units: [{ id: '1', title: 'Commit 1', files: ['src/a.js'], validation: ['npm test'] }],
            questions: []
          },
          handoffText: 'plan handoff text',
          timedOut: false,
          usedFallback: false,
          fallbackReason: null,
          fatalOutputReason: null,
          handoffParseError: null
        };
      }

      return {
        agent,
        ok: true,
        exitCode: 0,
        outputText: `${stage} output`,
        handoffData: {
          goal: 'test goal',
          units: [{ id: '1', title: 'Commit 1', files: ['src/a.js'], validation: ['npm test'] }],
          questions: []
        },
        handoffText: `${stage} handoff`,
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      useCase: 'coding',
      agents: ['claude'],
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });

    try {
      await orchestrator.runPlanMode(config, { steps: [] });
    } finally {
      orchestrator.runStep = originalRunStep;
    }

    const initialPlanPrompt = capturedPrompts.find((entry) => entry.stage === 'plan');
    assert.ok(initialPlanPrompt, 'Initial plan prompt should be captured');
    assert.ok(initialPlanPrompt.prompt.includes('Plan type: coding'));
    assert.ok(initialPlanPrompt.prompt.includes('Output unit kind: commit'));
    assert.ok(initialPlanPrompt.prompt.includes('Required fields per unit:'));
  });

  await test('runStep includes plan-mode useCase handoff options in implementation', async () => {
    const orchestrator = new LoopiOrchestrator();
    const fnString = orchestrator.runStep.toString();
    assert.ok(fnString.includes("mode === 'plan' ? { useCase: config.useCase || null } : {}"));
  });

  console.log('orchestrator: implement loop engine');

  await test('runImplementLoopSequence exists and is a function', async () => {
    const orchestrator = new LoopiOrchestrator();
    assert.strictEqual(typeof orchestrator.runImplementLoopSequence, 'function');
  });

  await test('runImplementLoopSequence does not have modeBuilderOptions parameter', async () => {
    const orchestrator = new LoopiOrchestrator();
    const fnString = orchestrator.runImplementLoopSequence.toString();
    assert.ok(!fnString.includes('modeBuilderOptions'), 'modeBuilderOptions should not be present in runImplementLoopSequence');
  });

  await test('runImplementLoopSequence tracks failure metadata on error', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({ settings: { cwd: '.', timeoutMs: 10000, implementLoops: 3 } });
    const run = createRun(config);
    const originalRunStep = orchestrator.runStep;

    let callCount = 0;
    orchestrator.runStep = async ({ stage }) => {
      callCount += 1;
      if (stage === 'implement-review' && callCount === 4) {
        return {
          agent: 'codex',
          ok: false,
          exitCode: 1,
          outputText: 'review failed badly',
          handoffData: null,
          handoffText: '',
          timedOut: false,
          usedFallback: false,
          fallbackReason: null,
          fatalOutputReason: null
        };
      }

      return {
        agent: stage === 'implement' || stage === 'implement-repair' ? 'claude' : 'codex',
        ok: true,
        exitCode: 0,
        outputText: `${stage} output ${callCount}`,
        handoffData: stage === 'implement' || stage === 'implement-repair'
          ? { status: 'DONE', summary: `${stage} summary ${callCount}` }
          : null,
        handoffText: stage === 'implement' || stage === 'implement-repair'
          ? `handoff ${callCount}`
          : '',
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null
      };
    };

    const result = await orchestrator.runImplementLoopSequence({
      config,
      run,
      loopCount: 3,
      initialImplementNeeded: true,
      implementationPlan: 'Test plan'
    });

    orchestrator.runStep = originalRunStep;

    assert.ok(result.failure);
    assert.strictEqual(result.failure.loopNumber, 2);
    assert.strictEqual(result.failure.phase, 'review');
  });

  await test('runImplementLoopSequence with initialImplementNeeded=false returns seeded initial state', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({ settings: { cwd: '.', timeoutMs: 10000, implementLoops: 1 } });
    const run = createRun(config);
    const originalRunStep = orchestrator.runStep;

    orchestrator.runStep = async ({ stage, cycleNumber }) => ({
      agent: stage === 'implement-repair' ? 'claude' : 'codex',
      ok: true,
      exitCode: 0,
      outputText: `${stage} loop ${cycleNumber || 0}`,
      handoffData: stage === 'implement-repair'
        ? { status: 'DONE', summary: 'repaired' }
        : null,
      handoffText: stage === 'implement-repair' ? 'repair handoff' : '',
      timedOut: false,
      usedFallback: false,
      fallbackReason: null,
      fatalOutputReason: null
    });

    const result = await orchestrator.runImplementLoopSequence({
      config,
      run,
      loopCount: 1,
      initialImplementNeeded: false,
      implementationPlan: 'Test plan',
      currentImplementation: 'seeded implementation',
      currentImplementationHandoffText: 'seeded handoff',
      currentImplementationHandoffData: { status: 'DONE', summary: 'seeded summary' }
    });

    orchestrator.runStep = originalRunStep;

    assert.strictEqual(result.initialOutput, 'seeded implementation');
    assert.strictEqual(result.initialHandoffText, 'seeded handoff');
    assert.deepStrictEqual(result.initialHandoffData, { status: 'DONE', summary: 'seeded summary' });
    assert.strictEqual(result.finalOutput, 'implement-repair loop 1');
  });

  await test('runImplementLoopSequence builds review prompts with accumulated feedback', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      agents: ['claude', 'codex', 'gemini'],
      settings: { cwd: '.', timeoutMs: 10000, implementLoops: 1 }
    });
    const run = createRun(config);
    const originalRunStep = orchestrator.runStep;
    const capturedReviewPrompts = [];

    orchestrator.runStep = async ({ stage, prompt, agent }) => {
      if (stage === 'implement-review') {
        capturedReviewPrompts.push({ agent, prompt });
      }

      return {
        agent,
        ok: true,
        exitCode: 0,
        outputText: stage === 'implement-review'
          ? `Review output from ${agent}`
          : `${stage} output`,
        handoffData: stage === 'implement' || stage === 'implement-repair'
          ? { status: 'DONE', summary: `${stage} summary` }
          : null,
        handoffText: stage === 'implement' || stage === 'implement-repair'
          ? `${stage} handoff`
          : '',
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null
      };
    };

    const result = await orchestrator.runImplementLoopSequence({
      config,
      run,
      loopCount: 1,
      initialImplementNeeded: true,
      implementationPlan: 'Test plan'
    });

    orchestrator.runStep = originalRunStep;

    assert.strictEqual(result.failure, null);
    assert.strictEqual(capturedReviewPrompts.length, 2);
    assert.ok(!capturedReviewPrompts[0].prompt.includes('Prior implementation reviewer summaries'));
    assert.ok(capturedReviewPrompts[1].prompt.includes('Prior implementation reviewer summaries'));
    assert.ok(capturedReviewPrompts[1].prompt.includes('Review output from codex'));
    assert.strictEqual(result.feedbackEntries.length, 2);
    assert.strictEqual(result.feedbackEntries[0].text, 'Review output from codex');
    assert.strictEqual(result.feedbackEntries[1].text, 'Review output from gemini');
  });

  await test('runImplementLoopSequence with initialImplementNeeded=false fails without seeded state', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({ settings: { cwd: '.', timeoutMs: 10000, implementLoops: 1 } });
    const run = createRun(config);

    const result = await orchestrator.runImplementLoopSequence({
      config,
      run,
      loopCount: 1,
      initialImplementNeeded: false,
      implementationPlan: 'Test plan',
      currentImplementation: null,
      currentImplementationHandoffText: null,
      currentImplementationHandoffData: null
    });

    assert.ok(result.failure);
    assert.ok(result.failure.error.includes('requires currentImplementation'));
  });

  await test('runImplementLoopSequence no longer shadows currentLoop in the review/repair loop', async () => {
    const orchestrator = new LoopiOrchestrator();
    const loopFnString = orchestrator.runImplementLoopSequence.toString();
    assert.ok(loopFnString.includes('let currentLoop = 0;'));
    assert.ok(loopFnString.includes('for (currentLoop = 1;'));
    assert.ok(!loopFnString.includes('for (let currentLoop = 1;'));
  });

  console.log('orchestrator: standalone implement mode');

  await test('runIterativeImplementMode exists and is a function', async () => {
    const orchestrator = new LoopiOrchestrator();
    assert.strictEqual(typeof orchestrator.runIterativeImplementMode, 'function');
  });

  await test('runIterativeImplementMode uses config.settings.implementLoops', async () => {
    const orchestrator = new LoopiOrchestrator();
    const fnString = orchestrator.runIterativeImplementMode.toString();
    assert.ok(fnString.includes('config.settings.implementLoops'));
  });

  await test('runIterativeImplementMode throws on failure with detailed error', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({ settings: { cwd: '.', timeoutMs: 10000, implementLoops: 2 } });
    const run = createRun(config);
    const originalRunImplementLoopSequence = orchestrator.runImplementLoopSequence;

    orchestrator.runImplementLoopSequence = async () => ({
      initialOutput: 'initial',
      initialHandoffText: 'initial handoff',
      initialHandoffData: { status: 'DONE' },
      finalOutput: 'final',
      finalHandoffText: 'final handoff',
      finalHandoffData: { status: 'DONE' },
      feedbackEntries: [],
      failure: {
        loopNumber: 2,
        phase: 'repair',
        error: 'repair exploded'
      }
    });

    await assert.rejects(
      () => orchestrator.runIterativeImplementMode(config, run),
      /Implement mode failed at loop 2, phase repair: repair exploded/
    );

    orchestrator.runImplementLoopSequence = originalRunImplementLoopSequence;
  });

  await test('runIterativeImplementMode forwards original prompt and custom implement guidance', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      prompt: 'Ship the feature safely',
      customImplementPrompt: 'Keep the edits narrowly scoped.',
      settings: { cwd: '.', timeoutMs: 10000, implementLoops: 1 }
    });
    const run = createRun(config);
    const originalRunImplementLoopSequence = orchestrator.runImplementLoopSequence;
    const capturedArgs = [];

    orchestrator.runImplementLoopSequence = async (args) => {
      capturedArgs.push(args);
      return {
        initialOutput: 'initial',
        initialHandoffText: 'initial handoff',
        initialHandoffData: {
          status: 'DONE',
          summary: 'done',
          completed_work: ['did the work'],
          remaining_work: [],
          validation: ['ran tests']
        },
        finalOutput: 'final',
        finalHandoffText: 'final handoff',
        finalHandoffData: {
          status: 'DONE',
          summary: 'done',
          completed_work: ['did the work'],
          remaining_work: [],
          validation: ['ran tests']
        },
        feedbackEntries: [],
        failure: null
      };
    };

    await orchestrator.runIterativeImplementMode(config, run);
    orchestrator.runImplementLoopSequence = originalRunImplementLoopSequence;

    assert.strictEqual(capturedArgs.length, 1);
    assert.strictEqual(capturedArgs[0].originalPrompt, 'Ship the feature safely');
    assert.strictEqual(capturedArgs[0].customImplementPrompt, 'Keep the edits narrowly scoped.');
    assert.strictEqual(capturedArgs[0].implementHandoffSchema, 'implement');
  });

  await test('runMode routes implement mode through runIterativeImplementMode', async () => {
    const orchestrator = new LoopiOrchestrator();
    const fnString = orchestrator.runMode.toString();
    assert.ok(fnString.includes("config.mode === 'implement'"));
    assert.ok(fnString.includes('runIterativeImplementMode'));
  });
};
