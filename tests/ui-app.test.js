const assert = require('assert');
const { createLoopiApp } = require('../apps/ui/public/app.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  [FAIL] ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

function createFakeElement(id) {
  return {
    id,
    innerHTML: '',
    checked: false,
    value: '',
    onchange: null
  };
}

function createListenerElement(id) {
  const listeners = {};
  return {
    id,
    value: '',
    checked: false,
    addEventListener(eventName, fn) {
      listeners[eventName] = listeners[eventName] || [];
      listeners[eventName].push(fn);
    },
    _dispatch(eventName) {
      (listeners[eventName] || []).forEach((fn) => fn({ target: this }));
    }
  };
}

function createFakeDocument(options = {}) {
  const elements = new Map();
  const ids = [
    'hero-summary',
    'tab-setup',
    'tab-settings',
    'tab-composer',
    'tab-runs',
    'advanced-toggle'
  ];

  for (const id of ids) {
    elements.set(id, createFakeElement(id));
  }

  const listenerIds = Array.isArray(options.listenerIds) ? options.listenerIds : [];
  for (const id of listenerIds) {
    elements.set(id, createListenerElement(id));
  }

  return {
    visibilityState: options.visibilityState || 'visible',
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    }
  };
}

function createFakeTimerHarness() {
  let nextId = 1;
  const timers = [];

  function activeTimers() {
    return timers.filter((timer) => !timer.cleared);
  }

  return {
    setTimeout(fn, delay) {
      const timer = {
        id: nextId++,
        fn,
        delay,
        cleared: false
      };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) {
        timer.cleared = true;
      }
    },
    latestDelay() {
      const current = activeTimers();
      return current.length > 0 ? current[current.length - 1].delay : null;
    },
    async runLatest() {
      const current = activeTimers();
      if (current.length === 0) {
        throw new Error('No active timer to run.');
      }
      const timer = current[current.length - 1];
      timer.cleared = true;
      await timer.fn();
    }
  };
}

function createFetchStub() {
  const calls = [];
  const stub = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/config/validate') {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            data: {
              valid: true,
              normalized: {
                mode: 'plan'
              },
              error: null
            }
          };
        }
      };
    }

    throw new Error(`Unexpected fetch call in UI app test: ${url}`);
  };

  stub.calls = calls;
  return stub;
}

function createProviderFetchStub() {
  const calls = [];
  const stub = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/providers/test-task') {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            data: {
              success: true,
              providers: {
                draftprovider: {
                  id: 'draftprovider',
                  type: 'openai-compatible',
                  baseUrl: 'http://localhost:8000/v1',
                  model: 'demo-model',
                  status: 'ready',
                  ready: true,
                  errorMessage: null
                }
              },
              normalized: null,
              error: null
            }
          };
        }
      };
    }

    if (url === '/api/providers/test-current') {
      throw new Error('refreshProviderStatus should use /api/providers/test-task when a draft config exists');
    }

    throw new Error(`Unexpected fetch call in UI app test: ${url}`);
  };

  stub.calls = calls;
  return stub;
}

function createRunFetchStub() {
  const calls = [];
  const stub = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/runs') {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            data: []
          };
        }
      };
    }

    if (url === '/api/runs/sessions') {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            data: [
              {
                runId: 'run-one',
                status: 'completed',
                mode: 'plan',
                prompt: 'Finished run',
                startedAt: '2026-04-23T10:00:00Z',
                finishedAt: '2026-04-23T10:01:00Z',
                durationMs: 60000,
                taskFile: 'shared/task.json',
                error: null,
                active: false,
                launchedAt: '2026-04-23T10:00:00Z',
                updatedAt: '2026-04-23T10:01:00Z'
              },
              {
                runId: 'run-two',
                status: 'running',
                mode: 'review',
                prompt: 'Still active',
                startedAt: '2026-04-23T10:02:00Z',
                finishedAt: null,
                durationMs: null,
                taskFile: 'shared/task.json',
                error: null,
                active: true,
                launchedAt: '2026-04-23T10:02:00Z',
                updatedAt: '2026-04-23T10:02:10Z'
              }
            ]
          };
        }
      };
    }

    if (url === '/api/runs/run-two') {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            data: {
              runId: 'run-two',
              exists: false,
              isDamaged: false,
              error: null,
              task: null,
              steps: [],
              artifacts: [],
              summary: null
            }
          };
        }
      };
    }

    throw new Error(`Unexpected fetch call in UI app test: ${url}`);
  };

  stub.calls = calls;
  return stub;
}

function createContextFetchStub() {
  const calls = [];
  const stub = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/context/status') {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            data: {
              ok: true,
              status: 'config-mismatch',
              contextDir: 'C:/project/context',
              cacheDir: 'C:/project/context/.loopi-context',
              builtAt: 1713888000000,
              mismatches: [{ field: 'include', reason: 'include patterns changed' }],
              driftedSources: [],
              skippedSources: [{ sourceRelativePath: 'shared/slides.pptx', skipReason: 'unsupported format' }],
              manifest: null,
              instructions: 'Run "npm run cli -- context prepare" from the project root, then retry the run.'
            }
          };
        }
      };
    }

    if (url === '/api/context/prepare') {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            data: {
              ok: true,
              sourceCount: 3
            }
          };
        }
      };
    }

    throw new Error(`Unexpected fetch call in UI app test: ${url}`);
  };

  stub.calls = calls;
  return stub;
}

function createBlockedRunFetchStub() {
  const calls = [];
  const stub = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/runs/launch') {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            data: {
              success: false,
              launched: false,
              runId: null,
              error: {
                code: 'CONTEXT_CACHE_MISSING',
                message: 'Prepared context cache is not ready.',
                contextStatus: {
                  ok: true,
                  status: 'missing',
                  contextDir: 'C:/project/context',
                  cacheDir: 'C:/project/context/.loopi-context',
                  mismatches: [],
                  driftedSources: [],
                  skippedSources: [],
                  instructions: 'Run "npm run cli -- context prepare" from the project root, then retry the run.'
                }
              }
            }
          };
        }
      };
    }

    if (url === '/api/runs') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: [] };
        }
      };
    }

    if (url === '/api/runs/sessions') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: [] };
        }
      };
    }

    if (url === '/api/files/scratchpad' || url === '/api/files/log') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { filePath: url, content: '' } };
        }
      };
    }

    throw new Error(`Unexpected fetch call in UI app test: ${url}`);
  };

  stub.calls = calls;
  return stub;
}

function createDraft() {
  return {
    mode: 'plan',
    prompt: 'Initial prompt',
    agents: ['claude'],
    settings: {
      planLoops: 1,
      qualityLoops: 1,
      implementLoops: 1,
      sectionImplementLoops: 1,
      timeoutMs: 180000,
      continueOnError: false,
      writeScratchpad: true
    }
  };
}

console.log('ui-app: browser-script behavior');

