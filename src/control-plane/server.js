const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const { createControlPlaneService } = require('./index');
const taskPaths = require('../task-paths');

const STATIC_ROOT = path.join(__dirname, '..', '..', 'apps', 'ui', 'public');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4311;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function parseArgs(argv) {
  const parsed = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    projectRoot: process.env.LOOPI_PROJECT_ROOT || undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (token === '--host' && argv[index + 1]) {
      parsed.host = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (token === '--port' && argv[index + 1]) {
      const value = Number(argv[index + 1]);
      if (Number.isInteger(value) && value > 0) {
        parsed.port = value;
      }
      index += 1;
      continue;
    }
    if (token === '--project-root' && argv[index + 1]) {
      parsed.projectRoot = String(argv[index + 1]).trim();
      index += 1;
    }
  }

  return parsed;
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body exceeds 1MB.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const json = JSON.stringify(payload, null, 2) + '\n';
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(json);
}

function sendText(res, statusCode, contentType, payload) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function notFound(res, message = 'Not found') {
  sendJson(res, 404, { ok: false, error: message });
}

async function safeReadText(filePath) {
  try {
    return {
      exists: true,
      filePath,
      content: await fs.readFile(filePath, 'utf8')
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        exists: false,
        filePath,
        content: ''
      };
    }
    return {
      exists: true,
      filePath,
      content: '',
      error: error.message
    };
  }
}

async function buildBootstrap(service) {
  return {
    ok: true,
    projectRoot: service.projectRoot,
    useCases: service.listUseCases(),
    adapterMetadata: service.getAllAdapterMetadata(),
    adapterOptions: service.getAllAdapterOptionMetadata(),
    paths: {
      taskFile: taskPaths.legacyTaskFile(service.projectRoot),
      scratchpadFile: taskPaths.legacyScratchpadFile(service.projectRoot),
      logFile: taskPaths.legacyLogFile(service.projectRoot)
    }
  };
}

