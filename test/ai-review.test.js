const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAiReviewChunks } = require('../src/ai-context-builder');
const {
  OpenAIChatProvider,
  AnthropicMessagesProvider,
  GeminiGenerateContentProvider,
  OpenAICompatibleProvider,
  createAiProvider
} = require('../src/ai-provider');
const { runAiReview, normalizeAiFinding, mergeFindings, applyAiConfigDefaults } = require('../src/ai-review');

test('buildAiReviewChunks keeps high risk findings and splits by token budget', () => {
  const chunks = buildAiReviewChunks({
    request: {
      project: { name: 'demo' },
      languages: ['python'],
      ai: { max_input_tokens: 120 }
    },
    fileChanges: [
      {
        file: 'a.py',
        added_lines: [
          { line: 1, text: 'def a():' },
          { line: 2, text: '    return "x".lower()' }
        ]
      },
      {
        file: 'b.py',
        added_lines: [
          { line: 1, text: 'def b():' },
          { line: 2, text: '    return "y".lower()' }
        ]
      }
    ],
    symbols: [
      { file: 'a.py', line: 1, language: 'python', symbol: 'a', confidence: 'MEDIUM' },
      { file: 'b.py', line: 1, language: 'python', symbol: 'b', confidence: 'MEDIUM' }
    ],
    reviewConfig: {
      rule_documents: [
        { path: 'docs/security/redlines.md', content: 'Do not log user secrets.' }
      ],
      rules: {
        custom_rules: [
          { id: 'PY001', description: 'Service functions require annotations.' },
          { id: 'PROJECT-PY001', description: 'Project service functions require annotations.', scope: 'project' }
        ]
      }
    },
    staticFindings: [
      {
        file: 'b.py',
        line: 2,
        severity: 'CRITICAL',
        rule_id: 'REDLINE-INJECTION-001',
        message: 'critical first'
      }
    ]
  });

  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].static_findings[0].rule_id, 'REDLINE-INJECTION-001');
  assert.equal(chunks[0].fixed.repo_rule_documents[0].path, 'docs/security/redlines.md');
  assert.equal(chunks[0].fixed.custom_rules[0].id, 'PY001');
  assert.equal(chunks[0].fixed.custom_rules[0].rule_source, 'repo:.review-config.yaml#PY001');
  assert.equal(chunks[0].fixed.custom_rules[1].rule_source, 'project:config#PROJECT-PY001');
  assert.ok(chunks.every((chunk) => chunk.estimated_input_tokens <= 120));
});

test('buildAiReviewChunks includes AI output constraints in fixed context', () => {
  const chunks = buildAiReviewChunks({
    request: {
      project: { name: 'demo' },
      languages: ['python'],
      ai: {
        max_input_tokens: 500,
        max_output_tokens: 2048,
        max_findings_per_chunk: 3
      }
    },
    fileChanges: [
      {
        file: 'a.py',
        added_lines: [{ line: 1, text: 'value = 1' }]
      }
    ],
    symbols: [],
    staticFindings: [],
    reviewConfig: {}
  });

  assert.equal(chunks[0].fixed.output_constraints.max_findings, 3);
  assert.equal(chunks[0].fixed.output_constraints.max_output_tokens, 2048);
});

test('applyAiConfigDefaults adds global max output tokens without overwriting request value', () => {
  const withDefault = applyAiConfigDefaults(
    { project: { name: 'demo' }, ai: {} },
    { ai: { maxOutputTokens: 4096 } }
  );
  const withOverride = applyAiConfigDefaults(
    { project: { name: 'demo' }, ai: { max_output_tokens: 1024 } },
    { ai: { maxOutputTokens: 4096 } }
  );

  assert.equal(withDefault.ai.max_output_tokens, 4096);
  assert.equal(withOverride.ai.max_output_tokens, 1024);
});

test('buildAiReviewChunks includes deterministic language rules in fixed context', () => {
  const chunks = buildAiReviewChunks({
    request: {
      project: { name: 'demo' },
      languages: ['python', 'lua'],
      ai: { max_input_tokens: 500 }
    },
    fileChanges: [
      {
        file: 'a.py',
        added_lines: [{ line: 1, text: 'def fn(items=[]): pass' }]
      }
    ],
    symbols: [],
    staticFindings: [],
    reviewConfig: {}
  });

  assert.ok(chunks[0].fixed.language_rules.some((rule) => rule.id === 'LANG-PY-MUTABLE-DEFAULT-001'));
  assert.ok(chunks[0].fixed.language_rules.some((rule) => rule.rule_source === 'global:language-rules#LANG-LUA-PCALL-001'));
});

