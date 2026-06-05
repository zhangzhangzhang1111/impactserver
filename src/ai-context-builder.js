const DEFAULT_MAX_INPUT_TOKENS = 120000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
const DEFAULT_MAX_FINDINGS_PER_CHUNK = 20;
const { LANGUAGE_RULES, customRuleSourcePrefix } = require('./rule-engine');

function buildAiReviewChunks({ request, fileChanges, symbols, staticFindings, reviewConfig }) {
  const maxTokens = Number((request.ai && request.ai.max_input_tokens)
    || (request.options && request.options.max_ai_input_tokens)
    || DEFAULT_MAX_INPUT_TOKENS);
  const fixed = buildFixedContext(request, reviewConfig);
  const staticByFile = groupBy(staticFindings || [], (finding) => finding.file);
  const symbolsByFile = groupBy(symbols || [], (symbol) => symbol.file);

  const items = (fileChanges || []).map((change) => ({
    file: change.file,
    added_lines: change.added_lines || [],
    symbols: symbolsByFile.get(change.file) || [],
    static_findings: staticByFile.get(change.file) || []
  })).sort(compareRiskFirst);

  const chunks = [];
  let current = emptyChunk(fixed, chunks.length);

  for (const item of items) {
    const candidate = appendItem(current, item);
    if (estimateTokens(candidate) <= maxTokens || current.files.length === 0) {
      current = fitChunk(candidate, maxTokens);
      continue;
    }
    chunks.push(finishChunk(current, maxTokens));
    current = fitChunk(appendItem(emptyChunk(fixed, chunks.length), item), maxTokens);
  }

  if (current.files.length > 0 || chunks.length === 0) {
    chunks.push(finishChunk(current, maxTokens));
  }
  return chunks;
}

function buildFixedContext(request, reviewConfig = {}) {
  return {
    role: 'You are an AI code impact and redline review assistant. Return JSON only.',
    output_schema: {
      findings: [{
        file: 'string',
        line: 'number',
        language: 'lua|c|cpp|java|python|unknown',
        severity: 'CRITICAL|WARNING|INFO',
        category: 'string',
        rule_id: 'string',
        rule_source: 'string',
        confidence: 'HIGH|MEDIUM|LOW',
        message: 'string',
        suggestion: 'string',
        evidence: { code_excerpt: 'string' }
      }]
    },
    redline_rules: [
      'REDLINE-SECRETS-001',
      'REDLINE-INJECTION-001',
      'REDLINE-PRIVACY-001',
      'REDLINE-ERROR-001',
      'REDLINE-EXCEPTION-001'
    ],
    repo_rule_documents: (reviewConfig.rule_documents || []).map((document) => ({
      type: document.type,
      path: document.path,
      content: document.content
    })),
    custom_rules: ((reviewConfig.rules && reviewConfig.rules.custom_rules) || []).map((rule) => ({
      id: rule.id,
      language: rule.language,
      severity: rule.severity,
      description: rule.description,
      rule_source: `${customRuleSourcePrefix(rule)}#${rule.id}`
    })),
    language_rules: languageRulesForContext(request.languages || []),
    languages: request.languages || [],
    output_constraints: {
      max_findings: numberOption(request, 'max_findings_per_chunk', DEFAULT_MAX_FINDINGS_PER_CHUNK),
      max_output_tokens: numberOption(request, 'max_output_tokens', DEFAULT_MAX_OUTPUT_TOKENS)
    }
  };
}

function languageRulesForContext(languages) {
  const allowed = new Set(languages || []);
  return LANGUAGE_RULES
    .filter((rule) => allowed.size === 0 || allowed.has(rule.language))
    .map((rule) => ({
      id: rule.id,
      language: rule.language,
      severity: rule.severity,
      category: rule.category,
      description: rule.message,
      suggestion: rule.suggestion,
      rule_source: `global:language-rules#${rule.id}`
    }));
}

function numberOption(request, key, fallback) {
  const value = request.ai && request.ai[key] !== undefined
    ? request.ai[key]
    : request.options && request.options[key] !== undefined
      ? request.options[key]
      : fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function emptyChunk(fixed, index) {
  return {
    chunk_id: `chunk_${String(index + 1).padStart(3, '0')}`,
    fixed,
    files: [],
    symbols: [],
    static_findings: [],
    truncated: false,
    estimated_input_tokens: 0
  };
}

function appendItem(chunk, item) {
  return {
    ...chunk,
    files: [...chunk.files, { file: item.file, added_lines: item.added_lines }],
    symbols: [...chunk.symbols, ...item.symbols],
    static_findings: [...chunk.static_findings, ...item.static_findings]
  };
}

function finishChunk(chunk, maxTokens) {
  const fitted = fitChunk(chunk, maxTokens);
  return {
    ...fitted,
    estimated_input_tokens: Math.min(estimateTokens(fitted), maxTokens)
  };
}

function fitChunk(chunk, maxTokens) {
  let fitted = {
    ...chunk,
    files: chunk.files.map((file) => ({
      ...file,
      added_lines: file.added_lines.map((line) => ({ ...line }))
    }))
  };

  while (estimateTokens(fitted) > maxTokens && countLines(fitted.files) > 1) {
    fitted = trimOneLine(fitted);
  }

  if (estimateTokens(fitted) > maxTokens) {
    fitted = {
      ...fitted,
      files: fitted.files.map((file) => ({
        ...file,
        added_lines: file.added_lines.slice(0, 1).map((line) => ({
          ...line,
          text: truncate(line.text, Math.max(24, maxTokens * 2))
        }))
      })),
      truncated: true
    };
  }

  return fitted;
}

function trimOneLine(chunk) {
  const files = chunk.files.map((file) => ({
    ...file,
    added_lines: [...file.added_lines]
  }));
  for (let i = files.length - 1; i >= 0; i -= 1) {
    if (files[i].added_lines.length > 1) {
      files[i].added_lines.pop();
      return { ...chunk, files, truncated: true };
    }
  }
  return { ...chunk, files, truncated: true };
}

function countLines(files) {
  return files.reduce((sum, file) => sum + file.added_lines.length, 0);
}

function compareRiskFirst(left, right) {
  return maxSeverityScore(right.static_findings) - maxSeverityScore(left.static_findings);
}

function maxSeverityScore(findings) {
  return Math.max(0, ...findings.map((finding) => ({
    CRITICAL: 3,
    WARNING: 2,
    INFO: 1
  }[finding.severity] || 0)));
}

function estimateTokens(value) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function truncate(value, length) {
  const text = String(value || '');
  if (text.length <= length) return text;
  return `${text.slice(0, length - 15)}...[truncated]`;
}

module.exports = { buildAiReviewChunks, estimateTokens, numberOption, languageRulesForContext };
