const http = require('http');

function startMockHttpServer(statusCode, responseBody, opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const payload = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
      if (typeof opts.onRequest === 'function') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          opts.onRequest(req, body);
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(payload);
        });
        return;
      }

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(payload);
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

function startSequentialMockHttpServer(responses) {
  return new Promise((resolve) => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      const response = responses[Math.min(requestCount, responses.length - 1)];
      requestCount += 1;
      const payload = typeof response === 'string' ? response : JSON.stringify(response);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

module.exports = {
  startMockHttpServer,
  startSequentialMockHttpServer
};
