const fs = require('node:fs/promises');
const path = require('node:path');
const { analyze } = require('./analyzer');
const { mergeProjectConfigIntoRequest } = require('./project-config-store');
const { TaskRunner } = require('./task-runner');
const { createNoopLogger } = require('./logger');
const { redactProvider } = require('./ai-provider-config-store');

const STAGES = {
  pending: 'PENDING',
  checkout: 'CHECKOUT',
  diff: 'DIFF_PARSE',
  symbols: 'SYMBOL_LOCATE',
  impact: 'IMPACT_ANALYSIS',
  rules: 'STATIC_RULE_REVIEW',
  ai: 'AI_REVIEW',
  report: 'REPORT_RENDER',
  success: 'SUCCESS',
  failed: 'FAILED',
  timeout: 'TIMEOUT',
  cancelled: 'CANCELLED'
};

class TaskService {
  constructor({ store, config, projectConfigStore = null, taskRunner = null, analyzeImpl = analyze, logger = createNoopLogger() }) {
    this.store = store;
    this.config = config;
    this.projectConfigStore = projectConfigStore;
    this.analyzeImpl = analyzeImpl;
    this.logger = logger;
    this.taskRunner = taskRunner || new TaskRunner({
      concurrency: config.workerConcurrency || 1,
      runTask: (taskId) => this.runTask(taskId)
    });
  }

  async createTask(request) {
    validateRequest(request);
    const projectConfig = this.projectConfigStore
      ? await this.projectConfigStore.get(request.project.name)
      : null;
    const mergedRequest = mergeProjectConfigIntoRequest({ projectConfig, request });
    validateRequest(mergedRequest);
    const idempotencyKey = buildIdempotencyKey(mergedRequest);
    const existing = await this.store.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      this.logger.info('analysis task idempotency hit', taskLogContext(existing));
      return { ...existing, existing: true };
    }

    const now = new Date();
    const task = {
      task_id: createTaskId(now),
      project_name: mergedRequest.project.name,
      status: STAGES.pending,
      stage: STAGES.pending,
      progress: 0,
      trigger: mergedRequest.trigger || {},
      idempotency_key: idempotencyKey,
      base_commit: mergedRequest.revision && mergedRequest.revision.base_commit,
      target_commit: mergedRequest.revision && mergedRequest.revision.target_commit,
      branch: mergedRequest.revision && mergedRequest.revision.source_branch,
      retention_days: mergedRequest.retention_days,
      protected_branch_retention_days: mergedRequest.protected_branch_retention_days,
      report_dir: null,
      created_at: now.toISOString(),
      started_at: null,
      updated_at: now.toISOString(),
      request: mergedRequest
    };

