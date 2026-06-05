const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadReviewConfig } = require('../src/review-config');
const { parseDiff } = require('../src/diff-parser');
const { scanRules } = require('../src/rule-engine');

test('loadReviewConfig reads repo YAML custom rules and rule documents', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-config-'));
  await fs.mkdir(path.join(repo, 'docs', 'security'), { recursive: true });
  await fs.writeFile(path.join(repo, 'docs', 'security', 'redlines.md'), '# Redlines\nDo not log user secrets.\n');
  await fs.writeFile(path.join(repo, '.review-config.yaml'), [
    'version: "1.0"',
    'project:',
    '  languages: ["python"]',
    'rules:',
    '  redline_documents:',
    '    - "docs/security/redlines.md"',
    '  custom_rules:',
    '    - id: "PY-SERVICE-ANNOTATION"',
    '      language: "python"',
    '      severity: "WARNING"',
    '      category: "Style"',
    '      description: "Service functions should expose type annotations."',
    '      pattern: "^def service_[^(]+\\([^)]*\\):"',
    '      suggestion: "Add explicit argument and return type annotations."'
  ].join('\n'));

  const config = await loadReviewConfig(repo);

  assert.equal(config.version, '1.0');
  assert.deepEqual(config.project.languages, ['python']);
  assert.equal(config.rules.custom_rules[0].id, 'PY-SERVICE-ANNOTATION');
  assert.equal(config.rule_documents[0].path, 'docs/security/redlines.md');
  assert.match(config.rule_documents[0].content, /Do not log user secrets/);
});

test('loadReviewConfig rejects repo document paths outside the repo', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-config-bad-'));
  await fs.writeFile(path.join(repo, '.review-config.yaml'), [
    'version: "1.0"',
    'rules:',
    '  redline_documents:',
    '    - "../outside.md"'
  ].join('\n'));

  await assert.rejects(loadReviewConfig(repo), /outside repository/);
});

test('scanRules applies repo custom regex rules to added lines', () => {
  const patch = `diff --git a/service.py b/service.py
--- a/service.py
+++ b/service.py
@@ -1,2 +1,3 @@
+def service_get_user(name):
+    return name
`;
  const findings = scanRules(parseDiff(patch), {
    rules: {
      custom_rules: [
        {
          id: 'PY-SERVICE-ANNOTATION',
          language: 'python',
          severity: 'WARNING',
          category: 'Style',
          description: 'Service functions should expose type annotations.',
          pattern: '^def service_[^(]+\\([^)]*\\):',
          suggestion: 'Add explicit argument and return type annotations.'
        }
      ]
    }
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule_id, 'PY-SERVICE-ANNOTATION');
  assert.equal(findings[0].rule_source, 'repo:.review-config.yaml#PY-SERVICE-ANNOTATION');
});

test('loadReviewConfig normalizes configured Tree-sitter symbol locator tools', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-config-treesitter-'));
  await fs.writeFile(path.join(repo, '.review-config.json'), JSON.stringify({
    tools: {
      tree_sitter_symbol_locator: [
        {
          id: 'tree-sitter-python',
          language: 'python',
          command: '/opt/impact-tools/tree-sitter-symbols',
          args: ['--grammar', 'python'],
          parser: 'json-symbols',
          timeout_ms: 15000
        }
      ]
    }
  }));

  const config = await loadReviewConfig(repo);

  assert.equal(config.tools.tree_sitter_symbol_locator[0].id, 'tree-sitter-python');
  assert.equal(config.tools.tree_sitter_symbol_locator[0].parser, 'json-symbols');
  assert.equal(config.tools.tree_sitter_symbol_locator[0].timeout_ms, 15000);
});
