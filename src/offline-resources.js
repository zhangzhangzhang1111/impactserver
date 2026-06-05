const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');

function selectAssets(release, resource) {
  const patterns = (resource.assets || []).map((asset) => ({
    ...asset,
    regex: new RegExp(asset.pattern)
  }));
  const selected = [];

  for (const wanted of patterns) {
    const match = (release.assets || []).find((asset) => wanted.regex.test(asset.name));
    if (!match && wanted.required !== false) {
      throw new Error(`No release asset matched ${wanted.pattern} for ${resource.name}`);
    }
    if (match) {
      selected.push({
        name: wanted.name || match.name,
        fileName: match.name,
        url: match.browser_download_url,
        digest: match.digest || null,
        size: match.size || null
      });
    }
  }

  if (resource.sourceArchive) {
    const key = resource.sourceArchive === 'tarball' ? 'tarball_url' : 'zipball_url';
    const url = release[key];
    if (!url) {
      throw new Error(`Release ${resource.name} does not expose ${key}`);
    }
    const extension = resource.sourceArchive === 'tarball' ? 'tar.gz' : 'zip';
    selected.push({
      name: resource.sourceArchiveName || `source-${resource.sourceArchive}`,
      fileName: `${resource.name}-${release.tag_name}.${extension}`,
      url,
      digest: null,
      size: null
    });
  }

  return selected;
}

function parseDigest(value) {
  if (!value) return null;
  const match = String(value).match(/^sha256:(.+)$/);
  if (!match) return null;
  return { algorithm: 'sha256', value: match[1].toLowerCase() };
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function verifyAssetFile(filePath, asset) {
  const stat = await fs.stat(filePath);
  if (asset.size !== null && asset.size !== undefined && Number(asset.size) !== stat.size) {
    throw new Error(`asset size mismatch for ${filePath}: expected ${asset.size}, got ${stat.size}`);
  }
  const digest = parseDigest(asset.digest);
  const sha256 = await sha256File(filePath);
  if (digest && digest.value !== sha256) {
    throw new Error(`asset checksum mismatch for ${filePath}: expected ${digest.value}, got ${sha256}`);
  }
  return {
    verified: true,
    size: stat.size,
    sha256,
    digest_checked: Boolean(digest)
  };
}

function normalizeReleaseMetadata(release) {
  return {
    tag: release.tag_name,
    name: release.name || release.tag_name,
    html_url: release.html_url,
    published_at: release.published_at
  };
}

module.exports = {
  selectAssets,
  normalizeReleaseMetadata,
  parseDigest,
  sha256File,
  verifyAssetFile
};
