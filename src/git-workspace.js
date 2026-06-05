const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { safeSegment } = require('./path-utils');

const execFileAsync = promisify(execFile);

async function prepareGitWorkspace({
  request,
  workspaceDir,
  gitCacheDir,
  allowedCloneUrlPatterns = [],
  retainWorkspaces = false,
  execFileImpl = execFileAsync,
  pathExists = exists
}) {
  let sourceRepoPath = resolveRepositoryPath(request);
  if (!sourceRepoPath) {
    const remoteCloneUrl = resolveRemoteCloneUrl(request);
    if (remoteCloneUrl) {
      assertAllowedCloneUrl(remoteCloneUrl, allowedCloneUrlPatterns);
      sourceRepoPath = await ensureMirrorRepository({
        request,
        cloneUrl: remoteCloneUrl,
        gitCacheDir,
        allowedCloneUrlPatterns,
        execFileImpl,
        pathExists
      });
    }
  }
  if (!sourceRepoPath) {
    return {
      sourceRepoPath: null,
      repoPath: null,
      cleanup: async () => {}
    };
  }

  const revision = request.revision || {};
  const target = revision.target_commit || 'HEAD';
  if (!revision.base_commit) {
    return {
      sourceRepoPath,
      repoPath: sourceRepoPath,
      cleanup: async () => {}
    };
  }

  const root = path.resolve(workspaceDir || path.join(process.cwd(), 'workspaces'));
  await fs.mkdir(root, { recursive: true });
  const project = safeSegment((request.project && request.project.name) || 'project');
  const worktreePath = path.join(root, `${project}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await execFileImpl('git', ['-C', sourceRepoPath, 'worktree', 'add', '--detach', worktreePath, target], {
    maxBuffer: 16 * 1024 * 1024
  });

  return {
    sourceRepoPath,
    repoPath: worktreePath,
    cleanup: async () => {
      if (retainWorkspaces) return;
      await removeWorktree(sourceRepoPath, worktreePath, execFileImpl);
    }
  };
}

async function ensureMirrorRepository({ request, cloneUrl, gitCacheDir, allowedCloneUrlPatterns = [], execFileImpl, pathExists }) {
  const root = path.resolve(gitCacheDir || path.join(process.cwd(), 'git-cache'));
  await fs.mkdir(root, { recursive: true });
  const project = request.project || {};
  const mirrorName = `${safeSegment(project.repository_full_name || cloneUrl)}.git`;
  const mirrorPath = path.join(root, mirrorName);
  if (await pathExists(mirrorPath)) {
    await execFileImpl('git', ['-C', mirrorPath, 'remote', 'update', '--prune'], {
      maxBuffer: 64 * 1024 * 1024
    });
  } else {
    await execFileImpl('git', ['clone', '--mirror', cloneUrl, mirrorPath], {
      maxBuffer: 64 * 1024 * 1024
    });
  }

  const sourceRepo = request.revision && request.revision.source_repo;
  const sourceCloneUrl = sourceRepo && sourceRepo.clone_url;
  const target = request.revision && request.revision.target_commit;
  if (sourceCloneUrl && sourceCloneUrl !== cloneUrl && target) {
    assertAllowedCloneUrl(sourceCloneUrl, allowedCloneUrlPatterns);
    await execFileImpl('git', ['-C', mirrorPath, 'fetch', sourceCloneUrl, target], {
      maxBuffer: 64 * 1024 * 1024
    });
  }

  return mirrorPath;
}

async function removeWorktree(sourceRepoPath, worktreePath, execFileImpl = execFileAsync) {
  try {
    await execFileImpl('git', ['-C', sourceRepoPath, 'worktree', 'remove', '--force', worktreePath], {
      maxBuffer: 16 * 1024 * 1024
    });
  } catch {
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
}

function resolveRepositoryPath(request) {
  const project = request.project || {};
  const candidate = project.repository_path || project.local_path || request.repository_path;
  if (candidate) return path.resolve(candidate);

  const cloneUrl = project.clone_url || '';
  if (cloneUrl.startsWith('file://')) {
    return path.resolve(new URL(cloneUrl).pathname);
  }
  if (cloneUrl.startsWith('/')) {
    return path.resolve(cloneUrl);
  }
  return null;
}

function resolveRemoteCloneUrl(request) {
  const project = request.project || {};
  const cloneUrl = project.clone_url || '';
  if (!cloneUrl || cloneUrl.startsWith('file://') || cloneUrl.startsWith('/')) return '';
  return cloneUrl;
}

function assertAllowedCloneUrl(cloneUrl, allowedCloneUrlPatterns = []) {
  const patterns = allowedCloneUrlPatterns || [];
  if (patterns.length === 0) return;
  const allowed = patterns.some((pattern) => new RegExp(pattern).test(cloneUrl));
  if (!allowed) {
    const error = new Error(`Remote clone URL is not allowed by IMPACT_ALLOWED_CLONE_URL_PATTERNS: ${cloneUrl}`);
    error.code = 'CLONE_URL_NOT_ALLOWED';
    throw error;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  prepareGitWorkspace,
  ensureMirrorRepository,
  removeWorktree,
  resolveRepositoryPath,
  resolveRemoteCloneUrl,
  assertAllowedCloneUrl
};
