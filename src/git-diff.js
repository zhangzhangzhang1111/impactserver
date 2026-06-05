const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepareGitWorkspace, resolveRepositoryPath } = require('./git-workspace');

const execFileAsync = promisify(execFile);

async function collectDiff(request, config = {}) {
  if (Object.prototype.hasOwnProperty.call(request, 'diff_patch')) {
    return { patch: request.diff_patch, repoPath: request.repository_path || null, cleanup: async () => {} };
  }

  const workspace = await prepareGitWorkspace({
    request,
    workspaceDir: config.workspaceDir,
    gitCacheDir: config.gitCacheDir,
    allowedCloneUrlPatterns: config.allowedCloneUrlPatterns,
    retainWorkspaces: config.retainWorkspaces
  });
  if (!workspace.repoPath) {
    return { patch: '', repoPath: null, cleanup: workspace.cleanup };
  }

  const revision = request.revision || {};
  const base = revision.base_commit;
  const target = revision.target_commit || 'HEAD';
  if (!base) {
    return { patch: '', repoPath: workspace.repoPath, cleanup: workspace.cleanup };
  }

  const { stdout } = await execFileAsync('git', ['-C', workspace.repoPath, 'diff', '--unified=80', base, target], {
    maxBuffer: 64 * 1024 * 1024
  });
  return { patch: stdout, repoPath: workspace.repoPath, cleanup: workspace.cleanup };
}

module.exports = { collectDiff, resolveRepositoryPath };
