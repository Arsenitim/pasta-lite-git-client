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

const { slashes, fakeSsh, printedAt } = h;

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
  assert.equal(err.ssh.user, undefined, 'no URL to check ssh\'s user against');
  assert.equal(err.ssh.shownAs, 'fake.invalid');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'ssh ran once: git never tried the second URL (V11)');
  assert.equal(h.git(second, 'for-each-ref').trim(), '', 'the second repository is unchanged');
});

test('sshTarget: a fetch uses the remote\'s first URL, as git does (several remote.<r>.url values)', async (t) => {
  const r = sshRepo();
  h.git(r.local, 'remote', 'set-url', '--add', 'origin', `git@second.invalid:${slashes(r.remote)}`);
  fakeSsh(t, 'deny');
  const err = await failure(OPS.fetch(r));
  assert.deepEqual(err.ssh, { host: 'fake.invalid', user: 'git' });
});

test('sshTarget: ssh\'s user counts only for the URL\'s own host (ProxyJump: the jump host\'s refusal)', async (t) => {
  const r = sshRepo();
  fakeSsh(t, 'deny', { env: { FAKE_SSH_WHO: 'jumper@jump.invalid' } });
  const err = await failure(OPS.fetch(r));
  assert.deepEqual(err.ssh, { host: 'fake.invalid', shownAs: 'jump.invalid' });
});

