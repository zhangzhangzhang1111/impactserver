const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parseDiff } = require('../src/diff-parser');
const { indexSymbols } = require('../src/symbol-locator');
const { scanRules } = require('../src/rule-engine');
const { TaskStore } = require('../src/task-store');
const { TaskService } = require('../src/task-service');

const execFileAsync = promisify(execFile);

const PATCH = `diff --git a/app.py b/app.py
index 0000000..1111111 100644
--- a/app.py
+++ b/app.py
@@ -1,4 +1,6 @@
 def get_user(name):
+    sql = f"select * from users where name = '{name}'"
+    return db.execute(sql)
     return None
`;

test('parseDiff extracts added lines with new file line numbers', () => {
  const files = parseDiff(PATCH);
  assert.equal(files.length, 1);
  assert.equal(files[0].file, 'app.py');
  assert.deepEqual(files[0].added_lines.map((line) => line.line), [2, 3]);
});

test('symbol index finds Python functions and Lua functions', () => {
  const py = indexSymbols('class User:\n    pass\n\ndef get_user(name):\n    return name\n', 'python');
  assert.equal(py[0].name, 'User');
  assert.equal(py[1].name, 'get_user');

  const lua = indexSymbols('local function run()\n  return true\nend\n', 'lua');
  assert.equal(lua[0].name, 'run');
});

test('rule engine flags SQL injection style change', () => {
  const findings = scanRules(parseDiff(PATCH));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule_id, 'REDLINE-INJECTION-001');
  assert.equal(findings[0].severity, 'CRITICAL');
});

test('task service runs analysis and writes report artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-pipeline-'));
  const config = {
    runtimeDir: path.join(root, 'runtime'),
    reportsDir: path.join(root, 'reports'),
    autoRunTasks: false
  };
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: config.runtimeDir }),
    config
  });

  const task = await service.createTask({
    project: { name: 'demo' },
    revision: { source_branch: 'feature/sql-risk' },
    trigger: { provider: 'github', delivery_id: 'abc', pr_number: 7 },
    languages: ['python'],
    diff_patch: PATCH
  });

  const finished = await service.runTask(task.task_id);
  assert.equal(finished.status, 'SUCCESS');
  assert.ok(finished.report_dir);

  const report = await service.getReport(task.task_id, 'json');
  assert.equal(report.verdict.blocking, true);
  assert.equal(report.findings[0].rule_id, 'REDLINE-INJECTION-001');
  assert.ok(report.artifacts.html_report.endsWith('index.html'));
  assert.ok(report.artifacts.artifact_manifest.endsWith('artifacts.json'));
  assert.ok(await exists(path.join(finished.report_dir, 'index.html')));
  assert.ok(await exists(path.join(finished.report_dir, 'artifacts.json')));

  const markdown = await service.getReport(task.task_id, 'markdown');
  assert.match(markdown, /Impact Analysis Report/);
});

test('task service includes AI review findings when configured with provider', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-ai-pipeline-'));
  const config = {
    runtimeDir: path.join(root, 'runtime'),
    reportsDir: path.join(root, 'reports'),
    autoRunTasks: false,
    ai: {
      enabled: true,
      provider: {
        review: async () => ({
          findings: [
            {
              file: 'app.py',
              line: 3,
              language: 'python',
              severity: 'WARNING',
              category: 'AI',
              rule_id: 'AI-SUGGESTION',
              rule_source: 'AI_SUGGESTION',
              confidence: 'MEDIUM',
              message: 'AI suggests validating the DB result.',
              suggestion: 'Add a nil/empty result check.',
              evidence: { code_excerpt: 'db.execute(sql)' }
            }
          ],
          usage: {
            provider: 'test-ai',
            model: 'fake',
            input_tokens: 10,
            output_tokens: 5,
            chunk_count: 1,
            truncated: false
          }
        })
      }
    }
  };
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: config.runtimeDir }),
    config
  });

  const task = await service.createTask({
    project: { name: 'demo-ai' },
    revision: { source_branch: 'feature/ai-review' },
    trigger: { provider: 'github', delivery_id: 'ai-abc', pr_number: 8 },
    languages: ['python'],
    options: { enable_ai_review: true },
    diff_patch: PATCH
  });

  const finished = await service.runTask(task.task_id);
  assert.equal(finished.status, 'SUCCESS');

  const report = await service.getReport(task.task_id, 'json');
  assert.ok(report.findings.some((finding) => finding.rule_id === 'AI-SUGGESTION'));
  assert.equal(report.ai_usage.provider, 'test-ai');
  assert.equal(report.ai_usage.chunk_count, 1);
});

