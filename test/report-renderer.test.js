const test = require('node:test');
const assert = require('node:assert/strict');
const { renderHtml, renderArtifactManifest } = require('../src/report-renderer');

test('renderHtml creates escaped local report overview', () => {
  const html = renderHtml({
    task_id: 'task_1',
    project_name: 'demo',
    verdict: { risk_level: 'HIGH', risk_score: 90, blocking: true, critical_count: 1, warning_count: 0 },
    findings: [
      {
        severity: 'CRITICAL',
        rule_id: 'REDLINE-XSS',
        file: 'app.py',
        line: 2,
        message: '<script>alert(1)</script>',
        suggestion: 'Use parameters.'
      }
    ],
    impact_tree: [
      { modified_symbol: 'get_user', file: 'app.py', language: 'python', confidence: 'HIGH', changed_lines: [2] }
    ],
    changed_files: [{ file: 'app.py', added_line_count: 1 }],
    limitations: ['limited'],
    artifacts: { markdown_report: '/tmp/review.md', json_report: '/tmp/report.json' },
    ai_usage: { provider: 'test-ai', chunk_count: 1 }
  });

  assert.match(html, /Impact Analysis Report/);
  assert.match(html, /REDLINE-XSS/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('renderArtifactManifest lists report artifacts with stable roles', () => {
  const manifest = renderArtifactManifest({
    task_id: 'task_1',
    project_name: 'demo',
    artifacts: {
      html_report: '/reports/demo/index.html',
      markdown_report: '/reports/demo/review.md',
      json_report: '/reports/demo/report.json',
      diff_patch: '/reports/demo/diff.patch',
      ai_usage: '/reports/demo/ai-usage.json',
      static_findings: '/reports/demo/static-findings.json'
    }
  });

  assert.equal(manifest.schema_version, '1.0');
  assert.equal(manifest.task_id, 'task_1');
  assert.deepEqual(manifest.files.map((file) => file.role), [
    'html_report',
    'markdown_report',
    'json_report',
    'diff_patch',
    'ai_usage',
    'static_findings'
  ]);
});
