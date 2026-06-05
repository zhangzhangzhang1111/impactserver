const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('loadConfig reads official AI provider settings from environment', () => {
  const config = loadConfig({
    IMPACT_AI_ENABLED: 'true',
    IMPACT_AI_PROVIDER: 'anthropic',
    IMPACT_AI_BASE_URL: 'https://api.example.test',
    IMPACT_AI_API_KEY: 'secret',
    IMPACT_AI_MODEL: 'claude-sonnet-4-5',
    IMPACT_AI_TIMEOUT_MS: '45000',
    IMPACT_AI_MAX_RETRIES: '3',
    IMPACT_AI_MAX_OUTPUT_TOKENS: '8192',
    IMPACT_AI_ANTHROPIC_VERSION: '2023-06-01'
  }, '/repo');

  assert.equal(config.ai.enabled, true);
  assert.equal(config.ai.provider, 'anthropic');
  assert.equal(config.ai.baseUrl, 'https://api.example.test');
  assert.equal(config.ai.apiKey, 'secret');
  assert.equal(config.ai.model, 'claude-sonnet-4-5');
  assert.equal(config.ai.timeoutMs, 45000);
  assert.equal(config.ai.maxRetries, 3);
  assert.equal(config.ai.maxOutputTokens, 8192);
  assert.equal(config.ai.anthropicVersion, '2023-06-01');
});