test('OpenAICompatibleProvider retries rate limits and parses JSON content', async () => {
  const calls = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://ai.example.test/v1',
    apiKey: 'token',
    model: 'qwen-coder',
    maxRetries: 1,
    timeoutMs: 1000,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) {
        return response(429, { error: 'rate limited' });
      }
      return response(200, {
        model: 'qwen-coder',
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    file: 'app.py',
                    line: 3,
                    language: 'python',
                    severity: 'WARNING',
                    category: 'AI',
                    rule_id: 'AI-SUGGESTION',
                    rule_source: 'AI_SUGGESTION',
                    confidence: 'MEDIUM',
                    message: 'Add input validation.',
                    suggestion: 'Validate name before use.',
                    evidence: { code_excerpt: 'name' }
                  }
                ]
              })
            }
          }
        ]
      });
    }
  });

  const result = await provider.review({ chunk: { chunk_id: 'chunk_001' } });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://ai.example.test/v1/chat/completions');
  assert.equal(calls[1].options.headers.authorization, 'Bearer token');
  assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.findings[0].message, 'Add input validation.');
});

test('OpenAICompatibleProvider sends max_tokens when chunk has output constraint', async () => {
  const calls = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://ai.example.test/v1',
    apiKey: 'token',
    model: 'qwen-coder',
    maxRetries: 0,
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return response(200, {
        model: 'qwen-coder',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        choices: [{ message: { content: JSON.stringify({ findings: [] }) } }]
      });
    }
  });

  await provider.review({
    chunk: {
      chunk_id: 'chunk_001',
      fixed: { output_constraints: { max_output_tokens: 2048 } }
    }
  });

  assert.equal(calls[0].max_tokens, 2048);
});

test('OpenAICompatibleProvider repairs invalid JSON content once', async () => {
  const calls = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://ai.example.test/v1',
    apiKey: 'token',
    model: 'qwen-coder',
    maxRetries: 0,
    maxRepairAttempts: 1,
    timeoutMs: 1000,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return response(200, {
          model: 'qwen-coder',
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          choices: [{ message: { content: '{"findings": [' } }]
        });
      }
      return response(200, {
        model: 'qwen-coder',
        usage: { prompt_tokens: 6, completion_tokens: 6, total_tokens: 12 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    file: 'fixed.py',
                    line: 1,
                    severity: 'INFO',
                    rule_id: 'AI-SUGGESTION',
                    message: 'repaired'
                  }
                ]
              })
            }
          }
        ]
      });
    }
  });

  const result = await provider.review({ chunk: { chunk_id: 'chunk_001' } });

  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /repair/i);
  assert.equal(result.findings[0].file, 'fixed.py');
  assert.equal(result.usage.repair_attempts, 1);
  assert.equal(result.usage.input_tokens, 16);
});

test('OpenAIChatProvider sends official chat completion request shape', async () => {
  const calls = [];
  const provider = new OpenAIChatProvider({
    apiKey: 'openai-token',
    model: 'gpt-5.1',
    maxRetries: 0,
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return response(200, {
        model: 'gpt-5.1',
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
        choices: [{ message: { content: JSON.stringify({ findings: [] }) } }]
      });
    }
  });

  const result = await provider.review({
    chunk: {
      chunk_id: 'chunk_openai',
      fixed: {
        role: 'Return JSON only.',
        output_constraints: { max_output_tokens: 1024 }
      }
    }
  });

  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, 'Bearer openai-token');
  assert.equal(calls[0].body.model, 'gpt-5.1');
  assert.equal(calls[0].body.max_completion_tokens, 1024);
  assert.equal(calls[0].body.response_format.type, 'json_object');
  assert.deepEqual(calls[0].body.messages.map((message) => message.role), ['developer', 'user']);
  assert.equal(result.usage.provider, 'openai');
  assert.equal(result.usage.input_tokens, 11);
});

