const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('loadConfig uses project JSON path for AI providers instead of global provider environment', () => {
  const config = loadConfig({
    IMPACT_AI_PROVIDER: 'anthropic',
    IMPACT_AI_API_KEY: 'secret'
  }, '/repo');

  assert.equal(config.aiProviderConfigPath, '/repo/config/ai-providers.json');
  assert.deepEqual(config.ai, {});
});