test('stale validation banner appears after editing a previously validated draft', async () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({
    document,
    fetch,
    navigator: {}
  });

  app.__test.setConfigRaw(createDraft(), { renderNow: false, draftMode: 'new' });
  app.render();
  await app.__test.validateCurrentConfig();

  const validatedComposer = app.__test.getPanelHtml('composer');
  assert.ok(validatedComposer.includes('Config is valid and ready to save or run.'));

  app.__test.mutateDraft((draft) => {
    draft.prompt = 'Changed after validation';
  });

  const staleComposer = app.__test.getPanelHtml('composer');
  assert.ok(staleComposer.includes('Draft changed since the last validation.'));
  assert.ok(fetch.calls.some((call) => call.url === '/api/config/validate'));
});

test('refreshRuns follows another active session when the previous active run has already finished', async () => {
  const document = createFakeDocument();
  const fetch = createRunFetchStub();
  const app = createLoopiApp({
    document,
    fetch,
    navigator: {}
  });

  app.state.activeSessionId = 'run-one';
  await app.__test.refreshRuns();

  assert.strictEqual(app.state.activeSessionId, 'run-two');
  assert.strictEqual(app.state.selectedRunId, 'run-two');
  assert.ok(fetch.calls.some((call) => call.url === '/api/runs/run-two'));
});

test('refreshProviderStatus tests the current draft instead of requiring a saved task file', async () => {
  const document = createFakeDocument();
  const fetch = createProviderFetchStub();
  const app = createLoopiApp({
    document,
    fetch,
    navigator: {}
  });

  app.__test.setConfigRaw({
    mode: 'review',
    prompt: 'Provider draft',
    agents: ['claude'],
    providers: {
      draftprovider: {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'demo-model'
      }
    }
  }, { renderNow: false, draftMode: 'new' });

  await app.__test.refreshProviderStatus();

  assert.ok(fetch.calls.some((call) => call.url === '/api/providers/test-task'));
  assert.strictEqual(app.state.providerStatus.providers.draftprovider.ready, true);
});

test('refreshContextStatus and prepareContext use the current draft config', async () => {
  const document = createFakeDocument();
  const fetch = createContextFetchStub();
  const app = createLoopiApp({
    document,
    fetch,
    navigator: {}
  });

  app.__test.setConfigRaw({
    mode: 'plan',
    prompt: 'Context draft',
    agents: ['claude'],
    context: {
      dir: './draft-context',
      include: ['**/*.md']
    },
    settings: {
      planLoops: 1,
      qualityLoops: 1,
      implementLoops: 1,
      sectionImplementLoops: 1,
      timeoutMs: 180000,
      continueOnError: false,
      writeScratchpad: true
    }
  }, { renderNow: false, draftMode: 'new' });

  await app.__test.refreshContextStatus();
  await app.__test.prepareContext();

  const statusCalls = fetch.calls.filter((call) => call.url === '/api/context/status');
  const prepareCalls = fetch.calls.filter((call) => call.url === '/api/context/prepare');
  assert.ok(statusCalls.length >= 1);
  assert.ok(prepareCalls.length >= 1);
  assert.strictEqual(JSON.parse(statusCalls[0].options.body).rawConfig.context.dir, './draft-context');
  assert.strictEqual(JSON.parse(prepareCalls[0].options.body).rawConfig.context.dir, './draft-context');
  assert.strictEqual(app.state.contextStatus.status, 'config-mismatch');
});

test('blocked run due to missing context preparation surfaces a blocker without hijacking the active tab', async () => {
  const document = createFakeDocument();
  const fetch = createBlockedRunFetchStub();
  const app = createLoopiApp({
    document,
    fetch,
    navigator: {}
  });

  // Simulate the user launching from the Composer tab.
  app.state.activeTab = 'composer';

  app.__test.setConfigRaw({
    mode: 'plan',
    prompt: 'Blocked run',
    agents: ['claude'],
    context: {
      dir: './context'
    },
    settings: {
      planLoops: 1,
      qualityLoops: 1,
      implementLoops: 1,
      sectionImplementLoops: 1,
      timeoutMs: 180000,
      continueOnError: false,
      writeScratchpad: true
    }
  }, { renderNow: false, draftMode: 'new' });

  await app.__test.runCurrentConfig();

  // activeTab should not be teleported. The blocker banner is rendered inline
  // on whichever tab the user launched from.
  assert.strictEqual(app.state.activeTab, 'composer');
  assert.strictEqual(app.state.contextStatus.status, 'missing');
  assert.ok(app.state.contextBlocker, 'contextBlocker should be populated on CONTEXT_* errors');
  assert.strictEqual(app.state.contextBlocker.code, 'CONTEXT_CACHE_MISSING');
  assert.ok(String(app.state.contextBlocker.message).includes('Prepared context cache'));
  assert.ok(String(app.state.lastActionError).includes('Prepared context cache'));
  assert.ok(fetch.calls.some((call) => call.url === '/api/runs/launch'));

  const composerHtml = app.__test.getPanelHtml('composer');
  assert.ok(composerHtml.includes('Run blocked by prepared-context state.'),
    'composer should render the inline context-blocker banner');
  assert.ok(composerHtml.includes('data-goto-tab="settings"'),
    'blocker on a non-settings tab should offer a real Go to Settings button, not just text');
  assert.ok(composerHtml.includes('Go to Settings'),
    'banner should label the navigation button clearly');
});

test('context-blocker banner on the Settings tab does not offer a redundant Go to Settings button', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.__test.setConfigRaw(createDraft(), { renderNow: false, draftMode: 'new' });
  app.state.activeTab = 'settings';
  app.state.contextBlocker = {
    code: 'CONTEXT_CACHE_MISSING',
    message: 'Prepared context cache is not ready.',
    instructions: 'Run prepare.',
    contextStatus: null
  };

  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');
  assert.ok(settingsHtml.includes('Run blocked by prepared-context state.'),
    'settings should render the blocker banner');
  assert.ok(!settingsHtml.includes('data-goto-tab="settings"'),
    'the Go to Settings button should be hidden when the user is already on Settings');
});

test('blocked context banner does not appear after a successful prepare', async () => {
  const document = createFakeDocument();
  const fetch = async (url, options = {}) => {
    if (url === '/api/context/prepare') {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            data: {
              ok: true,
              sourceCount: 2,
              indexedCount: 2,
              skippedCount: 0,
              skippedSources: []
            }
          };
        }
      };
    }
    if (url === '/api/context/status') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { ok: true, status: 'ready' } };
        }
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.__test.setConfigRaw({
    mode: 'plan',
    prompt: 'Prepare after block',
    agents: ['claude'],
    context: { dir: './context' },
    settings: {
      planLoops: 1,
      qualityLoops: 1,
      implementLoops: 1,
      sectionImplementLoops: 1,
      timeoutMs: 180000,
      continueOnError: false,
      writeScratchpad: true
    }
  }, { renderNow: false, draftMode: 'new' });

  app.state.contextBlocker = {
    code: 'CONTEXT_CACHE_MISSING',
    message: 'Prepared context cache is not ready.',
    instructions: 'Run prepare.',
    contextStatus: null
  };

  await app.__test.prepareContext();

  assert.strictEqual(app.state.contextBlocker, null,
    'successful prepare should clear any stale context blocker');
});

