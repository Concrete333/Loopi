const {
  assert,
  LoopiOrchestrator,
  createConfig,
  createRun
} = require('../orchestrator-test-helpers');

module.exports = async function registerOneShotTests(test) {
  console.log('orchestrator: one-shot unit-by-unit implement');

  await test('runOneShotUnitImplement exists and is a function', async () => {
    const orchestrator = new LoopiOrchestrator();
    assert.strictEqual(typeof orchestrator.runOneShotUnitImplement, 'function');
  });

  await test('runOneShotUnitImplement fails fast when handoffData is missing', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({ settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 2 } });
    const run = createRun(config);

    await assert.rejects(
      () => orchestrator.runOneShotUnitImplement({
        config,
        run,
        handoffData: null,
        renderedPlanText: 'Plan text'
      }),
      /requires plan handoff data, but none was provided/
    );
  });

  await test('runOneShotUnitImplement fails fast when units are empty', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({ settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 2 } });
    const run = createRun(config);

    await assert.rejects(
      () => orchestrator.runOneShotUnitImplement({
        config,
        run,
        handoffData: { units: [], unit_kind: 'commit' },
        renderedPlanText: 'Plan text'
      }),
      /requires non-empty units array/
    );
  });

  await test('runOneShotUnitImplement fails fast when units array is missing', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({ settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 2 } });
    const run = createRun(config);

    await assert.rejects(
      () => orchestrator.runOneShotUnitImplement({
        config,
        run,
        handoffData: { unit_kind: 'commit', goal: 'test' },
        renderedPlanText: 'Plan text'
      }),
      /requires non-empty units array/
    );
  });

  await test('runOneShotUnitImplement executes units in order with correct context', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      agents: ['claude', 'codex'],
      settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 1 }
    });
    const run = createRun(config);
    const originalRunImplementLoopSequence = orchestrator.runImplementLoopSequence;
    const capturedCalls = [];

    orchestrator.runImplementLoopSequence = async (args) => {
      capturedCalls.push(args);
      return {
        initialOutput: `initial for ${args.unitContext?.id}`,
        initialHandoffText: 'initial handoff',
        initialHandoffData: { status: 'DONE' },
        finalOutput: `final for ${args.unitContext?.id}`,
        finalHandoffText: 'final handoff',
        finalHandoffData: { status: 'DONE' },
        feedbackEntries: [],
        failure: null
      };
    };

    const handoffData = {
      unit_kind: 'commit',
      units: [
        { id: 'commit-1', title: 'First unit', purpose: 'do first' },
        { id: 'commit-2', title: 'Second unit', purpose: 'do second' }
      ],
      goal: 'Test goal',
      validation: ['Test validation'],
      risks: []
    };

    const result = await orchestrator.runOneShotUnitImplement({
      config,
      run,
      handoffData,
      renderedPlanText: 'Rendered plan'
    });

    orchestrator.runImplementLoopSequence = originalRunImplementLoopSequence;

    assert.strictEqual(capturedCalls.length, 2);
    assert.strictEqual(capturedCalls[0].unitContext.id, 'commit-1');
    assert.strictEqual(capturedCalls[0].unitContext.title, 'First unit');
    assert.strictEqual(capturedCalls[0].unitContext.unitKind, 'commit');
    assert.strictEqual(capturedCalls[0].completedUnitsSummary, 'None (this is first unit)');
    assert.strictEqual(capturedCalls[0].unitContext.completedUnitsSummary, undefined);
    assert.strictEqual(capturedCalls[1].unitContext.id, 'commit-2');
    assert.strictEqual(capturedCalls[1].unitContext.title, 'Second unit');
    assert.ok(capturedCalls[1].completedUnitsSummary.includes('commit-1: First unit'));
    assert.strictEqual(capturedCalls[1].unitContext.completedUnitsSummary, undefined);
    assert.ok(result.finalOutput.includes('final for commit-1'));
    assert.ok(result.finalOutput.includes('final for commit-2'));
    assert.strictEqual(result.finalHandoffData.status, 'DONE');
    assert.strictEqual(result.finalHandoffData.units.length, 2);
    assert.strictEqual(result.finalHandoffData.units[0].id, 'commit-1');
    assert.strictEqual(result.finalHandoffData.units[1].id, 'commit-2');
  });

  await test('runOneShotUnitImplement stops on unit failure', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      agents: ['claude', 'codex'],
      settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 1 }
    });
    const run = createRun(config);
    const originalRunImplementLoopSequence = orchestrator.runImplementLoopSequence;
    const capturedCalls = [];

    orchestrator.runImplementLoopSequence = async (args) => {
      capturedCalls.push(args);
      if (args.unitContext.id === 'commit-2') {
        return {
          initialOutput: null,
          initialHandoffText: null,
          initialHandoffData: null,
          finalOutput: null,
          finalHandoffText: null,
          finalHandoffData: null,
          feedbackEntries: [],
          failure: {
            loopNumber: 1,
            phase: 'implement',
            error: 'unit 2 failed'
          }
        };
      }
      return {
        initialOutput: `initial for ${args.unitContext?.id}`,
        initialHandoffText: 'initial handoff',
        initialHandoffData: { status: 'DONE' },
        finalOutput: `final for ${args.unitContext?.id}`,
        finalHandoffText: 'final handoff',
        finalHandoffData: { status: 'DONE' },
        feedbackEntries: [],
        failure: null
      };
    };

    const handoffData = {
      unit_kind: 'commit',
      units: [
        { id: 'commit-1', title: 'First unit', purpose: 'do first' },
        { id: 'commit-2', title: 'Second unit', purpose: 'do second' },
        { id: 'commit-3', title: 'Third unit', purpose: 'do third' }
      ],
      goal: 'Test goal',
      validation: ['Test validation'],
      risks: []
    };

    await assert.rejects(
      () => orchestrator.runOneShotUnitImplement({
        config,
        run,
        handoffData,
        renderedPlanText: 'Rendered plan'
      }),
      /One-shot implement failed at unit commit-2 \(Second unit\), loop 1, phase implement: unit 2 failed/
    );

    orchestrator.runImplementLoopSequence = originalRunImplementLoopSequence;

    assert.strictEqual(capturedCalls.length, 2);
    assert.strictEqual(capturedCalls[0].unitContext.id, 'commit-1');
    assert.strictEqual(capturedCalls[1].unitContext.id, 'commit-2');
  });

  await test('runOneShotUnitImplement uses sectionImplementLoops for loop count', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      agents: ['claude', 'codex'],
      settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 3 }
    });
    const run = createRun(config);
    const originalRunImplementLoopSequence = orchestrator.runImplementLoopSequence;
    const capturedLoopCounts = [];

    orchestrator.runImplementLoopSequence = async (args) => {
      capturedLoopCounts.push(args.loopCount);
      return {
        initialOutput: 'output',
        initialHandoffText: 'handoff',
        initialHandoffData: { status: 'DONE' },
        finalOutput: 'output',
        finalHandoffText: 'handoff',
        finalHandoffData: { status: 'DONE' },
        feedbackEntries: [],
        failure: null
      };
    };

    const handoffData = {
      unit_kind: 'commit',
      units: [{ id: 'commit-1', title: 'Unit 1', purpose: 'test' }],
      goal: 'Test goal',
      validation: ['Test validation'],
      risks: []
    };

    await orchestrator.runOneShotUnitImplement({
      config,
      run,
      handoffData,
      renderedPlanText: 'Plan text'
    });

    orchestrator.runImplementLoopSequence = originalRunImplementLoopSequence;

    assert.strictEqual(capturedLoopCounts.length, 1);
    assert.strictEqual(capturedLoopCounts[0], 3);
  });

  await test('runOneShotMode calls runOneShotUnitImplement', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'one-shot',
      useCase: 'coding',
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1, planLoops: 1, sectionImplementLoops: 2 }
    });
    const run = createRun(config);
    const originalRunOneShotUnitImplement = orchestrator.runOneShotUnitImplement;
    const originalRunCollaborativeMode = orchestrator.runCollaborativeMode;
    const capturedCalls = [];

    orchestrator.runOneShotUnitImplement = async ({ handoffData }) => {
      capturedCalls.push('runOneShotUnitImplement');
      capturedCalls.push(handoffData?.units?.[0]?.id);
      return {
        finalOutput: 'unit implement output',
        finalHandoffText: 'unit implement handoff',
        finalHandoffData: { status: 'DONE' }
      };
    };

    orchestrator.runCollaborativeMode = async ({ mode }) => {
      if (mode === 'plan') {
        return {
          finalOutput: 'plan output',
          finalHandoffText: 'plan handoff',
          finalHandoffData: {
            goal: 'test goal',
            plan_type: 'coding',
            unit_kind: 'commit',
            units: [{ id: 'commit-1', title: 'Test commit', purpose: 'test' }],
            validation: ['test'],
            risks: []
          }
        };
      }
      capturedCalls.push('runCollaborativeMode-implement');
      return { finalOutput: 'fallback', finalHandoffData: null };
    };

    const result = await orchestrator.runOneShotMode(config, run);

    orchestrator.runOneShotUnitImplement = originalRunOneShotUnitImplement;
    orchestrator.runCollaborativeMode = originalRunCollaborativeMode;

    assert.ok(capturedCalls.includes('runOneShotUnitImplement'));
    assert.ok(capturedCalls.includes('commit-1'));
    assert.ok(!capturedCalls.includes('runCollaborativeMode-implement'));
    assert.strictEqual(result.cycles.length, 1);
  });

  await test('runOneShotMode preserves handoffData across quality loops', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'one-shot',
      useCase: 'coding',
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 2, planLoops: 1, sectionImplementLoops: 1 }
    });
    const run = createRun(config);
    const originalRunOneShotUnitImplement = orchestrator.runOneShotUnitImplement;
    const originalRunCollaborativeMode = orchestrator.runCollaborativeMode;
    const capturedHandoffData = [];

    orchestrator.runOneShotUnitImplement = async ({ handoffData }) => {
      capturedHandoffData.push(handoffData);
      return {
        finalOutput: 'implement output',
        finalHandoffText: 'implement handoff',
        finalHandoffData: { status: 'DONE' }
      };
    };

    orchestrator.runCollaborativeMode = async ({ mode }) => {
      if (mode === 'plan') {
        const unitId = `commit-${capturedHandoffData.length + 1}`;
        return {
          finalOutput: `plan output cycle ${capturedHandoffData.length + 1}`,
          finalHandoffText: `plan handoff cycle ${capturedHandoffData.length + 1}`,
          finalHandoffData: {
            goal: 'test goal',
            plan_type: 'coding',
            unit_kind: 'commit',
            units: [{ id: unitId, title: `Commit ${capturedHandoffData.length + 1}`, purpose: 'test' }],
            validation: ['test'],
            risks: []
          }
        };
      }
      return { finalOutput: 'review output', finalHandoffData: null };
    };

    await orchestrator.runOneShotMode(config, run);

    orchestrator.runOneShotUnitImplement = originalRunOneShotUnitImplement;
    orchestrator.runCollaborativeMode = originalRunCollaborativeMode;

    assert.strictEqual(capturedHandoffData.length, 2);
    assert.ok(capturedHandoffData[0].units);
    assert.ok(capturedHandoffData[1].units);
    assert.strictEqual(capturedHandoffData[0].units[0].id, 'commit-1');
    assert.strictEqual(capturedHandoffData[1].units[0].id, 'commit-2');
  });

  await test('runOneShotUnitImplement uses effectiveAgents override', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'one-shot',
      useCase: 'coding',
      agents: ['claude', 'codex', 'gemini'],
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 1,
        planLoops: 1,
        sectionImplementLoops: 2,
        oneShotOrigins: {
          implement: 'gemini',
          plan: 'claude'
        }
      }
    });
    const run = createRun(config);
    const originalRunImplementLoopSequence = orchestrator.runImplementLoopSequence;
    const capturedAgentOrders = [];

    orchestrator.runImplementLoopSequence = async (args) => {
      capturedAgentOrders.push(args.effectiveAgents);
      return {
        initialOutput: 'output',
        initialHandoffText: 'handoff',
        initialHandoffData: { status: 'DONE' },
        finalOutput: 'output',
        finalHandoffText: 'handoff',
        finalHandoffData: { status: 'DONE' },
        feedbackEntries: [],
        failure: null
      };
    };

    const handoffData = {
      unit_kind: 'commit',
      units: [{ id: 'commit-1', title: 'Unit 1', purpose: 'test' }],
      goal: 'Test goal',
      validation: ['Test validation'],
      risks: []
    };

    await orchestrator.runOneShotUnitImplement({
      config,
      run,
      handoffData,
      renderedPlanText: 'Plan text',
      effectiveAgents: ['gemini', 'claude', 'codex']
    });

    orchestrator.runImplementLoopSequence = originalRunImplementLoopSequence;

    assert.strictEqual(capturedAgentOrders.length, 1);
    assert.deepStrictEqual(capturedAgentOrders[0], ['gemini', 'claude', 'codex']);
  });

  await test('runOneShotMode uses rendered plan text not handoff JSON', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'one-shot',
      useCase: 'coding',
      agents: ['claude', 'codex'],
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1, planLoops: 1, sectionImplementLoops: 1 }
    });
    const run = createRun(config);
    const originalRunCollaborativeMode = orchestrator.runCollaborativeMode;
    const originalRunOneShotUnitImplement = orchestrator.runOneShotUnitImplement;
    const capturedPlanText = [];

    orchestrator.runCollaborativeMode = async ({ mode }) => {
      if (mode === 'plan') {
        return {
          finalOutput: 'HUMAN PLAN',
          finalHandoffText: '{"units":[...]}',
          finalHandoffData: {
            goal: 'test goal',
            plan_type: 'coding',
            unit_kind: 'commit',
            units: [{ id: 'commit-1', title: 'Test commit', purpose: 'test' }],
            validation: ['test'],
            risks: []
          }
        };
      }
      return { finalOutput: 'fallback', finalHandoffData: null };
    };
    orchestrator.runOneShotUnitImplement = async ({ renderedPlanText }) => {
      capturedPlanText.push(renderedPlanText);
      return {
        finalOutput: 'implement output',
        finalHandoffText: 'implement handoff',
        finalHandoffData: { status: 'DONE' }
      };
    };

    await orchestrator.runOneShotMode(config, run);

    orchestrator.runCollaborativeMode = originalRunCollaborativeMode;
    orchestrator.runOneShotUnitImplement = originalRunOneShotUnitImplement;

    assert.strictEqual(capturedPlanText.length, 1);
    assert.strictEqual(capturedPlanText[0], 'HUMAN PLAN');
  });

  await test('runOneShotUnitImplement fails when unit_kind is missing', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'one-shot',
      useCase: 'coding',
      agents: ['claude', 'codex'],
      settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 2 }
    });
    const run = createRun(config);

    const handoffData = {
      units: [{ id: 'commit-1', title: 'Test' }],
      goal: 'Test goal',
      validation: ['Test validation'],
      risks: []
    };

    await assert.rejects(
      () => orchestrator.runOneShotUnitImplement({
        config,
        run,
        handoffData,
        renderedPlanText: 'Plan text'
      }),
      /unit_kind in plan handoff data/
    );
  });

  await test('runOneShotMode passes implement origin override into unit implement', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'one-shot',
      useCase: 'coding',
      agents: ['claude', 'codex', 'gemini'],
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 1,
        planLoops: 1,
        sectionImplementLoops: 2,
        oneShotOrigins: {
          implement: 'gemini'
        }
      }
    });
    const run = createRun(config);
    const originalRunCollaborativeMode = orchestrator.runCollaborativeMode;
    const originalRunOneShotUnitImplement = orchestrator.runOneShotUnitImplement;
    const capturedEffectiveAgents = [];

    orchestrator.runCollaborativeMode = async ({ mode }) => {
      if (mode === 'plan') {
        return {
          finalOutput: 'HUMAN PLAN',
          finalHandoffText: '{"units":[...]}',
          finalHandoffData: {
            goal: 'test goal',
            plan_type: 'coding',
            unit_kind: 'commit',
            units: [{ id: 'commit-1', title: 'Test commit', purpose: 'test' }],
            validation: ['test'],
            risks: []
          }
        };
      }
      return { finalOutput: 'fallback', finalHandoffData: null };
    };
    orchestrator.runOneShotUnitImplement = async ({ effectiveAgents }) => {
      capturedEffectiveAgents.push(effectiveAgents);
      return {
        finalOutput: 'implement output',
        finalHandoffText: 'implement handoff',
        finalHandoffData: { status: 'DONE' }
      };
    };

    await orchestrator.runOneShotMode(config, run);

    orchestrator.runCollaborativeMode = originalRunCollaborativeMode;
    orchestrator.runOneShotUnitImplement = originalRunOneShotUnitImplement;

    assert.strictEqual(capturedEffectiveAgents.length, 1);
    assert.deepStrictEqual(capturedEffectiveAgents[0], ['gemini', 'claude', 'codex']);
  });

  await test('runOneShotMode falls back to rendered handoff when finalOutput is empty', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'one-shot',
      useCase: 'coding',
      agents: ['claude', 'codex'],
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1, planLoops: 1, sectionImplementLoops: 1 }
    });
    const run = createRun(config);
    const originalRunCollaborativeMode = orchestrator.runCollaborativeMode;
    const originalRunOneShotUnitImplement = orchestrator.runOneShotUnitImplement;
    const capturedPlanText = [];

    orchestrator.runCollaborativeMode = async ({ mode }) => {
      if (mode === 'plan') {
        return {
          finalOutput: '',
          finalHandoffText: '{"plan_type":"coding"}',
          finalHandoffData: {
            goal: 'test goal',
            plan_type: 'coding',
            unit_kind: 'commit',
            units: [{ id: 'commit-1', title: 'Test commit', purpose: 'test', why: 'because', validation: ['test'] }],
            validation: ['test'],
            risks: []
          }
        };
      }
      return { finalOutput: 'fallback', finalHandoffData: null };
    };
    orchestrator.runOneShotUnitImplement = async ({ renderedPlanText }) => {
      capturedPlanText.push(renderedPlanText);
      return {
        finalOutput: 'implement output',
        finalHandoffText: 'implement handoff',
        finalHandoffData: { status: 'DONE' }
      };
    };

    await orchestrator.runOneShotMode(config, run);

    orchestrator.runCollaborativeMode = originalRunCollaborativeMode;
    orchestrator.runOneShotUnitImplement = originalRunOneShotUnitImplement;

    assert.strictEqual(capturedPlanText.length, 1);
    assert.ok(capturedPlanText[0].includes('Test commit'));
    assert.ok(!capturedPlanText[0].includes('{"plan_type"'));
  });

  await test('runOneShotUnitImplement uses implement-unit handoff schema', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'one-shot',
      useCase: 'coding',
      settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 1 }
    });
    const run = createRun(config);
    const originalRunImplementLoopSequence = orchestrator.runImplementLoopSequence;
    const capturedSchemas = [];

    orchestrator.runImplementLoopSequence = async (args) => {
      capturedSchemas.push(args.implementHandoffSchema);
      return {
        initialOutput: 'output',
        initialHandoffText: 'handoff',
        finalOutput: 'output',
        finalHandoffText: 'handoff',
        finalHandoffData: {
          status: 'DONE',
          summary: 'done',
          unit_id: 'commit-1',
          unit_title: 'Unit 1',
          unit_kind: 'commit',
          completed_work: ['did the work'],
          remaining_work: [],
          validation: ['ran tests']
        },
        feedbackEntries: [],
        failure: null
      };
    };

    await orchestrator.runOneShotUnitImplement({
      config,
      run,
      handoffData: {
        unit_kind: 'commit',
        units: [{ id: 'commit-1', title: 'Unit 1', purpose: 'test' }],
        goal: 'Test goal',
        validation: ['Test validation'],
        risks: []
      },
      renderedPlanText: 'Plan text'
    });

    orchestrator.runImplementLoopSequence = originalRunImplementLoopSequence;
    assert.deepStrictEqual(capturedSchemas, ['implement-unit']);
  });

  await test('one-shot config fails clearly when useCase is missing', async () => {
    assert.throws(() => {
      createConfig({
        mode: 'one-shot',
        settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1, sectionImplementLoops: 1 }
      });
    }, /mode "one-shot" requires a non-empty "useCase"/);
  });
};
