const fs = require('node:fs/promises');
const path = require('node:path');
const { detectLanguage } = require('./language');
const { indexSymbols, findEnclosingSymbol } = require('./symbol-locator');

const SUPPORTED_EXTENSIONS = new Set(['.py', '.lua', '.java', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx']);

async function analyzeImpact({ repoPath, symbols, maxDepth = 2 }) {
  const baseTree = buildBaseImpactTree(symbols);
  if (!repoPath) return baseTree;

  const files = await listSourceFiles(repoPath);
  const sourceIndex = await indexRepository(repoPath, files);

  return baseTree.map((impact) => {
    const level1 = uniqueCallers(findCallers(sourceIndex, impact.modified_symbol, impact.file));
    const level2 = maxDepth >= 2
      ? uniqueCallers(level1.flatMap((caller) => findCallers(sourceIndex, caller.symbol, caller.file)))
      : [];
    return {
      ...impact,
      confidence: level1.length > 0 ? 'MEDIUM' : impact.confidence,
      source: level1.length > 0 ? 'static-reference' : impact.source,
      level_1_callers: level1,
      level_2_callers: level2,
      limitations: [
        'static reference tracing may miss dynamic calls, reflection, monkey patching, macro expansion, and runtime registration',
        'LSP call hierarchy is not yet enabled for this task'
      ]
    };
  });
}

function buildBaseImpactTree(symbols) {
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
        changed_lines: [],
        level_1_callers: [],
        level_2_callers: [],
        limitations: ['impact analysis is limited to changed symbols when repository sources are unavailable']
      });
    }
    grouped.get(key).changed_lines.push(item.line);
  }
  return Array.from(grouped.values());
}

async function indexRepository(repoPath, files) {
  const entries = [];
  for (const file of files) {
    const absolute = path.join(repoPath, file);
    const source = await fs.readFile(absolute, 'utf8');
    const language = detectLanguage(file);
    entries.push({
      file,
      language,
      source,
      lines: source.split(/\r?\n/),
      symbols: indexSymbols(source, language)
    });
  }
  return entries;
}

function findCallers(sourceIndex, calleeSymbol, calleeFile) {
  if (!calleeSymbol || calleeSymbol === '<module>') return [];
  const callers = [];
  const referencePattern = referenceRegex(calleeSymbol);
  for (const entry of sourceIndex) {
    entry.lines.forEach((line, idx) => {
      const lineNumber = idx + 1;
      if (entry.file === calleeFile && definitionLineMatches(line, calleeSymbol, entry.language)) return;
      if (!referencePattern.test(line)) return;
      const enclosing = findEnclosingSymbol(entry.symbols, lineNumber);
      if (!enclosing || enclosing.name === calleeSymbol) return;
      callers.push({
        symbol: enclosing.name,
        file: entry.file,
        language: entry.language,
        line: lineNumber,
        risk: 'UNKNOWN',
        source: 'static-reference',
        confidence: 'MEDIUM'
      });
    });
  }
  return callers;
}

function referenceRegex(symbol) {
  const bare = symbol.split(/[.:]/).pop();
  return new RegExp(`\\b${escapeRegex(bare)}\\s*\\(`);
}

function definitionLineMatches(line, symbol, language) {
  const trimmed = line.trim();
  const bare = symbol.split(/[.:]/).pop();
  if (language === 'python') return new RegExp(`^(async\\s+def|def|class)\\s+${escapeRegex(bare)}\\b`).test(trimmed);
  if (language === 'lua') return trimmed.includes(`function ${symbol}`) || trimmed.includes(`${symbol} = function`);
  if (language === 'java' || language === 'c' || language === 'cpp') return new RegExp(`\\b${escapeRegex(bare)}\\s*\\([^;]*\\)`).test(trimmed) && trimmed.endsWith('{');
  return false;
}

async function listSourceFiles(repoPath) {
  const result = [];
  async function walk(currentDir, relativeDir = '') {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolute = path.join(currentDir, entry.name);
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        result.push(relative);
      }
    }
  }
  await walk(repoPath);
  return result.sort();
}

function uniqueCallers(callers) {
  const seen = new Set();
  return callers.filter((caller) => {
    const key = `${caller.file}:${caller.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  analyzeImpact,
  buildBaseImpactTree,
  findCallers,
  listSourceFiles
};
