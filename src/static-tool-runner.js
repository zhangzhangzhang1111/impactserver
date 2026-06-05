const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { detectLanguage } = require('./language');

const execFileAsync = promisify(execFile);

async function runStaticTools({
  repoPath,
  fileChanges,
  reviewConfig,
  execFileImpl = execFileAsync
}) {
  const tools = configuredTools(reviewConfig);
  const languages = new Set((fileChanges || []).map((change) => detectLanguage(change.file)));
  const findings = [];
  const runs = [];

  for (const tool of tools) {
    if (!shouldRunTool(tool, languages)) continue;
    const started = Date.now();
    try {
      const result = await execFileImpl(tool.command, tool.args || [], {
        cwd: repoPath || process.cwd(),
        timeout: tool.timeout_ms || 30000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          IMPACT_STATIC_TOOL_ID: tool.id,
          IMPACT_CHANGED_FILES: JSON.stringify((fileChanges || []).map((change) => change.file))
        }
      });
      const parsed = parseToolOutput(tool, result.stdout || '');
      parsed.forEach((finding, index) => findings.push(normalizeToolFinding(finding, tool, index)));
      runs.push({
        id: tool.id,
        command: tool.command,
        parser: tool.parser,
        status: 'SUCCESS',
        finding_count: parsed.length,
        duration_ms: Date.now() - started
      });
    } catch (error) {
      runs.push({
        id: tool.id,
        command: tool.command,
        parser: tool.parser,
        status: 'FAILED',
        finding_count: 0,
        duration_ms: Date.now() - started,
        error: error.message
      });
    }
  }

  return { findings, runs };
}

function configuredTools(reviewConfig = {}) {
  const tools = reviewConfig.tools && reviewConfig.tools.static_tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && tool.id && tool.command)
    .map((tool) => ({
      id: String(tool.id),
      language: tool.language || 'all',
      command: String(tool.command),
      args: Array.isArray(tool.args) ? tool.args.map(String) : [],
      parser: tool.parser || 'json-findings',
      timeout_ms: Number(tool.timeout_ms || 30000)
    }));
}

function shouldRunTool(tool, languages) {
  return tool.language === 'all' || languages.has(tool.language);
}

function parseToolOutput(tool, stdout) {
  if (tool.parser === 'json-findings') return parseJsonFindings(stdout);
  throw new Error(`Unsupported static tool parser: ${tool.parser}`);
}

function parseJsonFindings(stdout) {
  const parsed = JSON.parse(stdout || '[]');
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.findings)) return parsed.findings;
  return [];
}

function normalizeToolFinding(finding, tool, index) {
  const file = String(finding.file || 'unknown');
  const line = Number(finding.line || 1);
  const ruleId = String(finding.rule_id || `${tool.id.toUpperCase()}-${index + 1}`);
  return {
    id: finding.id || `${tool.id}_finding_${String(index + 1).padStart(3, '0')}`,
    file,
    line,
    language: finding.language || 'unknown',
    severity: normalizeSeverity(finding.severity),
    category: finding.category || 'StaticTool',
    rule_id: ruleId,
    rule_source: `tool:${tool.id}#${ruleId}`,
    source_engine: [tool.id],
    confidence: normalizeConfidence(finding.confidence),
    message: finding.message || 'Static tool finding.',
    suggestion: finding.suggestion || 'Review the static tool finding.',
    evidence: finding.evidence || {},
    dedupe_key: `${file}:${line}:${ruleId}`
  };
}

function normalizeSeverity(value) {
  const normalized = String(value || '').toUpperCase();
  if (['CRITICAL', 'WARNING', 'INFO'].includes(normalized)) return normalized;
  return 'WARNING';
}

function normalizeConfidence(value) {
  const normalized = String(value || '').toUpperCase();
  if (['HIGH', 'MEDIUM', 'LOW'].includes(normalized)) return normalized;
  return 'MEDIUM';
}

module.exports = {
  runStaticTools,
  configuredTools,
  parseJsonFindings,
  normalizeToolFinding
};
