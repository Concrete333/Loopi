const {
  assert,
  PROJECT_ROOT,
  DialecticOrchestrator,
  normalizeTaskConfig
} = require('../orchestrator-test-helpers');

module.exports = async function registerCheckpointTests(test) {
  console.log('\norchestrator: Commit 12 - Interactive planning checkpoint');

  await test('interactive mode pauses after first draft and before review', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude', 'codex'],
      planQuestionMode: 'interactive',
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 1
      }
    }, { projectRoot: PROJECT_ROOT });

    const run = orchestrator.createRun(config);
    const originalRunStep = orchestrator.runStep;
    const originalCollectPlanAnswers = orchestrator.collectPlanAnswers;
    const capturedSteps = [];
    const capturedPrompts = [];

    orchestrator.runStep = async ({ stage, agent, prompt, cycleNumber }) => {
      capturedSteps.push({ stage, agent, cycleNumber });
      capturedPrompts.push({ stage, prompt, cycleNumber });

      if (stage === 'plan') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Initial plan draft',
          handoffData: {
            goal: 'test goal',
            steps: ['step 1'],
            questions: [
              {
                id: 'q1',
                question: 'Should we use feature area grouping?',
                impact: 'Determines plan structure',
                agentDefault: 'feature area'
              }
            ]
          },
          handoffText: 'plan handoff text',
          timedOut: false,
          usedFallback: false,
          fallbackReason: null,
          fatalOutputReason: null,
          handoffParseError: null
        };
      }

      if (stage === 'review') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Review feedback',
          handoffData: { findings: [], approval: 'approved' },
          handoffText: 'review handoff',
          timedOut: false,
          usedFallback: false,
          fallbackReason: null,
          fatalOutputReason: null,
          handoffParseError: null
        };
      }

      if (stage === 'synthesis') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Revised plan',
          handoffData: {
            goal: 'test goal',
            steps: ['step 1 with clarification'],
            questions: []
          },
          handoffText: 'synthesis handoff',
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
        outputText: 'other output',
        handoffData: null,
        handoffText: '',
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    let collectPlanAnswersCalled = false;
    orchestrator.collectPlanAnswers = async (questions) => {
      collectPlanAnswersCalled = true;
      assert.strictEqual(questions.length, 1);
      return [{ id: 'q1', question: 'Should we use feature area grouping?', answer: 'feature area', usedDefault: true }];
    };

    try {
      await orchestrator.runPlanMode(config, run);
      assert.ok(collectPlanAnswersCalled, 'collectPlanAnswers should be called in interactive mode');
      assert.ok(capturedSteps.length >= 3, 'Should have at least 3 steps');
      assert.strictEqual(capturedSteps[0].stage, 'plan', 'First step should be initial plan draft');
      assert.strictEqual(capturedSteps[0].agent, 'claude', 'Initial plan should be from origin agent');

      const reviewStep = capturedSteps.find((s) => s.stage === 'review');
      const synthesisStep = capturedSteps.find((s) => s.stage === 'synthesis');
      assert.ok(reviewStep, 'Review step should be present');
      assert.ok(synthesisStep, 'Synthesis step should be present');

      const reviewPrompt = capturedPrompts.find((s) => s.stage === 'review');
      const synthesisPrompt = capturedPrompts.find((s) => s.stage === 'synthesis');
      assert.ok(reviewPrompt.prompt.includes('<clarifications>'));
      assert.ok(reviewPrompt.prompt.includes('feature area (planner default used)'));
      assert.ok(synthesisPrompt.prompt.includes('<clarifications>'));
    } finally {
      orchestrator.runStep = originalRunStep;
      orchestrator.collectPlanAnswers = originalCollectPlanAnswers;
    }
  });

  await test('autonomous mode does not pause and uses defaults', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude', 'codex'],
      planQuestionMode: 'autonomous',
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 1
      }
    }, { projectRoot: PROJECT_ROOT });

    const run = orchestrator.createRun(config);
    const originalRunStep = orchestrator.runStep;
    const originalCollectPlanAnswers = orchestrator.collectPlanAnswers;
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
            steps: ['step 1'],
            questions: [
              {
                id: 'q1',
                question: 'Should we use feature area grouping?',
                impact: 'Determines plan structure',
                agentDefault: 'feature area'
              }
            ]
          },
          handoffText: 'plan handoff text',
          timedOut: false,
          usedFallback: false,
          fallbackReason: null,
          fatalOutputReason: null,
          handoffParseError: null
        };
      }

      if (stage === 'review') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Review feedback',
          handoffData: { findings: [], approval: 'approved' },
          handoffText: 'review handoff',
          timedOut: false,
          usedFallback: false,
          fallbackReason: null,
          fatalOutputReason: null,
          handoffParseError: null
        };
      }

      if (stage === 'synthesis') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Revised plan',
          handoffData: {
            goal: 'test goal',
            steps: ['step 1 with default'],
            questions: []
          },
          handoffText: 'synthesis handoff',
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
        outputText: 'other output',
        handoffData: null,
        handoffText: '',
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    let collectPlanAnswersCalled = false;
    orchestrator.collectPlanAnswers = async () => {
      collectPlanAnswersCalled = true;
      return [];
    };

    try {
      await orchestrator.runPlanMode(config, run);
      assert.ok(!collectPlanAnswersCalled, 'collectPlanAnswers should NOT be called in autonomous mode');

      const reviewPrompt = capturedPrompts.find((s) => s.stage === 'review');
      assert.ok(reviewPrompt.prompt.includes('<clarifications>'));
      assert.ok(reviewPrompt.prompt.includes('feature area (planner default used)'));
    } finally {
      orchestrator.runStep = originalRunStep;
      orchestrator.collectPlanAnswers = originalCollectPlanAnswers;
    }
  });

  await test('no questions means no pause', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude', 'codex'],
      planQuestionMode: 'interactive',
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 1
      }
    }, { projectRoot: PROJECT_ROOT });

    const run = orchestrator.createRun(config);
    const originalRunStep = orchestrator.runStep;
    const originalCollectPlanAnswers = orchestrator.collectPlanAnswers;

    orchestrator.runStep = async ({ stage, agent }) => {
      if (stage === 'plan') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Initial plan draft',
          handoffData: {
            goal: 'test goal',
            steps: ['step 1'],
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
        outputText: 'other output',
        handoffData: null,
        handoffText: '',
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    let collectPlanAnswersCalled = false;
    orchestrator.collectPlanAnswers = async () => {
      collectPlanAnswersCalled = true;
      return [];
    };

    try {
      await orchestrator.runPlanMode(config, run);
      assert.ok(!collectPlanAnswersCalled, 'collectPlanAnswers should NOT be called when there are no questions');
    } finally {
      orchestrator.runStep = originalRunStep;
      orchestrator.collectPlanAnswers = originalCollectPlanAnswers;
    }
  });

  await test('malformed question handoff warns and continues', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude', 'codex'],
      planQuestionMode: 'interactive',
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 1
      }
    }, { projectRoot: PROJECT_ROOT });

    const run = orchestrator.createRun(config);
    const originalRunStep = orchestrator.runStep;
    const originalWarn = console.warn;
    const warnings = [];

    console.warn = (message) => warnings.push(message);

    orchestrator.runStep = async ({ stage, agent }) => {
      if (stage === 'plan') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Initial plan draft',
          handoffData: null,
          handoffText: 'plan handoff text',
          timedOut: false,
          usedFallback: false,
          fallbackReason: null,
          fatalOutputReason: null,
          handoffParseError: 'Invalid HANDOFF_JSON block: questions[0].question must be a non-empty string.'
        };
      }

      return {
        agent,
        ok: true,
        exitCode: 0,
        outputText: 'other output',
        handoffData: null,
        handoffText: '',
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    const originalCollectPlanAnswers = orchestrator.collectPlanAnswers;
    let collectPlanAnswersCalled = false;
    orchestrator.collectPlanAnswers = async () => {
      collectPlanAnswersCalled = true;
      return [];
    };

    try {
      await orchestrator.runPlanMode(config, run);
      assert.ok(!collectPlanAnswersCalled, 'collectPlanAnswers should NOT be called for malformed questions');
      assert.ok(warnings.some((warning) => warning.includes('invalid question block')));
    } finally {
      orchestrator.runStep = originalRunStep;
      orchestrator.collectPlanAnswers = originalCollectPlanAnswers;
      console.warn = originalWarn;
    }
  });

  await test('clarifications remain present in later quality loops', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude', 'codex'],
      planQuestionMode: 'autonomous',
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 2
      }
    }, { projectRoot: PROJECT_ROOT });

    const run = orchestrator.createRun(config);
    const originalRunStep = orchestrator.runStep;
    const capturedClarifications = [];

    orchestrator.runStep = async ({ stage, agent, prompt, cycleNumber }) => {
      if ((stage === 'review' || stage === 'synthesis') && prompt && prompt.includes('<clarifications>')) {
        capturedClarifications.push({ stage, cycleNumber, prompt });
      }

      if (stage === 'plan') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Initial plan draft',
          handoffData: {
            goal: 'test goal',
            steps: ['step 1'],
            questions: [
              {
                id: 'q1',
                question: 'Should we use feature area grouping?',
                impact: 'Determines plan structure',
                agentDefault: 'feature area'
              }
            ]
          },
          handoffText: 'plan handoff text',
          timedOut: false,
          usedFallback: false,
          fallbackReason: null,
          fatalOutputReason: null,
          handoffParseError: null
        };
      }

      if (stage === 'review') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Review feedback',
          handoffData: { findings: [], approval: 'approved' },
          handoffText: 'review handoff',
          timedOut: false,
          usedFallback: false,
          fallbackReason: null,
          fatalOutputReason: null,
          handoffParseError: null
        };
      }

      if (stage === 'synthesis') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Revised plan',
          handoffData: {
            goal: 'test goal',
            steps: ['step 1'],
            questions: []
          },
          handoffText: 'synthesis handoff',
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
        outputText: 'other output',
        handoffData: null,
        handoffText: '',
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    try {
      await orchestrator.runPlanMode(config, run);

      const loop1Clarifications = capturedClarifications.filter((c) => c.cycleNumber === 1);
      const loop2Clarifications = capturedClarifications.filter((c) => c.cycleNumber === 2);

      assert.ok(loop1Clarifications.length > 0, 'Clarifications should be in loop 1 review/synthesis');
      assert.ok(loop2Clarifications.length > 0, 'Clarifications should persist in loop 2 review/synthesis');
    } finally {
      orchestrator.runStep = originalRunStep;
    }
  });
};
