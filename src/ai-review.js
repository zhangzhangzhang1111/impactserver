const { buildAiReviewChunks } = require('./ai-context-builder');
const { createAiProvider } = require('./ai-provider');

async function runAiReview({ request, config, fileChanges, symbols, staticFindings, reviewConfig }) {
  if (!shouldRunAiReview(request, config)) {
    return {
      findings: [],
      usage: emptyUsage()
    };
  }

  const effectiveRequest = applyAiConfigDefaults(request, config);
  const chunks = buildAiReviewChunks({ request: effectiveRequest, fileChanges, symbols, staticFindings, reviewConfig });
  const provider = resolveProvider(effectiveRequest, config);
  const aiFindings = [];
  const usage = {
    provider: provider.name || 'openai-compatible',
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    chunk_count: 0,
    truncated: false,
    output_truncated: false,
    dropped_findings: 0,
    aggregation: {
      input_chunks: chunks.length,
      raw_ai_findings: 0,
      normalized_ai_findings: 0,
      manual_review_findings: 0
    }
  };

  for (const chunk of chunks) {
    try {
      const response = await provider.review({ chunk });
      const rawFindings = Array.isArray(response.findings) ? response.findings : [];
      const cappedFindings = capFindingsForChunk(rawFindings, chunk, usage);
      cappedFindings.forEach((finding, index) => {
        aiFindings.push(normalizeAiFinding(finding, aiFindings.length + index));
      });
      usage.aggregation.raw_ai_findings += rawFindings.length;
      usage.aggregation.normalized_ai_findings += cappedFindings.length;
      accumulateUsage(usage, response.usage, chunk);
    } catch (error) {
      aiFindings.push(manualReviewFinding(error, chunk, aiFindings.length));
      usage.aggregation.manual_review_findings += 1;
      usage.aggregation.normalized_ai_findings += 1;
      usage.provider = provider.name || usage.provider;
      usage.chunk_count += 1;
      usage.truncated = usage.truncated || Boolean(chunk.truncated);
      usage.degraded = true;
      usage.degrade_reason = error.message;
    }
  }

  return {
    findings: aiFindings,
    usage
  };
}

function applyAiConfigDefaults(request, config) {
  const maxOutputTokens = Number(config && config.ai && config.ai.maxOutputTokens);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return request;
  const requestAi = request.ai || {};
  if (requestAi.max_output_tokens) return request;
  return {
    ...request,
    ai: {
      ...requestAi,
      max_output_tokens: maxOutputTokens
    }
  };
}

function capFindingsForChunk(findings, chunk, usage) {
  const maxFindings = chunk.fixed
    && chunk.fixed.output_constraints
    && Number(chunk.fixed.output_constraints.max_findings);
  if (!Number.isFinite(maxFindings) || maxFindings <= 0 || findings.length <= maxFindings) {
    return findings;
  }
  const dropped = findings.length - maxFindings;
  usage.output_truncated = true;
  usage.dropped_findings += dropped;
  usage.truncated = true;
  return findings.slice(0, maxFindings);
}

function shouldRunAiReview(request, config) {
  const option = request.options && request.options.enable_ai_review;
  if (option === false) return false;
  if (option !== true && !(config.ai && config.ai.enabled)) return false;
  return Boolean(resolveProvider(request, config, false));
}

function resolveProvider(request, config, throwOnMissing = true) {
  const ai = mergeAiProviderConfig(request, config);
  if (ai.provider && typeof ai.provider === 'object') return ai.provider;
  if (ai.provider || ai.baseUrl) {
    return createAiProvider({
      provider: ai.provider,
      baseUrl: ai.baseUrl,
      apiKey: ai.apiKey,
      model: ai.model,
      timeoutMs: ai.timeoutMs,
      maxRetries: ai.maxRetries,
      maxOutputTokens: ai.maxOutputTokens,
      anthropicVersion: ai.anthropicVersion,
      fetchImpl: ai.fetchImpl
    });
  }
  if (throwOnMissing) throw new Error('AI review is enabled but no provider is configured');
  return null;
}

function mergeAiProviderConfig(request, config) {
  const globalAi = (config && config.ai) || {};
  const requestAi = (request && request.ai) || {};
  return {
    ...globalAi,
    ...normalizeAiConfigKeys(requestAi),
    apiKey: requestAi.api_key || requestAi.apiKey || globalAi.apiKey,
    baseUrl: requestAi.base_url || requestAi.baseUrl || globalAi.baseUrl,
    timeoutMs: requestAi.timeout_ms || requestAi.timeoutMs || globalAi.timeoutMs,
    maxRetries: requestAi.max_retries || requestAi.maxRetries || globalAi.maxRetries,
    maxOutputTokens: requestAi.max_output_tokens || requestAi.maxOutputTokens || globalAi.maxOutputTokens,
    anthropicVersion: requestAi.anthropic_version || requestAi.anthropicVersion || globalAi.anthropicVersion
  };
}