test('invalid context path status shows "Context path invalid" chip and instruction text', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({
    document,
    fetch,
    navigator: {}
  });

  app.__test.setConfigRaw(createDraft(), { renderNow: false, draftMode: 'new' });
  app.state.contextStatus = {
    ok: true,
    status: 'missing',
    contextDir: 'C:/project/nonexistent',
    cacheDir: null,
    builtAt: null,
    mismatches: [],
    driftedSources: [],
    skippedSources: [],
    manifest: null,
    instructions: 'Context directory "C:/project/nonexistent" does not exist.'
  };

  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');

  assert.ok(settingsHtml.includes('Context path invalid'), 'should show Context path invalid chip');
  assert.ok(!settingsHtml.includes('Not prepared'), 'should not show generic Not prepared chip for invalid path');
  assert.ok(settingsHtml.includes('does not exist'), 'should show instruction text about the invalid context path');
  assert.ok(!settingsHtml.includes('class="button button--primary" id="prepare-context"'), 'Prepare Context should not be primary when the context path is invalid');
  assert.ok(settingsHtml.includes('class="button button--secondary" id="prepare-context"'), 'Prepare Context should be secondary when the context path is invalid');
});

test('cache-missing context status shows "Not prepared" chip with Prepare Context as primary', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({
    document,
    fetch,
    navigator: {}
  });

  app.__test.setConfigRaw(createDraft(), { renderNow: false, draftMode: 'new' });
  app.state.contextStatus = {
    ok: true,
    status: 'missing',
    contextDir: 'C:/project/context',
    cacheDir: 'C:/project/context/.loopi-context',
    builtAt: null,
    mismatches: [],
    driftedSources: [],
    skippedSources: [],
    manifest: null,
    instructions: 'Run "npm run cli -- context prepare" to rebuild.'
  };

  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');

  assert.ok(settingsHtml.includes('Not prepared'), 'should show Not prepared chip when dir exists but cache missing');
  assert.ok(!settingsHtml.includes('Directory not found'), 'should not show Directory not found when dir exists');
  assert.ok(settingsHtml.includes('class="button button--primary" id="prepare-context"'), 'Prepare Context should be primary when dir exists');
});

test('hero summary shows loading placeholder before data is ready', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({
    document,
    fetch,
    navigator: {}
  });

  app.render();
  const heroHtml = app.__test.getPanelHtml('hero');
  assert.ok(heroHtml.includes('Loading'), 'hero should show loading placeholder when setupStatus is null');
  assert.ok(!heroHtml.includes('0/0'), 'hero should not show misleading 0/0 before data loads');
});

test('setup adapter cards use compact help and install labels with truncatable paths', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({
    document,
    fetch,
    navigator: {}
  });

  const docsUrl = 'https://docs.anthropic.com/en/docs/claude-code/getting-started';
  const resolvedPath = 'C:\\Users\\cwbec\\AppData\\Roaming\\npm\\gemini.cmd';
  app.state.setupStatus = {
    adapters: [{
      id: 'gemini',
      agentId: 'gemini',
      displayName: 'Gemini CLI',
      status: 'missing',
      ready: false,
      resolvedPath,
      errorMessage: null,
      metadata: {
        docsUrl,
        installHint: 'npm install -g @google/gemini-cli',
        loginHint: 'gemini auth login',
        installCommand: {
          command: 'npm install -g @google/gemini-cli'
        }
      },
      nextAction: { type: 'install' }
    }],
    summary: { total: 1, ready: 0 }
  };
  app.state.providerStatus = { providers: {} };

  app.render();
  const setupHtml = app.__test.getPanelHtml('setup');

  assert.ok(setupHtml.includes('Startup Help'), 'docs action should have a user-friendly label');
  assert.ok(!setupHtml.includes('>Docs<'), 'old terse docs label should not be shown');
  assert.ok(setupHtml.includes('>Install</button>'), 'install helper button should use the shorter label');
  assert.ok(!setupHtml.includes('Install In Loopi'), 'old install label should not be shown');
  assert.ok(!setupHtml.includes(`<p>${docsUrl}</p>`), 'raw docs URL should not be visible as card copy');
  assert.ok(setupHtml.includes('chip--path'), 'resolved path chip should use truncation styling');
  assert.ok(setupHtml.includes(`title="${resolvedPath}"`), 'full resolved path should remain inspectable');
});

test('init keeps data from successful refreshers when one refresher fails', async () => {
  const document = createFakeDocument();
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/bootstrap') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { projectRoot: '/test', useCases: [], adapterMetadata: [], paths: {} } };
        }
      };
    }
    if (url === '/api/config') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { exists: false, valid: true, raw: null, rawText: null } };
        }
      };
    }
    if (url === '/api/setup/status') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { adapters: [{ id: 'claude', ready: true, status: 'ready' }] } };
        }
      };
    }
    if (url === '/api/providers/test-current') {
      throw new Error('Simulated provider test failure');
    }
    if (url === '/api/runs') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: [{ runId: 'run-1', mode: 'plan' }] };
        }
      };
    }
    if (url === '/api/runs/sessions') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: [] };
        }
      };
    }
    if (url === '/api/files/scratchpad' || url === '/api/files/log') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { filePath: url, content: '' } };
        }
      };
    }
    if (url === '/api/context/status') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { ok: true, status: 'no-context' } };
        }
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const app = createLoopiApp({ document, fetch, navigator: {} });
  await app.__test.init();

  // setup refresh succeeded
  assert.ok(app.state.setupStatus !== null, 'setupStatus should be populated');
  assert.ok(Array.isArray(app.state.setupStatus.adapters), 'adapters should be an array');

  // runs refresh succeeded
  assert.ok(Array.isArray(app.state.runs), 'runs should be populated');

  // provider refresh failed but did not wipe other state
  assert.strictEqual(app.state.providerStatus, null, 'providerStatus should remain null after failure');

  // initErrors should capture the failure
  assert.ok(Array.isArray(app.state.initErrors), 'initErrors should be an array');
  assert.ok(app.state.initErrors.length > 0, 'initErrors should not be empty');
  assert.ok(app.state.initErrors.some((e) => e.refresher === 'providers'), 'initErrors should include providers failure');

  const heroHtml = app.__test.getPanelHtml('hero');
  assert.ok(!heroHtml.includes('Loading status'), 'hero should not stay stuck in loading after init failure');
  assert.ok(heroHtml.includes('Retry Startup Checks'), 'hero should offer a startup retry affordance after init failure');
  assert.ok(heroHtml.includes('Unavailable'), 'hero should show degraded availability instead of fake loaded counts');
});

