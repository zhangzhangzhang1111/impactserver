const crypto = require('node:crypto');
const { sendJson } = require('./http');

const SUPPORTED_GITHUB_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);
const SUPPORTED_GITLAB_MR_ACTIONS = new Set(['open', 'opened', 'update', 'reopen', 'reopened']);

function createWebhookClientApp({ config = {}, fetchImpl = global.fetch } = {}) {
  return async function webhookClientApp(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      const match = url.pathname.match(/^\/webhooks\/(github|gitlab)$/);
      if (req.method === 'POST' && match) {
        const provider = match[1];
        const rawBody = await readRawBody(req);
        if (!verifyWebhookSignature({
          provider,
          secret: config.webhookSecret || '',
          rawBody,
          headers: req.headers || {}
        })) {
          sendJson(res, 401, { error: 'invalid_signature' });
          return;
        }

        const payload = parseJson(rawBody);
        const mapped = mapWebhookToAnalysisRequest({
          provider,
          payload,
          headers: req.headers || {},
          defaultLanguages: config.defaultLanguages || ['lua', 'cpp', 'java', 'python']
        });

        if (mapped.ignored) {
          sendJson(res, 202, { ignored: true, reason: mapped.reason });
          return;
        }

        const result = await forwardAnalysisRequest({
          request: mapped.request,
          config,
          fetchImpl
        });
        sendJson(res, result.status, result.body);
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      sendJson(res, statusCode, {
        error: statusCode === 500 ? 'internal_error' : 'bad_request',
        message: error.message
      });
    }
  };
}

function mapWebhookToAnalysisRequest({ provider, payload, headers = {}, defaultLanguages = ['lua', 'cpp', 'java', 'python'] }) {
  if (provider === 'github') return mapGitHubPullRequest(payload, headers, defaultLanguages);
  if (provider === 'gitlab') return mapGitLabMergeRequest(payload, headers, defaultLanguages);
  return { ignored: true, reason: `unsupported provider: ${provider}` };
}

function mapGitHubPullRequest(payload, headers, defaultLanguages) {
  const event = header(headers, 'x-github-event') || 'unknown';
  if (event !== 'pull_request') return { ignored: true, reason: `unsupported GitHub event: ${event}` };
  if (!SUPPORTED_GITHUB_PR_ACTIONS.has(payload.action)) {
    return { ignored: true, reason: `unsupported action: ${payload.action || 'unknown'}` };
  }
  const pr = payload.pull_request;
  if (!pr || !pr.base || !pr.head) return { ignored: true, reason: 'missing pull_request base/head data' };

  const baseRepo = pr.base.repo || {};
  const headRepo = pr.head.repo || {};
  const fullName = baseRepo.full_name || (payload.repository && payload.repository.full_name) || 'unknown/repository';
  const sourceFullName = headRepo.full_name || fullName;

  return {
    ignored: false,
    request: {
      project: {
        name: projectName(fullName),
        repository_full_name: fullName,
        clone_url: cloneUrl(baseRepo),
        default_branch: baseRepo.default_branch || pr.base.ref || 'main'
      },
      revision: {
        base_commit: pr.base.sha,
        target_commit: pr.head.sha,
        source_branch: pr.head.ref,
        target_branch: pr.base.ref,
        compare_mode: 'base_to_head',
        source_repo: {
          full_name: sourceFullName,
          clone_url: cloneUrl(headRepo)
        }
      },
      trigger: {
        provider: 'github',
        event,
        action: payload.action,
        delivery_id: header(headers, 'x-github-delivery') || '',
        pr_number: pr.number || payload.number || null,
        pr_url: pr.html_url || '',
        sender: payload.sender && payload.sender.login
      },
      languages: defaultLanguages
    }
  };
}

