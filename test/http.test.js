const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createApp } = require('../src/app');
const { TaskStore } = require('../src/task-store');
const { TaskService } = require('../src/task-service');

test('health route returns ok', async () => {
  const app = await createTestApp();
  const response = await request(app, { path: '/healthz' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('task submission validates project name', async () => {
  const app = await createTestApp();
  const response = await request(app, {
    method: 'POST',
    path: '/api/v1/analysis/tasks',
    body: { revision: { base_commit: 'a', target_commit: 'b' } }
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /project\.name/);
});

test('task submission returns id and can be queried', async () => {
  const app = await createTestApp();
  const submit = await request(app, {
    method: 'POST',
    path: '/api/v1/analysis/tasks',
    body: {
      project: { name: 'demo' },
      diff_patch: ''
    }
  });
  assert.equal(submit.statusCode, 202);
  assert.match(submit.body.task_id, /^task_/);

  const status = await request(app, { path: `/api/v1/analysis/tasks/${submit.body.task_id}` });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.project_name, 'demo');
});

test('task list route returns project history', async () => {
  const app = await createTestApp();
  const submit = await request(app, {
    method: 'POST',
    path: '/api/v1/analysis/tasks',
    body: {
      project: { name: 'demo-history' },
      diff_patch: ''
    }
  });
  assert.equal(submit.statusCode, 202);

  const list = await request(app, { path: '/api/v1/analysis/tasks?project=demo-history' });

  assert.equal(list.statusCode, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.tasks[0].project_name, 'demo-history');
  assert.equal(list.body.tasks[0].request, undefined);
});

test('project config routes return public project defaults', async () => {
  const projectConfigStore = {
    listPublic: async () => [
      {
        name: 'user-service',
        repository_full_name: 'org/user-service',
        clone_url: 'https://github.com/org/user-service.git',
        languages: ['python']
      }
    ],
    getPublic: async (name) => name === 'user-service'
      ? {
          name: 'user-service',
          repository_full_name: 'org/user-service',
          clone_url: 'https://github.com/org/user-service.git',
          languages: ['python']
        }
      : null
  };
  const app = await createTestApp({ projectConfigStore });

  const list = await request(app, { path: '/api/v1/projects' });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.projects[0].name, 'user-service');

  const single = await request(app, { path: '/api/v1/projects/user-service/config' });
  assert.equal(single.statusCode, 200);
  assert.equal(single.body.repository_full_name, 'org/user-service');

  const missing = await request(app, { path: '/api/v1/projects/missing/config' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.error, 'project_config_not_found');
});

test('task cancel route cancels pending task', async () => {
  const app = await createTestApp();
  const submit = await request(app, {
    method: 'POST',
    path: '/api/v1/analysis/tasks',
    body: {
      project: { name: 'cancel-http' },
      diff_patch: ''
    }
  });
  assert.equal(submit.statusCode, 202);

  const cancel = await request(app, {
    method: 'POST',
    path: `/api/v1/analysis/tasks/${submit.body.task_id}/cancel`
  });

  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.body.status, 'CANCELLED');
});

test('worker stats route returns queue state', async () => {
  const app = await createTestApp({
    taskRunner: {
      stats: () => ({ queued: 2, running: 1, concurrency: 3 })
    }
  });

  const response = await request(app, { path: '/api/v1/worker/stats' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { queued: 2, running: 1, concurrency: 3 });
});

test('dashboard API returns worker stats, recent tasks, and report links', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-dashboard-api-'));
  const runtimeDir = path.join(root, 'runtime');
  const reportDir = path.join(root, 'reports', 'demo');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'index.html'), '<h1>report</h1>');
  await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify({
    verdict: { risk_level: 'HIGH', risk_score: 90 },
    artifacts: {
      report_dir: reportDir,
      html_report: path.join(reportDir, 'index.html')
    }
  }));
  const store = new TaskStore({ runtimeDir });
  await store.save({
    task_id: 'task_dashboard_success',
    project_name: 'demo',
    status: 'SUCCESS',
    stage: 'SUCCESS',
    progress: 100,
    trigger: {},
    branch: 'feature/dashboard',
    report_dir: reportDir,
    created_at: '2026-06-05T07:00:00.000Z',
    started_at: '2026-06-05T07:00:01.000Z',
    updated_at: '2026-06-05T07:00:02.000Z'
  });
  const taskService = new TaskService({
    store,
    config: { runtimeDir, reportsDir: path.join(root, 'reports'), autoRunTasks: false },
    taskRunner: {
      stats: () => ({ queued: 1, running: 2, concurrency: 3 })
    }
  });
  const app = createApp({ taskService, config: { apiToken: '' } });

  const response = await request(app, { path: '/api/v1/dashboard?limit=10' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.worker, { queued: 1, running: 2, concurrency: 3 });
  assert.equal(response.body.tasks[0].task_id, 'task_dashboard_success');
  assert.equal(response.body.tasks[0].report.available, true);
  assert.equal(response.body.tasks[0].report.risk_level, 'HIGH');
  assert.equal(response.body.tasks[0].report.html_url, '/api/v1/analysis/tasks/task_dashboard_success/artifacts/html_report');
  assert.equal(response.body.tasks[0].report.json_url, '/api/v1/analysis/tasks/task_dashboard_success/report?format=json');
  assert.equal(response.body.tasks[0].report.markdown_url, '/api/v1/analysis/tasks/task_dashboard_success/report?format=markdown');
});

test('dashboard route serves an HTML progress board', async () => {
  const app = await createTestApp();

  const response = await request(app, { path: '/dashboard' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(response.text, /Impact Analysis Dashboard/);
  assert.match(response.text, /\/api\/v1\/dashboard/);
});

test('dashboard shell can load with API token while dashboard data stays protected', async () => {
  const app = await createTestApp({ configOverrides: { apiToken: 'secret-token' } });

  const shell = await request(app, { path: '/dashboard' });
  const dataWithoutToken = await request(app, { path: '/api/v1/dashboard' });
  const dataWithToken = await request(app, {
    path: '/api/v1/dashboard',
    headers: { authorization: 'Bearer secret-token' }
  });

  assert.equal(shell.statusCode, 200);
  assert.equal(dataWithoutToken.statusCode, 401);
  assert.equal(dataWithToken.statusCode, 200);
});

test('report artifact routes return whitelisted local report files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-http-artifact-'));
  const runtimeDir = path.join(root, 'runtime');
  const reportDir = path.join(root, 'reports', 'demo');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'index.html'), '<h1>report</h1>');
  await fs.writeFile(path.join(reportDir, 'artifacts.json'), JSON.stringify({ files: [{ role: 'html_report' }] }));
  await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify({
    artifacts: {
      report_dir: reportDir,
      html_report: path.join(reportDir, 'index.html'),
      artifact_manifest: path.join(reportDir, 'artifacts.json'),
      unsafe: path.join(root, 'outside.txt')
    }
  }));
  await fs.writeFile(path.join(root, 'outside.txt'), 'nope');

  const store = new TaskStore({ runtimeDir });
  await store.save({
    task_id: 'task_artifacts',
    project_name: 'demo',
    status: 'SUCCESS',
    stage: 'SUCCESS',
    report_dir: reportDir
  });
  const taskService = new TaskService({
    store,
    config: { runtimeDir, reportsDir: path.join(root, 'reports'), autoRunTasks: false }
  });
  const app = createApp({ taskService, config: { apiToken: '' } });

  const html = await request(app, { path: '/api/v1/analysis/tasks/task_artifacts/artifacts/html_report' });
  assert.equal(html.statusCode, 200);
  assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(html.text, '<h1>report</h1>');

  const manifest = await request(app, { path: '/api/v1/analysis/tasks/task_artifacts/artifacts/artifact_manifest' });
  assert.equal(manifest.statusCode, 200);
  assert.deepEqual(manifest.body.files, [{ role: 'html_report' }]);

  const missing = await request(app, { path: '/api/v1/analysis/tasks/task_artifacts/artifacts/missing' });
  assert.equal(missing.statusCode, 404);

  const unsafe = await request(app, { path: '/api/v1/analysis/tasks/task_artifacts/artifacts/unsafe' });
  assert.equal(unsafe.statusCode, 400);
  assert.equal(unsafe.body.error, 'bad_request');
});

async function createTestApp({ projectConfigStore = null, taskRunner = null, configOverrides = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-http-'));
  const config = {
    runtimeDir: path.join(root, 'runtime'),
    reportsDir: path.join(root, 'reports'),
    apiToken: '',
    autoRunTasks: false,
    ...configOverrides
  };
  const store = new TaskStore({ runtimeDir: config.runtimeDir });
  const taskService = new TaskService({ store, config, projectConfigStore, taskRunner });
  return createApp({ taskService, config });
}

async function request(app, { method = 'GET', path: requestPath, body, headers = {} } = {}) {
  return requestWithHeaders(app, { method, path: requestPath, body, headers });
}

async function requestWithHeaders(app, { method = 'GET', path: requestPath, body, headers = {} } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.url = requestPath;
  req.headers = {
    ...(raw ? { 'content-type': 'application/json' } : {}),
    ...headers
  };

  const res = {
    statusCode: null,
    headers: null,
    chunks: [],
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
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
    headers: res.headers,
    text,
    body: parseBody(text)
  };
}

function parseBody(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
