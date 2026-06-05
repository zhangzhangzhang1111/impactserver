const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../src/task-store');
const { TaskService } = require('../src/task-service');

test('TaskService marks long running analysis as TIMEOUT', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-timeout-'));
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: path.join(root, 'runtime') }),
    config: {
      runtimeDir: path.join(root, 'runtime'),
      reportsDir: path.join(root, 'reports'),
      autoRunTasks: false,
      taskTimeoutMs: 5
    },
    analyzeImpl: async () => new Promise(() => {})
  });
  const task = await service.createTask({
    project: { name: 'timeout-demo' },
    diff_patch: ''
  });

  const finished = await service.runTask(task.task_id);

  assert.equal(finished.status, 'TIMEOUT');
  assert.equal(finished.stage, 'TIMEOUT');
  assert.match(finished.error, /timed out/);
});

test('TaskService cancels pending tasks before worker execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-cancel-'));
  const runner = {
    cancelQueuedCalls: [],
    cancelQueued(taskId) {
      this.cancelQueuedCalls.push(taskId);
      return true;
    }
  };
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: path.join(root, 'runtime') }),
    config: {
      runtimeDir: path.join(root, 'runtime'),
      reportsDir: path.join(root, 'reports'),
      autoRunTasks: false
    },
    taskRunner: runner
  });
  const task = await service.createTask({
    project: { name: 'cancel-demo' },
    diff_patch: ''
  });

  const cancelled = await service.cancelTask(task.task_id);

  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.stage, 'CANCELLED');
  assert.deepEqual(runner.cancelQueuedCalls, [task.task_id]);
});

test('TaskService logs task lifecycle and analysis failures with context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-logs-'));
  const entries = [];
  const logger = captureLogger(entries);
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: path.join(root, 'runtime') }),
    config: {
      runtimeDir: path.join(root, 'runtime'),
      reportsDir: path.join(root, 'reports'),
      autoRunTasks: false
    },
    logger,
    analyzeImpl: async ({ onStage }) => {
      await onStage('DIFF_PARSE', 25);
      throw new Error('diff parser exploded');
    }
  });
  const task = await service.createTask({
    project: { name: 'logging-demo' },
    diff_patch: ''
  });

  const finished = await service.runTask(task.task_id);

  assert.equal(finished.status, 'FAILED');
  assert.ok(entries.some((entry) => entry.level === 'info' && entry.message === 'analysis task created' && entry.task_id === task.task_id));
  assert.ok(entries.some((entry) => entry.level === 'info' && entry.message === 'analysis task stage updated' && entry.stage === 'DIFF_PARSE'));
  const failure = entries.find((entry) => entry.level === 'error' && entry.message === 'analysis task failed');
  assert.equal(failure.task_id, task.task_id);
  assert.equal(failure.project_name, 'logging-demo');
  assert.equal(failure.stage, 'FAILED');
  assert.equal(failure.error.message, 'diff parser exploded');
});

function captureLogger(entries) {
  return {
    debug: (message, context = {}) => entries.push({ level: 'debug', message, ...context }),
    info: (message, context = {}) => entries.push({ level: 'info', message, ...context }),
    warn: (message, context = {}) => entries.push({ level: 'warn', message, ...context }),
    error: (message, context = {}) => entries.push({ level: 'error', message, ...context })
  };
}
