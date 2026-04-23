const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startControlPlaneServer } = require('../src/control-plane/server');

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

process.on('beforeExit', () => {
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
});
