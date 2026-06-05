const fs = require('node:fs/promises');
const path = require('node:path');
const { collectDiff } = require('./git-diff');
const { parseDiff } = require('./diff-parser');
const { locateSymbols } = require('./symbol-locator');
const { scanRules } = require('./rule-engine');
const { renderReport, renderMarkdown, renderHtml, renderArtifactManifest } = require('./report-renderer');
const { runAiReview, mergeFindings } = require('./ai-review');
const { safeSegment } = require('./path-utils');
const { loadReviewConfig, mergeReviewConfigs } = require('./review-config');
const { runStaticTools } = require('./static-tool-runner');
const { analyzeImpact } = require('./impact-analyzer');
const { runLspCallHierarchy, mergeLspImpact } = require('./lsp-call-hierarchy');
const { runTreeSitterSymbolLocator } = require('./tree-sitter-symbol-locator');
const { createNoopLogger } = require('./logger');

async function analyze({ task, config, onStage, logger = createNoopLogger() }) {
  const request = task.request;
  const startedAt = task.started_at || new Date().toISOString();

  let diff;
  try {
    await onStage('DIFF_PARSE', 25);
    logger.info('analysis diff collection started', analysisLogContext(task, 'DIFF_PARSE'));
    diff = await collectDiff(request, config);
    const fileChanges = parseDiff(diff.patch);
    logger.info('analysis diff parsed', {
      ...analysisLogContext(task, 'DIFF_PARSE'),
      changed_file_count: fileChanges.length
    });
    const repoReviewConfig = await loadReviewConfig(diff.repoPath);
    const reviewConfig = mergeReviewConfigs(request.project_config || {}, repoReviewConfig);

    await onStage('SYMBOL_LOCATE', 45);
    logger.info('analysis symbol location started', analysisLogContext(task, 'SYMBOL_LOCATE'));
    const treeSitterResult = await runTreeSitterSymbolLocator({
      repoPath: diff.repoPath,
      fileChanges,
      reviewConfig
    });
    const symbols = await locateSymbols({
      repoPath: diff.repoPath,
      fileChanges,
      treeSitterSymbols: treeSitterResult.symbols
    });
    logger.info('analysis symbols located', {
      ...analysisLogContext(task, 'SYMBOL_LOCATE'),
      symbol_count: symbols.length,
      tree_sitter_run_count: treeSitterResult.runs.length
    });
    logger.info('analysis impact traversal started', analysisLogContext(task, 'IMPACT_ANALYSIS'));
    const staticImpactTree = await analyzeImpact({
      repoPath: diff.repoPath,
      symbols,
      maxDepth: request.options && request.options.max_call_depth
    });
    logger.info('analysis impact traversal finished', {
      ...analysisLogContext(task, 'IMPACT_ANALYSIS'),
      impact_entry_count: staticImpactTree.length
    });

    await onStage('STATIC_RULE_REVIEW', 65);
    logger.info('analysis static review started', analysisLogContext(task, 'STATIC_RULE_REVIEW'));
    const lspResult = await runLspCallHierarchy({
      repoPath: diff.repoPath,
      symbols,
      reviewConfig
    });
    const impactTree = mergeLspImpact(staticImpactTree, lspResult.impact_tree);
    const deterministicFindings = scanRules(fileChanges, reviewConfig);
    const staticToolResult = await runStaticTools({
      repoPath: diff.repoPath,
      fileChanges,
      reviewConfig
    });
    const staticFindings = mergeFindings(deterministicFindings, staticToolResult.findings);
    logger.info('analysis static review finished', {
      ...analysisLogContext(task, 'STATIC_RULE_REVIEW'),
      finding_count: staticFindings.length,
      lsp_run_count: lspResult.runs.length,
      static_tool_run_count: staticToolResult.runs.length
    });

    await onStage('AI_REVIEW', 75);
    logger.info('analysis ai review started', analysisLogContext(task, 'AI_REVIEW'));
    const aiReview = await runAiReview({
      request,
      config,
      fileChanges,
      symbols,
      staticFindings,
      reviewConfig
    });
    const findings = mergeFindings(staticFindings, aiReview.findings);
    const aiUsage = aiReview.usage;
    logger.info('analysis ai review finished', {
      ...analysisLogContext(task, 'AI_REVIEW'),
      finding_count: aiReview.findings.length,
      ai_provider: aiUsage && aiUsage.provider,
      ai_model: aiUsage && aiUsage.model
    });

    await onStage('REPORT_RENDER', 90);
    logger.info('analysis report rendering started', analysisLogContext(task, 'REPORT_RENDER'));
    const reportDir = buildReportDir({ request, task, reportsDir: config.reportsDir, startedAt });
    await fs.mkdir(reportDir, { recursive: true });

    const report = renderReport({
      task,
      request,
      startedAt,
      fileChanges,
      symbols,
      impactTree,
      findings,
      aiUsage,
      treeSitterToolRuns: treeSitterResult.runs,
      staticToolRuns: staticToolResult.runs,
      lspToolRuns: lspResult.runs,
      reportDir
    });
    const markdown = renderMarkdown(report);
    const html = renderHtml(report);
    const artifactManifest = renderArtifactManifest(report);

    await fs.writeFile(path.join(reportDir, 'index.html'), html);
    await fs.writeFile(path.join(reportDir, 'diff.patch'), diff.patch);
    await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(reportDir, 'review.md'), markdown);
    await fs.writeFile(path.join(reportDir, 'ai-usage.json'), JSON.stringify(aiUsage, null, 2));
    await fs.writeFile(path.join(reportDir, 'static-findings.json'), JSON.stringify(staticFindings, null, 2));
    await fs.writeFile(path.join(reportDir, 'tree-sitter-tool-runs.json'), JSON.stringify(treeSitterResult.runs, null, 2));
    await fs.writeFile(path.join(reportDir, 'static-tool-runs.json'), JSON.stringify(staticToolResult.runs, null, 2));
    await fs.writeFile(path.join(reportDir, 'lsp-tool-runs.json'), JSON.stringify(lspResult.runs, null, 2));
    await fs.writeFile(path.join(reportDir, 'artifacts.json'), JSON.stringify(artifactManifest, null, 2));
    logger.info('analysis report artifacts written', {
      ...analysisLogContext(task, 'REPORT_RENDER'),
      report_dir: reportDir
    });

    return report;
  } finally {
    if (diff && diff.cleanup) {
      try {
        await diff.cleanup();
        logger.info('analysis workspace cleanup finished', analysisLogContext(task, 'CLEANUP'));
      } catch (error) {
        logger.error('analysis workspace cleanup failed', {
          ...analysisLogContext(task, 'CLEANUP'),
          error
        });
        throw error;
      }
    }
  }
}

function analysisLogContext(task, stage) {
  return {
    task_id: task.task_id,
    project_name: task.project_name,
    stage
  };
}

function buildReportDir({ request, task, reportsDir, startedAt }) {
  const date = new Date(startedAt);
  const day = date.toISOString().slice(0, 10);
  const time = date.toISOString().slice(11, 19).replace(/:/g, '');
  const trigger = request.trigger || {};
  const revision = request.revision || {};
  const prPrefix = trigger.pr_number ? `pr-${trigger.pr_number}-` : '';
  const branch = safeSegment(revision.source_branch || revision.target_branch || 'unknown-branch');
  const project = safeSegment(request.project.name);
  const dirName = `${prPrefix}${branch}-${time}-${task.task_id.slice(-6)}`;
  return path.join(reportsDir, project, day, dirName);
}

module.exports = { analyze, buildReportDir, safeSegment };
