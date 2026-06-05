const fs = require('node:fs/promises');
const path = require('node:path');

const EMPTY_REVIEW_CONFIG = Object.freeze({
  version: '1.0',
  project: { languages: [] },
  rules: {
    redline_documents: [],
    style_documents: [],
    custom_rules: []
  },
  tools: { static_tools: [], tree_sitter_symbol_locator: [], lsp_call_hierarchy: [] },
  ai: {},
  rule_documents: []
});

async function loadReviewConfig(repoPath) {
  if (!repoPath) return cloneEmpty();
  const yamlPath = path.join(repoPath, '.review-config.yaml');
  const jsonPath = path.join(repoPath, '.review-config.json');
  let config;

  if (await exists(jsonPath)) {
    config = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  } else if (await exists(yamlPath)) {
    config = parseReviewConfigYaml(await fs.readFile(yamlPath, 'utf8'));
  } else {
    return cloneEmpty();
  }

  const normalized = normalizeReviewConfig(config);
  normalized.rule_documents = await loadRuleDocuments(repoPath, normalized);
  return normalized;
}

function normalizeReviewConfig(config) {
  return {
    version: String(config.version || '1.0'),
    project: {
      languages: asArray(config.project && config.project.languages)
    },
    rules: {
      redline_documents: asArray(config.rules && config.rules.redline_documents),
      style_documents: asArray(config.rules && config.rules.style_documents),
      custom_rules: asArray(config.rules && config.rules.custom_rules).map(normalizeCustomRule)
    },
    tools: {
      static_tools: asArray(config.tools && config.tools.static_tools).map(normalizeStaticTool),
      tree_sitter_symbol_locator: asArray(config.tools && config.tools.tree_sitter_symbol_locator).map(normalizeTreeSitterTool),
      lsp_call_hierarchy: asArray(config.tools && config.tools.lsp_call_hierarchy).map(normalizeLspTool)
    },
    ai: config.ai || {},
    rule_documents: []
  };
}

function normalizeCustomRule(rule) {
  return {
    id: String(rule.id || '').trim(),
    language: rule.language || 'unknown',
    severity: normalizeSeverity(rule.severity || 'WARNING'),
    category: rule.category || 'CustomRule',
    description: rule.description || rule.message || 'Repository custom rule matched.',
    pattern: rule.pattern || '',
    suggestion: rule.suggestion || 'Review the repository custom rule and update the change.',
    scope: rule.scope || 'repo'
  };
}

function normalizeStaticTool(tool) {
  return {
    id: String(tool.id || '').trim(),
    language: tool.language || 'all',
    command: String(tool.command || '').trim(),
    args: asArray(tool.args).map(String),
    parser: tool.parser || 'json-findings',
    timeout_ms: Number(tool.timeout_ms || 30000)
  };
}

function normalizeTreeSitterTool(tool) {
  return {
    id: String(tool.id || '').trim(),
    language: tool.language || 'all',
    command: String(tool.command || '').trim(),
    args: asArray(tool.args).map(String),
    parser: tool.parser || 'json-symbols',
    timeout_ms: Number(tool.timeout_ms || 30000)
  };
}

function normalizeLspTool(tool) {
  return {
    id: String(tool.id || '').trim(),
    language: tool.language || 'all',
    command: String(tool.command || '').trim(),
    args: asArray(tool.args).map(String),
    parser: tool.parser || 'json-impact',
    timeout_ms: Number(tool.timeout_ms || 60000)
  };
}

async function loadRuleDocuments(repoPath, config) {
  const documents = [];
  const refs = [
    ...config.rules.redline_documents.map((docPath) => ({ type: 'redline', path: docPath })),
    ...config.rules.style_documents.map((docPath) => ({ type: 'style', path: docPath }))
  ];
  for (const ref of refs) {
    const absolute = safeRepoPath(repoPath, ref.path);
    documents.push({
      type: ref.type,
      path: ref.path,
      content: await fs.readFile(absolute, 'utf8')
    });
  }
  return documents;
}

function safeRepoPath(repoPath, relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Rule document path is outside repository: ${relativePath}`);
  }
  const root = path.resolve(repoPath);
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Rule document path is outside repository: ${relativePath}`);
  }
  return absolute;
}