test('task service applies project-level custom review rules', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-project-rules-pipeline-'));
  const config = {
    runtimeDir: path.join(root, 'runtime'),
    reportsDir: path.join(root, 'reports'),
    autoRunTasks: false
  };
  const projectConfigStore = {
    get: async (name) => name === 'demo-project-rules'
      ? {
          name,
          rules: {
            custom_rules: [
              {
                id: 'PROJECT-PY-SERVICE-ANNOTATION',
                language: 'python',
                severity: 'WARNING',
                category: 'Style',
                description: 'Project service functions should expose type annotations.',
                pattern: '^def service_[^(]+\\([^)]*\\):',
                suggestion: 'Add project-required type annotations.'
              }
            ]
          }
        }
      : null
  };
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: config.runtimeDir }),
    config,
    projectConfigStore
  });

  const task = await service.createTask({
    project: { name: 'demo-project-rules' },
    revision: { source_branch: 'feature/project-rules' },
    trigger: { provider: 'github', delivery_id: 'project-rules-abc', pr_number: 14 },
    languages: ['python'],
    diff_patch: `diff --git a/service.py b/service.py
--- a/service.py
+++ b/service.py
@@ -1,1 +1,2 @@
+def service_get_user(name):
+    return name
`
  });

  const finished = await service.runTask(task.task_id);
  assert.equal(finished.status, 'SUCCESS');

  const report = await service.getReport(task.task_id, 'json');
  const finding = report.findings.find((item) => item.rule_id === 'PROJECT-PY-SERVICE-ANNOTATION');
  assert.equal(finding.rule_source, 'project:config#PROJECT-PY-SERVICE-ANNOTATION');
  assert.deepEqual(finding.source_engine, ['project-custom-rule']);
});

test('task service loads target revision repo review config custom rules', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-config-pipeline-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(repo, 'service.py'), 'def service_get_user(name):\n    return name\n');
  await git(repo, ['add', 'service.py']);
  await git(repo, ['commit', '-m', 'base']);
  const base = await revParse(repo, 'HEAD');

  await fs.writeFile(path.join(repo, '.review-config.yaml'), [
    'version: "1.0"',
    'rules:',
    '  custom_rules:',
    '    - id: "PY-SERVICE-ANNOTATION"',
    '      language: "python"',
    '      severity: "WARNING"',
    '      category: "Style"',
    '      description: "Service functions should expose type annotations."',
    '      pattern: "^def service_[^(]+\\([^)]*\\):"',
    '      suggestion: "Add explicit argument and return type annotations."'
  ].join('\n'));
  await fs.writeFile(path.join(repo, 'service.py'), [
    'def service_get_user(name):',
    '    return name.strip()',
    '',
    'def service_create_user(name):',
    '    return name'
  ].join('\n'));
  await git(repo, ['add', '.review-config.yaml', 'service.py']);
  await git(repo, ['commit', '-m', 'target']);
  const target = await revParse(repo, 'HEAD');

  const config = {
    runtimeDir: path.join(root, 'runtime'),
    reportsDir: path.join(root, 'reports'),
    workspaceDir: path.join(root, 'workspaces'),
    autoRunTasks: false
  };
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: config.runtimeDir }),
    config
  });

  const task = await service.createTask({
    project: { name: 'demo-config', repository_path: repo },
    revision: { base_commit: base, target_commit: target, source_branch: 'feature/config-rules' },
    trigger: { provider: 'github', delivery_id: 'config-abc', pr_number: 9 },
    languages: ['python']
  });

  const finished = await service.runTask(task.task_id);
  assert.equal(finished.status, 'SUCCESS');

  const report = await service.getReport(task.task_id, 'json');
  assert.ok(report.findings.some((finding) => finding.rule_id === 'PY-SERVICE-ANNOTATION'));
});