test('AnthropicMessagesProvider sends official messages request shape', async () => {
  const calls = [];
  const provider = new AnthropicMessagesProvider({
    apiKey: 'anthropic-token',
    model: 'claude-sonnet-4-5',
    maxRetries: 0,
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return response(200, {
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 12, output_tokens: 7 },
        content: [{ type: 'text', text: JSON.stringify({ findings: [] }) }]
      });
    }
  });

  const result = await provider.review({
    chunk: {
      chunk_id: 'chunk_anthropic',
      fixed: {
        role: 'Return JSON only.',
        output_constraints: { max_output_tokens: 2048 }
      }
    }
  });

  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].options.headers['x-api-key'], 'anthropic-token');
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].body.model, 'claude-sonnet-4-5');
  assert.equal(calls[0].body.max_tokens, 2048);
  assert.equal(calls[0].body.system, 'Return JSON only.');
  assert.deepEqual(calls[0].body.messages.map((message) => message.role), ['user']);
  assert.equal(result.usage.provider, 'anthropic');
  assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.usage.output_tokens, 7);
});

test('GeminiGenerateContentProvider sends official generateContent request shape', async () => {
  const calls = [];
  const provider = new GeminiGenerateContentProvider({
    apiKey: 'gemini-token',
    model: 'gemini-3.5-flash',
    maxRetries: 0,
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return response(200, {
        modelVersion: 'gemini-3.5-flash',
        usageMetadata: {
          promptTokenCount: 13,
          candidatesTokenCount: 8,
          totalTokenCount: 21
        },
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ findings: [] }) }]
            }
          }
        ]
      });
    }
  });

  const result = await provider.review({
    chunk: {
      chunk_id: 'chunk_gemini',
      fixed: {
        role: 'Return JSON only.',
        output_constraints: { max_output_tokens: 3072 }
      }
    }
  });

  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'gemini-token');
  assert.equal(calls[0].body.systemInstruction.parts[0].text, 'Return JSON only.');
  assert.equal(calls[0].body.contents[0].role, 'user');
  assert.equal(calls[0].body.contents[0].parts[0].text, JSON.stringify({ chunk_id: 'chunk_gemini', fixed: { role: 'Return JSON only.', output_constraints: { max_output_tokens: 3072 } } }));
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, 3072);
  assert.equal(result.usage.provider, 'gemini');
  assert.equal(result.usage.total_tokens, 21);
});

test('createAiProvider configures Chinese mainstream providers with official defaults', async () => {
  const cases = [
    {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      expectedUrl: 'https://api.deepseek.com/chat/completions',
      expectedUsageProvider: 'deepseek',
      expectedMaxTokenField: 'max_tokens'
    },
    {
      provider: 'qwen',
      model: 'qwen-plus',
      expectedUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      expectedUsageProvider: 'qwen',
      expectedMaxTokenField: 'max_tokens'
    },
    {
      provider: 'doubao',
      model: 'doubao-pro-32k-240615',
      expectedUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      expectedUsageProvider: 'doubao',
      expectedMaxTokenField: 'max_tokens'
    },
    {
      provider: 'minimax',
      model: 'MiniMax-M2.5',
      expectedUrl: 'https://api.minimax.io/v1/text/chatcompletion_v2',
      expectedUsageProvider: 'minimax',
      expectedMaxTokenField: 'max_tokens'
    }
  ];

  for (const item of cases) {
    const calls = [];
    const provider = createAiProvider({
      provider: item.provider,
      apiKey: 'cn-token',
      model: item.model,
      maxRetries: 0,
      timeoutMs: 1000,
      fetchImpl: async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return response(200, {
          model: item.model,
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }]
        });
      }
    });

    const result = await provider.review({
      chunk: {
        chunk_id: `chunk_${item.provider}`,
        fixed: { output_constraints: { max_output_tokens: 4096 } }
      }
    });

    assert.equal(calls[0].url, item.expectedUrl);
    assert.equal(calls[0].options.headers.authorization, 'Bearer cn-token');
    assert.equal(calls[0].body.model, item.model);
    assert.equal(calls[0].body[item.expectedMaxTokenField], 4096);
    assert.equal(result.usage.provider, item.expectedUsageProvider);
  }
});

