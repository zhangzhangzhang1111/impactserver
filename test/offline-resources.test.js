const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  selectAssets,
  normalizeReleaseMetadata,
  parseDigest,
  sha256File,
  verifyAssetFile
} = require('../src/offline-resources');

test('selectAssets picks matching release assets', () => {
  const release = {
    tag_name: '22.1.0',
    assets: [
      {
        name: 'clangd-linux-22.1.0.zip',
        browser_download_url: 'https://example.test/clangd.zip',
        digest: 'sha256:abc',
        size: 123
      }
    ]
  };
  const selected = selectAssets(release, {
    name: 'clangd',
    assets: [{ name: 'linux-x64', pattern: '^clangd-linux-.*\\.zip$' }]
  });
  assert.deepEqual(selected, [
    {
      name: 'linux-x64',
      fileName: 'clangd-linux-22.1.0.zip',
      url: 'https://example.test/clangd.zip',
      digest: 'sha256:abc',
      size: 123
    }
  ]);
});

test('selectAssets allows optional missing assets', () => {
  const selected = selectAssets({ assets: [] }, {
    name: 'pyright',
    assets: [{ name: 'source', pattern: '.*\\.zip$', required: false }]
  });
  assert.deepEqual(selected, []);
});

test('selectAssets adds GitHub source archive when requested', () => {
  const selected = selectAssets({
    tag_name: '1.1.409',
    assets: [],
    zipball_url: 'https://api.github.com/repos/microsoft/pyright/zipball/1.1.409'
  }, {
    name: 'pyright',
    sourceArchive: 'zipball'
  });
  assert.deepEqual(selected, [
    {
      name: 'source-zipball',
      fileName: 'pyright-1.1.409.zip',
      url: 'https://api.github.com/repos/microsoft/pyright/zipball/1.1.409',
      digest: null,
      size: null
    }
  ]);
});

test('normalizeReleaseMetadata returns trace fields', () => {
  assert.deepEqual(normalizeReleaseMetadata({
    tag_name: '3.18.2',
    html_url: 'https://github.com/LuaLS/lua-language-server/releases/tag/3.18.2',
    published_at: '2026-04-14T14:38:00Z'
  }), {
    tag: '3.18.2',
    name: '3.18.2',
    html_url: 'https://github.com/LuaLS/lua-language-server/releases/tag/3.18.2',
    published_at: '2026-04-14T14:38:00Z'
  });
});

test('parseDigest accepts GitHub sha256 digest fields', () => {
  assert.deepEqual(parseDigest('sha256:abc123'), { algorithm: 'sha256', value: 'abc123' });
  assert.equal(parseDigest(null), null);
  assert.equal(parseDigest('md5:abc'), null);
});

test('verifyAssetFile confirms size and sha256 digest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-offline-verify-'));
  const filePath = path.join(root, 'asset.bin');
  await fs.writeFile(filePath, 'hello');
  const sha256 = await sha256File(filePath);

  const result = await verifyAssetFile(filePath, {
    size: 5,
    digest: `sha256:${sha256}`
  });

  assert.equal(result.verified, true);
  assert.equal(result.sha256, sha256);
  assert.equal(result.size, 5);
});

test('verifyAssetFile rejects mismatched checksums', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-offline-bad-'));
  const filePath = path.join(root, 'asset.bin');
  await fs.writeFile(filePath, 'hello');

  await assert.rejects(verifyAssetFile(filePath, {
    size: 5,
    digest: 'sha256:not-the-real-hash'
  }), /checksum mismatch/);
});
