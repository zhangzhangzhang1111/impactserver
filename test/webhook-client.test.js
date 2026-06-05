const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const {
  mapWebhookToAnalysisRequest,
  verifyWebhookSignature,
  createWebhookClientApp
} = require('../src/webhook-client');

test('mapWebhookToAnalysisRequest converts GitHub pull_request payload to analysis request', () => {
  const payload = {
    action: 'synchronize',
    pull_request: {
      number: 42,
      html_url: 'https://github.com/org/user-service/pull/42',
      base: {
        sha: 'base-sha',
        ref: 'main',
        repo: {
          full_name: 'org/user-service',
          clone_url: 'https://github.com/org/user-service.git',
          default_branch: 'main'
        }
      },
      head: {
        sha: 'head-sha',
        ref: 'feature/login',
        repo: {
          full_name: 'dev/user-service',
          clone_url: 'https://github.com/dev/user-service.git'
        }
      }
    },
    sender: { login: 'alice' }
  };

  const result = mapWebhookToAnalysisRequest({
    provider: 'github',
    payload,
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-1'
    },
    defaultLanguages: ['python', 'java']
  });

  assert.equal(result.ignored, false);
  assert.equal(result.request.project.name, 'org-user-service');
  assert.equal(result.request.project.repository_full_name, 'org/user-service');
  assert.equal(result.request.revision.base_commit, 'base-sha');
  assert.equal(result.request.revision.target_commit, 'head-sha');
  assert.equal(result.request.revision.source_repo.full_name, 'dev/user-service');
  assert.equal(result.request.trigger.delivery_id, 'delivery-1');
  assert.equal(result.request.trigger.pr_number, 42);
  assert.deepEqual(result.request.languages, ['python', 'java']);
});

test('mapWebhookToAnalysisRequest ignores unsupported GitHub pull_request actions', () => {
  const result = mapWebhookToAnalysisRequest({
    provider: 'github',
    payload: { action: 'closed', pull_request: {} },
    headers: { 'x-github-event': 'pull_request' }
  });

  assert.equal(result.ignored, true);
  assert.match(result.reason, /unsupported action/);
});

test('mapWebhookToAnalysisRequest converts GitLab merge request payload to analysis request', () => {
  const payload = {
    object_kind: 'merge_request',
    project: {
      path_with_namespace: 'org/user-service',
      git_http_url: 'https://gitlab.example.com/org/user-service.git',
      default_branch: 'main'
    },
    object_attributes: {
      iid: 7,
      action: 'update',
      source_branch: 'feature/lua',
      target_branch: 'main',
      url: 'https://gitlab.example.com/org/user-service/-/merge_requests/7',
      diff_refs: {
        base_sha: 'base-sha',
        head_sha: 'head-sha'
      },
      source: {
        path_with_namespace: 'fork/user-service',
        git_http_url: 'https://gitlab.example.com/fork/user-service.git'
      }
    },
    user: { username: 'bob' }
  };

  const result = mapWebhookToAnalysisRequest({
    provider: 'gitlab',
    payload,
    headers: {
      'x-gitlab-event': 'Merge Request Hook',
      'x-gitlab-event-uuid': 'gitlab-event-1'
    },
    defaultLanguages: ['lua']
  });

  assert.equal(result.ignored, false);
  assert.equal(result.request.project.name, 'org-user-service');
  assert.equal(result.request.revision.base_commit, 'base-sha');
  assert.equal(result.request.revision.target_commit, 'head-sha');
  assert.equal(result.request.revision.source_repo.full_name, 'fork/user-service');
  assert.equal(result.request.trigger.provider, 'gitlab');
  assert.equal(result.request.trigger.pr_number, 7);
});

