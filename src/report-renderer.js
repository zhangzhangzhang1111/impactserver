const path = require('node:path');

function renderReport({
  task,
  request,
  startedAt,
  fileChanges,
  symbols,
  impactTree,
  findings,
  aiUsage,
  treeSitterToolRuns = [],
  staticToolRuns = [],
  lspToolRuns = [],
  reportDir
}) {
  const criticalCount = findings.filter((finding) => finding.severity === 'CRITICAL').length;
  const warningCount = findings.filter((finding) => finding.severity === 'WARNING').length;
  const riskScore = Math.min(100, criticalCount * 45 + warningCount * 15 + symbols.length * 2);
  const riskLevel = criticalCount > 0 ? 'HIGH' : warningCount > 0 ? 'MEDIUM' : symbols.length > 0 ? 'LOW' : 'LOW';

  return {
    schema_version: '1.0',
    task_id: task.task_id,
    project_name: request.project.name,
    meta: {
      repository: request.project.repository_full_name || request.project.clone_url || request.project.repository_path || null,
      base_commit: request.revision && request.revision.base_commit,
      target_commit: request.revision && request.revision.target_commit,
      languages: request.languages || [],
      analyzed_at: new Date(startedAt).toISOString()
    },
    verdict: {
      risk_level: riskLevel,
      blocking: criticalCount > 0,
      risk_score: riskScore,
      critical_count: criticalCount,
      warning_count: warningCount
    },
    findings,
    impact_tree: impactTree || buildImpactTree(symbols),
    changed_files: fileChanges.map((file) => ({
      file: file.file,
      added_line_count: file.added_lines.length
    })),
    tree_sitter_tool_runs: treeSitterToolRuns,
    static_tool_runs: staticToolRuns,
    lsp_tool_runs: lspToolRuns,
    ai_usage: aiUsage,
    limitations: [
      'Symbol location uses configured Tree-sitter wrappers when available and falls back to heuristic parsing for uncovered files or failed tools.',
      'Static reference call chains may miss dynamic dispatch; LSP call hierarchy can replace this source when configured.'
    ],
    artifacts: {
      report_dir: reportDir,
      html_report: path.join(reportDir, 'index.html'),
      markdown_report: path.join(reportDir, 'review.md'),
      json_report: path.join(reportDir, 'report.json'),
      diff_patch: path.join(reportDir, 'diff.patch'),
      ai_usage: path.join(reportDir, 'ai-usage.json'),
      static_findings: path.join(reportDir, 'static-findings.json'),
      tree_sitter_tool_runs: path.join(reportDir, 'tree-sitter-tool-runs.json'),
      static_tool_runs: path.join(reportDir, 'static-tool-runs.json'),
      lsp_tool_runs: path.join(reportDir, 'lsp-tool-runs.json'),
      artifact_manifest: path.join(reportDir, 'artifacts.json')
    }
  };
}