    await this.store.save(task);
    this.logger.info('analysis task created', taskLogContext(task));
    if (this.config.autoRunTasks) {
      this.logger.info('analysis task enqueued', taskLogContext(task));
      this.taskRunner.enqueue(task.task_id).catch((error) => {
        this.logger.error('analysis task worker execution rejected', {
          ...taskLogContext(task),
          error
        });
      });
    }
    return task;
  }

  async getTask(taskId) {
    return this.store.get(taskId);
  }

  async listTasks(filters = {}) {
    const limit = clampNumber(filters.limit, 1, 200, 50);
    const offset = clampNumber(filters.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    let tasks = await this.store.list();
    if (filters.project) {
      tasks = tasks.filter((task) => task.project_name === filters.project);
    }
    if (filters.status) {
      tasks = tasks.filter((task) => task.status === filters.status);
    }
    tasks.sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
    const page = tasks.slice(offset, offset + limit).map(summarizeTask);
    return {
      total: tasks.length,
      limit,
      offset,
      tasks: page
    };
  }

  async getDashboard(filters = {}) {
    const limit = clampNumber(filters.limit, 1, 200, 50);
    const history = await this.listTasks({
      project: filters.project,
      status: filters.status,
      limit,
      offset: 0
    });
    const tasks = [];
    for (const summary of history.tasks) {
      const fullTask = await this.store.get(summary.task_id);
      tasks.push({
        ...summary,
        error: fullTask && fullTask.error,
        report: await this.reportSummary(summary.task_id, fullTask || summary)
      });
    }
    return {
      generated_at: new Date().toISOString(),
      worker: this.taskRunner && this.taskRunner.stats
        ? this.taskRunner.stats()
        : { queued: 0, running: 0, concurrency: 0 },
      total: history.total,
      limit: history.limit,
      offset: history.offset,
      tasks
    };
  }

  getAiProvidersPublic() {
    const aiProviders = this.config.aiProviders || { default_provider: '', providers: [] };
    return {
      default_provider: aiProviders.default_provider || '',
      providers: Array.isArray(aiProviders.providers)
        ? aiProviders.providers.map(redactProvider)
        : []
    };
  }

  async reportSummary(taskId, task) {
    if (!task || !task.report_dir) {
      return { available: false };
    }
    try {
      const report = await this.getReport(taskId, 'json');
      if (!report) return { available: false };
      return {
        available: true,
        risk_level: report.verdict && report.verdict.risk_level,
        risk_score: report.verdict && report.verdict.risk_score,
        blocking: report.verdict && report.verdict.blocking,
        html_url: report.artifacts && report.artifacts.html_report
          ? `/api/v1/analysis/tasks/${taskId}/artifacts/html_report`
          : '',
        json_url: `/api/v1/analysis/tasks/${taskId}/report?format=json`,
        markdown_url: `/api/v1/analysis/tasks/${taskId}/report?format=markdown`
      };
    } catch (error) {
      this.logger.error('dashboard report summary failed', {
        ...taskLogContext(task),
        error
      });
      return {
        available: false,
        error: error.message
      };
    }
  }

  async getReport(taskId, format) {
    const task = await this.store.get(taskId);
    if (!task || !task.report_dir) return null;
    if (format === 'markdown') {
      try {
        return await fs.readFile(path.join(task.report_dir, 'review.md'), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        this.logger.error('markdown report read failed', {
          ...taskLogContext(task),
          format,
          error
        });
        throw error;
      }
    }
    try {
      const raw = await fs.readFile(path.join(task.report_dir, 'report.json'), 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      this.logger.error('json report read failed', {
        ...taskLogContext(task),
        format,
        error
      });
      throw error;
    }
  }

  async getReportArtifact(taskId, role) {
    const task = await this.store.get(taskId);
    if (!task || !task.report_dir) return null;
    const report = await this.getReport(taskId, 'json');
    if (!report || !report.artifacts || !report.artifacts[role]) return null;
    const artifactPath = safeArtifactPath(task.report_dir, report.artifacts[role]);
    try {
      const body = await fs.readFile(artifactPath, 'utf8');
      return {
        role,
        path: artifactPath,
        body,
        contentType: contentTypeForArtifact(role, artifactPath)
      };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      this.logger.error('report artifact read failed', {
        ...taskLogContext(task),
        role,
        artifact_path: artifactPath,
        error
      });
      throw error;
    }
  }

  async runTask(taskId) {
    const task = await this.store.get(taskId);
    if (!task) {
      this.logger.warn('analysis task missing before run', { task_id: taskId });
      return null;
    }
    if (task.status === STAGES.cancelled) {
      this.logger.info('analysis task skipped because it is cancelled', taskLogContext(task));
      return task;
    }

    let terminal = false;
    try {
      this.logger.info('analysis task started', taskLogContext(task));
      await this.update(task, { status: 'RUNNING', stage: STAGES.checkout, progress: 10, started_at: new Date().toISOString() });
      const report = await withTimeout(this.analyzeImpl({
        task,
        config: this.config,
        logger: this.logger,
        onStage: (stage, progress) => {
          if (terminal) return null;
          return this.update(task, { status: 'RUNNING', stage, progress });
        }
      }), this.config.taskTimeoutMs);
      terminal = true;
      await this.update(task, {
        status: STAGES.success,
        stage: STAGES.success,
        progress: 100,
        report_dir: report.artifacts.report_dir
      });
      this.logger.info('analysis task succeeded', taskLogContext(task));
      return this.store.get(taskId);
    } catch (error) {
      terminal = true;
      const timeout = error && error.code === 'TASK_TIMEOUT';
      await this.update(task, {
        status: timeout ? STAGES.timeout : STAGES.failed,
        stage: timeout ? STAGES.timeout : STAGES.failed,
        error: error.message,
        progress: task.progress || 0
      });
      this.logger.error(timeout ? 'analysis task timed out' : 'analysis task failed', {
        ...taskLogContext(task),
        error
      });
      return this.store.get(taskId);
    }
  }

  async cancelTask(taskId) {
    const task = await this.store.get(taskId);
    if (!task) return null;
    if (task.status !== STAGES.pending) {
      const error = new Error(`Only PENDING tasks can be cancelled. Current status: ${task.status}`);
      error.statusCode = 409;
      this.logger.warn('analysis task cancel rejected', {
        ...taskLogContext(task),
        error
      });
      throw error;
    }
    if (this.taskRunner && this.taskRunner.cancelQueued) {
      this.taskRunner.cancelQueued(taskId);
    }
    await this.update(task, {
      status: STAGES.cancelled,
      stage: STAGES.cancelled,
      progress: 0
    });
    this.logger.info('analysis task cancelled', taskLogContext(task));
    return this.store.get(taskId);
  }

  async update(task, patch) {
    Object.assign(task, patch, { updated_at: new Date().toISOString() });
    await this.store.save(task);
    if (patch.status || patch.stage || Object.prototype.hasOwnProperty.call(patch, 'progress')) {
      this.logger.info('analysis task stage updated', taskLogContext(task));
    }
  }

  async cleanupExpiredReports({ now = new Date(), dryRun = false } = {}) {
    const tasks = await this.store.list();
    const deleted = [];
    const kept = [];
    const errors = [];
    for (const task of tasks) {
      const decision = cleanupDecision(task, this.config, now);
      if (!decision.expired) {
        kept.push({ task_id: task.task_id, reason: decision.reason });
        continue;
      }
      if (!dryRun) {
        try {
          if (task.report_dir) {
            await fs.rm(task.report_dir, { recursive: true, force: true });
          }
          await this.store.delete(task.task_id);
          this.logger.info('expired analysis report deleted', {
            ...taskLogContext(task),
            report_dir: task.report_dir
          });
        } catch (error) {
          this.logger.error('expired analysis report cleanup failed', {
            ...taskLogContext(task),
            report_dir: task.report_dir,
            error
          });
          errors.push({ task_id: task.task_id, error: error.message });
          continue;
        }
      }
      deleted.push(task.task_id);
    }
    return {
      dry_run: dryRun,
      deleted_tasks: deleted,
      kept_count: kept.length,
      errors
    };
  }
}

function taskLogContext(task) {
  return {
    task_id: task.task_id,
    project_name: task.project_name,
    status: task.status,
    stage: task.stage,
    progress: task.progress,
    branch: task.branch,
    report_dir: task.report_dir || undefined
  };
}

function summarizeTask(task) {
  return {
    task_id: task.task_id,
    project_name: task.project_name,
    status: task.status,
    stage: task.stage,
    progress: task.progress,
    trigger: task.trigger,
    idempotency_key: task.idempotency_key,
    branch: task.branch,
    report_dir: task.report_dir,
    created_at: task.created_at,
    started_at: task.started_at,
    updated_at: task.updated_at
  };
}

function cleanupDecision(task, config, now) {
  if (!task.report_dir) return { expired: false, reason: 'no_report' };
  if (!['SUCCESS', 'FAILED'].includes(task.status)) return { expired: false, reason: 'active_task' };
  const created = new Date(task.created_at || task.updated_at || 0);
  if (Number.isNaN(created.getTime())) return { expired: false, reason: 'invalid_timestamp' };
  const retentionDays = isProtectedBranch(task.branch)
    ? Number(task.protected_branch_retention_days || config.protectedBranchRetentionDays || 180)
    : Number(task.retention_days || config.retentionDays || 30);
  const ageMs = now.getTime() - created.getTime();
  return {
    expired: ageMs > retentionDays * 24 * 60 * 60 * 1000,
    reason: `retention_${retentionDays}_days`
  };
}

function isProtectedBranch(branch) {
  return branch === 'main' || branch === 'master' || /^release[/-]/.test(String(branch || ''));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function safeArtifactPath(reportDir, artifactPath) {
  const root = path.resolve(reportDir);
  const absolute = path.resolve(artifactPath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error(`Report artifact path is outside report directory: ${artifactPath}`);
    error.statusCode = 400;
    throw error;
  }
  return absolute;
}

function contentTypeForArtifact(role, artifactPath) {
  if (role === 'html_report' || artifactPath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (role === 'markdown_report' || artifactPath.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (artifactPath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (artifactPath.endsWith('.patch')) return 'text/x-patch; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function withTimeout(promise, timeoutMs) {
  const ms = Number(timeoutMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`analysis timed out after ${ms}ms`);
      error.code = 'TASK_TIMEOUT';
      reject(error);
    }, ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') {
    throw Object.assign(new Error('request body must be an object'), { statusCode: 400 });
  }
  if (!request.project || !request.project.name) {
    throw Object.assign(new Error('project.name is required'), { statusCode: 400 });
  }
  if (!request.revision && !Object.prototype.hasOwnProperty.call(request, 'diff_patch')) {
    throw Object.assign(new Error('revision or diff_patch is required'), { statusCode: 400 });
  }
}

function buildIdempotencyKey(request) {
  const trigger = request.trigger || {};
  if (trigger.provider && trigger.delivery_id) {
    return `${trigger.provider}:${trigger.delivery_id}`;
  }
  return '';
}

function createTaskId(date) {
  const stamp = date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `task_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  TaskService,
  STAGES,
  validateRequest,
  buildIdempotencyKey,
  summarizeTask,
  cleanupDecision,
  isProtectedBranch,
  withTimeout,
  safeArtifactPath,
  contentTypeForArtifact
};
