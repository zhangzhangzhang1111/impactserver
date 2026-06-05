const PROVIDERS = {
  openai: {
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    path: '/chat/completions',
    maxTokenField: 'max_completion_tokens',
    instructionRole: 'developer'
  },
  deepseek: {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    path: '/chat/completions',
    maxTokenField: 'max_tokens',
    instructionRole: 'system'
  },
  qwen: {
    name: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    path: '/chat/completions',
    maxTokenField: 'max_tokens',
    instructionRole: 'system'
  },
  doubao: {
    name: 'doubao',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    path: '/chat/completions',
    maxTokenField: 'max_tokens',
    instructionRole: 'system'
  },
  minimax: {
    name: 'minimax',
    baseUrl: 'https://api.minimax.io',
    path: '/v1/text/chatcompletion_v2',
    maxTokenField: 'max_tokens',
    instructionRole: 'system'
  }
};

class ChatCompletionProvider {
  constructor({
    providerName = 'openai-compatible',
    baseUrl,
    path = '/chat/completions',
    apiKey,
    model,
    timeoutMs = 60000,
    maxRetries = 2,
    maxRepairAttempts = 1,
    maxTokenField = 'max_tokens',
    instructionRole = 'system',
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep
  }) {
    if (!baseUrl) throw new Error('AI provider baseUrl is required');
    if (!fetchImpl) throw new Error('fetch is not available in this Node.js runtime');
    this.name = providerName;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.path = path.startsWith('/') ? path : `/${path}`;
    this.apiKey = apiKey || '';
    this.model = model || 'default';
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.maxRepairAttempts = maxRepairAttempts;
    this.maxTokenField = maxTokenField;
    this.instructionRole = instructionRole;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  async review({ chunk }) {
    return reviewWithRepair({
      provider: this,
      chunk,
      buildBody: () => this.buildBody(chunk),
      parseResponse: parseChatCompletionResponse,
      buildRepairBody: ({ invalidContent, error }) => buildChatRepairBody({
        model: this.model,
        maxTokenField: this.maxTokenField,
        invalidContent,
        error
      })
    });
  }

  buildBody(chunk) {
    const body = {
      model: this.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: this.instructionRole,
          content: reviewInstruction(chunk)
        },
        {
          role: 'user',
          content: JSON.stringify(chunk)
        }
      ]
    };
    const maxTokens = maxOutputTokens(chunk);
    if (maxTokens) body[this.maxTokenField] = maxTokens;
    return body;
  }

  async postWithRetry(body) {
    return postJsonWithRetry({
      url: `${this.baseUrl}${this.path}`,
      headers: this.headers(),
      body,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });
  }

  headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json'
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }
}

class OpenAICompatibleProvider extends ChatCompletionProvider {
  constructor(options = {}) {
    super({
      ...options,
      providerName: options.providerName || 'openai-compatible',
      path: options.path || '/chat/completions',
      maxTokenField: options.maxTokenField || 'max_tokens',
      instructionRole: options.instructionRole || 'system'
    });
  }
}

class OpenAIChatProvider extends ChatCompletionProvider {
  constructor(options = {}) {
    super({
      ...options,
      providerName: 'openai',
      baseUrl: options.baseUrl || PROVIDERS.openai.baseUrl,
      path: PROVIDERS.openai.path,
      maxTokenField: PROVIDERS.openai.maxTokenField,
      instructionRole: PROVIDERS.openai.instructionRole
    });
  }
}

class AnthropicMessagesProvider {
  constructor({
    baseUrl = 'https://api.anthropic.com',
    apiKey,
    model,
    anthropicVersion = '2023-06-01',
    timeoutMs = 60000,
    maxRetries = 2,
    maxRepairAttempts = 1,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep
  }) {
    if (!fetchImpl) throw new Error('fetch is not available in this Node.js runtime');
    this.name = 'anthropic';
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.model = model || 'claude-sonnet-4-5';
    this.anthropicVersion = anthropicVersion;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.maxRepairAttempts = maxRepairAttempts;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  async review({ chunk }) {
    return reviewWithRepair({
      provider: this,
      chunk,
      buildBody: () => this.buildBody(chunk),
      parseResponse: parseAnthropicMessageResponse,
      buildRepairBody: ({ invalidContent, error }) => this.buildRepairBody({ invalidContent, error })
    });
  }

  buildBody(chunk) {
    return {
      model: this.model,
      max_tokens: maxOutputTokens(chunk) || 4096,
      temperature: 0,
      system: reviewInstruction(chunk),
      messages: [
        {
          role: 'user',
          content: JSON.stringify(chunk)
        }
      ]
    };
  }

  buildRepairBody({ invalidContent, error }) {
    return {
      model: this.model,
      max_tokens: 1024,
      temperature: 0,
      system: 'Repair the previous AI code review response. Return valid JSON only with a top-level findings array.',
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            error: error.message,
            invalid_content: invalidContent,
            required_shape: { findings: [] }
          })
        }
      ]
    };
  }

  async postWithRetry(body) {
    return postJsonWithRetry({
      url: `${this.baseUrl}/v1/messages`,
      headers: this.headers(),
      body,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });
  }

  headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'anthropic-version': this.anthropicVersion
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    return headers;
  }
}