test('runAiReview downgrades repeated invalid AI output to manual review finding', async () => {
  const result = await runAiReview({
    request: {
      project: { name: 'demo' },
      options: { enable_ai_review: true },
      languages: ['python']
    },
    config: {
      ai: {
        enabled: true,
        provider: {
          review: async () => {
            throw new Error('AI provider returned invalid JSON content: nope');
          }
        }
      }
    },
    fileChanges: [
      {
        file: 'app.py',
        added_lines: [{ line: 2, text: 'value = 1' }]
      }
    ],
    symbols: [],
    staticFindings: [],
    reviewConfig: {}
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rule_id, 'MANUAL_REVIEW_REQUIRED');
  assert.equal(result.findings[0].severity, 'WARNING');
  assert.equal(result.usage.degraded, true);
  assert.match(result.usage.degrade_reason, /invalid JSON/);
});

test('runAiReview lets request AI provider override global provider while inheriting API key', async () => {
  const calls = [];
  const result = await runAiReview({
    request: {
      project: { name: 'demo' },
      options: { enable_ai_review: true },
      ai: {
        provider: 'qwen',
        model: 'qwen-plus',
        max_output_tokens: 1024
      },
      languages: ['python']
    },
    config: {
      ai: {
        enabled: true,
        provider: 'openai',
        apiKey: 'shared-key',
        model: 'gpt-5.1',
        timeoutMs: 1000,
        maxRetries: 0,
        fetchImpl: async (url, options) => {
          calls.push({ url, options, body: JSON.parse(options.body) });
          return response(200, {
            model: 'qwen-plus',
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            choices: [{ message: { content: JSON.stringify({ findings: [] }) } }]
          });
        }
      }
    },
    fileChanges: [
      {
        file: 'a.py',
        added_lines: [{ line: 1, text: 'value = 1' }]
      }
    ],
    symbols: [],
    staticFindings: [],
    reviewConfig: {}
  });

  assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, 'Bearer shared-key');
  assert.equal(calls[0].body.model, 'qwen-plus');
  assert.equal(calls[0].body.max_tokens, 1024);
  assert.equal(result.usage.provider, 'qwen');
});

test('runAiReview caps findings per chunk and records aggregation metadata', async () => {
  const result = await runAiReview({
    request: {
      project: { name: 'demo' },
      options: { enable_ai_review: true },
      ai: { max_findings_per_chunk: 2 },
      languages: ['python']
    },
    config: {
      ai: {
        enabled: true,
        provider: {
          name: 'test-ai',
          review: async () => ({
            findings: [
              { file: 'a.py', line: 1, severity: 'INFO', rule_id: 'AI-1', message: 'one' },
              { file: 'a.py', line: 2, severity: 'INFO', rule_id: 'AI-2', message: 'two' },
              { file: 'a.py', line: 3, severity: 'INFO', rule_id: 'AI-3', message: 'three' }
            ],
            usage: {
              provider: 'test-ai',
              model: 'fake',
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              chunk_count: 1
            }
          })
        }
      }
    },
    fileChanges: [
      {
        file: 'a.py',
        added_lines: [{ line: 1, text: 'value = 1' }]
      }
    ],
    symbols: [],
    staticFindings: [],
    reviewConfig: {}
  });

  assert.deepEqual(result.findings.map((finding) => finding.rule_id), ['AI-1', 'AI-2']);
  assert.equal(result.usage.output_truncated, true);
  assert.equal(result.usage.dropped_findings, 1);
  assert.equal(result.usage.aggregation.input_chunks, 1);
  assert.equal(result.usage.aggregation.raw_ai_findings, 3);
  assert.equal(result.usage.aggregation.normalized_ai_findings, 2);
});

test('AI findings are normalized and deduplicated with static findings', () => {
  const aiFinding = normalizeAiFinding({
    file: 'app.py',
    line: 2,
    language: 'python',
    severity: 'CRITICAL',
    category: 'InjectionRisk',
    rule_id: 'REDLINE-INJECTION-001',
    rule_source: 'global:redlines#REDLINE-INJECTION-001',
    confidence: 'HIGH',
    message: 'AI confirms SQL injection.',
    suggestion: 'Use parameters.',
    evidence: { code_excerpt: 'sql' }
  }, 0);

  const merged = mergeFindings([
    {
      file: 'app.py',
      line: 2,
      rule_id: 'REDLINE-INJECTION-001',
      source_engine: ['node-rule-engine'],
      dedupe_key: 'app.py:2:REDLINE-INJECTION-001'
    }
  ], [aiFinding]);

  assert.deepEqual(merged[0].source_engine, ['node-rule-engine', 'ai']);
  assert.equal(merged.length, 1);
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