test('task service runs configured static tools and persists tool run summary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-static-tool-pipeline-'));
  const repo = path.join(root, 'repo');
  const fakeTool = path.join(root, 'fake-tool.js');
  await fs.mkdir(repo);
  await fs.writeFile(fakeTool, [
    'console.log(JSON.stringify({ findings: [{',
    '  file: "app.py",',
    '  line: 2,',
    '  language: "python",',
    '  severity: "WARNING",',
    '  category: "Style",',
    '  rule_id: "FAKE-STATIC-001",',
    '  message: "fake configured static tool finding",',
    '  suggestion: "fix it",',
    '  evidence: { code_excerpt: "value" }',
    '}]}));'
  ].join('\n'));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(repo, 'app.py'), 'value = 1\n');
  await git(repo, ['add', 'app.py']);
  await git(repo, ['commit', '-m', 'base']);
  const base = await revParse(repo, 'HEAD');

  await fs.writeFile(path.join(repo, '.review-config.json'), JSON.stringify({
    tools: {
      static_tools: [
        {
          id: 'fake-static',
          language: 'python',
          command: process.execPath,
          args: [fakeTool],
          parser: 'json-findings'
        }
      ]
    }
  }, null, 2));
  await fs.writeFile(path.join(repo, 'app.py'), 'value = 2\n');
  await git(repo, ['add', '.review-config.json', 'app.py']);
  await git(repo, ['commit', '-m', 'target']);
  const target = await revParse(repo, 'HEAD');

  const config = {
    runtimeDir: path.join(root, 'runtime'),
    reportsDir: path.join(root, 'reports'),
    workspaceDir: path.join(root, 'workspaces'),
    autoRunTasks: false
  };
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: config.runtimeDir }),
    config
  });

  const task = await service.createTask({
    project: { name: 'demo-static-tool', repository_path: repo },
    revision: { base_commit: base, target_commit: target, source_branch: 'feature/static-tool' },
    trigger: { provider: 'github', delivery_id: 'static-tool-abc', pr_number: 10 },
    languages: ['python']
  });

  const finished = await service.runTask(task.task_id);
  assert.equal(finished.status, 'SUCCESS');

  const report = await service.getReport(task.task_id, 'json');
  assert.ok(report.findings.some((finding) => finding.rule_id === 'FAKE-STATIC-001'));
  assert.equal(report.static_tool_runs[0].id, 'fake-static');
  assert.equal(report.static_tool_runs[0].status, 'SUCCESS');
});

test('task service report includes static reference level 1 and level 2 callers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-impact-pipeline-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(repo, 'dao.py'), [
    'def get_user_by_name(name):',
    '    return None'
  ].join('\n'));
  await fs.writeFile(path.join(repo, 'service.py'), [
    'from dao import get_user_by_name',
    '',
    'def load_user(name):',
    '    return get_user_by_name(name)'
  ].join('\n'));
  await fs.writeFile(path.join(repo, 'api.py'), [
    'from service import load_user',
    '',
    'def login(name):',
    '    return load_user(name)'
  ].join('\n'));
  await git(repo, ['add', 'dao.py', 'service.py', 'api.py']);
  await git(repo, ['commit', '-m', 'base']);
  const base = await revParse(repo, 'HEAD');

  await fs.writeFile(path.join(repo, 'dao.py'), [
    'def get_user_by_name(name):',
    '    return {"name": name}'
  ].join('\n'));
  await git(repo, ['add', 'dao.py']);
  await git(repo, ['commit', '-m', 'target']);
  const target = await revParse(repo, 'HEAD');

  const config = {
    runtimeDir: path.join(root, 'runtime'),
    reportsDir: path.join(root, 'reports'),
    workspaceDir: path.join(root, 'workspaces'),
    autoRunTasks: false
  };
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: config.runtimeDir }),
    config
  });

  const task = await service.createTask({
    project: { name: 'demo-impact', repository_path: repo },
    revision: {
      base_commit: base,
      target_commit: target,
      source_branch: 'feature/impact'
    },
    trigger: { provider: 'github', delivery_id: 'impact-abc', pr_number: 11 },
    languages: ['python'],
    options: { max_call_depth: 2 }
  });

  const finished = await service.runTask(task.task_id);
  assert.equal(finished.status, 'SUCCESS');

  const report = await service.getReport(task.task_id, 'json');
  const daoImpact = report.impact_tree.find((item) => item.modified_symbol === 'get_user_by_name');
  assert.equal(daoImpact.level_1_callers[0].symbol, 'load_user');
  assert.equal(daoImpact.level_2_callers[0].symbol, 'login');
});