async function serveStatic(req, res, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(requestedPath)
    .replace(/^([/\\])+/, '')
    .replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(STATIC_ROOT, normalized);

  if (!filePath.startsWith(STATIC_ROOT)) {
    notFound(res);
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    sendText(res, 200, MIME_TYPES[ext] || 'application/octet-stream', content);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const ext = path.extname(normalized).toLowerCase();
      if (ext && ext !== '.html') {
        sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
        return;
      }
      try {
        const fallback = await fs.readFile(path.join(STATIC_ROOT, 'index.html'));
        sendText(res, 200, MIME_TYPES['.html'], fallback);
        return;
      } catch (fallbackError) {
        sendJson(res, 500, { ok: false, error: fallbackError.message });
        return;
      }
    }
    sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleApiRequest(req, res, url, service) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    sendJson(res, 200, { ok: true, data: await buildBootstrap(service) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/setup/status') {
    sendJson(res, 200, { ok: true, data: await service.getSetupStatus() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/setup/ready-adapters') {
    sendJson(res, 200, { ok: true, data: await service.getReadyAdapters() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/setup/metadata') {
    sendJson(res, 200, { ok: true, data: service.getAllAdapterMetadata() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/adapters/options') {
    sendJson(res, 200, { ok: true, data: service.getAllAdapterOptionMetadata() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/adapters/options/discover') {
    const body = await readJsonBody(req);
    const agentIds = Array.isArray(body.agents)
      ? body.agents.map((agent) => String(agent || '').trim().toLowerCase()).filter(Boolean)
      : [];
    sendJson(res, 200, {
      ok: true,
      data: await service.discoverAdapterOptions(agentIds, {
        refresh: body.refresh === true
      })
    });
    return;
  }

  const setupInstallMatch = pathname.match(/^\/api\/setup\/adapters\/([^/]+)\/install$/);
  if (req.method === 'POST' && setupInstallMatch) {
    const body = await readJsonBody(req);
    sendJson(res, 200, {
      ok: true,
      data: await service.runAdapterInstall(decodeURIComponent(setupInstallMatch[1]), {
        approved: body.approved === true
      })
    });
    return;
  }

  const setupLoginMatch = pathname.match(/^\/api\/setup\/adapters\/([^/]+)\/login$/);
  if (req.method === 'POST' && setupLoginMatch) {
    const body = await readJsonBody(req);
    sendJson(res, 200, {
      ok: true,
      data: await service.runAdapterLogin(decodeURIComponent(setupLoginMatch[1]), {
        approved: body.approved === true
      })
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/use-cases') {
    sendJson(res, 200, { ok: true, data: service.listUseCases() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    sendJson(res, 200, { ok: true, data: await service.loadConfig() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/config/validate') {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, data: await service.validateConfig(body.rawConfig || body) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/config/save') {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, data: await service.saveConfig(body.rawConfig || body) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/presets') {
    sendJson(res, 200, { ok: true, data: await service.listPresets() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/presets/save') {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, data: await service.savePreset(body.presetName) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/presets/use') {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, data: await service.usePreset(body.presetName) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/providers/test') {
    const body = await readJsonBody(req);
    sendJson(res, 200, {
      ok: true,
      data: await service.testProvider(body.providerId, body.providerConfig || {})
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/providers/test-current') {
    sendJson(res, 200, { ok: true, data: await service.testCurrentProviders() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/providers/test-task') {
    const body = await readJsonBody(req);
    sendJson(res, 200, {
      ok: true,
      data: await service.testProvidersFromTask(body.rawConfig || body)
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/runs/launch') {
    const body = await readJsonBody(req);
    sendJson(res, 200, {
      ok: true,
      data: await service.launchRunSession({
        rawConfig: body.rawConfig || null
      })
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/runs/sessions') {
    sendJson(res, 200, { ok: true, data: service.listRunSessions() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/context/status') {
    sendJson(res, 200, { ok: true, data: await service.getContextStatus() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/context/status') {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, data: await service.getContextStatus({ rawConfig: body.rawConfig || null }) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/context/prepare') {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, data: await service.prepareContext({ rawConfig: body.rawConfig || null }) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/runs') {
    sendJson(res, 200, { ok: true, data: await service.listRuns() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/files/scratchpad') {
    sendJson(res, 200, {
      ok: true,
      data: await safeReadText(taskPaths.legacyScratchpadFile(service.projectRoot))
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/files/log') {
    sendJson(res, 200, {
      ok: true,
      data: await safeReadText(taskPaths.legacyLogFile(service.projectRoot))
    });
    return;
  }

  const runDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (req.method === 'GET' && runDetailMatch) {
    sendJson(res, 200, {
      ok: true,
      data: await service.getRunDetails(decodeURIComponent(runDetailMatch[1]))
    });
    return;
  }

  const sessionDetailMatch = pathname.match(/^\/api\/runs\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && sessionDetailMatch) {
    sendJson(res, 200, {
      ok: true,
      data: service.getRunSession(decodeURIComponent(sessionDetailMatch[1]))
    });
    return;
  }

  const artifactListMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts$/);
  if (req.method === 'GET' && artifactListMatch) {
    sendJson(res, 200, {
      ok: true,
      data: await service.listArtifacts(
        decodeURIComponent(artifactListMatch[1]),
        { type: url.searchParams.get('type') || undefined }
      )
    });
    return;
  }

  const artifactDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (req.method === 'GET' && artifactDetailMatch) {
    sendJson(res, 200, {
      ok: true,
      data: await service.getArtifact(
        decodeURIComponent(artifactDetailMatch[1]),
        decodeURIComponent(artifactDetailMatch[2])
      )
    });
    return;
  }

  notFound(res);
}

function createControlPlaneServer({ projectRoot, host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const service = createControlPlaneService({ projectRoot });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApiRequest(req, res, url, service);
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message
      });
    }
  });

  return { server, service, host, port };
}

async function startControlPlaneServer(options = {}) {
  const { server, service, host, port } = createControlPlaneServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;

  return {
    server,
    service,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = await startControlPlaneServer(options);
  console.log(`Loopi UI running at ${started.url}`);
  console.log(`Project root: ${started.service.projectRoot}`);
  console.log('Press Ctrl+C to stop.');
}

function handleMainError(error) {
  if (error && error.code === 'EADDRINUSE') {
    const port = error.port || DEFAULT_PORT;
    console.error(`Port ${port} is already in use.`);
    console.error(`Try: npm run ui -- --port ${port + 1}`);
  } else {
    console.error(error.message || String(error));
  }
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(handleMainError);
}

module.exports = {
  createControlPlaneServer,
  startControlPlaneServer,
  handleMainError,
  DEFAULT_HOST,
  DEFAULT_PORT
};