test('verifyWebhookSignature validates GitHub sha256 signatures', () => {
  const rawBody = Buffer.from(JSON.stringify({ action: 'opened' }));
  const signature = crypto.createHmac('sha256', 'secret').update(rawBody).digest('hex');

  assert.equal(verifyWebhookSignature({
    provider: 'github',
    secret: 'secret',
    rawBody,
    headers: { 'x-hub-signature-256': `sha256=${signature}` }
  }), true);

  assert.equal(verifyWebhookSignature({
    provider: 'github',
    secret: 'secret',
    rawBody,
    headers: { 'x-hub-signature-256': 'sha256=bad' }
  }), false);
});

test('verifyWebhookSignature validates GitLab secret tokens', () => {
  assert.equal(verifyWebhookSignature({
    provider: 'gitlab',
    secret: 'secret',
    rawBody: Buffer.from('{}'),
    headers: { 'x-gitlab-token': 'secret' }
  }), true);

  assert.equal(verifyWebhookSignature({
    provider: 'gitlab',
    secret: 'secret',
    rawBody: Buffer.from('{}'),
    headers: { 'x-gitlab-token': 'wrong' }
  }), false);
});

test('createWebhookClientApp forwards accepted webhook to impact API', async () => {
  const forwarded = [];
  const app = createWebhookClientApp({
    config: {
      webhookSecret: 'secret',
      impactApiUrl: 'http://impact.test',
      impactApiToken: 'impact-token',
      defaultLanguages: ['python']
    },
    fetchImpl: async (url, options) => {
      forwarded.push({ url, options });
      return {
        ok: true,
        status: 202,
        json: async () => ({ task_id: 'task_1', status: 'PENDING' })
      };
    }
  });
  const raw = Buffer.from(JSON.stringify({
    action: 'opened',
    pull_request: {
      number: 1,
      html_url: 'https://github.com/org/repo/pull/1',
      base: {
        sha: 'base',
        ref: 'main',
        repo: { full_name: 'org/repo', clone_url: 'https://github.com/org/repo.git' }
      },
      head: {
        sha: 'head',
        ref: 'feature',
        repo: { full_name: 'org/repo', clone_url: 'https://github.com/org/repo.git' }
      }
    },
    sender: { login: 'alice' }
  }));
  const signature = crypto.createHmac('sha256', 'secret').update(raw).digest('hex');

  const response = await request(app, {
    method: 'POST',
    path: '/webhooks/github',
    raw,
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-forward',
      'x-hub-signature-256': `sha256=${signature}`
    }
  });

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.task_id, 'task_1');
  assert.equal(forwarded[0].url, 'http://impact.test/api/v1/analysis/tasks');
  assert.equal(forwarded[0].options.headers.authorization, 'Bearer impact-token');
  assert.match(forwarded[0].options.body, /delivery-forward/);
});

test('createWebhookClientApp rejects invalid webhook signatures', async () => {
  const app = createWebhookClientApp({
    config: {
      webhookSecret: 'secret',
      impactApiUrl: 'http://impact.test',
      defaultLanguages: ['python']
    },
    fetchImpl: async () => {
      throw new Error('should not forward');
    }
  });

  const response = await request(app, {
    method: 'POST',
    path: '/webhooks/github',
    raw: Buffer.from('{}'),
    headers: {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': 'sha256=bad'
    }
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, 'invalid_signature');
});

async function request(app, { method = 'GET', path: requestPath, raw = Buffer.alloc(0), headers = {} } = {}) {
  const req = Readable.from(raw.length ? [raw] : []);
  req.method = method;
  req.url = requestPath;
  req.headers = headers;

  const res = {
    statusCode: null,
    headers: null,
    chunks: [],
    writeHead(statusCode, responseHeaders) {
      this.statusCode = statusCode;
      this.headers = responseHeaders;
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
      this.finished = true;
      if (this.resolve) this.resolve();
    }
  };

  await new Promise((resolve, reject) => {
    res.resolve = resolve;
    Promise.resolve(app(req, res)).catch(reject);
  });

  const text = Buffer.concat(res.chunks).toString('utf8');
  return {
    statusCode: res.statusCode,
    body: text ? JSON.parse(text) : {}
  };
}
