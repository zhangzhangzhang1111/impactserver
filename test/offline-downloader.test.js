const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { downloadOfflineResources } = require('../scripts/download-offline-resources');
const { sha256File } = require('../src/offline-resources');

test('downloadOfflineResources verifies downloaded files and reuses valid cache', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-offline-download-'));
  const manifestPath = path.join(root, 'manifest.json');
  const outputDir = path.join(root, 'offline');
  const assetContent = Buffer.from('release-binary');
  const expectedSha = await sha256Buffer(assetContent);
  await fs.writeFile(manifestPath, JSON.stringify({
    resources: [
      {
        name: 'fake-tool',
        repository: 'https://github.com/example/fake-tool',
        releaseApiUrl: 'https://api.github.com/repos/example/fake-tool/releases/latest',
        assets: [{ name: 'linux-x64', pattern: '^fake-tool-linux\\.zip$' }]
      }
    ]
  }));

  let assetDownloads = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/releases/latest')) {
      return jsonResponse({
        tag_name: 'v1.0.0',
        name: 'v1.0.0',
        html_url: 'https://github.com/example/fake-tool/releases/tag/v1.0.0',
        published_at: '2026-01-01T00:00:00Z',
        assets: [
          {
            name: 'fake-tool-linux.zip',
            browser_download_url: 'https://github.com/example/fake-tool/releases/download/v1.0.0/fake-tool-linux.zip',
            digest: `sha256:${expectedSha}`,
            size: assetContent.length
          }
        ]
      });
    }
    assetDownloads += 1;
    return streamResponse(assetContent);
  };

  const firstLock = await downloadOfflineResources({ manifestPath, outputDir, fetchImpl });
  const target = firstLock.resources[0].assets[0].local_path;
  assert.equal(await sha256File(target), expectedSha);
  assert.equal(firstLock.resources[0].assets[0].verified, true);
  assert.equal(firstLock.resources[0].assets[0].cache_hit, false);
  assert.equal(assetDownloads, 1);

  const secondLock = await downloadOfflineResources({ manifestPath, outputDir, fetchImpl });
  assert.equal(secondLock.resources[0].assets[0].cache_hit, true);
  assert.equal(secondLock.resources[0].assets[0].verified, true);
  assert.equal(assetDownloads, 1);
});

async function sha256Buffer(buffer) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function streamResponse(buffer) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: Readable.from([buffer])
  };
}
