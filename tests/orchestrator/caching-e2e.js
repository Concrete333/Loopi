const path = require('path');
const { __test } = require('../../src/orchestrator');
const { resolveContextDelivery, resolveContextDeliveryForCycle } = require('../../src/context-delivery');
const {
  assert,
  PROJECT_ROOT,
  DialecticOrchestrator,
  normalizeTaskConfig
} = require('../orchestrator-test-helpers');
const { startSequentialMockHttpServer } = require('./http-helpers');

module.exports = async function registerCachingAndE2ETests(test) {
  console.log('\norchestrator: Commit 17 - Run-level caching');

  await test('checkProviderReadiness is only called once per provider per run', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'test-model'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);
    let readinessCalls = 0;

    orchestrator.checkProviderReadiness = async () => {
      readinessCalls += 1;
      return {
        ready: true,
        providerId: 'nim-local',
        modelConfirmed: 'test-model',
        rawModels: ['test-model'],
        failureReason: null,
        error: null
      };
    };
    orchestrator.collaborationStore.writeArtifact = async () => {};

    await orchestrator.ensureProviderReadiness(config, run);
    await orchestrator.ensureProviderReadiness(config, run);

    assert.strictEqual(readinessCalls, 1, 'provider readiness should be cached within the run');
  });

  await test('Cached readiness reuse does not write duplicate provider-readiness artifacts', async () => {
    const orchestrator = new DialecticOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'test-model'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator.checkProviderReadiness = async () => ({
      ready: true,
      providerId: 'nim-local',
      modelConfirmed: 'test-model',
      rawModels: ['test-model'],
      failureReason: null,
      error: null
    });
    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };

    await orchestrator.ensureProviderReadiness(config, run);
    await orchestrator.ensureProviderReadiness(config, run);

    const readinessArtifacts = artifacts.filter((artifact) => artifact.type === 'provider-readiness');
    assert.strictEqual(readinessArtifacts.length, 1, 'only real readiness probes should write artifacts');
  });

  await test('ensureProviderReadiness checks only providers used by this run', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['nim-used'],
      providers: {
        'nim-used': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'used-model'
        },
        'nim-unused': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8001/v1',
          model: 'unused-model'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);
    const checked = [];

    orchestrator.checkProviderReadiness = async (providerConfig) => {
      checked.push(providerConfig.id);
      return {
        ready: true,
        providerId: providerConfig.id,
        modelConfirmed: providerConfig.model,
        rawModels: [providerConfig.model],
        failureReason: null,
        error: null
      };
    };

    const usedProviderIds = __test.getUsedProviderIds(config);
    await orchestrator.ensureProviderReadiness(config, run, usedProviderIds);

    assert.deepStrictEqual(checked, ['nim-used']);
  });

  await test('buildContextIndex is called exactly once per run when context is configured', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    let buildCalls = 0;

    orchestrator.buildContextIndex = async () => {
      buildCalls += 1;
      return {
        rootDir: path.join(PROJECT_ROOT, 'context'),
        builtAt: Date.now(),
        files: []
      };
    };
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      await orchestrator.ensureContextIndex(config);
      await orchestrator.ensureContextIndex(config);
    } finally {
      console.warn = originalWarn;
    }

    assert.strictEqual(buildCalls, 1, 'context index should be built once and then reused');
  });

  await test('Default stage context policy preserves current full vs digest behavior', async () => {
    const orchestrator = new DialecticOrchestrator();
    const captured = [];

    const planConfig = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude', 'codex'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const planRun = orchestrator.createRun(planConfig);

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'plan/guide.md',
          phase: 'plan',
          sizeBytes: 10,
          content: '# Plan Guide\nDetailed context body.',
          skipped: false,
          purpose: 'Plan reference'
        },
        {
          relativePath: 'review/rubric.md',
          phase: 'review',
          sizeBytes: 10,
          content: '# Review Rubric\nReview context body.',
          skipped: false,
          purpose: 'Review rubric'
        },
        {
          relativePath: 'implement/spec.md',
          phase: 'implement',
          sizeBytes: 10,
          content: '# Implement Spec\nImplement context body.',
          skipped: false,
          purpose: 'Implement spec'
        }
      ]
    };

    const originalRunStep = orchestrator.runStep;
    orchestrator.runStep = async ({ stage, agent, prompt }) => {
      captured.push({ stage, agent, prompt });
      if (stage === 'plan' || stage === 'synthesis' || stage === 'implement' || stage === 'implement-repair') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: `${stage} output`,
          handoffData: {
            goal: 'test goal',
            units: [{ id: '1', title: 'Commit 1' }],
            questions: [],
            status: 'DONE',
            summary: `${stage} summary`
          },
          handoffText: `${stage} handoff`,
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
        handoffData: null,
        handoffText: `${stage} handoff`,
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    try {
      await orchestrator.runPlanMode(planConfig, planRun);

      const implementConfig = normalizeTaskConfig({
        mode: 'implement',
        prompt: 'Implement prompt',
        agents: ['claude', 'codex'],
        context: {
          dir: './context'
        },
        settings: { cwd: '.', timeoutMs: 10000, implementLoops: 1 }
      }, { projectRoot: PROJECT_ROOT });
      const implementRun = orchestrator.createRun(implementConfig);
      await orchestrator.runImplementLoopSequence({
        config: implementConfig,
        run: implementRun,
        loopCount: 1,
        initialImplementNeeded: true,
        implementationPlan: 'Test implementation plan',
        originalPrompt: 'Original prompt',
        customImplementPrompt: null
      });
    } finally {
      orchestrator.runStep = originalRunStep;
    }

    const planStep = captured.find((entry) => entry.stage === 'plan');
    const planReviewStep = captured.find((entry) => entry.stage === 'review');
    const synthesisStep = captured.find((entry) => entry.stage === 'synthesis');
    const implementStep = captured.find((entry) => entry.stage === 'implement');
    const repairStep = captured.find((entry) => entry.stage === 'implement-repair');

    assert.ok(planStep.prompt.includes('<context>'));
    assert.ok(planStep.prompt.includes('Detailed context body.'));
    assert.ok(planReviewStep.prompt.includes('<context-digest>'));
    assert.ok(!planReviewStep.prompt.includes('Detailed context body.'));
    assert.ok(synthesisStep.prompt.includes('<context-digest>'));
    assert.ok(!synthesisStep.prompt.includes('Detailed context body.'));
    assert.ok(implementStep.prompt.includes('<context>'));
    assert.ok(implementStep.prompt.includes('Implement context body.'));
    assert.ok(repairStep.prompt.includes('<context-digest>'));
    assert.ok(!repairStep.prompt.includes('Implement context body.'));
  });

  await test('resolveContextDelivery returns defaults and respects overrides', async () => {
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });

    assert.strictEqual(resolveContextDelivery(config, 'planInitial'), 'full');
    assert.strictEqual(resolveContextDelivery(config, 'planReview'), 'digest');

    const overriddenConfig = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context',
        deliveryPolicy: {
          planInitial: 'digest',
          reviewSynthesis: 'none'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });

    assert.strictEqual(resolveContextDelivery(overriddenConfig, 'planInitial'), 'digest');
    assert.strictEqual(resolveContextDelivery(overriddenConfig, 'reviewSynthesis'), 'none');
    assert.strictEqual(resolveContextDelivery(overriddenConfig, 'implementReview'), 'full');
  });

  await test('resolveContextDeliveryForCycle keeps cycle 1 unchanged and only downgrades full to digest on later cycles', async () => {
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });

    assert.strictEqual(resolveContextDeliveryForCycle(config, 'reviewParallel', null), 'full');
    assert.strictEqual(resolveContextDeliveryForCycle(config, 'reviewParallel', 1), 'full');
    assert.strictEqual(resolveContextDeliveryForCycle(config, 'reviewParallel', 2), 'digest');
    assert.strictEqual(resolveContextDeliveryForCycle(config, 'implementReview', 2), 'digest');
    assert.strictEqual(resolveContextDeliveryForCycle(config, 'planReview', 2), 'digest');
    assert.strictEqual(resolveContextDeliveryForCycle(config, 'reviewSynthesis', 2), 'digest');
    assert.strictEqual(resolveContextDeliveryForCycle(config, 'planInitial', 2), 'full');
  });

  await test('resolveContextDeliveryForCycle respects explicit overrides and never auto-downgrades to none', async () => {
    const explicitOverrideConfig = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context',
        deliveryPolicy: {
          reviewParallel: 'full',
          planReview: 'digest',
          implementReview: 'none'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });

    assert.strictEqual(resolveContextDeliveryForCycle(explicitOverrideConfig, 'reviewParallel', 2), 'full');
    assert.strictEqual(resolveContextDeliveryForCycle(explicitOverrideConfig, 'planReview', 2), 'digest');
    assert.strictEqual(resolveContextDeliveryForCycle(explicitOverrideConfig, 'implementReview', 2), 'none');
  });

  await test('resolveContextDeliveryForCycle may downgrade stages filled by context.deliveryPolicy.default', async () => {
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context',
        deliveryPolicy: {
          default: 'full'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });

    assert.deepStrictEqual(config.context.deliveryPolicyOverrides, {});
    assert.strictEqual(resolveContextDeliveryForCycle(config, 'reviewParallel', 2), 'digest');
    assert.strictEqual(resolveContextDeliveryForCycle(config, 'implementReview', 2), 'digest');
  });

  await test('Unknown internal context delivery stage keys throw immediately', async () => {
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });

    assert.throws(() => {
      resolveContextDelivery(config, 'planSynthesis');
    }, /Unknown context delivery stage key "planSynthesis"/);
  });

  await test('Context deliveryPolicy can suppress or downgrade context by stage', async () => {
    const orchestrator = new DialecticOrchestrator();
    const captured = [];

    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Review prompt',
      agents: ['claude', 'codex'],
      context: {
        dir: './context',
        deliveryPolicy: {
          reviewInitial: 'none',
          reviewParallel: 'digest',
          reviewSynthesis: 'none'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'review/rubric.md',
          phase: 'review',
          sizeBytes: 10,
          content: '# Review Rubric\nReview context body.',
          skipped: false,
          purpose: 'Review rubric'
        }
      ]
    };

    const originalRunStep = orchestrator.runStep;
    orchestrator.runStep = async ({ stage, agent, prompt }) => {
      captured.push({ stage, agent, prompt });
      return {
        agent,
        ok: true,
        exitCode: 0,
        outputText: `${stage} output`,
        handoffData: stage === 'review-synthesis'
          ? { summary: 'done' }
          : null,
        handoffText: `${stage} handoff`,
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    try {
      await orchestrator.runCollaborativeMode({
        mode: 'review',
        prompt: config.prompt,
        config,
        run
      });
    } finally {
      orchestrator.runStep = originalRunStep;
    }

    const initialStep = captured.find((entry) => entry.stage === 'review');
    const parallelStep = captured.find((entry) => entry.stage === 'parallel-review');
    const synthesisStep = captured.find((entry) => entry.stage === 'review-synthesis');

    assert.ok(initialStep);
    assert.ok(!initialStep.prompt.includes('<context>'));
    assert.ok(!initialStep.prompt.includes('<context-digest>'));
    assert.ok(parallelStep.prompt.includes('<context-digest>'));
    assert.ok(!parallelStep.prompt.includes('Review context body.'));
    assert.ok(!synthesisStep.prompt.includes('<context>'));
    assert.ok(!synthesisStep.prompt.includes('<context-digest>'));
  });

  await test('Later review-mode cycles downgrade default reviewParallel prompts to context digests', async () => {
    const orchestrator = new DialecticOrchestrator();
    const captured = [];
    const logs = [];

    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Review prompt',
      agents: ['claude', 'codex', 'gemini'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'review/rubric.md',
          phase: 'review',
          sizeBytes: 10,
          content: '# Review Rubric\nReview context body.',
          skipped: false,
          purpose: 'Review rubric'
        }
      ]
    };

    const originalRunStep = orchestrator.runStep;
    const originalLog = console.log;
    console.log = (message) => logs.push(message);
    orchestrator.runStep = async ({ stage, agent, prompt }) => {
      captured.push({ stage, agent, prompt });
      return {
        agent,
        ok: true,
        exitCode: 0,
        outputText: `${stage} output`,
        handoffData: { summary: `${stage} summary` },
        handoffText: `${stage} handoff`,
        timedOut: false,
        usedFallback: false,
        fallbackReason: null,
        fatalOutputReason: null,
        handoffParseError: null
      };
    };

    try {
      await orchestrator.runCollaborativeMode({
        mode: 'review',
        prompt: config.prompt,
        config,
        run,
        cycleNumber: 2
      });
    } finally {
      orchestrator.runStep = originalRunStep;
      console.log = originalLog;
    }

    const initialStep = captured.find((entry) => entry.stage === 'review');
    const parallelSteps = captured.filter((entry) => entry.stage === 'spec-compliance-review' || entry.stage === 'code-quality-review');
    const synthesisStep = captured.find((entry) => entry.stage === 'review-synthesis');

    assert.ok(initialStep.prompt.includes('<context>'));
    assert.ok(initialStep.prompt.includes('Review context body.'));
    assert.ok(parallelSteps.length > 0);
    for (const step of parallelSteps) {
      assert.ok(step.prompt.includes('<context-digest>'));
      assert.ok(!step.prompt.includes('Review context body.'));
    }
    assert.ok(synthesisStep.prompt.includes('<context-digest>'));
    assert.ok(!synthesisStep.prompt.includes('Review context body.'));
    assert.ok(
      logs.some((line) => line.includes('[context] stage=reviewParallel delivery=digest') && line.includes('(cycle 2 downgrade from full)')),
      'context log should show when cycle-aware downgrade changes reviewParallel from full to digest'
    );
  });

  await test('Digest prompt context carries provider render cap when maxInputChars is set', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['nim-local'],
      context: {
        dir: './context'
      },
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'test-model',
          maxInputChars: 4096
        }
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'plan/guide.md',
          phase: 'plan',
          sizeBytes: 10,
          content: '# Guide\nBody',
          skipped: false
        }
      ]
    };

    const contextPack = await orchestrator.getPromptContextForPhase(config, 'plan', {
      agentName: 'nim-local',
      delivery: 'digest'
    });

    assert.strictEqual(contextPack.renderMode, 'digest');
    assert.strictEqual(contextPack.renderMaxChars, 4096);
  });

  console.log('\norchestrator: Commit 20 - End-to-end coverage');

  await test('Run with both HTTP provider and context folder configured works end-to-end and records artifacts in order', async () => {
    const orchestrator = new DialecticOrchestrator();
    const artifacts = [];
    const initialPlanContent = [
      '1. Goal',
      'Ship the feature safely.',
      'BEGIN_HANDOFF_JSON',
      JSON.stringify({
        goal: 'Ship the feature safely.',
        steps: ['Update the adapter.', 'Run tests.'],
        risks: ['Transient provider failures.'],
        validation: ['Run tests.'],
        questions: [
          {
            id: 'q1',
            question: 'Should we keep the rollout narrow?',
            impact: 'Affects plan scope.',
            agentDefault: 'Yes'
          }
        ]
      }),
      'END_HANDOFF_JSON'
    ].join('\n');
    const synthesisContent = [
      '1. Goal',
      'Ship the feature safely with the clarified scope.',
      'BEGIN_HANDOFF_JSON',
      JSON.stringify({
        goal: 'Ship the feature safely with the clarified scope.',
        steps: ['Update the adapter.', 'Run tests.'],
        risks: ['Transient provider failures.'],
        validation: ['Run tests.'],
        questions: []
      }),
      'END_HANDOFF_JSON'
    ].join('\n');

    const { port, close } = await startSequentialMockHttpServer([
      { choices: [{ message: { content: initialPlanContent } }], model: 'test-model' },
      { choices: [{ message: { content: 'Review feedback: looks good.' } }], model: 'test-model' },
      { choices: [{ message: { content: synthesisContent } }], model: 'test-model' }
    ]);

    try {
      const config = normalizeTaskConfig({
        mode: 'plan',
        prompt: 'Test prompt',
        agents: ['nim-local'],
        context: {
          dir: './context'
        },
        providers: {
          'nim-local': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: 'test-model'
          }
        },
        planQuestionMode: 'autonomous',
        settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
      }, { projectRoot: PROJECT_ROOT });
      const run = orchestrator.createRun(config);

      orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
        artifacts.push(artifact);
      };
      orchestrator.checkProviderReadiness = async () => ({
        ready: true,
        providerId: 'nim-local',
        modelConfirmed: 'test-model',
        rawModels: ['test-model'],
        failureReason: null,
        error: null
      });
      orchestrator.buildContextIndex = async () => ({
        rootDir: path.join(PROJECT_ROOT, 'context'),
        builtAt: Date.now(),
        files: [
          {
            relativePath: 'plan/guide.md',
            phase: 'plan',
            sizeBytes: 10,
            content: 'Guide',
            skipped: false
          }
        ]
      });

      const result = await orchestrator.runMode(config, run);

      assert.ok(result.finalOutput.includes('Ship the feature safely with the clarified scope.'));
      const artifactTypes = artifacts.map((artifact) => artifact.type);
      assert.deepStrictEqual(artifactTypes, [
        'provider-readiness',
        'context-selection',
        'provider-execution',
        'plan-clarifications',
        'context-selection',
        'provider-execution',
        'context-selection',
        'provider-execution'
      ]);
      const contextStageKeys = artifacts
        .filter((artifact) => artifact.type === 'context-selection')
        .map((artifact) => artifact.data.stageKey);
      assert.deepStrictEqual(contextStageKeys, [
        'planInitial',
        'planReview',
        'reviewSynthesis'
      ]);
    } finally {
      await close();
    }
  });
};
