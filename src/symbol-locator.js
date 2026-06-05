const fs = require('node:fs/promises');
const path = require('node:path');
const { detectLanguage } = require('./language');
const { mapChangedLinesToTreeSitterSymbols } = require('./tree-sitter-symbol-locator');

async function locateSymbols({ repoPath, fileChanges, treeSitterSymbols = [] }) {
  const result = [];
  const treeSitterByLine = mapChangedLinesToTreeSitterSymbols({ fileChanges, ranges: treeSitterSymbols });
  for (const change of fileChanges) {
    const language = detectLanguage(change.file);
    const source = await readSource(repoPath, change.file);
    const index = source ? indexSymbols(source, language) : [];
    for (const added of change.added_lines) {
      const treeSitterSymbol = treeSitterByLine.get(`${change.file}:${added.line}`);
      if (treeSitterSymbol) {
        result.push(treeSitterSymbol);
        continue;
      }
      const symbol = findEnclosingSymbol(index, added.line) || {
        name: '<module>',
        kind: 'module',
        start_line: 1,
        end_line: source ? source.split(/\r?\n/).length : added.line
      };
      result.push({
        file: change.file,
        line: added.line,
        language,
        symbol: symbol.name,
        kind: symbol.kind,
        confidence: source ? 'MEDIUM' : 'LOW',
        source: source ? 'heuristic-symbol-locator' : 'diff-only'
      });
    }
  }
  return result;
}

async function readSource(repoPath, file) {
  if (!repoPath) return '';
  try {
    return await fs.readFile(path.join(repoPath, file), 'utf8');
  } catch {
    return '';
  }
}

function indexSymbols(source, language) {
  const lines = source.split(/\r?\n/);
  const symbols = [];

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    const match = matchSymbol(line, language);
    if (!match) return;
    symbols.push({
      name: match.name,
      kind: match.kind,
      start_line: lineNumber,
      end_line: lines.length
    });
  });

  for (let i = 0; i < symbols.length; i += 1) {
    symbols[i].end_line = (symbols[i + 1] && symbols[i + 1].start_line - 1) || lines.length;
  }
  return symbols;
}

function matchSymbol(line, language) {
  const trimmed = line.trim();
  if (language === 'python') {
    const match = trimmed.match(/^(async\s+def|def|class)\s+([A-Za-z_][\w]*)/);
    if (match) return { kind: match[1].includes('class') ? 'class' : 'function', name: match[2] };
  }
  if (language === 'lua') {
    const match = trimmed.match(/^(?:local\s+)?function\s+([A-Za-z_][\w.:]*)|^([A-Za-z_][\w.]*)\s*=\s*function\b/);
    if (match) return { kind: 'function', name: match[1] || match[2] };
  }
  if (language === 'java') {
    const classMatch = trimmed.match(/^(?:public|private|protected|abstract|final|\s)*\s*class\s+([A-Za-z_][\w]*)/);
    if (classMatch) return { kind: 'class', name: classMatch[1] };
    const methodMatch = trimmed.match(/^(?:public|private|protected|static|final|synchronized|\s)+[\w<>\[\], ?]+\s+([A-Za-z_][\w]*)\s*\(/);
    if (methodMatch) return { kind: 'method', name: methodMatch[1] };
  }
  if (language === 'c' || language === 'cpp') {
    const match = trimmed.match(/^(?:[\w:*&<>,~]+\s+)+([A-Za-z_][\w:]*)\s*\([^;]*\)\s*(?:const\s*)?\{/);
    if (match) return { kind: 'function', name: match[1] };
  }
  return null;
}

function findEnclosingSymbol(symbols, line) {
  return symbols.find((symbol) => symbol.start_line <= line && line <= symbol.end_line);
}

module.exports = { locateSymbols, indexSymbols, matchSymbol, findEnclosingSymbol };