class GeminiGenerateContentProvider {
  constructor({
    baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
    apiKey,
    model,
    timeoutMs = 60000,
    maxRetries = 2,
    maxRepairAttempts = 1,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep
  }) {
    if (!fetchImpl) throw new Error('fetch is not available in this Node.js runtime');
    this.name = 'gemini';
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.model = model || 'gemini-3.5-flash';
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.maxRepairAttempts = maxRepairAttempts;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  async review({ chunk }) {
    return reviewWithRepair({
      provider: this,
      chunk,
      buildBody: () => this.buildBody(chunk),
      parseResponse: parseGeminiGenerateContentResponse,
      buildRepairBody: ({ invalidContent, error }) => this.buildRepairBody({ invalidContent, error })
    });
  }

  buildBody(chunk) {
    const body = {
      systemInstruction: {
        parts: [{ text: reviewInstruction(chunk) }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: JSON.stringify(chunk) }]
        }
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json'
      }
    };
    const maxTokens = maxOutputTokens(chunk);
    if (maxTokens) body.generationConfig.maxOutputTokens = maxTokens;
    return body;
  }

  buildRepairBody({ invalidContent, error }) {
    return {
      systemInstruction: {
        parts: [{ text: 'Repair the previous AI code review response. Return valid JSON only with a top-level findings array.' }]
      },
      contents: [
        {
          role: 'user',
          parts: [{
            text: JSON.stringify({
              error: error.message,
              invalid_content: invalidContent,
              required_shape: { findings: [] }
            })
          }]
        }
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        maxOutputTokens: 1024
      }
    };
  }

  async postWithRetry(body) {
    return postJsonWithRetry({
      url: `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      headers: this.headers(),
      body,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });
  }

  headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json'
    };
    if (this.apiKey) headers['x-goog-api-key'] = this.apiKey;
    return headers;
  }
}

function createAiProvider(ai = {}) {
  const provider = String(ai.provider || (ai.baseUrl ? 'openai-compatible' : 'openai')).toLowerCase();
  if (provider === 'openai') return new OpenAIChatProvider(ai);
  if (provider === 'anthropic') return new AnthropicMessagesProvider(ai);
  if (provider === 'gemini') return new GeminiGenerateContentProvider(ai);
  if (provider === 'openai-compatible') {
    return new OpenAICompatibleProvider({
      ...ai,
      baseUrl: ai.baseUrl,
      providerName: 'openai-compatible'
    });
  }
  if (PROVIDERS[provider]) {
    const preset = PROVIDERS[provider];
    return new OpenAICompatibleProvider({
      ...ai,
      providerName: preset.name,
      baseUrl: ai.baseUrl || preset.baseUrl,
      path: preset.path,
      maxTokenField: preset.maxTokenField,
      instructionRole: preset.instructionRole
    });
  }
  throw new Error(`Unsupported AI provider: ${ai.provider}`);
}

async function reviewWithRepair({ provider, chunk, buildBody, parseResponse, buildRepairBody }) {
  const started = Date.now();
  const usage = {
    provider: provider.name || 'unknown',
    model: provider.model,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    chunk_count: 1,
    truncated: Boolean(chunk.truncated),
    repair_attempts: 0,
    elapsed_ms: 0
  };
  let response = await provider.postWithRetry(buildBody());
  addUsage(usage, response);
  let parsed = parseResponse(response);

  for (let attempt = 0; !parsed.ok && attempt < provider.maxRepairAttempts; attempt += 1) {
    const repairResponse = await provider.postWithRetry(buildRepairBody({
      invalidContent: parsed.content,
      error: parsed.error
    }));
    usage.repair_attempts += 1;
    addUsage(usage, repairResponse);
    response = repairResponse;
    parsed = parseResponse(repairResponse);
  }

  if (!parsed.ok) {
    throw new Error(`AI provider returned invalid JSON content: ${parsed.error.message}`);
  }
  usage.model = modelFromResponse(response) || provider.model;
  usage.elapsed_ms = Date.now() - started;
  return {
    findings: parsed.value.findings || [],
    usage
  };
}

async function postJsonWithRetry({ url, headers, body, fetchImpl, sleep, timeoutMs, maxRetries }) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.ok) return response.json();
      const text = await response.text();
      if (!isRetryable(response.status) || attempt === maxRetries) {
        throw new Error(`AI provider failed: ${response.status} ${response.statusText} ${text.slice(0, 300)}`);
      }
      lastError = new Error(`AI provider retryable failure: ${response.status}`);
    } catch (error) {
      if (attempt === maxRetries || error.name === 'AbortError') throw error;
      lastError = error;
    }
    await sleep(100 * 2 ** attempt);
  }
  throw lastError;
}

function parseChatCompletion(response) {
  const parsed = parseChatCompletionResponse(response);
  if (!parsed.ok) {
    throw new Error(`AI provider returned invalid JSON content: ${parsed.error.message}`);
  }
  return parsed.value;
}

function parseChatCompletionResponse(response) {
  return parseJsonFindingContent(response
    && response.choices
    && response.choices[0]
    && response.choices[0].message
    && response.choices[0].message.content);
}

function tryParseChatCompletion(response) {
  return parseChatCompletionResponse(response);
}

function parseAnthropicMessageResponse(response) {
  const content = Array.isArray(response && response.content)
    ? response.content
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text || '')
      .join('')
    : '';
  return parseJsonFindingContent(content);
}

function parseGeminiGenerateContentResponse(response) {
  const parts = response
    && response.candidates
    && response.candidates[0]
    && response.candidates[0].content
    && response.candidates[0].content.parts;
  const content = Array.isArray(parts)
    ? parts.map((part) => part.text || '').join('')
    : '';
  return parseJsonFindingContent(content);
}

function parseJsonFindingContent(content) {
  if (!content) return { ok: true, value: { findings: [] }, content: '' };
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.findings)) return { ok: true, value: parsed, content };
    return { ok: false, error: new Error('JSON object must contain a findings array'), content };
  } catch (error) {
    return { ok: false, error, content };
  }
}

function buildRepairBody({ model, invalidContent, error }) {
  return buildChatRepairBody({ model, maxTokenField: 'max_tokens', invalidContent, error });
}

function buildChatRepairBody({ model, maxTokenField, invalidContent, error }) {
  const body = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Repair the previous AI code review response. Return valid JSON only with a top-level findings array.'
      },
      {
        role: 'user',
        content: JSON.stringify({
          error: error.message,
          invalid_content: invalidContent,
          required_shape: { findings: [] }
        })
      }
    ]
  };
  if (maxTokenField) body[maxTokenField] = 1024;
  return body;
}

function addUsage(target, response = {}) {
  target.input_tokens += numberAt(response, ['usage', 'prompt_tokens'])
    || numberAt(response, ['usage', 'input_tokens'])
    || numberAt(response, ['usageMetadata', 'promptTokenCount']);
  target.output_tokens += numberAt(response, ['usage', 'completion_tokens'])
    || numberAt(response, ['usage', 'output_tokens'])
    || numberAt(response, ['usageMetadata', 'candidatesTokenCount']);
  target.total_tokens += numberAt(response, ['usage', 'total_tokens'])
    || numberAt(response, ['usageMetadata', 'totalTokenCount']);
}

function modelFromResponse(response = {}) {
  return response.model || response.modelVersion;
}

function maxOutputTokens(chunk) {
  const maxTokens = chunk.fixed && chunk.fixed.output_constraints && chunk.fixed.output_constraints.max_output_tokens;
  const number = Number(maxTokens);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function reviewInstruction(chunk) {
  return (chunk.fixed && chunk.fixed.role) || 'You are an AI code review assistant. Return JSON only.';
}

function isRetryable(status) {
  return status === 429 || status >= 500;
}

function numberAt(object, path) {
  let current = object;
  for (const key of path) {
    current = current && current[key];
  }
  return Number(current || 0);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  OpenAIChatProvider,
  AnthropicMessagesProvider,
  GeminiGenerateContentProvider,
  OpenAICompatibleProvider,
  createAiProvider,
  parseChatCompletion,
  tryParseChatCompletion,
  buildRepairBody
};
