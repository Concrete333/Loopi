const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startControlPlaneServer, handleMainError } = require('../src/control-plane/server');

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

function createProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aibridge-ui-'));
}

function cleanupProjectRoot(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

function requestJson(baseUrl, method, routePath, payload) {
  const url = new URL(routePath, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(body)
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload !== undefined) {
      req.write(JSON.stringify(payload));
    }
    req.end();
  });
}

function requestText(baseUrl, routePath) {
  const url = new URL(routePath, baseUrl);
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body
        });
      });
    }).on('error', reject);
  });
}

async function waitFor(checkFn, { attempts = 20, delayMs = 10 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (checkFn()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

console.log('ui-server: local control-plane web app');

test('serves the UI shell from /', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const response = await requestText(started.url, '/');
    assert.strictEqual(response.statusCode, 200);
    assert.ok(response.body.includes('Loopi Control Plane'));
    assert.ok(response.body.includes('/ui-core.js'));
    assert.ok(response.body.includes('/ui-render.js'));
    assert.ok(response.body.includes('/ui-state.js'));
    assert.ok(response.body.includes('/ui-actions.js'));
    assert.ok(response.body.includes('/ui-bindings.js'));
    assert.ok(response.body.includes('/app.js'));
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('serves split browser modules as static assets', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const coreResponse = await requestText(started.url, '/ui-core.js');
    const renderResponse = await requestText(started.url, '/ui-render.js');
    const stateResponse = await requestText(started.url, '/ui-state.js');
    const actionsResponse = await requestText(started.url, '/ui-actions.js');
    const bindingsResponse = await requestText(started.url, '/ui-bindings.js');
    assert.strictEqual(coreResponse.statusCode, 200);
    assert.strictEqual(renderResponse.statusCode, 200);
    assert.strictEqual(stateResponse.statusCode, 200);
    assert.strictEqual(actionsResponse.statusCode, 200);
    assert.strictEqual(bindingsResponse.statusCode, 200);
    assert.ok(coreResponse.body.includes('LoopiUiCore'));
    assert.ok(renderResponse.body.includes('createRenderers'));
    assert.ok(stateResponse.body.includes('createUiState'));
    assert.ok(actionsResponse.body.includes('createUiActions'));
    assert.ok(bindingsResponse.body.includes('createUiBindings'));
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('bootstrap endpoint returns project metadata and use cases', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const response = await requestJson(started.url, 'GET', '/api/bootstrap');
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.ok, true);
    assert.strictEqual(response.body.data.projectRoot, projectRoot);
    assert.ok(Array.isArray(response.body.data.useCases));
    assert.ok(Array.isArray(response.body.data.adapterMetadata));
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('setup install helper endpoint forwards approval to the service layer', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    let received = null;
    started.service.runAdapterInstall = async (agentId, options) => {
      received = { agentId, options };
      return {
        success: true,
        actionType: 'install',
        agentId,
        statusAfter: { status: 'installed_but_needs_login' }
      };
    };

    const response = await requestJson(started.url, 'POST', '/api/setup/adapters/claude/install', {
      approved: true
    });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.ok, true);
    assert.ok(received, 'service helper was invoked');
    assert.strictEqual(received.agentId, 'claude');
    assert.strictEqual(received.options.approved, true);
    assert.strictEqual(response.body.data.success, true);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('setup login helper endpoint forwards approval to the service layer', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    let received = null;
    started.service.runAdapterLogin = async (agentId, options) => {
      received = { agentId, options };
      return {
        success: true,
        actionType: 'login',
        agentId,
        statusAfter: { status: 'ready' }
      };
    };

    const response = await requestJson(started.url, 'POST', '/api/setup/adapters/codex/login', {
      approved: true
    });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.ok, true);
    assert.ok(received, 'service helper was invoked');
    assert.strictEqual(received.agentId, 'codex');
    assert.strictEqual(received.options.approved, true);
    assert.strictEqual(response.body.data.success, true);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('config validate endpoint returns backend validation results', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const response = await requestJson(started.url, 'POST', '/api/config/validate', {
      rawConfig: {
        mode: 'plan',
        prompt: 'Plan the next change',
        agents: ['claude']
      }
    });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.ok, true);
    assert.strictEqual(response.body.data.valid, true);
    assert.strictEqual(response.body.data.normalized.mode, 'plan');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('config endpoint returns invalid persisted config with raw text intact', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    fs.mkdirSync(path.join(projectRoot, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'shared', 'task.json'), '{invalid json');
    const response = await requestJson(started.url, 'GET', '/api/config');
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.ok, true);
    assert.strictEqual(response.body.data.exists, true);
    assert.strictEqual(response.body.data.valid, false);
    assert.strictEqual(response.body.data.rawText, '{invalid json');
    assert.ok(String(response.body.data.error || '').includes('Invalid JSON'));
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('run list endpoint returns collaboration-store-backed runs', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    await started.service.store.writeTask('run-2026-04-22T12-00-00-000Z', {
      mode: 'plan',
      prompt: 'Stored from test',
      agents: ['claude'],
      startedAt: '2026-04-22T12:00:00Z',
      status: 'completed'
    });

    const response = await requestJson(started.url, 'GET', '/api/runs');
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.ok, true);
    assert.strictEqual(response.body.data.length, 1);
    assert.strictEqual(response.body.data[0].runId, 'run-2026-04-22T12-00-00-000Z');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('run session list endpoint returns live background sessions', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    started.service.runSessions.set('run-live-001', {
      runId: 'run-live-001',
      status: 'running',
      mode: 'plan',
      prompt: 'Live session',
      startedAt: '2026-04-22T12:00:00Z',
      finishedAt: null,
      durationMs: null,
      taskFile: path.join(projectRoot, 'shared', 'task.json'),
      error: null,
      active: true,
      launchedAt: '2026-04-22T12:00:00Z',
      updatedAt: '2026-04-22T12:00:10Z'
    });

    const response = await requestJson(started.url, 'GET', '/api/runs/sessions');
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.ok, true);
    assert.strictEqual(response.body.data.length, 1);
    assert.strictEqual(response.body.data[0].runId, 'run-live-001');
    assert.strictEqual(response.body.data[0].active, true);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('context status endpoint returns no-context when no config exists', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const response = await requestJson(started.url, 'GET', '/api/context/status');
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.ok, true);
    assert.strictEqual(response.body.data.status, 'no-context');
    assert.strictEqual(response.body.data.contextDir, null);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('context prepare endpoint returns error when no config exists', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const response = await requestJson(started.url, 'POST', '/api/context/prepare', {});
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.ok, true);
    assert.strictEqual(response.body.data.ok, false);
    assert.ok(response.body.data.error.includes('No valid task configuration'));
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('context status returns prepared when cache exists', async () => {
  const projectRoot = createProjectRoot();
  const contextDir = path.join(projectRoot, 'context');
  const sharedDir = path.join(projectRoot, 'shared');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, 'notes.md'), '# Test Context\nSome notes.');
  fs.writeFileSync(path.join(sharedDir, 'task.json'), JSON.stringify({
    task: 'test',
    mode: 'plan',
    agents: ['claude'],
    context: { dir: 'context' }
  }));

  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const prepareResponse = await requestJson(started.url, 'POST', '/api/context/prepare', {});
    assert.strictEqual(prepareResponse.statusCode, 200);
    assert.strictEqual(prepareResponse.body.data.ok, true);
    assert.ok(prepareResponse.body.data.sourceCount >= 1);

    const statusResponse = await requestJson(started.url, 'GET', '/api/context/status');
    assert.strictEqual(statusResponse.statusCode, 200);
    assert.strictEqual(statusResponse.body.data.status, 'ready');
    assert.ok(statusResponse.body.data.builtAt);
    assert.strictEqual(statusResponse.body.data.driftedSources.length, 0);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('context status POST evaluates the current draft config without needing a saved task file', async () => {
  const projectRoot = createProjectRoot();
  const draftContextDir = path.join(projectRoot, 'draft-context');
  fs.mkdirSync(draftContextDir, { recursive: true });
  fs.writeFileSync(path.join(draftContextDir, 'notes.md'), '# Draft Context\nUnsaved draft status.');

  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const missingResponse = await requestJson(started.url, 'POST', '/api/context/status', {
      rawConfig: {
        mode: 'plan',
        prompt: 'Draft status',
        agents: ['claude'],
        context: { dir: './draft-context' }
      }
    });
    assert.strictEqual(missingResponse.statusCode, 200);
    assert.strictEqual(missingResponse.body.data.ok, true);
    assert.strictEqual(missingResponse.body.data.status, 'missing');

    const prepareResponse = await requestJson(started.url, 'POST', '/api/context/prepare', {
      rawConfig: {
        mode: 'plan',
        prompt: 'Draft status',
        agents: ['claude'],
        context: { dir: './draft-context' }
      }
    });
    assert.strictEqual(prepareResponse.statusCode, 200);
    assert.strictEqual(prepareResponse.body.data.ok, true);

    const readyResponse = await requestJson(started.url, 'POST', '/api/context/status', {
      rawConfig: {
        mode: 'plan',
        prompt: 'Draft status',
        agents: ['claude'],
        context: { dir: './draft-context' }
      }
    });
    assert.strictEqual(readyResponse.statusCode, 200);
    assert.strictEqual(readyResponse.body.data.status, 'ready');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('run launch short-circuits with a structured context error before creating a session', async () => {
  const projectRoot = createProjectRoot();
  const contextDir = path.join(projectRoot, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, 'notes.md'), '# Missing prepare\nRun should block.');

  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const launchResponse = await requestJson(started.url, 'POST', '/api/runs/launch', {
      rawConfig: {
        mode: 'plan',
        prompt: 'Blocked by missing context prepare',
        agents: ['claude'],
        context: { dir: './context' }
      }
    });
    assert.strictEqual(launchResponse.statusCode, 200);
    assert.strictEqual(launchResponse.body.ok, true);
    assert.strictEqual(launchResponse.body.data.success, false);
    assert.strictEqual(launchResponse.body.data.launched, false);
    assert.strictEqual(launchResponse.body.data.runId, null);
    assert.strictEqual(launchResponse.body.data.error.code, 'CONTEXT_CACHE_MISSING');
    assert.ok(launchResponse.body.data.error.contextStatus);

    const sessionsResponse = await requestJson(started.url, 'GET', '/api/runs/sessions');
    assert.strictEqual(sessionsResponse.statusCode, 200);
    assert.deepStrictEqual(sessionsResponse.body.data, []);

    // Phase 1: blocked launch must not persist the draft to shared/task.json
    const taskFilePath = path.join(projectRoot, 'shared', 'task.json');
    assert.strictEqual(fs.existsSync(taskFilePath), false, 'blocked launch must not write task.json');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('successful launch with rawConfig persists the task file after preflight passes', async () => {
  const projectRoot = createProjectRoot();
  const contextDir = path.join(projectRoot, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, 'notes.md'), '# Ready context\nWill prepare first.');

  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    // Prepare context so the launch is not blocked
    const draftConfig = {
      mode: 'plan',
      prompt: 'Successful launch test',
      agents: ['claude'],
      context: { dir: './context' }
    };
    await requestJson(started.url, 'POST', '/api/context/prepare', {
      rawConfig: draftConfig
    });

    // Stub the orchestrator to avoid needing real CLI agents
    started.service.createOrchestrator = () => ({
      init: async () => {},
      runTask: async () => ({
        runId: 'run-test-success',
        status: 'completed',
        mode: 'plan',
        prompt: 'Successful launch test',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1000,
        error: null
      })
    });

    const launchResponse = await requestJson(started.url, 'POST', '/api/runs/launch', {
      rawConfig: draftConfig
    });
    assert.strictEqual(launchResponse.statusCode, 200);
    assert.strictEqual(launchResponse.body.ok, true);
    assert.strictEqual(launchResponse.body.data.success, true);
    assert.strictEqual(launchResponse.body.data.launched, true);

    // Phase 1: successful launch must persist the draft to shared/task.json
    const taskFilePath = path.join(projectRoot, 'shared', 'task.json');
    assert.strictEqual(fs.existsSync(taskFilePath), true, 'successful launch must write task.json');
    const savedContent = JSON.parse(fs.readFileSync(taskFilePath, 'utf8'));
    assert.strictEqual(savedContent.mode, 'plan');
    assert.strictEqual(savedContent.prompt, 'Successful launch test');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('launch without rawConfig uses the saved task file and does not re-persist', async () => {
  const projectRoot = createProjectRoot();
  const contextDir = path.join(projectRoot, 'context');
  const sharedDir = path.join(projectRoot, 'shared');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, 'notes.md'), '# Saved config context\nAlready persisted.');
  const savedConfig = {
    mode: 'plan',
    prompt: 'Previously saved task',
    agents: ['claude'],
    context: { dir: 'context' }
  };
  fs.writeFileSync(path.join(sharedDir, 'task.json'), JSON.stringify(savedConfig, null, 2) + '\n');

  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    // Prepare context from the saved task file
    await requestJson(started.url, 'POST', '/api/context/prepare', {});

    // Record the original file metadata/content so we can prove it was not rewritten.
    const taskFilePath = path.join(sharedDir, 'task.json');
    const rawBefore = fs.readFileSync(taskFilePath, 'utf8');
    const statBefore = fs.statSync(taskFilePath);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Stub the orchestrator
    started.service.createOrchestrator = () => ({
      init: async () => {},
      runTask: async () => ({
        runId: 'run-test-saved',
        status: 'completed',
        mode: 'plan',
        prompt: 'Previously saved task',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 500,
        error: null
      })
    });

    const launchResponse = await requestJson(started.url, 'POST', '/api/runs/launch', {});
    assert.strictEqual(launchResponse.statusCode, 200);
    assert.strictEqual(launchResponse.body.ok, true);
    assert.strictEqual(launchResponse.body.data.success, true);
    assert.strictEqual(launchResponse.body.data.launched, true);

    // The task file should still exist and must not have been rewritten.
    const rawAfter = fs.readFileSync(taskFilePath, 'utf8');
    const statAfter = fs.statSync(taskFilePath);
    assert.strictEqual(rawAfter, rawBefore);
    assert.strictEqual(statAfter.mtimeMs, statBefore.mtimeMs, 'launch without rawConfig must not rewrite task.json');

    const savedAfter = JSON.parse(fs.readFileSync(taskFilePath, 'utf8'));
    assert.strictEqual(savedAfter.prompt, 'Previously saved task');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('background run session records sane failure payloads for odd thrown values', async () => {
  const projectRoot = createProjectRoot();
  const contextDir = path.join(projectRoot, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, 'notes.md'), '# Background wrapper test');

  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const draftConfig = {
      mode: 'plan',
      prompt: 'Odd thrown value session test',
      agents: ['claude'],
      context: { dir: './context' }
    };
    await requestJson(started.url, 'POST', '/api/context/prepare', {
      rawConfig: draftConfig
    });

    started.service.createOrchestrator = () => ({
      init: async () => {},
      runTask: async () => {
        throw null;
      }
    });

    const launchResult = await started.service.launchRunSession({
      rawConfig: draftConfig
    });
    assert.strictEqual(launchResult.success, true);
    assert.strictEqual(launchResult.launched, true);

    const settled = await waitFor(() => {
      const snapshot = started.service.getRunSession(launchResult.runId);
      return snapshot.exists && snapshot.session && snapshot.session.active === false;
    });
    assert.strictEqual(settled, true, 'background session should settle inactive after the failure');

    const sessionSnapshot = started.service.getRunSession(launchResult.runId);
    assert.strictEqual(sessionSnapshot.exists, true);
    assert.strictEqual(sessionSnapshot.session.active, false);
    assert.strictEqual(sessionSnapshot.session.status, 'failed');
    assert.deepStrictEqual(sessionSnapshot.session.error, { message: 'Unknown error.' });
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('missing .js asset returns 404 instead of SPA fallback', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const response = await requestText(started.url, '/nonexistent-module.js');
    assert.strictEqual(response.statusCode, 404);
    assert.ok(!response.body.includes('Loopi Control Plane'), 'must not return HTML for missing .js');
    assert.strictEqual(response.body.trim(), 'Not found');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('missing .css asset returns 404 instead of SPA fallback', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const response = await requestText(started.url, '/missing-styles.css');
    assert.strictEqual(response.statusCode, 404);
    assert.ok(!response.body.includes('Loopi Control Plane'), 'must not return HTML for missing .css');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('missing dotted non-html asset returns 404 instead of SPA fallback', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const response = await requestText(started.url, '/missing-source.map');
    assert.strictEqual(response.statusCode, 404);
    assert.ok(!response.body.includes('Loopi Control Plane'), 'must not return HTML for missing dotted assets');
    assert.strictEqual(response.body.trim(), 'Not found');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('extensionless unknown route still serves the app shell', async () => {
  const projectRoot = createProjectRoot();
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const response = await requestText(started.url, '/some-deep-route');
    assert.strictEqual(response.statusCode, 200);
    assert.ok(response.body.includes('Loopi Control Plane'), 'extensionless route should serve SPA shell');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('handleMainError produces helpful EADDRINUSE message', () => {
  const originalExitCode = process.exitCode;
  const error = new Error('listen EADDRINUSE: address already in use');
  error.code = 'EADDRINUSE';
  error.port = 4311;
  const output = [];
  const origError = console.error;
  console.error = (msg) => output.push(msg);
  try {
    handleMainError(error);
  } finally {
    console.error = origError;
    process.exitCode = originalExitCode;
  }
  assert.ok(output.some((line) => line.includes('4311')), 'should mention the port');
  assert.ok(output.some((line) => line.includes('4312')), 'should suggest alternative port');
});

test('prepare result includes indexedCount and skippedCount when sources are skipped', async () => {
  const projectRoot = createProjectRoot();
  const ctxDir = path.join(projectRoot, 'context');
  const sharedDir = path.join(projectRoot, 'shared');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, 'good.md'), 'hello');
  fs.writeFileSync(path.join(ctxDir, 'bad.bin'), Buffer.from([0xff, 0xfe]));
  fs.writeFileSync(path.join(sharedDir, 'task.json'), JSON.stringify({
    prompt: 'p', mode: 'plan', agents: ['claude'],
    context: { dir: './context' }
  }));
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const response = await requestJson(started.url, 'POST', '/api/context/prepare', {});
    assert.strictEqual(response.statusCode, 200);
    const result = response.body.data;
    assert.strictEqual(result.ok, true);
    assert.ok(typeof result.indexedCount === 'number', 'indexedCount should be a number');
    assert.ok(typeof result.skippedCount === 'number', 'skippedCount should be a number');
    assert.strictEqual(result.indexedCount + result.skippedCount, result.sourceCount,
      'indexedCount + skippedCount should equal sourceCount');
    if (result.skippedCount > 0) {
      assert.ok(Array.isArray(result.skippedSources), 'skippedSources should be an array');
      assert.strictEqual(result.skippedSources.length, result.skippedCount);
      assert.ok(result.skippedSources[0].sourceRelativePath, 'skipped source should have path');
      assert.ok(result.skippedSources[0].skipReason, 'skipped source should have reason');
    }
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

test('prepare error preserves structured error details from PreparedContextError', async () => {
  const projectRoot = createProjectRoot();
  const sharedDir = path.join(projectRoot, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(sharedDir, 'task.json'), JSON.stringify({
    prompt: 'p', mode: 'plan', agents: ['claude'],
    context: { dir: './nonexistent-context' }
  }));
  const started = await startControlPlaneServer({ projectRoot, port: 0 });
  try {
    const response = await requestJson(started.url, 'POST', '/api/context/prepare', {});
    assert.strictEqual(response.statusCode, 200);
    const result = response.body.data;
    assert.strictEqual(result.ok, false);
    assert.ok(result.error, 'should have an error message');
    assert.ok(result.error.includes('does not exist'), 'error should mention directory issue');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupProjectRoot(projectRoot);
  }
});

process.on('beforeExit', () => {
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
});