function parseReviewConfigYaml(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = source.split(/\r?\n/);

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)[0].length;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;

    if (line.startsWith('- ')) {
      const itemText = line.slice(2).trim();
      if (!Array.isArray(parent)) {
        throw new Error(`Invalid YAML list item: ${line}`);
      }
      if (isObjectStart(itemText)) {
        const [key, value] = splitKeyValue(itemText);
        const item = { [key]: parseScalar(value) };
        parent.push(item);
        stack.push({ indent, value: item });
      } else {
        parent.push(parseScalar(itemText));
      }
      continue;
    }

    const [key, valueText] = splitKeyValue(line);
    if (valueText === '') {
      const container = nextSignificantLine(lines, rawLine).trim().startsWith('- ') ? [] : {};
      parent[key] = container;
      stack.push({ indent, value: container });
    } else {
      parent[key] = parseScalar(valueText);
    }
  }

  return root;
}

function splitKeyValue(line) {
  const index = line.indexOf(':');
  if (index === -1) throw new Error(`Invalid YAML line: ${line}`);
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

function isObjectStart(value) {
  return /^[A-Za-z0-9_.-]+\s*:/.test(value);
}

function parseScalar(value) {
  if (value === '') return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseScalar(item.trim()));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function nextSignificantLine(lines, rawLine) {
  const index = lines.indexOf(rawLine);
  for (let i = index + 1; i < lines.length; i += 1) {
    if (lines[i].trim()) return lines[i];
  }
  return '';
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeSeverity(value) {
  const normalized = String(value || '').toUpperCase();
  if (['CRITICAL', 'WARNING', 'INFO'].includes(normalized)) return normalized;
  return 'WARNING';
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function cloneEmpty() {
  return JSON.parse(JSON.stringify(EMPTY_REVIEW_CONFIG));
}

function mergeReviewConfigs(projectConfig = {}, repoConfig = cloneEmpty()) {
  const normalizedProject = normalizeReviewConfig(projectConfig || {});
  normalizedProject.rules.custom_rules = normalizedProject.rules.custom_rules.map((rule) => ({
    ...rule,
    scope: 'project'
  }));
  return {
    version: repoConfig.version || normalizedProject.version || '1.0',
    project: {
      languages: mergeUnique(normalizedProject.project.languages, repoConfig.project && repoConfig.project.languages)
    },
    rules: {
      redline_documents: mergeUnique(normalizedProject.rules.redline_documents, repoConfig.rules && repoConfig.rules.redline_documents),
      style_documents: mergeUnique(normalizedProject.rules.style_documents, repoConfig.rules && repoConfig.rules.style_documents),
      custom_rules: [
        ...normalizedProject.rules.custom_rules,
        ...((repoConfig.rules && repoConfig.rules.custom_rules) || [])
      ]
    },
    tools: {
      static_tools: [
        ...normalizedProject.tools.static_tools,
        ...((repoConfig.tools && repoConfig.tools.static_tools) || [])
      ],
      tree_sitter_symbol_locator: [
        ...normalizedProject.tools.tree_sitter_symbol_locator,
        ...((repoConfig.tools && repoConfig.tools.tree_sitter_symbol_locator) || [])
      ],
      lsp_call_hierarchy: [
        ...normalizedProject.tools.lsp_call_hierarchy,
        ...((repoConfig.tools && repoConfig.tools.lsp_call_hierarchy) || [])
      ]
    },
    ai: {
      ...(normalizedProject.ai || {}),
      ...((repoConfig && repoConfig.ai) || {})
    },
    rule_documents: [
      ...((projectConfig && projectConfig.rule_documents) || []),
      ...((repoConfig && repoConfig.rule_documents) || [])
    ]
  };
}

function mergeUnique(left = [], right = []) {
  return Array.from(new Set([...(left || []), ...(right || [])]));
}

module.exports = {
  EMPTY_REVIEW_CONFIG,
  loadReviewConfig,
  parseReviewConfigYaml,
  normalizeReviewConfig,
  mergeReviewConfigs,
  safeRepoPath
};