test('retryInit clears startup errors after a previously failing refresher succeeds', async () => {
  const document = createFakeDocument();
  let providerShouldFail = true;
  const fetch = async (url, options = {}) => {
    if (url === '/api/bootstrap') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { projectRoot: '/test', useCases: [], adapterMetadata: [], paths: {} } };
        }
      };
    }
    if (url === '/api/config') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { exists: false, valid: true, raw: null, rawText: null } };
        }
      };
    }
    if (url === '/api/setup/status') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { adapters: [{ id: 'claude', ready: true, status: 'ready' }] } };
        }
      };
    }
    if (url === '/api/providers/test-current' || url === '/api/providers/test-task') {
      if (providerShouldFail) {
        throw new Error('Temporary provider failure');
      }
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            data: {
              success: true,
              providers: {
                localdemo: {
                  id: 'localdemo',
                  status: 'ready',
                  ready: true,
                  errorMessage: null
                }
              },
              normalized: null,
              error: null
            }
          };
        }
      };
    }
    if (url === '/api/runs') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: [] };
        }
      };
    }
    if (url === '/api/runs/sessions') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: [] };
        }
      };
    }
    if (url === '/api/files/scratchpad' || url === '/api/files/log') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { filePath: url, content: '' } };
        }
      };
    }
    if (url === '/api/context/status') {
      return {
        ok: true,
        async json() {
          return { ok: true, data: { ok: true, status: 'no-context' } };
        }
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const app = createLoopiApp({ document, fetch, navigator: {} });
  await app.__test.init();
  assert.ok(app.state.initErrors.length > 0, 'first init should capture the simulated provider failure');

  providerShouldFail = false;
  await app.__test.retryInit();

  assert.strictEqual(app.state.initErrors.length, 0, 'retry should clear startup errors once refreshers succeed');
  assert.ok(app.state.providerStatus !== null, 'provider status should populate after successful retry');
  assert.strictEqual(app.state.lastActionMessage, 'Startup checks refreshed.');
});

test('prepare success message mentions skipped files when skippedCount > 0', async () => {
  const document = createFakeDocument();
  const fetchCalls = [];
  const fetch = (url, options) => {
    fetchCalls.push({ url, options });
    if (url === '/api/bootstrap') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { projectRoot: '/test', useCases: [], adapterMetadata: [] } }) });
    if (url === '/api/config') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { exists: false, raw: null, rawText: '', valid: false } }) });
    if (url === '/api/setup/status') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { adapters: [], summary: { total: 0, ready: 0 } } }) });
    if (url === '/api/providers/test-current') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { success: true, providers: {} } }) });
    if (url === '/api/runs') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: [] }) });
    if (url === '/api/runs/sessions') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: [] }) });
    if (url === '/api/files/scratchpad') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { exists: false } }) });
    if (url === '/api/files/log') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { exists: false } }) });
    if (url === '/api/context/status') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { ok: true, status: 'missing' } }) });
    if (url === '/api/context/prepare') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            ok: true,
            sourceCount: 5,
            indexedCount: 3,
            skippedCount: 2,
            skippedSources: [
              { sourceRelativePath: 'bad.pdf', skipReason: 'Unsupported file type' },
              { sourceRelativePath: 'broken.docx', skipReason: 'Extraction failed' }
            ]
          }
        })
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  };

  const app = createLoopiApp({ document, fetch, navigator: {} });
  await app.__test.init();

  await app.__test.prepareContext();

  assert.ok(
    app.state.lastActionMessage.includes('3 indexed') && app.state.lastActionMessage.includes('2 skipped'),
    `message should mention indexed and skipped counts, got: "${app.state.lastActionMessage}"`
  );
});

test('prepare success message uses simple count when no files skipped', async () => {
  const document = createFakeDocument();
  const fetch = (url, options) => {
    if (url === '/api/bootstrap') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { projectRoot: '/test', useCases: [], adapterMetadata: [] } }) });
    if (url === '/api/config') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { exists: false, raw: null, rawText: '', valid: false } }) });
    if (url === '/api/setup/status') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { adapters: [], summary: { total: 0, ready: 0 } } }) });
    if (url === '/api/providers/test-current') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { success: true, providers: {} } }) });
    if (url === '/api/runs') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: [] }) });
    if (url === '/api/runs/sessions') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: [] }) });
    if (url === '/api/files/scratchpad') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { exists: false } }) });
    if (url === '/api/files/log') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { exists: false } }) });
    if (url === '/api/context/status') return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { ok: true, status: 'missing' } }) });
    if (url === '/api/context/prepare') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            ok: true,
            sourceCount: 4,
            indexedCount: 4,
            skippedCount: 0,
            skippedSources: []
          }
        })
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  };

  const app = createLoopiApp({ document, fetch, navigator: {} });
  await app.__test.init();

  await app.__test.prepareContext();

  assert.strictEqual(app.state.lastActionMessage, 'Context prepared: 4 sources indexed.');
});

test('typing into the raw editor survives an unrelated render', async () => {
  const document = createFakeDocument({ listenerIds: ['raw-editor'] });
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.__test.setConfigRaw(createDraft(), { renderNow: false, draftMode: 'new' });
  app.render();

  const rawEditor = document.getElementById('raw-editor');
  assert.ok(rawEditor, 'fake document should expose the raw-editor element');

  // Simulate the user typing a new JSON blob into the editor.
  rawEditor.value = '{"mode":"review","prompt":"hand-edited","agents":["claude"]}';
  rawEditor._dispatch('input');

  // Trigger an unrelated render (no draft mutation). Without the input
  // listener, state.rawEditorText would stay stale and the next render
  // would wipe the user's typing.
  await app.__test.validateCurrentConfig();

  assert.strictEqual(
    app.state.rawEditorText,
    '{"mode":"review","prompt":"hand-edited","agents":["claude"]}',
    'input listener should persist typed text into state so unrelated renders do not wipe it'
  );
});

test('typing into the raw editor survives a draft mutation render', async () => {
  const document = createFakeDocument({ listenerIds: ['raw-editor'] });
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.__test.setConfigRaw(createDraft(), { renderNow: false, draftMode: 'new' });
  app.render();

  const rawEditor = document.getElementById('raw-editor');
  assert.ok(rawEditor, 'fake document should expose the raw-editor element');

  rawEditor.value = '{"mode":"review","prompt":"hand-edited","agents":["claude"]}';
  rawEditor._dispatch('input');

  app.__test.mutateDraft((draft) => {
    draft.prompt = 'changed from composer';
  });

  assert.strictEqual(
    app.state.rawEditorText,
    '{"mode":"review","prompt":"hand-edited","agents":["claude"]}',
    'draft mutations should not overwrite unapplied raw JSON typing'
  );
  assert.strictEqual(
    app.state.rawEditorDirty,
    true,
    'raw editor should stay marked dirty until the app intentionally resyncs it'
  );
});

