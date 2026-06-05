const { detectLanguage } = require('./language');

const RULES = [
  {
    id: 'REDLINE-SECRETS-001',
    category: 'CredentialSecurity',
    severity: 'CRITICAL',
    message: 'Possible hard-coded credential or secret.',
    test: (line) => /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}/i.test(line)
  },
  {
    id: 'REDLINE-INJECTION-001',
    category: 'InjectionRisk',
    severity: 'CRITICAL',
    message: 'Dynamic execution or string-built executable statement requires validation.',
    test: (line, language) => {
      if (language === 'python') return /\b(eval|exec|pickle\.loads)\s*\(/.test(line) || /f["'].*\b(select|update|delete|insert)\b/i.test(line);
      if (language === 'lua') return /\b(load|string\.dump|loadstring)\s*\(/.test(line);
      if (language === 'java') return /\$\{.*\}/.test(line) || /ObjectInputStream/.test(line);
      if (language === 'c' || language === 'cpp') return /\b(sprintf|strcpy|gets)\s*\(/.test(line) || /printf\s*\(\s*[A-Za-z_][\w]*\s*\)/.test(line);
      return false;
    }
  },
  {
    id: 'REDLINE-PRIVACY-001',
    category: 'PrivacyProtection',
    severity: 'CRITICAL',
    message: 'Logs may expose sensitive credentials or personal data.',
    test: (line) => /\b(log|logger|print|console)\w*\s*\(.*(password|token|cookie|session|phone|id_card)/i.test(line)
  },
  {
    id: 'REDLINE-ERROR-001',
    category: 'ErrorExposure',
    severity: 'CRITICAL',
    message: 'External error response may expose internal details.',
    test: (line) => /\b(stacktrace|traceback|SQLException|internal path|\/var\/|\/etc\/)/i.test(line)
  },
  {
    id: 'REDLINE-EXCEPTION-001',
    category: 'ExceptionHandling',
    severity: 'WARNING',
    message: 'Exception appears to be swallowed without logging or rethrowing.',
    test: (line, language) => {
      if (language === 'python') return /^\s*except\b.*:\s*(pass)?\s*$/.test(line);
      if (language === 'java') return /catch\s*\([^)]*\)\s*\{\s*\}/.test(line);
      return false;
    }
  }
];

const LANGUAGE_RULES = [
  {
    id: 'LANG-PY-MUTABLE-DEFAULT-001',
    language: 'python',
    category: 'PythonPitfall',
    severity: 'WARNING',
    message: 'Python function uses a mutable default argument.',
    suggestion: 'Use None as the default and create a new list or dict inside the function.',
    test: (line) => /^\s*(async\s+def|def)\s+\w+\s*\([^)]*=\s*(\[\]|\{\})/.test(line)
  },
  {
    id: 'LANG-LUA-PCALL-001',
    language: 'lua',
    category: 'LuaErrorHandling',
    severity: 'WARNING',
    message: 'Lua pcall result appears to be ignored.',
    suggestion: 'Capture pcall status and error value, then log or propagate failures explicitly.',
    test: (line) => /^\s*pcall\s*\(/.test(line)
  },
  {
    id: 'LANG-JAVA-PRINTSTACKTRACE-001',
    language: 'java',
    category: 'JavaExceptionHandling',
    severity: 'WARNING',
    message: 'Java exception handling uses printStackTrace without structured context.',
    suggestion: 'Use structured logging with request context or rethrow a domain-specific exception.',
    test: (line) => /\.printStackTrace\s*\(/.test(line)
  },
  {
    id: 'LANG-CPP-RAII-001',
    language: 'cpp',
    category: 'CppResourceManagement',
    severity: 'WARNING',
    message: 'C++ raw new allocation should be reviewed for RAII ownership.',
    suggestion: 'Prefer std::unique_ptr, std::shared_ptr, containers, or stack allocation with clear ownership.',
    test: (line) => /\bnew\s+[A-Za-z_][\w:<>]*/.test(line)
  }
];

function scanRules(fileChanges, reviewConfig = {}) {
  const findings = [];
  for (const file of fileChanges) {
    const language = detectLanguage(file.file);
    for (const added of file.added_lines) {
      for (const rule of RULES) {
        if (!rule.test(added.text, language)) continue;
        findings.push(buildFinding({
          findingIndex: findings.length,
          file: file.file,
          line: added,
          language,
          rule,
          ruleSourcePrefix: 'global:redlines',
          sourceEngine: 'node-rule-engine',
          suggestion: suggestionFor(rule.id)
        }));
      }
      for (const rule of languageRulesFor(language)) {
        if (!rule.test(added.text, language)) continue;
        findings.push(buildFinding({
          findingIndex: findings.length,
          file: file.file,
          line: added,
          language,
          rule,
          ruleSourcePrefix: 'global:language-rules',
          sourceEngine: 'node-language-rule',
          suggestion: rule.suggestion
        }));
      }
      for (const rule of customRulesFor(reviewConfig, language)) {
        const regex = new RegExp(rule.pattern);
        if (!regex.test(added.text)) continue;
        findings.push(buildFinding({
          findingIndex: findings.length,
          file: file.file,
          line: added,
          language,
          rule: { ...rule, message: rule.description },
          ruleSourcePrefix: customRuleSourcePrefix(rule),
          sourceEngine: customRuleEngine(rule),
          suggestion: rule.suggestion
        }));
      }
    }
  }
  return dedupe(findings);
}

function buildFinding({ findingIndex, file, line, language, rule, ruleSourcePrefix, sourceEngine, suggestion }) {
  return {
    id: `finding_${String(findingIndex + 1).padStart(3, '0')}`,
    file,
    line: line.line,
    language,
    severity: rule.severity,
    category: rule.category,
    rule_id: rule.id,
    rule_source: `${ruleSourcePrefix}#${rule.id}`,
    source_engine: [sourceEngine],
    confidence: 'MEDIUM',
    message: rule.message,
    suggestion,
    evidence: {
      code_excerpt: line.text.trim()
    },
    dedupe_key: `${file}:${line.line}:${rule.id}`
  };
}

function languageRulesFor(language) {
  return LANGUAGE_RULES.filter((rule) => rule.language === language || (rule.language === 'cpp' && language === 'c'));
}

function customRulesFor(reviewConfig, language) {
  const rules = reviewConfig.rules && reviewConfig.rules.custom_rules;
  if (!Array.isArray(rules)) return [];
  return rules.filter((rule) => rule.id && rule.pattern && (rule.language === language || rule.language === 'all'));
}

function customRuleSourcePrefix(rule) {
  if (rule.scope === 'project') return 'project:config';
  return 'repo:.review-config.yaml';
}

function customRuleEngine(rule) {
  if (rule.scope === 'project') return 'project-custom-rule';
  return 'repo-custom-rule';
}

function suggestionFor(ruleId) {
  if (ruleId === 'REDLINE-SECRETS-001') return 'Move credentials to secret management and rotate any exposed value.';
  if (ruleId === 'REDLINE-INJECTION-001') return 'Use parameterized APIs, allowlists, and explicit input validation.';
  if (ruleId === 'REDLINE-PRIVACY-001') return 'Mask sensitive fields before logging.';
  if (ruleId === 'REDLINE-EXCEPTION-001') return 'Log contextual information or rethrow the exception.';
  return 'Review the redline rule and add a safer implementation.';
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    if (seen.has(finding.dedupe_key)) return false;
    seen.add(finding.dedupe_key);
    return true;
  });
}

module.exports = { RULES, LANGUAGE_RULES, scanRules, customRulesFor, languageRulesFor, customRuleSourcePrefix };