function normalizeAiConfigKeys(ai) {
  return {
    ...ai,
    apiKey: ai.api_key || ai.apiKey,
    baseUrl: ai.base_url || ai.baseUrl,
    timeoutMs: ai.timeout_ms || ai.timeoutMs,
    maxRetries: ai.max_retries || ai.maxRetries,
    maxOutputTokens: ai.max_output_tokens || ai.maxOutputTokens,
    anthropicVersion: ai.anthropic_version || ai.anthropicVersion
  };
}

function normalizeAiFinding(finding, index) {
  const file = String(finding.file || 'unknown');
  const line = Number(finding.line || 1);
  const ruleId = String(finding.rule_id || 'AI-SUGGESTION');
  return {
    id: finding.id || `ai_finding_${String(index + 1).padStart(3, '0')}`,
    file,
    line,
    language: finding.language || 'unknown',
    severity: normalizeSeverity(finding.severity),
    category: finding.category || 'AIReview',
    rule_id: ruleId,
    rule_source: finding.rule_source || 'AI_SUGGESTION',
    source_engine: ['ai'],
    confidence: normalizeConfidence(finding.confidence),
    message: finding.message || 'AI review finding.',
    suggestion: finding.suggestion || 'Review this change manually.',
    evidence: finding.evidence || {},
    dedupe_key: `${file}:${line}:${ruleId}`
  };
}

function mergeFindings(staticFindings, aiFindings) {
  const merged = new Map();
  for (const finding of [...staticFindings, ...aiFindings]) {
    const key = finding.dedupe_key || `${finding.file}:${finding.line}:${finding.rule_id}`;
    if (!merged.has(key)) {
      merged.set(key, { ...finding, source_engine: [...(finding.source_engine || [])] });
      continue;
    }
    const existing = merged.get(key);
    existing.source_engine = Array.from(new Set([...(existing.source_engine || []), ...(finding.source_engine || [])]));
    existing.confidence = strongestConfidence(existing.confidence, finding.confidence);
    if (!existing.suggestion && finding.suggestion) existing.suggestion = finding.suggestion;
  }
  return Array.from(merged.values());
}

function accumulateUsage(target, source = {}, chunk) {
  target.provider = source.provider || target.provider;
  target.model = source.model || target.model;
  target.input_tokens += Number(source.input_tokens || 0);
  target.output_tokens += Number(source.output_tokens || 0);
  target.total_tokens += Number(source.total_tokens || 0);
  target.chunk_count += Number(source.chunk_count || 1);
  target.truncated = target.truncated || Boolean(source.truncated || chunk.truncated);
}

function emptyUsage() {
  return {
    provider: 'not-configured',
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    chunk_count: 0,
    truncated: false,
    output_truncated: false,
    dropped_findings: 0,
    aggregation: {
      input_chunks: 0,
      raw_ai_findings: 0,
      normalized_ai_findings: 0,
      manual_review_findings: 0
    },
    degraded: false,
    degrade_reason: null
  };
}

function manualReviewFinding(error, chunk, index) {
  const firstFile = chunk.files && chunk.files[0];
  const firstLine = firstFile && firstFile.added_lines && firstFile.added_lines[0];
  const file = (firstFile && firstFile.file) || 'unknown';
  const line = (firstLine && firstLine.line) || 1;
  return {
    id: `manual_review_${String(index + 1).padStart(3, '0')}`,
    file,
    line,
    language: 'unknown',
    severity: 'WARNING',
    category: 'AIReview',
    rule_id: 'MANUAL_REVIEW_REQUIRED',
    rule_source: 'system:ai-review-fallback',
    source_engine: ['ai-fallback'],
    confidence: 'LOW',
    message: 'AI review could not produce valid structured output; manual review is required.',
    suggestion: 'Review this change manually and inspect AI provider diagnostics.',
    evidence: {
      chunk_id: chunk.chunk_id,
      error: error.message
    },
    dedupe_key: `${file}:${line}:MANUAL_REVIEW_REQUIRED`
  };
}

function normalizeSeverity(value) {
  const normalized = String(value || '').toUpperCase();
  if (['CRITICAL', 'WARNING', 'INFO'].includes(normalized)) return normalized;
  return 'INFO';
}

function normalizeConfidence(value) {
  const normalized = String(value || '').toUpperCase();
  if (['HIGH', 'MEDIUM', 'LOW'].includes(normalized)) return normalized;
  return 'LOW';
}

function strongestConfidence(left, right) {
  const score = { LOW: 1, MEDIUM: 2, HIGH: 3 };
  return (score[right] || 0) > (score[left] || 0) ? right : left;
}

module.exports = {
  runAiReview,
  shouldRunAiReview,
  normalizeAiFinding,
  mergeFindings,
  emptyUsage,
  manualReviewFinding,
  capFindingsForChunk,
  applyAiConfigDefaults,
  mergeAiProviderConfig,
  resolveProvider
};
