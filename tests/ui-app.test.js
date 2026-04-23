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

function createFakeDocument() {
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

  return {
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

process.on('beforeExit', () => {
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
});