test('task service report prefers configured LSP call hierarchy over static reference tracing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-lsp-pipeline-'));
  const repo = path.join(root, 'repo');
  const fakeLsp = path.join(root, 'fake-lsp.js');
  await fs.mkdir(repo);
  await fs.writeFile(fakeLsp, [
    'console.log(JSON.stringify({ impact_tree: [{',
    '  modified_symbol: "get_user_by_name",',
    '  file: "dao.py",',
    '  language: "python",',
    '  confidence: "HIGH",',
    '  level_1_callers: [{ symbol: "load_user_lsp", file: "service.py", line: 4 }],',
    '  level_2_callers: [{ symbol: "login_lsp", file: "api.py", line: 4 }],',
    '  limitations: ["fake lsp limitation"]',
    '}] }));'
  ].join('\n'));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(repo, 'dao.py'), 'def get_user_by_name(name):\n    return None\n');
  await fs.writeFile(path.join(repo, 'service.py'), 'from dao import get_user_by_name\n\ndef load_user(name):\n    return get_user_by_name(name)\n');
  await fs.writeFile(path.join(repo, 'api.py'), 'from service import load_user\n\ndef login(name):\n    return load_user(name)\n');
  await git(repo, ['add', 'dao.py', 'service.py', 'api.py']);
  await git(repo, ['commit', '-m', 'base']);
  const base = await revParse(repo, 'HEAD');

  await fs.writeFile(path.join(repo, '.review-config.json'), JSON.stringify({
    tools: {
      lsp_call_hierarchy: [
        {
          id: 'fake-lsp',
          language: 'python',
          command: process.execPath,
          args: [fakeLsp],
          parser: 'json-impact'
        }
      ]
    }
  }, null, 2));
  await fs.writeFile(path.join(repo, 'dao.py'), 'def get_user_by_name(name):\n    return {"name": name}\n');
  await git(repo, ['add', '.review-config.json', 'dao.py']);
  await git(repo, ['commit', '-m', 'target']);
  const target = await revParse(repo, 'HEAD');

  const config = {
    runtimeDir: path.join(root, 'runtime'),
    reportsDir: path.join(root, 'reports'),
    workspaceDir: path.join(root, 'workspaces'),
    autoRunTasks: false
  };
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: config.runtimeDir }),
    config
  });

  const task = await service.createTask({
    project: { name: 'demo-lsp', repository_path: repo },
    revision: { base_commit: base, target_commit: target, source_branch: 'feature/lsp' },
    trigger: { provider: 'github', delivery_id: 'lsp-abc', pr_number: 12 },
    languages: ['python'],
    options: { max_call_depth: 2 }
  });

  const finished = await service.runTask(task.task_id);
  assert.equal(finished.status, 'SUCCESS');

  const report = await service.getReport(task.task_id, 'json');
  const daoImpact = report.impact_tree.find((item) => item.modified_symbol === 'get_user_by_name');
  assert.equal(daoImpact.source, 'LSP');
  assert.equal(daoImpact.level_1_callers[0].symbol, 'load_user_lsp');
  assert.equal(report.lsp_tool_runs[0].id, 'fake-lsp');
});

test('task service uses configured Tree-sitter symbol locator before heuristic fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-treesitter-pipeline-'));
  const repo = path.join(root, 'repo');
  const fakeTreeSitter = path.join(root, 'fake-tree-sitter.js');
  await fs.mkdir(repo);
  await fs.writeFile(fakeTreeSitter, [
    'console.log(JSON.stringify({ symbols: [{',
    '  file: "app.py",',
    '  name: "parse_user",',
    '  kind: "function",',
    '  language: "python",',
    '  start_line: 1,',
    '  end_line: 4',
    '}] }));'
  ].join('\n'));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(repo, 'app.py'), [
    'def parse_user(name):',
    '    return name'
  ].join('\n'));
  await git(repo, ['add', 'app.py']);
  await git(repo, ['commit', '-m', 'base']);
  const base = await revParse(repo, 'HEAD');

  await fs.writeFile(path.join(repo, '.review-config.json'), JSON.stringify({
    tools: {
      tree_sitter_symbol_locator: [
        {
          id: 'fake-tree-sitter',
          language: 'python',
          command: process.execPath,
          args: [fakeTreeSitter],
          parser: 'json-symbols'
        }
      ]
    }
  }, null, 2));
  await fs.writeFile(path.join(repo, 'app.py'), [
    'def parse_user(name):',
    '    value = name.strip()',
    '    return value'
  ].join('\n'));
  await git(repo, ['add', '.review-config.json', 'app.py']);
  await git(repo, ['commit', '-m', 'target']);
  const target = await revParse(repo, 'HEAD');

  const config = {
    runtimeDir: path.join(root, 'runtime'),
    reportsDir: path.join(root, 'reports'),
    workspaceDir: path.join(root, 'workspaces'),
    autoRunTasks: false
  };
  const service = new TaskService({
    store: new TaskStore({ runtimeDir: config.runtimeDir }),
    config
  });

  const task = await service.createTask({
    project: { name: 'demo-treesitter', repository_path: repo },
    revision: { base_commit: base, target_commit: target, source_branch: 'feature/treesitter' },
    trigger: { provider: 'github', delivery_id: 'treesitter-abc', pr_number: 13 },
    languages: ['python']
  });

  const finished = await service.runTask(task.task_id);
  assert.equal(finished.status, 'SUCCESS');

  const report = await service.getReport(task.task_id, 'json');
  const impact = report.impact_tree.find((item) => item.modified_symbol === 'parse_user');
  assert.equal(impact.source, 'Tree-sitter');
  assert.equal(report.tree_sitter_tool_runs[0].id, 'fake-tree-sitter');
  assert.equal(report.tree_sitter_tool_runs[0].status, 'SUCCESS');
});

async function git(cwd, args) {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function revParse(cwd, ref) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', ref]);
  return stdout.trim();
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
