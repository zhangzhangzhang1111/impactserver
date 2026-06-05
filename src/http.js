function sendJson(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

function sendText(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });
  });
}

function requireAuth(req, apiToken) {
  if (!apiToken) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${apiToken}`;
}

module.exports = { sendJson, sendText, readJson, requireAuth };
