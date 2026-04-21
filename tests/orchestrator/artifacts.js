const path = require('path');
const {
  assert,
  PROJECT_ROOT,
  DialecticOrchestrator,
  normalizeTaskConfig
} = require('../orchestrator-test-helpers');
const { validateArtifactSafe } = require('../../src/artifact-schemas');
const { measureContextSectionChars } = require('../../src/prompts');
const { startMockHttpServer } = require('./http-helpers');

module.exports = async function registerArtifactTests(test) {
  console.log('\norchestrator: Commit 16 - Artifact logging');

  await test('Readiness check writes a provider-readiness artifact', async () => {
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
    orchestrator.runPlanMode = async () => ({ finalOutput: 'done', feedbackEntries: [] });

    await orchestrator.runMode(config, run);

    const readinessArtifact = artifacts.find((artifact) => artifact.type === 'provider-readiness');
    assert.ok(readinessArtifact, 'provider-readiness artifact should be written');
    assert.strictEqual(readinessArtifact.data.providerId, 'nim-local');
    assert.strictEqual(readinessArtifact.data.ready, true);
  });

  await test('HTTP execution writes a provider-execution artifact with correct fields', async () => {
    const orchestrator = new DialecticOrchestrator();
    const artifacts = [];
    const response = {
      choices: [{ message: { content: 'Hello from provider' }, finish_reason: 'stop' }],
      model: 'test-model'
    };
    const { port, close } = await startMockHttpServer(200, response);
    try {
      const config = normalizeTaskConfig({
        mode: 'review',
        prompt: 'Test prompt',
        agents: ['nim-local'],
        providers: {
          'nim-local': {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: 'test-model'
          }
        },
        settings: { cwd: '.', timeoutMs: 10000 }
      }, { projectRoot: PROJECT_ROOT });
      const run = orchestrator.createRun(config);

      orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
        artifacts.push(artifact);
      };

      const step = await orchestrator.runStep({
        run,
        config,
        stage: 'review',
        agent: 'nim-local',
        prompt: 'Hello!',
        cycleNumber: null,
        mode: 'review',
        executionPolicy: { canWrite: false },
        handoffSchema: 'review'
      });

      const executionArtifact = artifacts.find((artifact) => artifact.type === 'provider-execution');
      assert.ok(executionArtifact, 'provider-execution artifact should be written');
      assert.strictEqual(executionArtifact.data.providerId, 'nim-local');
      assert.strictEqual(executionArtifact.data.model, 'test-model');
      assert.strictEqual(executionArtifact.data.ok, true);
      assert.strictEqual(executionArtifact.data.errorType, null);
      assert.ok(executionArtifact.data.executionStartedAt);
      assert.ok(executionArtifact.data.executionCompletedAt);
      assert.strictEqual(executionArtifact.data.promptChars, 'Hello!'.length);
      assert.strictEqual(executionArtifact.data.outputChars, step.outputText.length);
    } finally {
      await close();
    }
  });

  await test('Context selection artifact records stage and delivery for full context', async () => {
    const orchestrator = new DialecticOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator._contextIndex = {
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
    };
    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };
    const originalLog = console.log;
    const logs = [];
    console.log = (message) => logs.push(message);
    let contextPack;

    try {
      contextPack = await orchestrator.getPromptContextForPhase(config, 'plan', {
        agentName: 'claude',
        run,
        delivery: 'full',
        stageKey: 'planInitial'
      });
    } finally {
      console.log = originalLog;
    }

    const contextArtifact = artifacts.find((artifact) => artifact.type === 'context-selection');
    assert.ok(contextArtifact, 'context-selection artifact should be written');
    assert.strictEqual(contextArtifact.data.stageKey, 'planInitial');
    assert.strictEqual(contextArtifact.data.delivery, 'full');
    assert.strictEqual(contextArtifact.data.suppressed, false);
    assert.strictEqual(contextArtifact.data.maxFiles, 10);
    assert.strictEqual(contextArtifact.data.maxChars, 20000);
    assert.strictEqual(contextArtifact.data.providerMaxInputChars, null);
    assert.strictEqual(contextArtifact.data.effectiveMaxChars, contextPack.effectiveMaxChars);
    assert.deepStrictEqual(logs, [
      `[orchestrator] [context] stage=planInitial delivery=full files=1 chars=${measureContextSectionChars(contextPack)}`
    ]);
    assert.ok(Array.isArray(contextArtifact.data.selectionReasons));
    assert.ok(contextArtifact.data.selectionReasons.length > 0);
    assert.strictEqual(contextArtifact.data.selectedFiles[0], contextPack.files[0].relativePath);
    const schemaResult = validateArtifactSafe(contextArtifact);
    assert.strictEqual(schemaResult.ok, true, schemaResult.error && schemaResult.error.message);
  });

  await test('getContextPackForPhase respects mixed-case phase cap keys after normalization', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'implement',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context',
        maxFilesPerPhase: {
          Implement: 1
        },
        maxCharsPerPhase: {
          Implement: 30
        }
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator._contextIndex = {
      rootDir: path.join(PROJECT_ROOT, 'context'),
      builtAt: Date.now(),
      files: [
        {
          relativePath: 'implement/first.md',
          phase: 'implement',
          sizeBytes: 10,
          content: 'First implement note',
          skipped: false
        },
        {
          relativePath: 'implement/second.md',
          phase: 'implement',
          sizeBytes: 10,
          content: 'Second implement note',
          skipped: false
        }
      ]
    };

    const contextPack = await orchestrator.getContextPackForPhase(config, 'implement', 'claude', run);

    assert.strictEqual(contextPack.effectiveMaxChars, 30, 'lowercased maxCharsPerPhase key should be applied at lookup time');
    assert.strictEqual(contextPack.files.length, 1, 'phase file cap should limit the selected files');
    assert.strictEqual(contextPack.files[0].relativePath, 'implement/first.md');
  });

  await test('Cached context selection reuse does not write duplicate context-selection artifacts', async () => {
    const orchestrator = new DialecticOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

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
    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };

    const firstPack = await orchestrator.getContextPackForPhase(config, 'plan', 'claude', run);
    const secondPack = await orchestrator.getContextPackForPhase(config, 'plan', 'claude', run);

    assert.strictEqual(firstPack, secondPack, 'context pack should be reused from the run cache');
    const contextArtifacts = artifacts.filter((artifact) => artifact.type === 'context-selection');
    assert.strictEqual(contextArtifacts.length, 1, 'cached context reuse should not log duplicate selection artifacts');
  });

  await test('Context pack cache keys include delivery mode explicitly', async () => {
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

    const fullPack = await orchestrator.getContextPackForPhase(config, 'plan', 'claude', null, 'full');
    const digestPack = await orchestrator.getContextPackForPhase(config, 'plan', 'claude', null, 'digest');

    assert.notStrictEqual(
      fullPack,
      digestPack,
      'full and digest deliveries should not share the same cached context-pack entry implicitly'
    );
  });

  await test('Digest and full context selections write distinct stage-aware artifacts', async () => {
    const orchestrator = new DialecticOrchestrator();
    const artifacts = [];
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
          maxInputChars: 100
        }
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

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
    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };
    const originalLog = console.log;
    const logs = [];
    console.log = (message) => logs.push(message);
    let fullContextPack;
    let digestContextPack;

    try {
      fullContextPack = await orchestrator.getPromptContextForPhase(config, 'plan', {
        agentName: 'nim-local',
        run,
        delivery: 'full',
        stageKey: 'planInitial'
      });
      digestContextPack = await orchestrator.getPromptContextForPhase(config, 'plan', {
        agentName: 'nim-local',
        run,
        delivery: 'digest',
        stageKey: 'planReview'
      });
    } finally {
      console.log = originalLog;
    }

    const contextArtifacts = artifacts.filter((artifact) => artifact.type === 'context-selection');
    assert.strictEqual(contextArtifacts.length, 2);
    assert.deepStrictEqual(
      contextArtifacts.map((artifact) => artifact.data.stageKey),
      ['planInitial', 'planReview']
    );
    assert.deepStrictEqual(
      contextArtifacts.map((artifact) => artifact.data.delivery),
      ['full', 'digest']
    );
    assert.deepStrictEqual(
      contextArtifacts.map((artifact) => artifact.data.providerMaxInputChars),
      [100, null]
    );
    assert.deepStrictEqual(
      contextArtifacts.map((artifact) => artifact.data.effectiveMaxChars),
      [60, 20000]
    );
    assert.deepStrictEqual(logs, [
      `[orchestrator] [context] stage=planInitial delivery=full files=1 chars=${measureContextSectionChars(fullContextPack)}`,
      `[orchestrator] [context] stage=planReview delivery=digest files=1 chars=${measureContextSectionChars(digestContextPack)}`
    ]);
    for (const artifact of contextArtifacts) {
      const schemaResult = validateArtifactSafe(artifact);
      assert.strictEqual(schemaResult.ok, true, schemaResult.error && schemaResult.error.message);
    }
  });

  await test('None delivery writes a suppressed context-selection artifact and log entry', async () => {
    const orchestrator = new DialecticOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
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
          content: '# Rubric\nBody',
          skipped: false
        }
      ]
    };
    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };
    const originalLog = console.log;
    const logs = [];
    console.log = (message) => logs.push(message);
    let contextPack;

    try {
      contextPack = await orchestrator.getPromptContextForPhase(config, 'review', {
        agentName: 'claude',
        run,
        delivery: 'none',
        stageKey: 'reviewInitial'
      });
    } finally {
      console.log = originalLog;
    }

    assert.strictEqual(contextPack, null);
    const contextArtifact = artifacts.find((artifact) => artifact.type === 'context-selection');
    assert.ok(contextArtifact, 'suppressed context-selection artifact should be written');
    assert.strictEqual(contextArtifact.data.phase, 'review');
    assert.strictEqual(contextArtifact.data.stageKey, 'reviewInitial');
    assert.strictEqual(contextArtifact.data.delivery, 'none');
    assert.strictEqual(contextArtifact.data.suppressed, true);
    assert.deepStrictEqual(contextArtifact.data.selectedFiles, []);
    assert.deepStrictEqual(contextArtifact.data.selectionReasons, []);
    assert.deepStrictEqual(logs, ['[orchestrator] [context] stage=reviewInitial delivery=none files=0 chars=0']);
    const schemaResult = validateArtifactSafe(contextArtifact);
    assert.strictEqual(schemaResult.ok, true, schemaResult.error && schemaResult.error.message);
  });

  await test('Context delivery logs respect DIALECTIC_SILENT', async () => {
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

    const originalLog = console.log;
    const originalSilent = process.env.DIALECTIC_SILENT;
    const logs = [];
    console.log = (message) => logs.push(message);
    process.env.DIALECTIC_SILENT = '1';

    try {
      await orchestrator.getPromptContextForPhase(config, 'plan', {
        agentName: 'claude',
        run: null,
        delivery: 'digest',
        stageKey: 'planReview'
      });
    } finally {
      console.log = originalLog;
      if (originalSilent === undefined) {
        delete process.env.DIALECTIC_SILENT;
      } else {
        process.env.DIALECTIC_SILENT = originalSilent;
      }
    }

    assert.deepStrictEqual(logs, []);
  });

  await test('Equivalent selections reused across agents write one context-selection artifact', async () => {
    const orchestrator = new DialecticOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['claude', 'codex'],
      context: {
        dir: './context'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
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
          content: '# Rubric\nBody',
          skipped: false
        }
      ]
    };
    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };

    await orchestrator.getContextPackForPhase(config, 'review', 'claude', run, 'full');
    await orchestrator.getContextPackForPhase(config, 'review', 'codex', run, 'full');

    const contextArtifacts = artifacts.filter((artifact) => artifact.type === 'context-selection');
    assert.strictEqual(contextArtifacts.length, 1, 'equivalent selections should log one artifact');
  });

  await test('Plan clarifications write a plan-clarifications artifact with usedDefault', async () => {
    const orchestrator = new DialecticOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      planQuestionMode: 'autonomous',
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);
    const originalRunStep = orchestrator.runStep;

    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };
    orchestrator.runStep = async ({ stage, agent }) => {
      if (stage === 'plan') {
        return {
          agent,
          ok: true,
          exitCode: 0,
          outputText: 'Initial plan draft',
          handoffData: {
            goal: 'test goal',
            units: [{ id: '1', title: 'Commit 1' }],
            questions: [
              {
                id: 'q1',
                question: 'Should we batch the migration?',
                impact: 'Changes rollout strategy',
                agentDefault: 'Yes, batch it'
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

      return {
        agent,
        ok: true,
        exitCode: 0,
        outputText: `${stage} output`,
        handoffData: { goal: 'test goal', units: [{ id: '1', title: 'Commit 1' }], questions: [] },
        handoffText: `${stage} handoff`,
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

    const clarificationsArtifact = artifacts.find((artifact) => artifact.type === 'plan-clarifications');
    assert.ok(clarificationsArtifact, 'plan-clarifications artifact should be written');
    assert.strictEqual(clarificationsArtifact.data.clarifications[0].usedDefault, true);
    assert.strictEqual(clarificationsArtifact.data.clarifications[0].answer, 'Yes, batch it');
  });

  await test('Failed HTTP execution artifact has ok false and errorType', async () => {
    const orchestrator = new DialecticOrchestrator();
    const artifacts = [];
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          model: 'test-model'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    orchestrator.collaborationStore.writeArtifact = async (_taskId, artifact) => {
      artifacts.push(artifact);
    };

    await orchestrator.runStep({
      run,
      config,
      stage: 'review',
      agent: 'nim-local',
      prompt: 'Hello!',
      cycleNumber: null,
      mode: 'review',
      executionPolicy: { canWrite: false },
      handoffSchema: 'review'
    });

    const executionArtifact = artifacts.find((artifact) => artifact.type === 'provider-execution');
    assert.ok(executionArtifact, 'provider-execution artifact should be written');
    assert.strictEqual(executionArtifact.data.ok, false);
    assert.strictEqual(executionArtifact.data.errorType, 'connection_failure');
  });

  await test('HTTP review failure surfaces provider error details instead of undefined exit code', async () => {
    const orchestrator = new DialecticOrchestrator();
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          model: 'test-model'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000 }
    }, { projectRoot: PROJECT_ROOT });
    const run = orchestrator.createRun(config);

    const step = await orchestrator.runStep({
      run,
      config,
      stage: 'review',
      agent: 'nim-local',
      prompt: 'Hello!',
      cycleNumber: null,
      mode: 'review',
      executionPolicy: { canWrite: false },
      handoffSchema: 'review'
    });

    assert.throws(() => {
      orchestrator.assertStepSucceeded(step, config);
    }, (error) => {
      assert.match(error.message, /connection_failure/i);
      assert.doesNotMatch(error.message, /exit code undefined/i);
      return true;
    });
  });
};
