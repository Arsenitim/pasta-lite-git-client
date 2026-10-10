'use strict';
// Remote ops over ssh with real git and a fake ssh (test/fixtures/fake-ssh.js, GIT_SSH_COMMAND):
// what fetch, pull, push and clone make of ssh's failures (docs/plans/ssh-remote-errors.md §7.2).
// The remotes are scp-like, fake.invalid:<a local bare repository>: nothing resolves the host and
// no test touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const h = require('./helpers');
const remote = require('../src/remote');
const { pull } = require('../src/pull');
const { cloneRepo } = require('../src/clone');

const FAKE_SSH = path.join(__dirname, 'fixtures', 'fake-ssh.js');
const slashes = (p) => p.replace(/\\/g, '/');

/**
 * Run git's ssh as the fake in `mode` for test `t` (its variables restored afterwards). `env`: more
 * FAKE_SSH_* variables. `repo`: the repository `serve` serves, passed as FAKE_SSH_REPO on Windows
 * (MSYS sh may convert the path in git's command; elsewhere the fake reads git's command).
 */
function fakeSsh(t, mode, { env = {}, repo } = {}) {
  const vars = {
    GIT_SSH_COMMAND: `"${slashes(process.execPath)}" "${slashes(FAKE_SSH)}"`,
    GIT_SSH_VARIANT: 'ssh', // 'simple' (git's guess for an unknown command) refuses ssh://host:port
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

/** A bare repository and a clone of it whose origin is the bare one over (fake) ssh: {remote, local, seed, url}. */
function sshRepo() {
  const r = h.repoWithRemote();
  const url = `fake.invalid:${slashes(r.remote)}`;
  h.git(r.local, 'remote', 'set-url', 'origin', url);
  return { ...r, url };
}

const failure = (p) => p.then(() => assert.fail('the op succeeded'), (e) => e);

// ---------------------------------------------------------------- S0: the fake itself

test('serve: fetch and push go through the fake ssh to the local repository', async (t) => {
  const r = sshRepo();
  fakeSsh(t, 'serve', { repo: r.remote });
  const sha = h.commitFile(r.seed, 'b.txt', 'b\n', 'second');
  h.git(r.seed, 'push', '-q', 'origin', 'main');
  await remote.fetch(r.local, { remote: 'origin', stallMs: 0 });
  assert.equal(h.git(r.local, 'rev-parse', 'origin/main').trim(), sha);
  h.git(r.local, 'merge', '-q', '--ff-only', 'origin/main');
  const mine = h.commitFile(r.local, 'c.txt', 'c\n', 'third');
  const res = await remote.push(r.local, { branch: 'main', stallMs: 0 });
  assert.deepEqual(res, { remote: 'origin', branch: 'main', remoteBranch: 'main', forced: false });
  assert.equal(h.git(r.remote, 'rev-parse', 'main').trim(), mine);
});

test('deny: fetch fails with kind auth, at once', async (t) => {
  const r = sshRepo();
  fakeSsh(t, 'deny');
  const t0 = Date.now();
  const err = await failure(remote.fetch(r.local, { remote: 'origin', stallMs: 0 }));
  assert.equal(err.kind, 'auth', err.message);
  assert.match(err.message, /^git@fake\.invalid: Permission denied \(publickey\)\./m);
  assert.ok(Date.now() - t0 < 30000);
});

// ---------------------------------------------------------------- S1: the same kinds on every remote op

// Each op of the app against sshRepo()'s `r`, with the stall timer off (S1 is ssh exiting at once).
const OPS = {
  fetch: (r) => remote.fetch(r.local, { remote: 'origin', stallMs: 0 }),
  pull: (r) => pull(r.local, { mode: 'ff-only', stallMs: 0 }),
  push: (r) => remote.push(r.local, { branch: 'main', stallMs: 0 }),
  clone: (r) => cloneRepo({ source: r.url, parent: h.tmpDir(), name: 'c', stallMs: 0 }),
};

for (const [mode, kind] of [['deny', 'auth'], ['hostkey', 'host-key'], ['changed', 'host-key'], ['unreachable', 'unreachable'], ['too-many', 'auth'], ['not-found', 'not-found']]) {
  test(`${mode}: fetch, pull, push and clone all fail with kind ${kind}`, async (t) => {
    fakeSsh(t, mode);
    for (const [op, run] of Object.entries(OPS)) {
      const r = sshRepo();
      const err = await failure(run(r));
      assert.equal(err.kind, kind, `${op}: ${err.message}`);
      if (op === 'clone') {
        assert.ok(err.made, 'clone: the folder it made, for the cleanup');
      } else {
        assert.equal(err.remote, 'origin', `${op} names the remote`);
      }
      if (mode === 'changed') {
        assert.equal(err.ssh.changed, true, op);
        assert.match(err.ssh.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/, op);
      }
      if (op !== 'clone' && (kind === 'auth' || kind === 'host-key')) {
        assert.equal(err.ssh.host, 'fake.invalid', `${op}: the URL's host`);
        assert.equal(err.ssh.port, undefined);
      }
      if (op !== 'clone' && kind !== 'auth' && kind !== 'host-key') assert.equal(err.ssh, undefined, op);
      if (mode === 'deny' && op !== 'clone') assert.deepEqual(err.ssh, { host: 'fake.invalid', user: 'git' }, op);
    }
  });
}

test('Fetch All: the error names the remote that failed, after the ones fetched before it', async (t) => {
  const r = sshRepo();
  h.git(r.local, 'remote', 'add', 'aaa', r.remote); // a local path: fetched without ssh
  fakeSsh(t, 'deny');
  const err = await failure(remote.fetch(r.local, { stallMs: 0 }));
  assert.equal(err.kind, 'auth');
  assert.equal(err.remote, 'origin');
  assert.ok(h.git(r.local, 'rev-parse', 'refs/remotes/aaa/main').trim(), 'aaa was fetched first');
});

test('sshTarget: an alias keeps its name in the command and ssh\'s resolved host is shown as text only', async (t) => {
  const r = sshRepo();
  h.git(r.local, 'remote', 'set-url', 'origin', `git@fake-alias:${slashes(r.remote)}`);
  fakeSsh(t, 'deny', { env: { FAKE_SSH_WHO: 'git@192.0.2.7' } });
  const err = await failure(OPS.fetch(r));
  assert.deepEqual(err.ssh, { host: 'fake-alias', user: 'git', shownAs: '192.0.2.7' });
});

test('sshTarget: the port of an ssh:// remote; ssh\'s own user (a User from ~/.ssh/config) over the URL\'s', async (t) => {
  const r = sshRepo();
  h.git(r.local, 'remote', 'set-url', 'origin', `ssh://git@fake.invalid:2222/${slashes(r.remote).replace(/^\//, '')}`);
  fakeSsh(t, 'deny', { env: { FAKE_SSH_WHO: 'deploy@fake.invalid' } });
  const err = await failure(OPS.push(r));
  assert.equal(err.kind, 'auth');
  assert.deepEqual(err.ssh, { host: 'fake.invalid', port: 2222, user: 'deploy' });
});

test('sshTarget: a token-shaped user in ssh\'s line is never used: the URL\'s user instead', async (t) => {
  const r = sshRepo();
  h.git(r.local, 'remote', 'set-url', 'origin', `git@fake.invalid:${slashes(r.remote)}`);
  const tokenish = ['gh', 'o_', 'Zq9'.repeat(10)].join(''); // built from parts, never written out
  fakeSsh(t, 'deny', { env: { FAKE_SSH_WHO: `${tokenish}@fake.invalid` } });
  const err = await failure(OPS.fetch(r));
  assert.deepEqual(err.ssh, { host: 'fake.invalid', user: 'git' });
  assert.ok(!JSON.stringify(err.ssh).includes(tokenish));
});

test('sshTarget: an insteadOf rewrite: the host git connected to, not the one configured', async (t) => {
  const r = sshRepo();
  h.git(r.local, 'config', 'url.git@rewritten.invalid:.insteadOf', 'short:');
  h.git(r.local, 'remote', 'set-url', 'origin', `short:${slashes(r.remote)}`);
  fakeSsh(t, 'deny');
  const err = await failure(OPS.fetch(r));
  assert.equal(err.ssh.host, 'rewritten.invalid');
  assert.equal(err.ssh.shownAs, 'fake.invalid', 'what ssh said, as text');
});

test('sshTarget: a remote with two push URLs has no host (the failing one can\'t be told); git stopped at the first', async (t) => {
  const r = sshRepo();
  const second = h.initRepo({ bare: true });
  const log = path.join(h.tmpDir(), 'ssh.log');
  h.git(r.local, 'remote', 'set-url', '--add', '--push', 'origin', r.url);
  h.git(r.local, 'remote', 'set-url', '--add', '--push', 'origin', `fake.invalid:${slashes(second)}`);
  fakeSsh(t, 'deny', { env: { FAKE_SSH_LOG: log } });
  const err = await failure(OPS.push(r));
  assert.equal(err.kind, 'auth');
  assert.equal(err.ssh.host, undefined);
  assert.equal(err.ssh.user, 'git');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'ssh ran once: git never tried the second URL (V11)');
  assert.equal(h.git(second, 'for-each-ref').trim(), '', 'the second repository is unchanged');
});

test('an https remote\'s auth failure has no ssh target (its text stays the credential helper one)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="pl-test"' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const r = h.repoWithRemote();
    h.git(r.local, 'remote', 'set-url', 'origin', `http://127.0.0.1:${server.address().port}/r.git`);
    const err = await failure(remote.fetch(r.local, { remote: 'origin', stallMs: 0 }));
    assert.equal(err.kind, 'auth');
    assert.equal(err.ssh, undefined);
    assert.equal(err.remote, 'origin');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
