'use strict';
// Test helpers: throwaway repos under the OS temp dir, isolated from user git config.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpDirs = [];

/**
 * A new folder under the OS temp dir, by its native real path: the canonical spelling git and the
 * app use (on Windows the runner's temp dir is an 8.3 short name, C:\Users\RUNNER~1\..., which
 * only the native realpath expands; on macOS /var is /private/var either way).
 */
function tmpDir(prefix = 'pl-') {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

// Isolate every test from the user's ~/.gitconfig and system config. On Windows the global config
// is a file of our own instead of /dev/null: Git for Windows hides the .git it creates
// (core.hideDotFiles), and Node can't open a hidden file with 'w' (CREATE_ALWAYS: EPERM), which
// the tests do to rewrite a worktree's .git file; core.symlinks=true lets git check out symlinks
// as links (git init still sets it false in a repo where symlinks can't be made).
const globalConfig = process.platform === 'win32' ? path.join(tmpDir('pl-home-'), 'gitconfig') : '/dev/null';
if (process.platform === 'win32') fs.writeFileSync(globalConfig, '[core]\n\thideDotFiles = false\n\tsymlinks = true\n');
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

/** Synchronous raw git (no global -c args) for test setup and assertions. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** New repo with branch `main`. `commits: true` adds one initial commit (README). */
function initRepo({ commits = true, bare = false } = {}) {
  const dir = tmpDir();
  git(dir, 'init', '-q', '-b', 'main', ...(bare ? ['--bare'] : []));
  if (!bare) {
    git(dir, 'config', 'commit.gpgSign', 'false');
    if (commits) commitFile(dir, 'README.md', 'hello\n', 'initial');
  }
  return dir;
}

function write(dir, file, content) {
  const p = path.join(dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

function commitFile(dir, file, content, message = `edit ${file}`) {
  write(dir, file, content);
  git(dir, 'add', '--', file);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/** Bare "origin" plus a clone of it; returns { remote, local }. */
function repoWithRemote() {
  const remote = initRepo({ bare: true });
  const seed = initRepo();
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const local = tmpDir();
  git(local, 'clone', '-q', remote, '.');
  git(local, 'config', 'commit.gpgSign', 'false');
  return { remote, local, seed };
}

/**
 * The "bare + worktrees" layout: `top/.bare` a bare clone of repoWithRemote's remote,
 * `top/.git` the file 'gitdir: ./.bare', `top/main` a linked worktree on main. `git clone --bare`
 * sets no fetch refspec: `refspec: true` (default) configures the usual one and fetches, so
 * refs/remotes/origin/* exist. Returns {top, bare, wt, remote, seed}.
 */
function bareWithWorktree({ refspec = true, worktree = true } = {}) {
  const { remote, seed } = repoWithRemote();
  const top = tmpDir();
  const bare = path.join(top, '.bare');
  git(top, 'clone', '-q', '--bare', remote, bare);
  fs.writeFileSync(path.join(top, '.git'), 'gitdir: ./.bare\n');
  if (refspec) {
    git(bare, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git(bare, 'fetch', '-q', 'origin');
  }
  const wt = path.join(top, 'main');
  if (worktree) {
    git(bare, 'worktree', 'add', '-q', wt, 'main');
    git(wt, 'config', 'commit.gpgSign', 'false');
  }
  return { top, bare, wt, remote, seed };
}

/**
 * Repo-local config that breaks naive parsing/behaviour. Modules must produce identical results
 * with it applied (the -c overrides in src/git-process.js must win).
 */
function hostileConfig(dir) {
  const cfg = {
    'color.ui': 'always', 'color.diff': 'always', 'color.status': 'always', 'color.branch': 'always',
    'diff.context': '5', 'diff.interHunkContext': '10', 'diff.noprefix': 'true', 'diff.mnemonicPrefix': 'true',
    'diff.renames': 'false', 'diff.external': 'false', 'status.relativePaths': 'true', 'status.short': 'true',
    'core.quotePath': 'true', 'log.showSignature': 'true', 'merge.ff': 'false', 'pull.rebase': 'true',
    'rebase.autoStash': 'true', 'commit.cleanup': 'verbatim', 'commit.verbose': 'true',
    'push.default': 'nothing', 'stash.showPatch': 'true', 'advice.detachedHead': 'true',
    // Rebase / merge (docs/plans/rebase.md §9): the -c overrides and explicit flags must win.
    'rebase.autoSquash': 'true', 'rebase.updateRefs': 'true', 'rebase.missingCommitsCheck': 'ignore',
    'rebase.abbreviateCommands': 'true', 'rebase.instructionFormat': '%an', 'rebase.backend': 'apply',
    'sequence.editor': 'false', 'core.editor': 'false', 'core.commentChar': ';', 'merge.conflictStyle': 'zdiff3',
  };
  for (const [k, v] of Object.entries(cfg)) git(dir, 'config', k, v);
}

const slashes = (p) => p.replace(/\\/g, '/');
const FAKE_SSH = path.join(__dirname, 'fixtures', 'fake-ssh.js');

/**
 * Run git's ssh as the fake ssh (test/fixtures/fake-ssh.js) in `mode` for test `t`, its variables
 * restored afterwards. `env`: more FAKE_SSH_* variables. `repo`: the repository `serve` serves,
 * passed as FAKE_SSH_REPO on Windows (MSYS sh may convert the path in git's command; elsewhere the
 * fake reads git's command). GIT_SSH_VARIANT=ssh: 'simple' (git's guess for an unknown command)
 * refuses ssh://host:port.
 */
function fakeSsh(t, mode, { env = {}, repo } = {}) {
  const vars = {
    GIT_SSH_COMMAND: `"${slashes(process.execPath)}" "${slashes(FAKE_SSH)}"`,
    GIT_SSH_VARIANT: 'ssh',
    FAKE_SSH_MODE: mode,
    ...(repo && process.platform === 'win32' ? { FAKE_SSH_REPO: repo } : {}),
    ...env,
  };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/**
 * Windows: which of the processes `pids` name run now, each as its identity `pid|image|start`
 * (Get-Process: the image name and the start time, no command lines). A pid alone doesn't name a
 * process: Windows hands a freed pid to the next process (under load another test's sleep had it
 * within 300 ms), and process.kill(pid, 0) ignores a pid's lowest two bits, so it answers for a
 * neighbour too. A process that got the pid later has another start time. `end`: identities to end
 * if they still run (in the same PowerShell, so never a process that got the pid meanwhile).
 */
function winProcesses(pids, end = []) {
  if (!pids.length) return [];
  const { system32 } = require('../src/which');
  const script = [
    `$end = @(${end.map((id) => `'${id}'`).join(', ')})`,
    `Get-Process -Id ${pids.map(Number).join(', ')} -ErrorAction SilentlyContinue | ForEach-Object {`,
    '  $start = 0; try { $start = $_.StartTime.ToFileTimeUtc() } catch {}',
    '  $id = \'{0}|{1}|{2}\' -f $_.Id, $_.ProcessName, $start',
    '  if ($end -contains $id) { try { $_.Kill() } catch {} } else { $id }',
    '}',
    'exit 0',
  ].join('\n');
  const ps = path.win32.join(system32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
  return out.split(/\r?\n/).filter(Boolean);
}
/** Windows: the identities among `ids` (winProcesses) whose process still runs. */
const stillRunning = (ids) => {
  const now = winProcesses(ids.map((id) => id.split('|')[0]));
  return ids.filter((id) => now.includes(id));
};
/**
 * Windows: the identities among `ids` that still run once the cancel settled. A killed process
 * ends a moment after TerminateProcess returns (seen 0-1 ms after the settle), so a few looks
 * within `ms`, which is far shorter than any sleep the test started.
 */
async function runningAfterKill(ids, ms = 2000) {
  for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 100))) {
    const left = stillRunning(ids);
    if (!left.length || Date.now() - t0 >= ms) return left;
  }
}

function cleanup() {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}
process.on('exit', cleanup);

module.exports = {
  tmpDir, globalConfig, git, initRepo, write, read, commitFile, repoWithRemote, bareWithWorktree, hostileConfig, cleanup,
  fakeSsh, winProcesses, stillRunning, runningAfterKill,
};
