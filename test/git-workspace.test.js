const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { collectDiff } = require('../src/git-diff');
const { prepareGitWorkspace } = require('../src/git-workspace');

const execFileAsync = promisify(execFile);

test('collectDiff creates an isolated worktree at target revision and cleans it up', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-git-'));
  const repo = path.join(root, 'repo');
  const workspaceDir = path.join(root, 'workspaces');
  await fs.mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);

  await fs.writeFile(path.join(repo, 'app.py'), 'def get_user(name):\n    return None\n');
  await git(repo, ['add', 'app.py']);
  await git(repo, ['commit', '-m', 'base']);
  const base = await revParse(repo, 'HEAD');

  await fs.writeFile(path.join(repo, 'app.py'), 'def get_user(name):\n    sql = f"select * from users where name = \'{name}\'"\n    return db.execute(sql)\n');
  await git(repo, ['add', 'app.py']);
  await git(repo, ['commit', '-m', 'target']);
  const target = await revParse(repo, 'HEAD');

  const diff = await collectDiff({
    project: { name: 'demo', repository_path: repo },
    revision: { base_commit: base, target_commit: target }
  }, { workspaceDir, retainWorkspaces: false });

  assert.match(diff.patch, /\+    sql = f"select/);
  assert.notEqual(diff.repoPath, repo);
  assert.match(diff.repoPath, /workspaces/);

  const targetSource = await fs.readFile(path.join(diff.repoPath, 'app.py'), 'utf8');
  assert.match(targetSource, /db\.execute/);

  await diff.cleanup();
  await assert.rejects(fs.stat(diff.repoPath), /ENOENT/);
});

test('prepareGitWorkspace clones remote repositories into bare mirror cache', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-git-cache-'));
  const commands = [];
  const workspace = await prepareGitWorkspace({
    request: {
      project: {
        name: 'demo',
        repository_full_name: 'org/demo',
        clone_url: 'https://github.com/org/demo.git'
      },
      revision: {
        base_commit: 'base-sha',
        target_commit: 'head-sha'
      }
    },
    workspaceDir: path.join(root, 'workspaces'),
    gitCacheDir: path.join(root, 'git-cache'),
    execFileImpl: async (command, args) => {
      commands.push([command, ...args]);
      return { stdout: '', stderr: '' };
    },
    pathExists: async () => false
  });

  assert.ok(workspace.sourceRepoPath.endsWith(path.join('git-cache', 'org-demo.git')));
  assert.ok(commands.some((cmd) => cmd.join(' ') === `git clone --mirror https://github.com/org/demo.git ${workspace.sourceRepoPath}`));
  assert.ok(commands.some((cmd) => cmd.includes('worktree') && cmd.includes('head-sha')));
});

test('prepareGitWorkspace fetches target commit from fork source repository', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-git-fork-'));
  const commands = [];
  await prepareGitWorkspace({
    request: {
      project: {
        name: 'demo',
        repository_full_name: 'org/demo',
        clone_url: 'https://github.com/org/demo.git'
      },
      revision: {
        base_commit: 'base-sha',
        target_commit: 'head-sha',
        source_repo: {
          full_name: 'fork/demo',
          clone_url: 'https://github.com/fork/demo.git'
        }
      }
    },
    workspaceDir: path.join(root, 'workspaces'),
    gitCacheDir: path.join(root, 'git-cache'),
    execFileImpl: async (command, args) => {
      commands.push([command, ...args]);
      return { stdout: '', stderr: '' };
    },
    pathExists: async () => true
  });

  assert.ok(commands.some((cmd) => cmd.join(' ') === 'git -C ' + path.join(root, 'git-cache', 'org-demo.git') + ' remote update --prune'));
  assert.ok(commands.some((cmd) => cmd.join(' ') === 'git -C ' + path.join(root, 'git-cache', 'org-demo.git') + ' fetch https://github.com/fork/demo.git head-sha'));
});

test('prepareGitWorkspace rejects remote clone URLs outside allowlist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-git-allowlist-'));
  await assert.rejects(
    prepareGitWorkspace({
      request: {
        project: {
          name: 'demo',
          repository_full_name: 'org/demo',
          clone_url: 'https://evil.example.test/org/demo.git'
        },
        revision: {
          base_commit: 'base-sha',
          target_commit: 'head-sha',
          source_repo: {
            full_name: 'fork/demo',
            clone_url: 'https://github.com/fork/demo.git'
          }
        }
      },
      workspaceDir: path.join(root, 'workspaces'),
      gitCacheDir: path.join(root, 'git-cache'),
      allowedCloneUrlPatterns: ['^https://github\\.com/'],
      execFileImpl: async () => ({ stdout: '', stderr: '' }),
      pathExists: async () => false
    }),
    /clone URL is not allowed/
  );
});

test('prepareGitWorkspace rejects fork source clone URLs outside allowlist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-git-fork-allowlist-'));
  await assert.rejects(
    prepareGitWorkspace({
      request: {
        project: {
          name: 'demo',
          repository_full_name: 'org/demo',
          clone_url: 'https://github.com/org/demo.git'
        },
        revision: {
          base_commit: 'base-sha',
          target_commit: 'head-sha',
          source_repo: {
            full_name: 'fork/demo',
            clone_url: 'ssh://internal.example.test/fork/demo.git'
          }
        }
      },
      workspaceDir: path.join(root, 'workspaces'),
      gitCacheDir: path.join(root, 'git-cache'),
      allowedCloneUrlPatterns: ['^https://github\\.com/'],
      execFileImpl: async () => ({ stdout: '', stderr: '' }),
      pathExists: async () => false
    }),
    /clone URL is not allowed/
  );
});

async function git(cwd, args) {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function revParse(cwd, ref) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', ref]);
  return stdout.trim();
}