function buildImpactTree(symbols) {
  const grouped = new Map();
  for (const item of symbols) {
    const key = `${item.file}:${item.symbol}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        modified_symbol: item.symbol,
        file: item.file,
        language: item.language,
        confidence: item.confidence,
        source: item.source,
        changed_lines: []
      });
    }
    grouped.get(key).changed_lines.push(item.line);
  }
  return Array.from(grouped.values());
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Impact Analysis Report`);
  lines.push('');
  lines.push(`- Task: \`${report.task_id}\``);
  lines.push(`- Project: \`${report.project_name}\``);
  lines.push(`- Risk: **${report.verdict.risk_level}** (${report.verdict.risk_score})`);
  lines.push(`- Blocking: **${report.verdict.blocking ? 'yes' : 'no'}**`);
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('No deterministic redline findings were detected.');
  } else {
    lines.push('| Severity | Rule | File | Line | Message |');
    lines.push('| --- | --- | --- | ---: | --- |');
    for (const finding of report.findings) {
      lines.push(`| ${finding.severity} | ${finding.rule_id} | ${finding.file} | ${finding.line} | ${finding.message} |`);
    }
  }
  lines.push('');
  lines.push('## Impact Tree');
  lines.push('');
  if (report.impact_tree.length === 0) {
    lines.push('No changed symbols were located.');
  } else {
    for (const item of report.impact_tree) {
      lines.push(`- \`${item.modified_symbol}\` in \`${item.file}\` (${item.language}, ${item.confidence}) lines ${item.changed_lines.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  for (const limitation of report.limitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push('');
  lines.push('## Recommended Test Points');
  lines.push('');
  if (report.findings.length > 0) {
    lines.push('- Add regression tests for each critical finding before merging.');
    lines.push('- Exercise changed entry points listed in the impact tree.');
  } else {
    lines.push('- Run project unit tests covering changed files and directly affected entry points.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderHtml(report) {
  const findingsRows = report.findings.length === 0
    ? '<tr><td colspan="5">No findings were detected.</td></tr>'
    : report.findings.map((finding) => `<tr><td>${escapeHtml(finding.severity)}</td><td>${escapeHtml(finding.rule_id)}</td><td>${escapeHtml(finding.file)}</td><td>${escapeHtml(finding.line)}</td><td>${escapeHtml(finding.message)}</td></tr>`).join('');
  const impactItems = report.impact_tree.length === 0
    ? '<li>No changed symbols were located.</li>'
    : report.impact_tree.map((item) => `<li><strong>${escapeHtml(item.modified_symbol)}</strong> in <code>${escapeHtml(item.file)}</code> (${escapeHtml(item.language)}, ${escapeHtml(item.confidence)})</li>`).join('');
  const artifactLinks = Object.entries(report.artifacts || {})
    .filter(([role]) => role !== 'report_dir')
    .map(([role, filePath]) => `<li><a href="${escapeHtml(path.basename(filePath))}">${escapeHtml(role)}</a></li>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Impact Analysis Report - ${escapeHtml(report.task_id)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1f2933; line-height: 1.45; }
    header { border-bottom: 1px solid #d9e2ec; margin-bottom: 24px; padding-bottom: 16px; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 16px 0; }
    .metric { border: 1px solid #d9e2ec; border-radius: 6px; padding: 12px; background: #f8fafc; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0 24px; }
    th, td { border: 1px solid #d9e2ec; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f1f5f9; }
    code { background: #edf2f7; padding: 1px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <header>
    <h1>Impact Analysis Report</h1>
    <p>Task <code>${escapeHtml(report.task_id)}</code> for <code>${escapeHtml(report.project_name)}</code></p>
  </header>
  <section class="meta">
    <div class="metric"><strong>Risk</strong><br>${escapeHtml(report.verdict.risk_level)} (${escapeHtml(report.verdict.risk_score)})</div>
    <div class="metric"><strong>Blocking</strong><br>${report.verdict.blocking ? 'yes' : 'no'}</div>
    <div class="metric"><strong>Critical</strong><br>${escapeHtml(report.verdict.critical_count)}</div>
    <div class="metric"><strong>Warnings</strong><br>${escapeHtml(report.verdict.warning_count)}</div>
  </section>
  <section>
    <h2>Findings</h2>
    <table>
      <thead><tr><th>Severity</th><th>Rule</th><th>File</th><th>Line</th><th>Message</th></tr></thead>
      <tbody>${findingsRows}</tbody>
    </table>
  </section>
  <section>
    <h2>Impact Tree</h2>
    <ul>${impactItems}</ul>
  </section>
  <section>
    <h2>Artifacts</h2>
    <ul>${artifactLinks}</ul>
  </section>
</body>
</html>
`;
}

function renderArtifactManifest(report) {
  return {
    schema_version: '1.0',
    task_id: report.task_id,
    project_name: report.project_name,
    generated_at: report.meta && report.meta.analyzed_at,
    files: Object.entries(report.artifacts || {})
      .filter(([role]) => role !== 'report_dir')
      .map(([role, filePath]) => ({
        role,
        path: filePath,
        file: path.basename(filePath)
      }))
  };
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { renderReport, renderMarkdown, renderHtml, renderArtifactManifest, buildImpactTree };
