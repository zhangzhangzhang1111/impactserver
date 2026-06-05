const fs = require('node:fs/promises');

class AiProviderConfigStore {
  constructor({ configPath, env = process.env }) {
    this.configPath = configPath;
    this.env = env;
  }

  async load() {
    if (!this.configPath) return { default_provider: '', providers: [] };
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      return normalizeAiProviderConfig(parsed, this.env);
    } catch (error) {
      if (error.code === 'ENOENT') return { default_provider: '', providers: [] };
      throw error;
    }
  }

  async getSelected({ providerId = '' } = {}) {
    const config = await this.load();
    return selectProvider(config, providerId);
  }

  async listPublic() {
    const config = await this.load();
    return {
      default_provider: config.default_provider,
      providers: config.providers.map(redactProvider)
    };
  }
}

function normalizeAiProviderConfig(config, env = process.env) {
  const providers = asArray(config && config.providers)
    .filter((provider) => provider && provider.id)
    .map((provider) => normalizeProvider(provider, env));
  return {
    default_provider: String((config && config.default_provider) || ''),
    providers
  };
}

function normalizeProvider(provider, env) {
  const apiKeyEnv = provider.api_key_env || provider.apiKeyEnv || '';
  return {
    id: String(provider.id),
    name: provider.name || String(provider.id),
    enabled: provider.enabled === true,
    provider: provider.provider || provider.id,
    model: provider.model || 'default',
    baseUrl: provider.base_url || provider.baseUrl || '',
    apiKey: apiKeyEnv ? String(env[apiKeyEnv] || '') : '',
    apiKeyEnv,
    maxInputTokens: numberOrZero(provider.max_input_tokens || provider.maxInputTokens),
    maxOutputTokens: numberOrZero(provider.max_output_tokens || provider.maxOutputTokens),
    timeoutMs: numberOrDefault(provider.timeout_ms || provider.timeoutMs, 60000),
    maxRetries: numberOrDefault(provider.max_retries || provider.maxRetries, 2),
    anthropicVersion: provider.anthropic_version || provider.anthropicVersion || '2023-06-01'
  };
}

function selectProvider(config, providerId = '') {
  const selectedId = providerId || config.default_provider;
  const selected = config.providers.find((provider) => provider.id === selectedId);
  if (selected && selected.enabled) return selected;
  return null;
}

function redactProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    enabled: provider.enabled,
    provider: provider.provider,
    model: provider.model,
    base_url: provider.baseUrl,
    api_key_env: provider.apiKeyEnv,
    has_api_key: Boolean(provider.apiKey),
    max_input_tokens: provider.maxInputTokens,
    max_output_tokens: provider.maxOutputTokens,
    timeout_ms: provider.timeoutMs,
    max_retries: provider.maxRetries,
    anthropic_version: provider.anthropicVersion
  };
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = {
  AiProviderConfigStore,
  normalizeAiProviderConfig,
  selectProvider,
  redactProvider
};