test('a changed host key of an alias with a port: the known_hosts name ssh printed, for ssh-keygen -R (fetch, push and clone)', async (t) => {
  fakeSsh(t, 'changed', { env: { FAKE_SSH_KEYNAME: '[192.0.2.7]:2222' } });
  for (const [op, run] of Object.entries(OPS)) {
    const r = sshRepo();
    h.git(r.local, 'remote', 'set-url', 'origin', `git@fake-alias:${slashes(r.remote)}`);
    const err = await failure(run(r));
    assert.equal(err.kind, 'host-key', op);
    assert.equal(err.ssh.changed, true, op);
    assert.equal(err.ssh.keyName, '[192.0.2.7]:2222', op);
    if (op !== 'clone') assert.equal(err.ssh.host, 'fake-alias', `${op}: the command keeps the alias`);
  }
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

// ---------------------------------------------------------------- S2: the stall watchdog and what ssh said

const outFile = () => path.join(h.tmpDir(), 'out.json');
// The slack of the Windows cancel test (test/exec.test.js): a hard kill settles well within it.
const SLACK = 10000;

for (const [mode, kind] of [['deny-hang', 'auth'], ['hostkey-hang', 'host-key'], ['unreachable-hang', 'unreachable'], ['changed-hang', 'host-key'], ['kex-hang', undefined], ['proxyjump-hang', 'auth']]) {
  test(`${mode}: the watchdog ends git ${500} ms after ssh's last ending: kind ${kind || 'none'}, stalled, git's text`, async (t) => {
    const out = outFile();
    fakeSsh(t, mode, { env: { FAKE_SSH_OUT: out } });
    const r = sshRepo();
    const err = await failure(remote.fetch(r.local, { remote: 'origin', stallMs: 500 }));
    const settled = Date.now();
    const at = await printedAt(out);
    assert.equal(err.kind, kind, err.message);
    assert.equal(err.stalled, true);
    assert.equal(err.remote, 'origin');
    // FAKE_SSH_OUT is written once the lines are out, a moment after git may have read them.
    assert.ok(settled - at >= 300, `not before the silence: ${settled - at} ms`);
    assert.ok(settled - at < 500 + SLACK, `${settled - at} ms`);
    assert.doesNotMatch(err.message, /git was cancelled/);
    if (mode === 'kex-hang') assert.match(err.message, /^kex_exchange_identification: read: Connection reset by peer$/m);
    if (mode === 'proxyjump-hang') {
      assert.match(err.message, /Connection closed by UNKNOWN port 65535/, 're-armed by the outer ending: fired after it');
      assert.equal(err.ssh.shownAs, 'jump.invalid');
      assert.equal(err.ssh.user, undefined, 'the jump host\'s user is no target\'s');
    }
    if (mode === 'changed-hang') assert.equal(err.ssh.changed, true);
  });
}

test('pull and push forward stallMs: a hanging ssh ends as auth, stalled', async (t) => {
  fakeSsh(t, 'deny-hang');
  const r = sshRepo();
  const p = await failure(pull(r.local, { mode: 'ff-only', stallMs: 500 }));
  assert.deepEqual([p.kind, p.stalled, p.remote], ['auth', true, 'origin']);
  const q = await failure(remote.push(sshRepo().local, { branch: 'main', stallMs: 500 }));
  assert.deepEqual([q.kind, q.stalled, q.remote], ['auth', true, 'origin']);
  assert.equal(q.ssh.host, 'fake.invalid');
});

test('a user\'s cancel after ssh\'s line (timer off): aborted, with what ssh said and its target', async (t) => {
  const out = outFile();
  fakeSsh(t, 'deny-hang', { env: { FAKE_SSH_OUT: out } });
  for (const op of ['fetch', 'push']) {
    if (fs.existsSync(out)) fs.rmSync(out);
    const r = sshRepo();
    const ac = new AbortController();
    const p = op === 'fetch'
      ? remote.fetch(r.local, { remote: 'origin', signal: ac.signal, stallMs: 0 })
      : remote.push(r.local, { branch: 'main', signal: ac.signal, stallMs: 0 });
    await printedAt(out);
    ac.abort();
    const err = await failure(p);
    assert.equal(err.kind, 'aborted', op);
    assert.equal(err.message, 'git was cancelled');
    assert.deepEqual(err.said, { kind: 'auth', line: 'git@fake.invalid: Permission denied (publickey).' }, op);
    assert.deepEqual(err.ssh, { host: 'fake.invalid', user: 'git' }, op);
    assert.equal(err.stalled, undefined);
  }
});

test('a cancel with nothing printed (the prompt hang): aborted, no said', async (t) => {
  const out = outFile();
  fakeSsh(t, 'silent-hang', { env: { FAKE_SSH_OUT: out } });
  const r = sshRepo();
  const ac = new AbortController();
  const p = remote.fetch(r.local, { remote: 'origin', signal: ac.signal, stallMs: 500 });
  await printedAt(out);
  await new Promise((resolve) => setTimeout(resolve, 700)); // past stallMs: silence alone never fires
  ac.abort();
  const err = await failure(p);
  assert.equal(err.kind, 'aborted');
  assert.equal(err.said, undefined);
  assert.equal(err.ssh, undefined);
});

test('said is redacted: a token-shaped user in ssh\'s line is masked', async (t) => {
  const out = outFile();
  const tokenish = ['gh', 'p_', 'Ab12'.repeat(8)].join(''); // built from parts, never written out
  fakeSsh(t, 'deny-hang', { env: { FAKE_SSH_OUT: out, FAKE_SSH_WHO: `${tokenish}@fake.invalid` } });
  const r = sshRepo();
  const ac = new AbortController();
  const p = remote.fetch(r.local, { remote: 'origin', signal: ac.signal, stallMs: 0 });
  await printedAt(out);
  ac.abort();
  const err = await failure(p);
  assert.equal(err.said.kind, 'auth');
  assert.ok(!err.said.line.includes(tokenish), err.said.line);
  assert.match(err.said.line, /\*\*\*@fake\.invalid: Permission denied/);
  assert.equal(err.ssh.user, undefined, 'and never the user of the command');
});

test('no false kill: a wrapper that retries and succeeds within the window; a pre-push hook that prints ssh\'s line and goes on', async (t) => {
  const r = sshRepo();
  fakeSsh(t, 'deny-then-serve', { repo: r.remote, env: { FAKE_SSH_DELAY: '200' } });
  const sha = h.commitFile(r.seed, 'b.txt', 'b\n', 'second');
  h.git(r.seed, 'push', '-q', 'origin', 'main');
  await remote.fetch(r.local, { remote: 'origin', stallMs: 2000 });
  assert.equal(h.git(r.local, 'rev-parse', 'origin/main').trim(), sha);
  h.git(r.local, 'merge', '-q', '--ff-only', 'origin/main');
  const mine = h.commitFile(r.local, 'c.txt', 'c\n', 'third');
  await remote.push(r.local, { branch: 'main', stallMs: 2000 });
  assert.equal(h.git(r.remote, 'rev-parse', 'main').trim(), mine);
  // A hook that prints ssh's exact line, then works on for a second: shorter than the window.
  process.env.FAKE_SSH_MODE = 'serve';
  h.write(r.local, '.git/hooks/pre-push', '#!/bin/sh\necho "git@fake.invalid: Permission denied (publickey)." >&2\nsleep 1\nexit 0\n');
  fs.chmodSync(path.join(r.local, '.git', 'hooks', 'pre-push'), 0o755);
  const again = h.commitFile(r.local, 'd.txt', 'd\n', 'fourth');
  await remote.push(r.local, { branch: 'main', stallMs: 3000 });
  assert.equal(h.git(r.remote, 'rev-parse', 'main').trim(), again);
});

test('W8: ssh passes only the "@@@" frame of its changed-key warning and hangs (Windows\' OpenSSH): fetch, pull, push and clone end as host-key, changed, bannerOnly', async (t) => {
  fakeSsh(t, 'banner-hang');
  for (const [op, run] of Object.entries({
    fetch: (r) => remote.fetch(r.local, { remote: 'origin', stallMs: 500 }),
    pull: (r) => pull(r.local, { mode: 'ff-only', stallMs: 500 }),
    push: (r) => remote.push(r.local, { branch: 'main', stallMs: 500 }),
    clone: (r) => cloneRepo({ source: r.url, parent: h.tmpDir(), name: 'c', stallMs: 500 }),
  })) {
    const err = await failure(run(sshRepo()));
    assert.equal(err.kind, 'host-key', `${op}: ${err.message}`);
    assert.equal(err.stalled, true, op);
    assert.equal(err.ssh.changed, true, op);
    assert.equal(err.ssh.bannerOnly, true, op);
    assert.equal(err.ssh.fingerprint, undefined, `${op}: ssh said none`);
    assert.equal(err.ssh.keyName, undefined, op);
    assert.match(err.message, /^@{59}$/m, op);
    if (op !== 'clone') assert.equal(err.ssh.host, 'fake.invalid', `${op}: ssh-keygen -R falls back to the URL's host`);
  }
});

test('Windows: a stall ends git\'s whole tree, the hanging ssh included (as a cancel does)', { skip: process.platform !== 'win32' && 'Windows: taskkill /T of git\'s tree' }, async (t) => {
  const pidFile = path.join(h.tmpDir(), 'ssh.pid');
  const out = outFile();
  fakeSsh(t, 'deny-hang', { env: { FAKE_SSH_PID: pidFile, FAKE_SSH_OUT: out } });
  const r = sshRepo();
  // 5 s, not 1 s: the ssh is named (by pid, image and start time) while it surely runs, and
  // PowerShell takes a few seconds to start on a CI runner.
  const p = failure(remote.fetch(r.local, { remote: 'origin', stallMs: 5000 }));
  const at = await printedAt(out);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const ids = h.winProcesses([pid]);
  t.after(() => h.winProcesses([pid], ids)); // a failed assertion leaves nothing running
  assert.deepEqual(ids.map((id) => id.split('|').slice(0, 2).join('|')), [`${pid}|node`], 'the fake ssh runs, hanging');
  const err = await p;
  assert.equal(err.kind, 'auth', err.message);
  assert.equal(err.stalled, true);
  assert.ok(Date.now() - at < 5000 + SLACK);
  assert.deepEqual(await h.runningAfterKill(ids), [], 'the ssh is gone with git');
});

// ---------------------------------------------------------------- S3: Windows askpass (docs/plans/ssh-remote-errors.md §4.4)

test('askpass: ssh gets Git for Windows\' false.exe with force on Windows only; never on macOS / Linux', async (t) => {
  const r = sshRepo();
  const out = outFile();
  fakeSsh(t, 'env', { repo: r.remote, env: { FAKE_SSH_OUT: out } });
  for (const k of ['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE']) {
    const saved = process.env[k];
    delete process.env[k];
    t.after(() => { if (saved !== undefined) process.env[k] = saved; });
  }
  await remote.fetch(r.local, { remote: 'origin', stallMs: 0 });
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  if (process.platform === 'win32') {
    assert.match(seen.askpass, /^[A-Za-z]:\/.*\/usr\/bin\/false\.exe$/i, 'forward slashes');
    assert.equal(seen.askpassRequire, 'force');
  } else {
    assert.deepEqual(seen, { askpass: null, askpassRequire: null });
  }
});

test('askpass: the user\'s own SSH_ASKPASS reaches ssh as it is, with no force from us', async (t) => {
  const r = sshRepo();
  const out = outFile();
  fakeSsh(t, 'env', { repo: r.remote, env: { FAKE_SSH_OUT: out, SSH_ASKPASS: 'C:/tools/my-askpass.exe' } });
  const saved = process.env.SSH_ASKPASS_REQUIRE;
  delete process.env.SSH_ASKPASS_REQUIRE;
  t.after(() => { if (saved !== undefined) process.env.SSH_ASKPASS_REQUIRE = saved; });
  await remote.push(r.local, { branch: 'main', stallMs: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { askpass: 'C:/tools/my-askpass.exe', askpassRequire: null });
});

test('askpass: a commit\'s hook (not a remote op) never sees ours', async (t) => {
  const { run } = require('../src/exec');
  const dir = h.initRepo();
  const out = path.join(h.tmpDir(), 'hook.txt');
  for (const k of ['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE']) {
    const saved = process.env[k];
    delete process.env[k];
    t.after(() => { if (saved !== undefined) process.env[k] = saved; });
  }
  h.write(dir, '.git/hooks/pre-commit', `#!/bin/sh\nprintf '%s|%s' "\${SSH_ASKPASS:-none}" "\${SSH_ASKPASS_REQUIRE:-none}" > '${slashes(out)}'\n`);
  fs.chmodSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
  h.write(dir, 'x.txt', 'x\n');
  await run(dir, ['add', 'x.txt']);
  await run(dir, ['commit', '-q', '-m', 'x']);
  assert.equal(fs.readFileSync(out, 'utf8'), 'none|none');
});

test('Windows: false.exe runs the way ssh starts it (a prompt with spaces, quotes and newlines) and fails silently', { skip: process.platform !== 'win32' && 'Windows: Git for Windows\' false.exe' }, () => {
  const { execFileSync } = require('node:child_process');
  const { askpassEnv } = require('../src/ssh-env');
  const env = askpassEnv({ env: {} });
  assert.ok(env.SSH_ASKPASS, 'Git for Windows has a false.exe next to its sh.exe');
  let failed = null;
  try {
    execFileSync(env.SSH_ASKPASS, ["Enter passphrase for key 'C:\\Users\\a b\\.ssh\\id_ed25519':\n\"x\""], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
  } catch (e) {
    failed = e;
  }
  assert.ok(failed, 'it fails');
  assert.equal(failed.status, 1);
  assert.equal(String(failed.stdout), '');
  assert.equal(String(failed.stderr), '');
});
