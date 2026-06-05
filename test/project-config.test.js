const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ProjectConfigStore, mergeProjectConfigIntoRequest } = require('../src/project-config-store');
const { TaskStore } = require('../src/task-store');
const { TaskService } = require('../src/task-service');

test('ProjectConfigStore loads project configs from JSON file and redacts secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-project-config-'));
  const configPath = path.join(root, 'projects.json');
  await fs.writeFile(configPath, JSON.stringify({
    projects: [
      {
        name: 'user-service',
        repository_full_name: 'org/user-service',
        clone_url: 'https://github.com/org/user-service.git',
        default_branch: 'main',
        credential_ref: 'github-readonly-key',
        languages: ['python'],
        retention_days: 14,
        ai: { enabled: true, max_input_tokens: 64000 },
        rules: {
          custom_rules: [
            {
              id: 'PROJECT-PY-ANNOTATION',
              language: 'python',
              severity: 'WARNING',
              description: 'Project service functions require annotations.',
              pattern: '^def service_'
            }
          ]
        }
      }
    ]
  }, null, 2));

  const store = new ProjectConfigStore({ configPath });
  const config = await store.get('user-service');
  const publicConfig = await store.getPublic('user-service');

  assert.equal(config.clone_url, 'https://github.com/org/user-service.git');
  assert.deepEqual(config.languages, ['python']);
  assert.equal(config.rules.custom_rules[0].id, 'PROJECT-PY-ANNOTATION');
  assert.equal(publicConfig.credential_ref, undefined);
  assert.equal(publicConfig.clone_url, 'https://github.com/org/user-service.git');
});

test('mergeProjectConfigIntoRequest applies project defaults without overwriting explicit request fields', () => {
  const merged = mergeProjectConfigIntoRequest({
    projectConfig: {
      name: 'user-service',
      repository_full_name: 'org/user-service',
      clone_url: 'https://github.com/org/user-service.git',
      default_branch: 'main',
      credential_ref: 'github-readonly-key',
      languages: ['python', 'java'],
      options: { max_call_depth: 2, enable_ai_review: true },
      ai: { max_input_tokens: 64000 },
      retention_days: 14
    },
    request: {
      project: { name: 'user-service', clone_url: 'ssh://override.git' },
      revision: { target_branch: 'release/1.0' },
      languages: ['lua'],
      options: { enable_ai_review: false },
      diff_patch: ''
    }
  });

  assert.equal(merged.project.repository_full_name, 'org/user-service');
  assert.equal(merged.project.clone_url, 'ssh://override.git');
  assert.equal(merged.project.default_branch, 'main');
  assert.equal(merged.project.credential_ref, 'github-readonly-key');
  assert.deepEqual(merged.languages, ['lua']);
  assert.equal(merged.options.max_call_depth, 2);
  assert.equal(merged.options.enable_ai_review, false);
  assert.equal(merged.ai.max_input_tokens, 64000);
  assert.equal(merged.retention_days, 14);
});

test('TaskService stores project config defaults on created task requests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-project-task-'));
  const projectConfigStore = {
    get: async (name) => name === 'user-service'
      ? {
          name: 'user-service',
          repository_full_name: 'org/user-service',
          clone_url: 'https://github.com/org/user-service.git',
          default_branch: 'main',
          languages: ['python'],
          options: { max_call_depth: 2 },
          retention_days: 14
        }
      : null
  };
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: path.join(root, 'runtime') }),
    projectConfigStore,
    config: {
      runtimeDir: path.join(root, 'runtime'),
      reportsDir: path.join(root, 'reports'),
      autoRunTasks: false
    }
  });

  const task = await service.createTask({
    project: { name: 'user-service' },
    revision: {
      base_commit: 'base',
      target_commit: 'head',
      source_branch: 'feature/project-config'
    }
  });

  assert.equal(task.request.project.clone_url, 'https://github.com/org/user-service.git');
  assert.deepEqual(task.request.languages, ['python']);
  assert.equal(task.request.options.max_call_depth, 2);
  assert.equal(task.retention_days, 14);
});
