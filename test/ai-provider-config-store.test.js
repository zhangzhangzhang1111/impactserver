const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AiProviderConfigStore } = require('../src/ai-provider-config-store');

test('AiProviderConfigStore loads enabled presets and injects API keys from env', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-ai-providers-'));
  const configPath = path.join(root, 'ai-providers.json');
  await fs.writeFile(configPath, JSON.stringify({
    default_provider: 'qwen',
    providers: [
      {
        id: 'qwen',
        name: '通义千问',
        enabled: true,
        provider: 'qwen',
        base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus',
        api_key_env: 'DASHSCOPE_API_KEY',
        max_input_tokens: 120000,
        max_output_tokens: 8000
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        enabled: false,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        api_key_env: 'DEEPSEEK_API_KEY'
      }
    ]
  }, null, 2));

  const store = new AiProviderConfigStore({
    configPath,
    env: { DASHSCOPE_API_KEY: 'dashscope-secret', DEEPSEEK_API_KEY: 'deepseek-secret' }
  });

  const selected = await store.getSelected({ providerId: '' });
  const disabled = await store.getSelected({ providerId: 'deepseek' });
  const publicConfig = await store.listPublic();

  assert.equal(selected.id, 'qwen');
  assert.equal(selected.provider, 'qwen');
  assert.equal(selected.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(selected.apiKey, 'dashscope-secret');
  assert.equal(selected.maxOutputTokens, 8000);
  assert.equal(disabled, null);
  assert.equal(publicConfig.default_provider, 'qwen');
  assert.equal(publicConfig.providers[0].api_key, undefined);
  assert.equal(publicConfig.providers[0].apiKey, undefined);
  assert.equal(publicConfig.providers[0].base_url, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(publicConfig.providers[0].has_api_key, true);
  assert.equal(publicConfig.providers[1].has_api_key, true);
});
