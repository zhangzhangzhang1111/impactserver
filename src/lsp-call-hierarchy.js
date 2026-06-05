const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function runLspCallHierarchy({
  repoPath,
  symbols,
  reviewConfig,
  execFileImpl = execFileAsync
}) {
  const tools = configuredLspTools(reviewConfig);
  const languages = new Set((symbols || []).map((symbol) => symbol.language));
  const impactTree = [];
  const runs = [];

  for (const tool of tools) {
    if (!shouldRunTool(tool, languages)) continue;
    const started = Date.now();
    try {
      const result = await execFileImpl(tool.command, tool.args || [], {
        cwd: repoPath || process.cwd(),
        timeout: tool.timeout_ms || 60000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          IMPACT_LSP_TOOL_ID: tool.id,
          IMPACT_SYMBOLS: JSON.stringify(symbols || [])
        }
      });
      const parsed = parseLspOutput(tool, result.stdout || '');
      parsed.forEach((entry) => impactTree.push(normalizeImpactEntry(entry, tool)));
      runs.push({
        id: tool.id,
        command: tool.command,
        parser: tool.parser,
        status: 'SUCCESS',
        impact_count: parsed.length,
        duration_ms: Date.now() - started
      });
    } catch (error) {
      runs.push({
        id: tool.id,
        command: tool.command,
        parser: tool.parser,
        status: 'FAILED',
        impact_count: 0,
        duration_ms: Date.now() - started,
        error: error.message
      });
    }
  }

  return { impact_tree: impactTree, runs };
}

function configuredLspTools(reviewConfig = {}) {
  const tools = reviewConfig.tools && reviewConfig.tools.lsp_call_hierarchy;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && tool.id && tool.command)
    .map((tool) => ({
      id: String(tool.id),
      language: tool.language || 'all',
      command: String(tool.command),
      args: Array.isArray(tool.args) ? tool.args.map(String) : [],
      parser: tool.parser || 'json-impact',
      timeout_ms: Number(tool.timeout_ms || 60000)
    }));
}

function shouldRunTool(tool, languages) {
  return tool.language === 'all' || languages.has(tool.language);
}

function parseLspOutput(tool, stdout) {
  if (tool.parser !== 'json-impact') {
    throw new Error(`Unsupported LSP call hierarchy parser: ${tool.parser}`);
  }
  const parsed = JSON.parse(stdout || '{}');
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.impact_tree)) return parsed.impact_tree;
  return [];
}

function normalizeImpactEntry(entry, tool) {
  return {
    modified_symbol: entry.modified_symbol || '<unknown>',
    file: entry.file || 'unknown',
    language: entry.language || tool.language || 'unknown',
    confidence: entry.confidence || 'HIGH',
    source: 'LSP',
    changed_lines: Array.isArray(entry.changed_lines) ? entry.changed_lines : [],
    level_1_callers: normalizeCallers(entry.level_1_callers || []),
    level_2_callers: normalizeCallers(entry.level_2_callers || []),
    limitations: Array.isArray(entry.limitations) ? entry.limitations : [],
    lsp_tool: tool.id
  };
}

function normalizeCallers(callers) {
  return callers.map((caller) => ({
    symbol: caller.symbol || '<unknown>',
    file: caller.file || 'unknown',
    language: caller.language || 'unknown',
    line: Number(caller.line || 1),
    risk: caller.risk || 'UNKNOWN',
    source: 'LSP',
    confidence: caller.confidence || 'HIGH'
  }));
}

function mergeLspImpact(staticImpact, lspImpact) {
  const merged = new Map();
  for (const entry of staticImpact || []) {
    merged.set(keyFor(entry), entry);
  }
  for (const entry of lspImpact || []) {
    const key = keyFor(entry);
    const existing = merged.get(key);
    merged.set(key, {
      ...(existing || {}),
      ...entry,
      changed_lines: entry.changed_lines && entry.changed_lines.length
        ? entry.changed_lines
        : (existing && existing.changed_lines) || [],
      limitations: Array.from(new Set([
        ...((entry && entry.limitations) || []),
        ...((existing && existing.limitations) || [])
      ]))
    });
  }
  return Array.from(merged.values());
}

function keyFor(entry) {
  return `${entry.file}:${entry.modified_symbol}`;
}

module.exports = {
  runLspCallHierarchy,
  configuredLspTools,
  parseLspOutput,
  normalizeImpactEntry,
  mergeLspImpact
};
