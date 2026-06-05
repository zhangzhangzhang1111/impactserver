const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../src/task-store');
const { TaskService } = require('../src/task-service');

test('listTasks filters by project and sorts newest first', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-history-'));
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: path.join(root, 'runtime') }),
    config: { autoRunTasks: false }
  });

  await service.store.save(taskFixture({ task_id: 'task_old', project_name: 'demo', created_at: '2026-06-01T00:00:00.000Z' }));
  await service.store.save(taskFixture({ task_id: 'task_other', project_name: 'other', created_at: '2026-06-03T00:00:00.000Z' }));
  await service.store.save(taskFixture({ task_id: 'task_new', project_name: 'demo', created_at: '2026-06-04T00:00:00.000Z' }));

  const result = await service.listTasks({ project: 'demo' });

  assert.deepEqual(result.tasks.map((task) => task.task_id), ['task_new', 'task_old']);
  assert.equal(result.total, 2);
});

test('cleanupExpiredReports removes expired feature reports but keeps protected branch reports', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-cleanup-'));
  const store = new TaskStore({ runtimeDir: path.join(root, 'runtime') });
  const service = new TaskService({
    store,
    config: {
      reportsDir: path.join(root, 'reports'),
      retentionDays: 30,
      protectedBranchRetentionDays: 180,
      autoRunTasks: false
    }
  });

  const oldFeatureReport = path.join(root, 'reports', 'demo', 'old-feature');
  const oldMainReport = path.join(root, 'reports', 'demo', 'old-main');
  const recentFeatureReport = path.join(root, 'reports', 'demo', 'recent-feature');
  await fs.mkdir(oldFeatureReport, { recursive: true });
  await fs.mkdir(oldMainReport, { recursive: true });
  await fs.mkdir(recentFeatureReport, { recursive: true });
  await fs.writeFile(path.join(oldFeatureReport, 'report.json'), '{}');
  await fs.writeFile(path.join(oldMainReport, 'report.json'), '{}');
  await fs.writeFile(path.join(recentFeatureReport, 'report.json'), '{}');

  await store.save(taskFixture({
    task_id: 'task_old_feature',
    project_name: 'demo',
    branch: 'feature/old',
    created_at: '2026-04-01T00:00:00.000Z',
    report_dir: oldFeatureReport
  }));
  await store.save(taskFixture({
    task_id: 'task_old_main',
    project_name: 'demo',
    branch: 'main',
    created_at: '2026-04-01T00:00:00.000Z',
    report_dir: oldMainReport
  }));
  await store.save(taskFixture({
    task_id: 'task_recent_feature',
    project_name: 'demo',
    branch: 'feature/recent',
    created_at: '2026-05-30T00:00:00.000Z',
    report_dir: recentFeatureReport
  }));

  const cleanup = await service.cleanupExpiredReports({ now: new Date('2026-06-04T00:00:00.000Z') });

  assert.deepEqual(cleanup.deleted_tasks, ['task_old_feature']);
  await assert.rejects(fs.stat(oldFeatureReport), /ENOENT/);
  assert.ok(await exists(oldMainReport));
  assert.ok(await exists(recentFeatureReport));
  assert.equal(await store.get('task_old_feature'), null);
  assert.notEqual(await store.get('task_old_main'), null);
  assert.notEqual(await store.get('task_recent_feature'), null);
});

function taskFixture(overrides) {
  return {
    task_id: overrides.task_id,
    project_name: overrides.project_name || 'demo',
    status: 'SUCCESS',
    stage: 'SUCCESS',
    progress: 100,
    trigger: {},
    idempotency_key: '',
    branch: overrides.branch || 'feature/demo',
    report_dir: overrides.report_dir || null,
    created_at: overrides.created_at,
    started_at: overrides.created_at,
    updated_at: overrides.created_at,
    request: {
      project: { name: overrides.project_name || 'demo' },
      revision: { source_branch: overrides.branch || 'feature/demo' },
      diff_patch: ''
    }
  };
}

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
