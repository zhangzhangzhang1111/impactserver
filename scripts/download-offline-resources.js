#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { selectAssets, normalizeReleaseMetadata, verifyAssetFile } = require('../src/offline-resources');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((arg) => arg !== '--dry-run');
  const manifestPath = positional[0] || path.join(process.cwd(), 'config', 'offline-resources.json');
  const outputDir = positional[1] || path.join(process.cwd(), 'offline-resources');
  await downloadOfflineResources({ manifestPath, outputDir, dryRun });

  console.log(`${dryRun ? 'Resolved' : 'Downloaded'} offline resources to ${outputDir}`);
}

async function downloadOfflineResources({
  manifestPath,
  outputDir,
  dryRun = false,
  fetchImpl = globalThis.fetch
}) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  await fs.mkdir(outputDir, { recursive: true });
  const lock = {
    generated_at: new Date().toISOString(),
    resources: []
  };

  for (const resource of manifest.resources) {
    if (resource.skipDownload) {
      lock.resources.push({ name: resource.name, skipped: true, reason: resource.reason || 'metadata only' });
      continue;
    }
    const release = await fetchJson(resource.releaseApiUrl, fetchImpl);
    const assets = selectAssets(release, resource);
    const resourceDir = path.join(outputDir, safeSegment(resource.name));
    await fs.mkdir(resourceDir, { recursive: true });

    for (const asset of assets) {
      const target = path.join(resourceDir, asset.fileName);
      asset.local_path = target;
      asset.cache_hit = false;
      asset.verified = false;
      if (dryRun) {
        asset.dry_run = true;
        continue;
      }
      const cached = await tryVerifyCachedAsset(target, asset);
      if (cached) {
        Object.assign(asset, cached, { cache_hit: true });
        continue;
      }
      await download(asset.url, target, fetchImpl);
      const verified = await verifyAssetFile(target, asset);
      Object.assign(asset, verified, { cache_hit: false });
    }

    lock.resources.push({
      name: resource.name,
      repository: resource.repository,
      release: normalizeReleaseMetadata(release),
      assets
    });
  }

  await fs.writeFile(path.join(outputDir, 'offline-resources.lock.json'), JSON.stringify(lock, null, 2));
  return lock;
}

async function fetchJson(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    headers: githubHeaders()
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function download(url, target, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    headers: githubHeaders()
  });
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(target));
}

async function tryVerifyCachedAsset(target, asset) {
  try {
    return await verifyAssetFile(target, asset);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

function githubHeaders() {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'impactserver-offline-resource-downloader'
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  downloadOfflineResources,
  fetchJson,
  download,
  tryVerifyCachedAsset,
  safeSegment
};