function mapGitLabMergeRequest(payload, headers, defaultLanguages) {
  const event = payload.object_kind || payload.event_type || header(headers, 'x-gitlab-event') || 'unknown';
  if (event !== 'merge_request') return { ignored: true, reason: `unsupported GitLab event: ${event}` };
  const attrs = payload.object_attributes || {};
  if (!SUPPORTED_GITLAB_MR_ACTIONS.has(attrs.action)) {
    return { ignored: true, reason: `unsupported action: ${attrs.action || 'unknown'}` };
  }

  const project = payload.project || {};
  const sourceProject = attrs.source || {};
  const fullName = project.path_with_namespace || attrs.target_project_path || 'unknown/repository';
  const sourceFullName = sourceProject.path_with_namespace || attrs.source_project_path || fullName;
  const diffRefs = attrs.diff_refs || {};

  return {
    ignored: false,
    request: {
      project: {
        name: projectName(fullName),
        repository_full_name: fullName,
        clone_url: project.git_http_url || project.git_ssh_url || '',
        default_branch: project.default_branch || attrs.target_branch || 'main'
      },
      revision: {
        base_commit: diffRefs.base_sha || attrs.target_branch_sha || '',
        target_commit: diffRefs.head_sha || (attrs.last_commit && attrs.last_commit.id) || '',
        source_branch: attrs.source_branch || '',
        target_branch: attrs.target_branch || '',
        compare_mode: 'base_to_head',
        source_repo: {
          full_name: sourceFullName,
          clone_url: sourceProject.git_http_url || sourceProject.git_ssh_url || project.git_http_url || project.git_ssh_url || ''
        }
      },
      trigger: {
        provider: 'gitlab',
        event: 'merge_request',
        action: attrs.action,
        delivery_id: header(headers, 'x-gitlab-event-uuid') || '',
        pr_number: attrs.iid || attrs.id || null,
        pr_url: attrs.url || '',
        sender: payload.user && (payload.user.username || payload.user.name)
      },
      languages: defaultLanguages
    }
  };
}

function verifyWebhookSignature({ provider, secret, rawBody, headers = {} }) {
  if (!secret) return true;
  if (provider === 'github') {
    const signature = header(headers, 'x-hub-signature-256');
    if (!signature || !signature.startsWith('sha256=')) return false;
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    return timingSafeEqual(signature, expected);
  }
  if (provider === 'gitlab') {
    const token = header(headers, 'x-gitlab-token');
    return timingSafeEqual(token || '', secret);
  }
  return false;
}

async function forwardAnalysisRequest({ request, config, fetchImpl }) {
  if (!fetchImpl) throw new Error('fetch is not available in this Node.js runtime');
  const baseUrl = String(config.impactApiUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (config.impactApiToken) headers.authorization = `Bearer ${config.impactApiToken}`;
  const response = await fetchImpl(`${baseUrl}/api/v1/analysis/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request)
  });
  const body = await response.json().catch(() => ({ error: 'invalid_impact_api_response' }));
  return {
    status: response.ok ? response.status : 502,
    body: response.ok ? body : { error: 'impact_api_error', status: response.status, body }
  };
}

function loadWebhookClientConfig(env = process.env) {
  return {
    host: env.IMPACT_WEBHOOK_HOST || '127.0.0.1',
    port: Number(env.IMPACT_WEBHOOK_PORT || 3005),
    webhookSecret: env.IMPACT_WEBHOOK_SECRET || '',
    impactApiUrl: env.IMPACT_API_URL || 'http://127.0.0.1:3000',
    impactApiToken: env.IMPACT_API_TOKEN || '',
    defaultLanguages: parseLanguages(env.IMPACT_DEFAULT_LANGUAGES)
  };
}

function parseLanguages(value) {
  if (!value) return ['lua', 'cpp', 'java', 'python'];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseJson(rawBody) {
  try {
    return JSON.parse(Buffer.from(rawBody).toString('utf8') || '{}');
  } catch (error) {
    error.statusCode = 400;
    throw error;
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function header(headers, name) {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
  }
  return '';
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function projectName(fullName) {
  return String(fullName || 'unknown-repository').replace(/[\\/]+/g, '-');
}

function cloneUrl(repo) {
  return repo.clone_url || repo.ssh_url || repo.git_url || '';
}

module.exports = {
  createWebhookClientApp,
  mapWebhookToAnalysisRequest,
  verifyWebhookSignature,
  forwardAnalysisRequest,
  loadWebhookClientConfig
};
