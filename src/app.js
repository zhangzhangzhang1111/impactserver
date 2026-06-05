const { sendJson, sendText, readJson, requireAuth } = require('./http');
const { renderDashboardHtml } = require('./dashboard');
const { createNoopLogger } = require('./logger');

function createApp({ taskService, config, logger = createNoopLogger() }) {
  return async function app(req, res) {
    const startedAt = Date.now();
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/dashboard') {
        sendText(res, 200, renderDashboardHtml(), { 'content-type': 'text/html; charset=utf-8' });
        return;
      }

      if (!requireAuth(req, config.apiToken)) {
        logger.warn('http request unauthorized', {
          method: req.method,
          path: url.pathname
        });
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/dashboard') {
        const dashboard = await taskService.getDashboard({
          project: url.searchParams.get('project') || '',
          status: url.searchParams.get('status') || '',
          limit: url.searchParams.get('limit')
        });
        sendJson(res, 200, dashboard);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/analysis/tasks') {
        const body = await readJson(req);
        const task = await taskService.createTask(body);
        sendJson(res, task.existing ? 200 : 202, {
          task_id: task.task_id,
          status: task.status,
          status_url: `/api/v1/analysis/tasks/${task.task_id}`
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/analysis/tasks') {
        const result = await taskService.listTasks({
          project: url.searchParams.get('project') || '',
          status: url.searchParams.get('status') || '',
          limit: url.searchParams.get('limit'),
          offset: url.searchParams.get('offset')
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/projects') {
        if (!taskService.projectConfigStore) {
          sendJson(res, 200, { projects: [] });
          return;
        }
        const projects = await taskService.projectConfigStore.listPublic();
        sendJson(res, 200, { projects });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/ai/providers') {
        sendJson(res, 200, taskService.getAiProvidersPublic());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/worker/stats') {
        const stats = taskService.taskRunner && taskService.taskRunner.stats
          ? taskService.taskRunner.stats()
          : { queued: 0, running: 0, concurrency: 0 };
        sendJson(res, 200, stats);
        return;
      }

      const projectConfigMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/config$/);
      if (req.method === 'GET' && projectConfigMatch) {
        if (!taskService.projectConfigStore) {
          sendJson(res, 404, { error: 'project_config_not_found' });
          return;
        }
        const projectName = decodeURIComponent(projectConfigMatch[1]);
        const projectConfig = await taskService.projectConfigStore.getPublic(projectName);
        if (!projectConfig) {
          sendJson(res, 404, { error: 'project_config_not_found' });
          return;
        }
        sendJson(res, 200, projectConfig);
        return;
      }

      const cancelMatch = url.pathname.match(/^\/api\/v1\/analysis\/tasks\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const task = await taskService.cancelTask(cancelMatch[1]);
        if (!task) {
          sendJson(res, 404, { error: 'task_not_found' });
          return;
        }
        sendJson(res, 200, task);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/maintenance/cleanup') {
        const body = await readJson(req);
        const result = await taskService.cleanupExpiredReports({
          dryRun: body.dry_run === true
        });
        sendJson(res, 200, result);
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/v1\/analysis\/tasks\/([^/]+)$/);
      if (req.method === 'GET' && taskMatch) {
        const task = await taskService.getTask(taskMatch[1]);
        if (!task) {
          sendJson(res, 404, { error: 'task_not_found' });
          return;
        }
        sendJson(res, 200, task);
        return;
      }

      const reportMatch = url.pathname.match(/^\/api\/v1\/analysis\/tasks\/([^/]+)\/report$/);
      if (req.method === 'GET' && reportMatch) {
        const format = url.searchParams.get('format') || 'json';
        const report = await taskService.getReport(reportMatch[1], format);
        if (!report) {
          sendJson(res, 404, { error: 'report_not_found' });
          return;
        }
        if (format === 'markdown') {
          sendText(res, 200, report, { 'content-type': 'text/markdown; charset=utf-8' });
        } else {
          sendJson(res, 200, report);
        }
        return;
      }

      const artifactMatch = url.pathname.match(/^\/api\/v1\/analysis\/tasks\/([^/]+)\/artifacts\/([^/]+)$/);
      if (req.method === 'GET' && artifactMatch) {
        const artifact = await taskService.getReportArtifact(artifactMatch[1], decodeURIComponent(artifactMatch[2]));
        if (!artifact) {
          sendJson(res, 404, { error: 'artifact_not_found' });
          return;
        }
        if (artifact.contentType.startsWith('application/json')) {
          sendJson(res, 200, JSON.parse(artifact.body));
        } else {
          sendText(res, 200, artifact.body, { 'content-type': artifact.contentType });
        }
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      logger.error('http request failed', {
        method: req.method,
        path: safePath(req.url),
        status_code: statusCode,
        duration_ms: Date.now() - startedAt,
        error
      });
      sendJson(res, statusCode, {
        error: statusCode === 500 ? 'internal_error' : 'bad_request',
        message: error.message
      });
    }
  };
}

function safePath(rawUrl) {
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
}

module.exports = { createApp };
