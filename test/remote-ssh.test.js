'use strict';
// Remote ops over ssh with real git and a fake ssh (test/fixtures/fake-ssh.js, GIT_SSH_COMMAND):
// what fetch, pull, push and clone make of ssh's failures (docs/plans/ssh-remote-errors.md §7.2).
// The remotes are scp-like, fake.invalid:<a local bare repository>: nothing resolves the host and
// no test touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./helpers');
const remote = require('../src/remote');

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