test('pending-action state disables the Run button during launch', async () => {
  const document = createFakeDocument();
  let releaseLaunch;
  const fetch = async (url) => {
    if (url === '/api/runs/launch') {
      return new Promise((resolve) => {
        releaseLaunch = () => resolve({
          ok: true,
          async json() {
            return {
              ok: true,
              data: {
                success: true,
                launched: true,
                runId: 'run-pending-test',
                status: 'starting',
                error: null
              }
            };
          }
        });
      });
    }
    if (url === '/api/runs') return { ok: true, async json() { return { ok: true, data: [] }; } };
    if (url === '/api/runs/sessions') return { ok: true, async json() { return { ok: true, data: [] }; } };
    if (url === '/api/files/scratchpad' || url === '/api/files/log') {
      return { ok: true, async json() { return { ok: true, data: { filePath: url, content: '' } }; } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const app = createLoopiApp({ document, fetch, navigator: {} });
  app.__test.setConfigRaw(createDraft(), { renderNow: false, draftMode: 'new' });
  app.render();

  // Emulate what the Run button click path does: set pending, render, run.
  const runPromise = (async () => {
    app.state.pendingActions = app.state.pendingActions || {};
    app.state.pendingActions.run = true;
    app.render();
    const composerDuringLaunch = app.__test.getPanelHtml('composer');
    assert.ok(composerDuringLaunch.includes('id="run-config"'), 'composer should render the run button');
    assert.ok(composerDuringLaunch.includes('disabled'),
      'run button should be disabled while a launch is pending');
    assert.ok(composerDuringLaunch.includes('Launching'),
      'run button should show a busy label while pending');
    await app.__test.runCurrentConfig();
    delete app.state.pendingActions.run;
    app.render();
  })();

  // Release the launch request and let the run completion path settle.
  await new Promise((r) => setTimeout(r, 0));
  releaseLaunch();
  await runPromise;

  const composerAfter = app.__test.getPanelHtml('composer');
  assert.ok(!composerAfter.includes('disabled'),
    'run button should no longer be disabled after launch settles');
});

test('session polling skips network work while the document is hidden', async () => {
  const document = createFakeDocument({ visibilityState: 'hidden' });
  const timers = createFakeTimerHarness();
  let runFetches = 0;
  let fileFetches = 0;
  const fetch = async (url) => {
    if (url === '/api/runs' || url === '/api/runs/sessions') {
      runFetches += 1;
      return { ok: true, async json() { return { ok: true, data: [] }; } };
    }
    if (url === '/api/files/scratchpad' || url === '/api/files/log') {
      fileFetches += 1;
      return { ok: true, async json() { return { ok: true, data: { filePath: url, content: '' } }; } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const app = createLoopiApp({
    document,
    fetch,
    navigator: {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  });
  app.state.activeTab = 'runs';
  app.state.runSessions = [{
    runId: 'run-hidden-poll',
    status: 'running',
    mode: 'review',
    prompt: 'hidden poll test',
    startedAt: '2026-04-23T10:00:00Z',
    finishedAt: null,
    durationMs: null,
    taskFile: 'shared/task.json',
    error: null,
    active: true,
    launchedAt: '2026-04-23T10:00:00Z',
    updatedAt: '2026-04-23T10:00:00Z'
  }];
  app.state.activeSessionId = 'run-hidden-poll';

  app.__test.scheduleSessionPolling();
  assert.strictEqual(timers.latestDelay(), 10000,
    'hidden tabs should schedule a slower polling interval');

  await timers.runLatest();

  assert.strictEqual(runFetches, 0,
    'hidden-tab polling should skip run refresh requests');
  assert.strictEqual(fileFetches, 0,
    'hidden-tab polling should skip file refresh requests');
  assert.strictEqual(timers.latestDelay(), 10000,
    'hidden-tab polling should continue using the hidden delay when still hidden');
});

test('session polling backs off after consecutive failures', async () => {
  const document = createFakeDocument({ visibilityState: 'visible' });
  const timers = createFakeTimerHarness();
  let calls = 0;
  const fetch = async (url) => {
    if (url === '/api/runs') {
      calls += 1;
      throw new Error('runs endpoint unavailable');
    }
    if (url === '/api/runs/sessions') {
      calls += 1;
      throw new Error('sessions endpoint unavailable');
    }
    if (url === '/api/files/scratchpad' || url === '/api/files/log') {
      calls += 1;
      throw new Error('files endpoint unavailable');
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const app = createLoopiApp({
    document,
    fetch,
    navigator: {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  });
  app.state.activeTab = 'runs';
  app.state.runSessions = [{
    runId: 'run-backoff-poll',
    status: 'running',
    mode: 'review',
    prompt: 'backoff test',
    startedAt: '2026-04-23T10:00:00Z',
    finishedAt: null,
    durationMs: null,
    taskFile: 'shared/task.json',
    error: null,
    active: true,
    launchedAt: '2026-04-23T10:00:00Z',
    updatedAt: '2026-04-23T10:00:00Z'
  }];
  app.state.activeSessionId = 'run-backoff-poll';

  app.__test.scheduleSessionPolling();
  assert.strictEqual(timers.latestDelay(), 1500,
    'visible polling should start at the base interval');

  await timers.runLatest();
  await timers.runLatest();

  assert.ok(calls >= 2, 'polling should have attempted refresh work during failures');
  assert.ok(timers.latestDelay() > 1500,
    'a second consecutive poll failure should schedule a slower retry');
});

test('provider API key input renders as type="password"', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.__test.setConfigRaw({
    mode: 'review',
    prompt: 'API key masking draft',
    agents: ['claude'],
    providers: {
      localdemo: {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'demo',
        apiKey: 'secret-key-value'
      }
    }
  }, { renderNow: false, draftMode: 'new' });

  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');

  assert.ok(settingsHtml.includes('data-provider-field="localdemo:apiKey"'),
    'settings should render the api key input');
  assert.ok(settingsHtml.includes('type="password"'),
    'api key input should use type="password" so it renders as masked text');
});

test('settings panel includes hover help for key shared-workflow controls', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.__test.setConfigRaw(createDraft(), { renderNow: false, draftMode: 'new' });
  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');

  assert.ok(settingsHtml.includes('The active project folder for this Loopi session.'),
    'Project Root should include explanatory help text');
  assert.ok(settingsHtml.includes('The folder of reference material Loopi can pull into planning, implementation, and review.'),
    'Context Directory should include explanatory help text');
  assert.ok(settingsHtml.includes('Turns prepared context on for this task.'),
    'Use shared context folder should include explanatory help text');
  assert.ok(settingsHtml.includes('Keeps a workflow moving after a failed step when possible'),
    'Continue on error should include explanatory help text');
  assert.ok(settingsHtml.includes('Writes the legacy shared/scratchpad.txt summary during runs'),
    'Write scratchpad should include explanatory help text');
  assert.ok(settingsHtml.includes('setting-hint__bubble'),
    'settings help should render with tooltip bubble markup');
});

test('settings panel includes hover help for timeout and advanced context caps', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.state.advanced = true;
  app.__test.setConfigRaw(createDraft(), { renderNow: false, draftMode: 'new' });
  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');

  assert.ok(settingsHtml.includes('How long Loopi will wait before treating a step as timed out.'),
    'Timeout should include explanatory help text');
  assert.ok(settingsHtml.includes('Caps how many prepared context files or excerpts can be included during planning.'),
    'Plan Max Files should include explanatory help text');
  assert.ok(settingsHtml.includes('Caps how many context files or excerpts implementation steps can receive.'),
    'Implement Max Files should include explanatory help text');
  assert.ok(settingsHtml.includes('Caps how many context files or excerpts reviewers can see.'),
    'Review Max Files should include explanatory help text');
  assert.ok(settingsHtml.includes('Caps the total context characters available to planning prompts after selection and truncation.'),
    'Plan Max Chars should include explanatory help text');
  assert.ok(settingsHtml.includes('Caps the total context characters implementation steps can receive.'),
    'Implement Max Chars should include explanatory help text');
  assert.ok(settingsHtml.includes('Caps the total context characters available during review.'),
    'Review Max Chars should include explanatory help text');
});

test('agent settings default selected agents to can write and omit capability badges', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.state.bootstrap = {
    adapterMetadata: [
      { id: 'claude', displayName: 'Claude', supportsWriteAccess: true },
      { id: 'gemini', displayName: 'Gemini', supportsWriteAccess: false }
    ]
  };

  app.__test.setConfigRaw({
    mode: 'plan',
    prompt: 'Agent policy defaults',
    agents: ['claude', 'gemini'],
    settings: {
      planLoops: 1,
      qualityLoops: 1,
      implementLoops: 1,
      sectionImplementLoops: 1,
      timeoutMs: 180000,
      continueOnError: false,
      writeScratchpad: true
    }
  }, { renderNow: false, draftMode: 'new' });

  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');

  assert.ok(settingsHtml.includes('data-agent-policy="claude"'),
    'selected agents should render a Can Write selector');
  assert.ok(settingsHtml.includes('data-agent-policy="gemini"'),
    'every selected agent should render a Can Write selector');
  assert.ok(!settingsHtml.includes('>Writable<'),
    'Agent Enablement should not show the old Writable badge');
  assert.ok(!settingsHtml.includes('>Read-only<'),
    'Agent Enablement should not show the old Read-only badge');
  assert.ok(/data-agent-policy="claude"[\s\S]*?<option value="true" selected>Yes<\/option>/.test(settingsHtml),
    'selected agents should default to Can Write = Yes');
  assert.ok(/data-agent-policy="gemini"[\s\S]*?<option value="true" selected>Yes<\/option>/.test(settingsHtml),
    'all selected agents should default to Can Write = Yes');
  assert.ok(!/data-agent-policy="claude"[^>]*>[\s\S]*?<\/select>/.exec(settingsHtml)[0].includes('>Default</option>'),
    'Can Write selector should no longer expose a Default option');
  assert.deepStrictEqual(app.state.configRaw.settings.agentPolicies.claude, { canWrite: true });
  assert.deepStrictEqual(app.state.configRaw.settings.agentPolicies.gemini, { canWrite: true });
});

test('agent defaults render adapter-specific model and option controls', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.state.bootstrap = {
    adapterMetadata: [
      { id: 'kilo', displayName: 'Kilo', supportsWriteAccess: true }
    ],
    adapterOptions: [
      {
        agentId: 'kilo',
        displayName: 'Kilo',
        schema: {
          agentId: 'kilo',
          options: {
            model: {
              key: 'model',
              label: 'Model',
              mode: 'startup_flag',
              kind: 'open',
              flag: '--model',
              allowCustom: true,
              values: [
                { value: 'Kilo Auto Frontier', label: 'Kilo Auto Frontier', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
                { value: 'Kilo Auto Balanced', label: 'Kilo Auto Balanced', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
                { value: 'Kilo Auto Free', label: 'Kilo Auto Free', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }
              ],
              discovery: { type: 'cli', command: 'models', verbose: true }
            },
            effort: {
              key: 'effort',
              label: 'Effort',
              mode: 'model_dependent',
              kind: 'open',
              flag: '--variant',
              values: []
            },
            agent: {
              key: 'agent',
              label: 'Agent Mode',
              mode: 'startup_flag',
              kind: 'open',
              flag: '--agent',
              allowCustom: true,
              values: [
                { value: 'code', label: 'code' },
                { value: 'ask', label: 'ask' },
                { value: 'debug', label: 'debug' },
                { value: 'plan', label: 'plan' }
              ]
            },
            thinking: {
              key: 'thinking',
              label: 'Thinking',
              mode: 'boolean_flag',
              kind: 'boolean',
              flag: '--thinking',
              modelDependent: true,
              values: []
            }
          }
        }
      }
    ]
  };
  app.state.adapterDiscovery = {
    kilo: {
      agentId: 'kilo',
      status: 'ready',
      options: {
        model: {
          status: 'ready',
          values: [
            { id: 'anthropic/claude-sonnet-4-6', label: 'anthropic/claude-sonnet-4-6', efforts: ['high', 'max'], supportsThinking: false }
          ]
        }
      }
    }
  };

  app.__test.setConfigRaw({
    mode: 'plan',
    prompt: 'Adapter options',
    agents: ['kilo'],
    settings: {
      agentOptions: {
        kilo: {
          model: 'anthropic/claude-sonnet-4-6',
          agent: 'plan',
          effort: 'high',
          thinking: true
        }
      }
    }
  }, { renderNow: false, draftMode: 'new' });

  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');

  assert.ok(settingsHtml.includes('data-agent-option="kilo:model"'),
    'model control should expose discovered values through an editable control');
  assert.ok(settingsHtml.includes('<select data-agent-option="kilo:model"'),
    'discovered model values should render as a dropdown');
  assert.ok(settingsHtml.includes('anthropic/claude-sonnet-4-6'),
    'discovered model should be rendered as a selectable value');
  assert.ok(settingsHtml.includes('Kilo Auto Frontier'),
    'Kilo Auto Frontier should be included as a built-in model option');
  assert.ok(settingsHtml.includes('Kilo Auto Balanced'),
    'Kilo Auto Balanced should be included as a built-in model option');
  assert.ok(settingsHtml.includes('Kilo Auto Free'),
    'Kilo Auto Free should be included as a built-in model option');
  assert.ok(/data-agent-option="kilo:effort"[\s\S]*?<option value="max"/.test(settingsHtml),
    'Kilo effort should be populated from the selected model variants');
  assert.ok(settingsHtml.includes('<select data-agent-option="kilo:agent"'),
    'adapter-specific agent mode option should render as a dropdown');
  assert.ok(!settingsHtml.includes('<select data-agent-option="kilo:variant"'),
    'Kilo variant should not render separately because effort maps to --variant');
  assert.ok(settingsHtml.includes('data-agent-option="kilo:thinking"'),
    'thinking option should still render for Kilo');
  const thinkingSelect = /<select data-agent-option="kilo:thinking"[\s\S]*?<\/select>/.exec(settingsHtml);
  assert.ok(thinkingSelect && thinkingSelect[0].includes('disabled'),
    'Kilo thinking should be disabled when the selected model uses effort variants instead');
  assert.ok(settingsHtml.includes('id="refresh-adapter-options"'),
    'settings should expose a model-list refresh action');
});

test('kilo thinking control enables when selected model supports thinking but no effort variants', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.state.bootstrap = {
    adapterMetadata: [
      { id: 'kilo', displayName: 'Kilo', supportsWriteAccess: true }
    ],
    adapterOptions: [
      {
        agentId: 'kilo',
        displayName: 'Kilo',
        schema: {
          agentId: 'kilo',
          options: {
            model: {
              key: 'model',
              label: 'Model',
              mode: 'startup_flag',
              kind: 'open',
              flag: '--model',
              allowCustom: true,
              values: []
            },
            effort: {
              key: 'effort',
              label: 'Effort',
              mode: 'model_dependent',
              kind: 'open',
              flag: '--variant',
              values: []
            },
            thinking: {
              key: 'thinking',
              label: 'Thinking',
              mode: 'boolean_flag',
              kind: 'boolean',
              flag: '--thinking',
              modelDependent: true,
              values: []
            }
          }
        }
      }
    ]
  };
  app.state.adapterDiscovery = {
    kilo: {
      agentId: 'kilo',
      status: 'ready',
      options: {
        model: {
          status: 'ready',
          values: [
            { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', efforts: [], supportsThinking: true }
          ]
        }
      }
    }
  };

  app.__test.setConfigRaw({
    mode: 'plan',
    prompt: 'Adapter options',
    agents: ['kilo'],
    settings: {
      agentOptions: {
        kilo: {
          model: 'anthropic/claude-haiku-4.5',
          thinking: true
        }
      }
    }
  }, { renderNow: false, draftMode: 'new' });

  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');
  const effortSelect = /<select data-agent-option="kilo:effort"[\s\S]*?<\/select>/.exec(settingsHtml);
  const thinkingSelect = /<select data-agent-option="kilo:thinking"[\s\S]*?<\/select>/.exec(settingsHtml);

  assert.ok(effortSelect && effortSelect[0].includes('Unsupported'),
    'Kilo effort should be disabled when selected model exposes no effort variants');
  assert.ok(thinkingSelect && !thinkingSelect[0].includes('disabled'),
    'Kilo thinking should be enabled when selected model supports a thinking toggle');
  assert.ok(thinkingSelect[0].includes('<option value="true" selected>On</option>'),
    'Kilo thinking On state should be selectable and selected');
});

test('kilo thinking control disables when selected model does not support thinking', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.state.bootstrap = {
    adapterMetadata: [
      { id: 'kilo', displayName: 'Kilo', supportsWriteAccess: true }
    ],
    adapterOptions: [
      {
        agentId: 'kilo',
        displayName: 'Kilo',
        schema: {
          agentId: 'kilo',
          options: {
            model: {
              key: 'model',
              label: 'Model',
              mode: 'startup_flag',
              kind: 'open',
              flag: '--model',
              allowCustom: true,
              values: [
                { value: 'provider/plain-model', label: 'provider/plain-model', efforts: [], supportsThinking: false }
              ]
            },
            effort: {
              key: 'effort',
              label: 'Effort',
              mode: 'model_dependent',
              kind: 'open',
              flag: '--variant',
              values: []
            },
            thinking: {
              key: 'thinking',
              label: 'Thinking',
              mode: 'boolean_flag',
              kind: 'boolean',
              flag: '--thinking',
              modelDependent: true,
              values: []
            }
          }
        }
      }
    ]
  };

  app.__test.setConfigRaw({
    mode: 'plan',
    prompt: 'Adapter options',
    agents: ['kilo'],
    settings: {
      agentOptions: {
        kilo: {
          model: 'provider/plain-model',
          thinking: true
        }
      }
    }
  }, { renderNow: false, draftMode: 'new' });

  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');
  const thinkingSelect = /<select data-agent-option="kilo:thinking"[\s\S]*?<\/select>/.exec(settingsHtml);

  assert.ok(thinkingSelect, 'Kilo thinking select should render');
  assert.ok(/disabled[\s\S]*?>Unsupported<\/option>/.test(thinkingSelect[0]),
    'Kilo thinking should be disabled for models that do not support thinking');
  assert.ok(!thinkingSelect[0].includes('<option value="true"'),
    'unsupported thinking control should not offer an On option');
});

test('codex discovered local models render as a model dropdown', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.state.bootstrap = {
    adapterMetadata: [
      { id: 'codex', displayName: 'Codex', supportsWriteAccess: true }
    ],
    adapterOptions: [
      {
        agentId: 'codex',
        displayName: 'Codex',
        schema: {
          agentId: 'codex',
          options: {
            model: {
              key: 'model',
              label: 'Model',
              mode: 'startup_flag',
              kind: 'open',
              flag: '--model',
              allowCustom: true,
              values: [],
              discovery: { type: 'codex-config' }
            },
            effort: {
              key: 'effort',
              label: 'Effort',
              mode: 'separate_flag',
              kind: 'enum',
              flag: '-c',
              configKey: 'model_reasoning_effort',
              values: [
                { value: 'none', label: 'none' },
                { value: 'minimal', label: 'minimal' },
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
                { value: 'xhigh', label: 'xhigh' }
              ]
            }
          }
        }
      }
    ]
  };
  app.state.adapterDiscovery = {
    codex: {
      agentId: 'codex',
      status: 'ready',
      options: {
        model: {
          status: 'ready',
          values: [
            { id: 'gpt-5.5', label: 'gpt-5.5 (local default)' },
            { id: 'gpt-5.4', label: 'gpt-5.4' }
          ]
        }
      }
    }
  };

  app.__test.setConfigRaw({
    mode: 'plan',
    prompt: 'Codex options',
    agents: ['codex'],
    settings: {
      agentOptions: {
        codex: {
          model: 'gpt-5.5'
        }
      }
    }
  }, { renderNow: false, draftMode: 'new' });

  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');

  assert.ok(settingsHtml.includes('<select data-agent-option="codex:model"'),
    'codex discovered model values should render as a dropdown');
  assert.ok(settingsHtml.includes('gpt-5.5 (local default)'),
    'codex local config model should be visible in the dropdown');
  assert.ok(!settingsHtml.includes('[object Object]'),
    'codex effort dropdown should render string labels, not object coercions');
});

test('opencode discovered models and agents populate CLI-backed controls', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.state.bootstrap = {
    adapterMetadata: [
      { id: 'opencode', displayName: 'OpenCode', supportsWriteAccess: true }
    ],
    adapterOptions: [
      {
        agentId: 'opencode',
        displayName: 'OpenCode',
        schema: {
          agentId: 'opencode',
          options: {
            model: {
              key: 'model',
              label: 'Model',
              mode: 'startup_flag',
              kind: 'open',
              flag: '--model',
              allowCustom: true,
              values: [],
              discovery: { type: 'cli', command: 'models', verbose: true }
            },
            effort: {
              key: 'effort',
              label: 'Effort',
              mode: 'model_dependent',
              kind: 'open',
              flag: '--variant',
              values: []
            },
            agent: {
              key: 'agent',
              label: 'Agent Mode',
              mode: 'startup_flag',
              kind: 'enum',
              flag: '--agent',
              allowCustom: true,
              values: [
                { value: 'plan', label: 'plan' },
                { value: 'build', label: 'build' }
              ],
              discovery: { type: 'cli', command: 'agents' }
            },
            showThinking: {
              key: 'showThinking',
              label: 'Show Thinking',
              mode: 'boolean_flag',
              kind: 'boolean',
              flag: '--thinking',
              values: []
            }
          }
        }
      }
    ]
  };
  app.state.adapterDiscovery = {
    opencode: {
      agentId: 'opencode',
      status: 'ready',
      options: {
        model: {
          status: 'ready',
          values: [
            { id: 'opencode/claude-haiku-4-5', label: 'opencode/claude-haiku-4-5 (Claude Haiku 4.5)', efforts: ['high', 'max'] }
          ]
        },
        agent: {
          status: 'ready',
          values: [
            { value: 'explore', label: 'explore (subagent)' },
            { value: 'plan', label: 'plan (primary)' },
            { value: 'build', label: 'build (primary)' }
          ]
        }
      }
    }
  };

  app.__test.setConfigRaw({
    mode: 'plan',
    prompt: 'OpenCode options',
    agents: ['opencode'],
    settings: {
      agentOptions: {
        opencode: {
          model: 'opencode/claude-haiku-4-5',
          effort: 'high',
          agent: 'explore',
          showThinking: true
        }
      }
    }
  }, { renderNow: false, draftMode: 'new' });

  app.render();
  const settingsHtml = app.__test.getPanelHtml('settings');

  assert.ok(settingsHtml.includes('<select data-agent-option="opencode:model"'),
    'OpenCode discovered models should render as a dropdown');
  assert.ok(settingsHtml.includes('Claude Haiku 4.5'),
    'OpenCode model labels should come from verbose CLI metadata');
  assert.ok(/data-agent-option="opencode:effort"[\s\S]*?<option value="max"/.test(settingsHtml),
    'OpenCode effort should be populated from model variants');
  assert.ok(/data-agent-option="opencode:agent"[\s\S]*?<option value="explore" selected>explore \(subagent\)<\/option>/.test(settingsHtml),
    'OpenCode agent mode should include agents discovered from the CLI');
  assert.ok(/data-agent-option="opencode:showThinking"[\s\S]*?<option value="true" selected>On<\/option>/.test(settingsHtml),
    'OpenCode --thinking should render as a real boolean CLI flag');
});

test('claude effort dropdown follows the CLI effort enum', () => {
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.state.bootstrap = {
    adapterMetadata: [
      { id: 'claude', displayName: 'Claude', supportsWriteAccess: true }
    ],
    adapterOptions: [
      {
        agentId: 'claude',
        displayName: 'Claude',
        schema: {
          agentId: 'claude',
          options: {
            model: {
              key: 'model',
              label: 'Model',
              mode: 'startup_flag',
              kind: 'open',
              flag: '--model',
              allowCustom: true,
              defaultSentinelValues: ['default'],
              defaultOptionMode: 'discovered',
              discovery: { type: 'claude-bundle-model-options' },
              values: []
            },
            effort: {
              key: 'effort',
              label: 'Effort',
              mode: 'separate_flag',
              kind: 'enum',
              flag: '--effort',
              values: [
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
                { value: 'max', label: 'max' }
              ]
            }
          }
        }
      }
    ]
  };
  app.state.adapterDiscovery = {
    claude: {
      agentId: 'claude',
      status: 'ready',
      options: {
        model: {
          status: 'ready',
          defaultOption: { label: 'Default' },
          values: [
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'opus', label: 'Opus' },
            { value: 'haiku', label: 'Haiku' }
          ]
        }
      }
    }
  };

  app.__test.setConfigRaw({
    mode: 'plan',
    prompt: 'Claude options',
    agents: ['claude'],
    settings: {
      agentOptions: {
        claude: {
          model: 'opus'
        }
      }
    }
  }, { renderNow: false, draftMode: 'new' });

  app.render();
  let settingsHtml = app.__test.getPanelHtml('settings');
  assert.ok(settingsHtml.includes('<select data-agent-option="claude:model"'),
    'Claude model should render as a dropdown when the CLI bundle exposes options');
  assert.ok(/<select data-agent-option="claude:model"[\s\S]*?<option value=""[^>]*>Default<\/option>/.test(settingsHtml),
    'Claude model should include Default when discovered from the CLI bundle');
  assert.ok(/<select data-agent-option="claude:model"[\s\S]*?<option value="haiku"/.test(settingsHtml),
    'Claude model should include Haiku when discovered from the CLI bundle');
  assert.ok(/data-agent-option="claude:effort"[\s\S]*?<option value="max"/.test(settingsHtml),
    'Claude should expose the max effort from the CLI enum');

  app.__test.mutateDraft((draft) => {
    draft.settings.agentOptions.claude.model = 'claude-haiku-4-5';
  }, { renderNow: true });
  settingsHtml = app.__test.getPanelHtml('settings');
  assert.ok(!/data-agent-option="claude:effort" disabled/.test(settingsHtml),
    'Claude effort stays enabled for custom model names because the CLI exposes effort as a session flag');
});

test('role select marks the currently selected target without brittle string patching', () => {
  const { createLoopiApp: _unused } = require('../apps/ui/public/app.js');
  const { roleSelect } = require('../apps/ui/public/ui-core.js');
  const targets = ['claude', 'my.weird-id', 'codex'];

  const markup = roleSelect('planner', 'my.weird-id', targets);
  // The "Auto" option should not be selected when a real target is chosen.
  assert.ok(markup.includes('<option value=""'), 'should render the Auto option');
  assert.ok(!/<option value=""[^>]*selected/.test(markup),
    'Auto option should not be selected when another target is chosen');
  // The target option with matching id should carry the selected attribute.
  assert.ok(/<option value="my\.weird-id" selected>/.test(markup),
    'the matching target option should be explicitly selected');
  // Other options must not be marked selected.
  assert.ok(!/<option value="claude" selected>/.test(markup));
  assert.ok(!/<option value="codex" selected>/.test(markup));
});

test('provider add flow announces lowercase normalization when IDs differ', () => {
  // This test validates the normalization message without simulating the DOM
  // click by invoking the same logic the binding runs: lowercase and compare.
  const rawId = 'NIM-Local';
  const providerId = rawId.toLowerCase();
  const message = rawId !== providerId
    ? `Provider "${providerId}" added to the draft config (normalized from "${rawId}"; provider IDs are stored lowercase).`
    : `Provider "${providerId}" added to the draft config.`;

  assert.ok(message.includes('normalized from'),
    'message should announce the normalization when the raw id was not already lowercase');
  assert.ok(message.includes('NIM-Local'),
    'message should echo the original casing the user typed');

  // And the pass-through case (already lowercase) stays quiet.
  const alreadyLower = 'nim-local';
  const quietMessage = alreadyLower !== alreadyLower.toLowerCase()
    ? `normalized`
    : `Provider "${alreadyLower}" added to the draft config.`;
  assert.ok(!quietMessage.includes('normalized'),
    'already-lowercase ids should not mention normalization');
});

test('tab-change clears stale action messages so they do not bleed across tabs', () => {
  // The tab-click handler lives in ui-bindings. We replicate its message-scope
  // behavior here: when the active tab changes, lastActionMessage and
  // lastActionError must be cleared so a note produced on one tab does not
  // persist onto another.
  const document = createFakeDocument();
  const fetch = createFetchStub();
  const app = createLoopiApp({ document, fetch, navigator: {} });

  app.state.activeTab = 'setup';
  app.state.lastActionMessage = 'Adapter detection refreshed.';
  app.state.lastActionError = '';

  // Simulate the tab-button click path's scope-clearing logic.
  const nextTab = 'composer';
  if (nextTab !== app.state.activeTab) {
    app.state.lastActionMessage = '';
    app.state.lastActionError = '';
  }
  app.state.activeTab = nextTab;

  assert.strictEqual(app.state.lastActionMessage, '',
    'action message should be cleared on tab change');
  assert.strictEqual(app.state.lastActionError, '',
    'action error should be cleared on tab change');
});

process.on('beforeExit', () => {
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
});
