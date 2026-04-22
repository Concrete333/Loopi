const fs = require('fs');
const path = require('path');
const { validateProviderAssignments, __test } = require('../../src/orchestrator');
const {
  assert,
  PROJECT_ROOT,
  LoopiOrchestrator,
  normalizeTaskConfig,
  createConfig,
  createRun
} = require('../orchestrator-test-helpers');

module.exports = async function registerReadinessTests(test) {
  test('getLocalProviderIds includes IPv6 loopback providers', () => {
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://[::1]:8000/v1',
          model: 'test-model'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });

    assert.deepStrictEqual(__test.getLocalProviderIds(config), ['nim-local']);
  });

  test('getLocalProviderIds includes bind-all local providers', () => {
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://0.0.0.0:8000/v1',
          model: 'test-model'
        }
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });

    assert.deepStrictEqual(__test.getLocalProviderIds(config), ['nim-local']);
  });

  test('getLocalProviderIds includes providers explicitly marked local', () => {
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['nim-lan'],
      providers: {
        'nim-lan': {
          type: 'openai-compatible',
          baseUrl: 'http://192.168.1.50:8000/v1',
          model: 'test-model',
          local: true
        }
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });

    assert.deepStrictEqual(__test.getLocalProviderIds(config), ['nim-lan']);
  });

  test('getUsedProviderIds only includes providers referenced by this run', () => {
    const config = normalizeTaskConfig({
      mode: 'review',
      prompt: 'Test prompt',
      agents: ['claude', 'nim-used'],
      providers: {
        'nim-used': {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8000/v1',
          model: 'used-model'
        },
        'nim-unused': {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8001/v1',
          model: 'unused-model'
        }
      },
      roles: {
        reviewer: 'nim-used'
      },
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }, { projectRoot: PROJECT_ROOT });

    const used = __test.getUsedProviderIds(config);
    assert.deepStrictEqual([...used], ['nim-used']);
  });

  console.log('orchestrator: Commit 8 - Provider validation and readiness checks');

  test('HTTP provider as implement origin throws descriptive error', () => {
    const config = createConfig({
      mode: 'implement',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          id: 'nim-local',
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      }
    });

    assert.throws(
      () => validateProviderAssignments(config),
      /does not support write access and cannot be used as the implement origin/
    );
  });

  test('HTTP provider as one-shot implement origin throws descriptive error', () => {
    const config = createConfig({
      mode: 'one-shot',
      agents: ['claude', 'nim-local'],
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 1,
        implementLoopsPerUnit: 1,
        oneShotOrigins: {
          implement: 'nim-local'
        }
      },
      providers: {
        'nim-local': {
          id: 'nim-local',
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      }
    });

    assert.throws(
      () => validateProviderAssignments(config),
      /HTTP provider.*does not support write access/
    );
  });

  test('HTTP provider as reviewer does not throw', () => {
    const config = createConfig({
      mode: 'review',
      agents: ['nim-local', 'claude'],
      providers: {
        'nim-local': {
          id: 'nim-local',
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      }
    });

    assert.doesNotThrow(() => validateProviderAssignments(config));
  });

  test('HTTP provider as one-shot reviewer does not throw', () => {
    const config = createConfig({
      mode: 'one-shot',
      agents: ['claude', 'nim-local'],
      settings: {
        cwd: '.',
        timeoutMs: 10000,
        qualityLoops: 1,
        implementLoopsPerUnit: 1,
        oneShotOrigins: {
          review: 'nim-local'
        }
      },
      providers: {
        'nim-local': {
          id: 'nim-local',
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      }
    });

    assert.doesNotThrow(() => validateProviderAssignments(config));
  });

  test('CLI adapter as implement origin passes validation', () => {
    const config = createConfig({
      mode: 'implement',
      agents: ['claude']
    });

    assert.doesNotThrow(() => validateProviderAssignments(config));
  });

  test('Plan mode does not trigger validation', () => {
    const config = createConfig({
      mode: 'plan',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          id: 'nim-local',
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      }
    });

    assert.doesNotThrow(() => validateProviderAssignments(config));
  });

  await test('ensureProviderReadiness with no providers does nothing', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'review',
      agents: ['claude']
    });

    await orchestrator.ensureProviderReadiness(config, createRun(config));
  });

  await test('ensureProviderReadiness with CLI-only providers does nothing', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'review',
      agents: ['claude', 'codex']
    });

    await orchestrator.ensureProviderReadiness(config, createRun(config));
  });

  console.log('\norchestrator: Commit 8 moved to runMode() - Enforcement boundary');

  test('direct runMode() call rejects HTTP implement origin', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'implement',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          id: 'nim-local',
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      }
    });

    const run = orchestrator.createRun(config);
    let errorThrown = false;
    try {
      await orchestrator.runMode(config, run);
    } catch (error) {
      errorThrown = true;
      assert.match(error.message, /HTTP provider.*does not support write access/);
    }
    assert.ok(errorThrown, 'Expected runMode to throw error');
  });

  await test('direct runMode() performs readiness checks before dispatch', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'review',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          id: 'nim-local',
          type: 'openai-compatible',
          baseUrl: 'http://invalid-host-99999.local/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      }
    });

    const run = orchestrator.createRun(config);

    let errorThrown = false;
    try {
      await orchestrator.runMode(config, run);
    } catch (error) {
      errorThrown = true;
      assert.match(error.message, /is not ready/i, 'Error should indicate provider not ready');
    }

    assert.ok(errorThrown, 'runMode should throw when provider readiness check fails');
  });

  console.log('\norchestrator: Commit 8 - Failed readiness aborts before mode dispatch');

  await test('readiness failure in plan mode prevents dispatch', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'plan',
      agents: ['claude'],
      providers: {
        'nim-local': {
          id: 'nim-local',
          type: 'openai-compatible',
          baseUrl: 'http://invalid-provider-host.local/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      },
      roles: {
        planner: 'nim-local'
      }
    });

    const run = orchestrator.createRun(config);
    let runPlanModeCalled = false;
    const originalRunPlanMode = orchestrator.runPlanMode;
    orchestrator.runPlanMode = async () => {
      runPlanModeCalled = true;
      return { qualityLoops: 0, initialOutput: '', finalOutput: '', feedbackEntries: [] };
    };

    let caughtError = null;
    try {
      await orchestrator.runMode(config, run);
    } catch (error) {
      caughtError = error;
    } finally {
      orchestrator.runPlanMode = originalRunPlanMode;
    }

    assert.strictEqual(runPlanModeCalled, false, 'runPlanMode should not be called when readiness check fails');
    assert.ok(caughtError, 'An error should have been caught');
    assert.match(caughtError.message, /is not ready/i, 'Error should indicate provider not ready');
  });

  await test('readiness failure in review mode prevents dispatch', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'review',
      agents: ['claude'],
      providers: {
        'nim-local': {
          id: 'nim-local',
          type: 'openai-compatible',
          baseUrl: 'http://invalid-provider-host.local/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      },
      roles: {
        reviewer: 'nim-local'
      }
    });

    const run = orchestrator.createRun(config);
    let runCollaborativeModeCalled = false;
    const originalRunCollaborativeMode = orchestrator.runCollaborativeMode;
    orchestrator.runCollaborativeMode = async () => {
      runCollaborativeModeCalled = true;
      return { finalOutput: '', finalHandoffText: '', finalHandoffData: null, feedbackEntries: [] };
    };

    let caughtError = null;
    try {
      await orchestrator.runMode(config, run);
    } catch (error) {
      caughtError = error;
    } finally {
      orchestrator.runCollaborativeMode = originalRunCollaborativeMode;
    }

    assert.strictEqual(runCollaborativeModeCalled, false, 'runCollaborativeMode should not be called when readiness check fails');
    assert.ok(caughtError, 'An error should have been caught');
    assert.match(caughtError.message, /is not ready/i, 'Error should indicate provider not ready');
  });

  await test('HTTP provider as implement origin is rejected by validation (before readiness runs)', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'implement',
      agents: ['nim-local'],
      providers: {
        'nim-local': {
          id: 'nim-local',
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      }
    });

    const run = orchestrator.createRun(config);
    let runIterativeImplementModeCalled = false;
    const originalRunIterativeImplementMode = orchestrator.runIterativeImplementMode;
    orchestrator.runIterativeImplementMode = async () => {
      runIterativeImplementModeCalled = true;
      return { implementLoops: 0, initialOutput: '', finalOutput: '', feedbackEntries: [] };
    };

    let caughtError = null;
    try {
      await orchestrator.runMode(config, run);
    } catch (error) {
      caughtError = error;
    } finally {
      orchestrator.runIterativeImplementMode = originalRunIterativeImplementMode;
    }

    assert.strictEqual(runIterativeImplementModeCalled, false, 'runIterativeImplementMode should not be called when validation rejects HTTP implement origin');
    assert.ok(caughtError, 'An error should have been caught');
    assert.match(caughtError.message, /HTTP provider.*does not support write access/, 'Error should mention HTTP provider write restriction');
  });

  await test('unused failing provider does not block run dispatch', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'plan',
      agents: ['claude'],
      providers: {
        'nim-unused': {
          id: 'nim-unused',
          type: 'openai-compatible',
          baseUrl: 'http://invalid-provider-host.local/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      }
    });

    const run = orchestrator.createRun(config);
    let runPlanModeCalled = false;
    const originalRunPlanMode = orchestrator.runPlanMode;
    orchestrator.runPlanMode = async () => {
      runPlanModeCalled = true;
      return { qualityLoops: 1, initialOutput: 'ok', finalOutput: 'ok', feedbackEntries: [] };
    };

    try {
      await orchestrator.runMode(config, run);
    } finally {
      orchestrator.runPlanMode = originalRunPlanMode;
    }

    assert.strictEqual(runPlanModeCalled, true, 'unused failing provider should not block plan mode dispatch');
  });

  await test('failed readiness aborts before runIterativeImplementMode dispatch', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'implement',
      agents: ['claude'],
      providers: {
        'nim-local': {
          id: 'nim-local',
          type: 'openai-compatible',
          baseUrl: 'http://invalid-provider-host.local/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      },
      roles: {
        reviewer: 'nim-local'
      }
    });

    const run = orchestrator.createRun(config);
    let runIterativeImplementModeCalled = false;
    const originalRunIterativeImplementMode = orchestrator.runIterativeImplementMode;
    orchestrator.runIterativeImplementMode = async () => {
      runIterativeImplementModeCalled = true;
      return { implementLoops: 0, initialOutput: '', finalOutput: '', feedbackEntries: [] };
    };

    let caughtError = null;
    try {
      await orchestrator.runMode(config, run);
    } catch (error) {
      caughtError = error;
    } finally {
      orchestrator.runIterativeImplementMode = originalRunIterativeImplementMode;
    }

    assert.strictEqual(runIterativeImplementModeCalled, false, 'runIterativeImplementMode should not be called when readiness check fails');
    assert.ok(caughtError, 'An error should have been caught');
    assert.match(caughtError.message, /is not ready/i, 'Error should indicate provider not ready');
  });

  console.log('\norchestrator: Commit 8 - Successful readiness allows dispatch');

  await test('successful readiness allows runPlanMode dispatch', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'plan',
      agents: ['claude']
    });

    const run = orchestrator.createRun(config);
    let runPlanModeCalled = false;
    const originalRunPlanMode = orchestrator.runPlanMode;
    orchestrator.runPlanMode = async () => {
      runPlanModeCalled = true;
      return { qualityLoops: 0, initialOutput: '', finalOutput: '', feedbackEntries: [] };
    };

    try {
      await orchestrator.runMode(config, run);
    } catch {}
    finally {
      orchestrator.runPlanMode = originalRunPlanMode;
    }

    assert.strictEqual(runPlanModeCalled, true, 'runPlanMode should be called when config is valid');
  });

  await test('successful readiness allows runCollaborativeMode dispatch', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'review',
      agents: ['claude']
    });

    const run = orchestrator.createRun(config);
    let runCollaborativeModeCalled = false;
    const originalRunCollaborativeMode = orchestrator.runCollaborativeMode;
    orchestrator.runCollaborativeMode = async () => {
      runCollaborativeModeCalled = true;
      return { finalOutput: '', finalHandoffText: '', finalHandoffData: null, feedbackEntries: [] };
    };

    try {
      await orchestrator.runMode(config, run);
    } catch {}
    finally {
      orchestrator.runCollaborativeMode = originalRunCollaborativeMode;
    }

    assert.strictEqual(runCollaborativeModeCalled, true, 'runCollaborativeMode should be called when config is valid');
  });

  await test('successful readiness allows runIterativeImplementMode dispatch', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'implement',
      agents: ['claude']
    });

    const run = orchestrator.createRun(config);
    let runIterativeImplementModeCalled = false;
    const originalRunIterativeImplementMode = orchestrator.runIterativeImplementMode;
    orchestrator.runIterativeImplementMode = async () => {
      runIterativeImplementModeCalled = true;
      return { implementLoops: 0, initialOutput: '', finalOutput: '', feedbackEntries: [] };
    };

    try {
      await orchestrator.runMode(config, run);
    } catch {}
    finally {
      orchestrator.runIterativeImplementMode = originalRunIterativeImplementMode;
    }

    assert.strictEqual(runIterativeImplementModeCalled, true, 'runIterativeImplementMode should be called when config is valid');
  });

  await test('CLI-only config skips readiness cleanly', async () => {
    const orchestrator = new LoopiOrchestrator();
    const config = createConfig({
      mode: 'review',
      agents: ['claude', 'codex']
    });

    await orchestrator.ensureProviderReadiness(config, createRun(config));
  });

  console.log('\norchestrator: Commit 10 - Context root resolution');

  await test('runMode builds context index relative to project root even when settings.cwd is narrowed', async () => {
    const orchestrator = new LoopiOrchestrator();
    const tempContextDirName = '__tmp_commit10_context_root__';
    const tempContextDir = path.join(PROJECT_ROOT, tempContextDirName);
    const tempContextFile = path.join(tempContextDir, 'shared-guidelines.md');

    fs.mkdirSync(tempContextDir, { recursive: true });
    fs.writeFileSync(tempContextFile, 'Project-root context file.', 'utf8');

    const config = normalizeTaskConfig({
      mode: 'plan',
      prompt: 'Test prompt',
      agents: ['claude'],
      context: {
        dir: tempContextDirName
      },
      settings: {
        cwd: 'src',
        timeoutMs: 10000,
        qualityLoops: 1
      }
    }, { projectRoot: PROJECT_ROOT });

    const run = orchestrator.createRun(config);
    const originalRunPlanMode = orchestrator.runPlanMode;
    orchestrator.runPlanMode = async () => ({
      qualityLoops: 0,
      initialOutput: '',
      finalOutput: '',
      feedbackEntries: []
    });

    try {
      await orchestrator.runMode(config, run);
      assert.ok(orchestrator._contextIndex, 'Context index should be built when context is configured');
      assert.strictEqual(orchestrator._contextIndex.rootDir, tempContextDir, 'Context directory should resolve from the project root');
      assert.ok(orchestrator._contextIndex.files.some((file) => file.relativePath === 'shared-guidelines.md'), 'Context index should include the project-root context file');
    } finally {
      orchestrator.runPlanMode = originalRunPlanMode;
      fs.rmSync(tempContextDir, { recursive: true, force: true });
    }
  });
};
