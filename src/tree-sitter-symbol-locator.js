const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { detectLanguage } = require('./language');

const execFileAsync = promisify(execFile);

async function runTreeSitterSymbolLocator({
  repoPath,
  fileChanges,
  reviewConfig,
  execFileImpl = execFileAsync
}) {
  const tools = configuredTreeSitterTools(reviewConfig);
  const languages = new Set((fileChanges || []).map((change) => detectLanguage(change.file)));
  const symbols = [];
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
          IMPACT_TREE_SITTER_TOOL_ID: tool.id,
          IMPACT_REPO_PATH: repoPath || '',
          IMPACT_FILE_CHANGES: JSON.stringify(fileChanges || []),
          IMPACT_CHANGED_FILES: JSON.stringify((fileChanges || []).map((change) => change.file))
        }
      });
      const parsed = parseTreeSitterOutput(tool, result.stdout || '');
      parsed.forEach((entry) => symbols.push(normalizeSymbolRange(entry, tool)));
      runs.push({
        id: tool.id,
        command: tool.command,
        parser: tool.parser,
        status: 'SUCCESS',
        symbol_count: parsed.length,
        duration_ms: Date.now() - started
      });
    } catch (error) {
      runs.push({
        id: tool.id,
        command: tool.command,
        parser: tool.parser,
        status: 'FAILED',
        symbol_count: 0,
        duration_ms: Date.now() - started,
        error: error.message
      });
    }
  }

  return { symbols, runs };
}

function configuredTreeSitterTools(reviewConfig = {}) {
  const tools = reviewConfig.tools && reviewConfig.tools.tree_sitter_symbol_locator;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && tool.id && tool.command)
    .map((tool) => ({
      id: String(tool.id),
      language: tool.language || 'all',
      command: String(tool.command),
      args: Array.isArray(tool.args) ? tool.args.map(String) : [],
      parser: tool.parser || 'json-symbols',
      timeout_ms: Number(tool.timeout_ms || 30000)
    }));
}

function shouldRunTool(tool, languages) {
  return tool.language === 'all' || languages.has(tool.language);
}

function parseTreeSitterOutput(tool, stdout) {
  if (tool.parser !== 'json-symbols') {
    throw new Error(`Unsupported Tree-sitter symbol parser: ${tool.parser}`);
  }
  const parsed = JSON.parse(stdout || '{}');
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.symbols)) return parsed.symbols;
  return [];
}

function normalizeSymbolRange(entry, tool) {
  const file = String(entry.file || 'unknown');
  const startLine = Number(entry.start_line || entry.startLine || entry.line || 1);
  const endLine = Number(entry.end_line || entry.endLine || startLine);
  return {
    file,
    name: entry.name || entry.symbol || '<module>',
    kind: entry.kind || 'symbol',
    language: entry.language || (tool.language === 'all' ? detectLanguage(file) : tool.language),
    start_line: startLine,
    end_line: Math.max(startLine, endLine),
    confidence: normalizeConfidence(entry.confidence || 'HIGH'),
    source: 'Tree-sitter',
    locator_tool: tool.id
  };
}

function mapChangedLinesToTreeSitterSymbols({ fileChanges, ranges }) {
  const result = new Map();
  const rangesByFile = new Map();
  for (const range of ranges || []) {
    if (!rangesByFile.has(range.file)) rangesByFile.set(range.file, []);
    rangesByFile.get(range.file).push(range);
  }

  for (const change of fileChanges || []) {
    const fileRanges = rangesByFile.get(change.file) || [];
    for (const added of change.added_lines || []) {
      const match = findSmallestEnclosingRange(fileRanges, added.line);
      if (!match) continue;
      result.set(`${change.file}:${added.line}`, {
        file: change.file,
        line: added.line,
        language: match.language || detectLanguage(change.file),
        symbol: match.name,
        kind: match.kind,
        confidence: match.confidence || 'HIGH',
        source: 'Tree-sitter',
        locator_tool: match.locator_tool,
        start_line: match.start_line,
        end_line: match.end_line
      });
    }
  }

  return result;
}

function findSmallestEnclosingRange(ranges, line) {
  return (ranges || [])
    .filter((range) => range.start_line <= line && line <= range.end_line)
    .sort((left, right) => {
      const leftSize = left.end_line - left.start_line;
      const rightSize = right.end_line - right.start_line;
      return leftSize - rightSize;
    })[0];
}

function normalizeConfidence(value) {
  const normalized = String(value || '').toUpperCase();
  if (['HIGH', 'MEDIUM', 'LOW'].includes(normalized)) return normalized;
  return 'HIGH';
}

module.exports = {
  runTreeSitterSymbolLocator,
  configuredTreeSitterTools,
  parseTreeSitterOutput,
  normalizeSymbolRange,
  mapChangedLinesToTreeSitterSymbols
};
