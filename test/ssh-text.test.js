'use strict';
// ssh's lines and the ssh target shown for a remote (src/ssh-text.js): the patterns against the
// lines ssh really prints (docs/plans/ssh-remote-errors.md §3.3, V1-V16, and the Windows QA), what
// sshFacts reads from them, and the shell-safe split of a configured remote's URL. Pure: no git runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SSH_LINES, SSH_ENDINGS, TOO_MANY, sshFacts, splitRemote, sshCommand, asciiHost } = require('../src/ssh-text');

const SRC = path.join(__dirname, '..', 'src', 'ssh-text.js');
const kindOf = (line) => ['auth', 'host-key', 'unreachable'].find((k) => SSH_LINES[k].some((re) => re.test(line))) || null;
const ending = (line) => SSH_ENDINGS.some((re) => re.test(line));
// A fingerprint's shape (43 base64 characters), built here rather than written out.
const FP = `SHA256:${'Ab3+/'.repeat(9).slice(0, 43)}`;

// V9: a changed host key (OpenSSH 9.9), with the '\r' Windows writes.
const CHANGED = [
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
  'The fingerprint for the ED25519 key sent by the remote host is',
  `${FP}.`,
  'Please contact your system administrator.',
  'Offending ED25519 key in /home/u/.ssh/known_hosts:1',
  'Host key for [127.0.0.1]:22222 has changed and you have requested strict checking.',
  'Host key verification failed.',
  'fatal: Could not read from remote repository.',
];

test('SSH_LINES: each kind matches the line ssh prints, with or without Windows\' \\r', () => {
  const cases = [
    ['az@127.0.0.1: Permission denied (publickey).', 'auth'], // V1
    ['git@github.com: Permission denied (publickey).', 'auth'], // Windows QA
    ['git@github.com: Permission denied (publickey,keyboard-interactive).', 'auth'],
    ['deploy@h: Permission denied (password)', 'auth'],
    ['Received disconnect from 192.0.2.1 port 22:2: Too many authentication failures', 'auth'],
    ['Host key verification failed.', 'host-key'], // V2
    ['No ED25519 host key is known for [127.0.0.1]:22222 and you have requested strict checking.', 'host-key'], // V8
    ['ssh: Could not resolve hostname nohost: nodename nor servname provided, or not known', 'unreachable'],
    ['ssh: connect to host h port 22: Connection refused', 'unreachable'],
    ['ssh: connect to host h port 22: Operation timed out', 'unreachable'],
    ['ssh: connect to host h port 22: Connection timed out', 'unreachable'],
    ['ssh: connect to host h port 22: Network is unreachable', 'unreachable'],
    ['ssh: connect to host 10.0.0.9 port 22: No route to host', 'unreachable'],
    ['ssh: connect to host 10.0.0.9 port 22: Host is down', 'unreachable'],
  ];
  for (const [line, kind] of cases) {
    assert.equal(kindOf(line), kind, line);
    assert.equal(kindOf(`${line}\r`), kind, `${line} + \\r`);
    assert.equal(kindOf(`warning: x\n${line}\r\nfatal: Could not read from remote repository.`), kind, `${line} among other lines`);
  }
  assert.ok(SSH_LINES.changed.some((re) => re.test(CHANGED[1])));
  assert.ok(SSH_LINES.changed.some((re) => re.test(CHANGED[8])));
  assert.ok(TOO_MANY.test(cases[4][0]));
  assert.ok(Object.isFrozen(SSH_LINES) && Object.isFrozen(SSH_LINES.auth) && Object.isFrozen(SSH_ENDINGS));
});

test('SSH_LINES: lookalikes don\'t match (git\'s own errors, a server\'s remote: text, a ref name mid-line)', () => {
  for (const line of [
    "error: unable to create 'x': Permission denied",
    'remote: Permission denied (publickey)',
    'Permission denied (publickey).',
    'git@github.com: Permission denied (publickey). and more',
    "error: pathspec 'Host key verification failed' did not match",
    "hint: branch 'ssh: connect to host h port 22: Connection refused'",
    'fatal: Could not read from remote repository.',
  ]) {
    assert.equal(kindOf(line), null, line);
  }
});

test('SSH_ENDINGS: every SSH_LINES pattern, and the endings that classify to nothing', () => {
  for (const re of Object.values(SSH_LINES).flat()) assert.ok(SSH_ENDINGS.includes(re), String(re));
  for (const line of [
    'kex_exchange_identification: read: Connection reset by peer',
    'kex_exchange_identification: Connection closed by remote host',
    'Connection closed by UNKNOWN port 65535',
    'Connection closed by 192.0.2.1 port 22',
    'Connection reset by 192.0.2.1 port 22',
    'Unable to negotiate with 192.0.2.1 port 22: no matching host key type found. Their offer: ssh-rsa',
    'Received disconnect from 192.0.2.1 port 22:11: Bye',
    'ssh: connect to host h port 22: No route to host',
    'ssh: connect to host h port 22: Host is down',
    'ssh: Could not resolve hostname h: Name or service not known',
    'git@h: Permission denied (publickey).\r',
  ]) {
    assert.ok(ending(line), line);
  }
  for (const line of ['fatal: Could not read from remote repository.', 'remote: Counting objects: 3, done.', '', 'Please make sure you have the correct access rights']) {
    assert.equal(ending(line), false, line);
  }
});

test('sshFacts: the last ssh line wins; its user@host; a changed key with its fingerprint; null for none', () => {
  assert.deepEqual(sshFacts(['az@127.0.0.1: Permission denied (publickey).', 'fatal: Could not read from remote repository.']),
    { kind: 'auth', line: 'az@127.0.0.1: Permission denied (publickey).', user: 'az', host: '127.0.0.1', changed: false, fingerprint: null });
  // V16: an alias resolved by ssh (the line names the HostName, no port).
  assert.equal(sshFacts(['az@127.0.0.1: Permission denied (publickey).\r']).line, 'az@127.0.0.1: Permission denied (publickey).', 'no \\r');
  // V8: two host-key lines, the last one counts.
  const v8 = sshFacts(['No ED25519 host key is known for [127.0.0.1]:22222 and you have requested strict checking.', 'Host key verification failed.']);
  assert.deepEqual(v8, { kind: 'host-key', line: 'Host key verification failed.', user: null, host: null, changed: false, fingerprint: null });
  // V9: changed, with the fingerprint, also with '\r\n' line ends.
  for (const lines of [CHANGED, CHANGED.map((l) => `${l}\r`)]) {
    const f = sshFacts(lines);
    assert.equal(f.kind, 'host-key');
    assert.equal(f.changed, true);
    assert.equal(f.fingerprint, FP);
  }
  // A fingerprint line that isn't one is not taken.
  const odd = CHANGED.map((l) => (l.startsWith('SHA256:') ? 'SHA256:short' : l));
  assert.equal(sshFacts(odd).fingerprint, null);
  // ProxyJump: the jump host's refusal, then the outer ssh's ending: the refusal is the last ssh line of a kind.
  assert.equal(sshFacts(['git@jump.invalid: Permission denied (publickey).', 'Connection closed by UNKNOWN port 65535']).host, 'jump.invalid');
  // A user with '@' in it: split at the last one.
  assert.deepEqual([sshFacts(['a@b@h: Permission denied (publickey).']).user, sshFacts(['a@b@h: Permission denied (publickey).']).host], ['a@b', 'h']);
  assert.equal(sshFacts(['fatal: Authentication failed for x']), null);
  assert.equal(sshFacts([]), null);
  assert.equal(sshFacts(undefined), null);
  assert.equal(sshFacts(['Received disconnect from 192.0.2.1 port 22:2: Too many authentication failures']).user, null);
});

test('splitRemote: ssh URLs and scp-like remotes as configured, leniently; null for anything it can\'t show safely', () => {
  const ok = [
    ['github-work:o/r.git', { host: 'github-work', port: null, user: null }],
    ['git@github_work:o/r.git', { host: 'github_work', port: null, user: 'git' }], // refused by parseCloneUrl (V18)
    ['ssh://deploy+ci@host:2222/r', { host: 'host', port: 2222, user: 'deploy+ci' }], // refused by parseCloneUrl (V18)
    ['ssh://git@h/r', { host: 'h', port: null, user: 'git' }],
    ['git+ssh://git@h:22/r', { host: 'h', port: 22, user: 'git' }],
    ['ssh+git://h/r', { host: 'h', port: null, user: null }],
    ['SSH://h:/r', { host: 'h', port: null, user: null }],
    ['git@[::1]:r', { host: '[::1]', port: null, user: 'git' }],
    ['ssh://git@[::1]:2222/r', { host: '[::1]', port: 2222, user: 'git' }],
    ['fake.invalid:C:/Users/x/r.git', { host: 'fake.invalid', port: null, user: null }],
    ['192.0.2.7:/srv/r.git', { host: '192.0.2.7', port: null, user: null }],
  ];
  for (const [url, want] of ok) assert.deepEqual(splitRemote(url), want, url);
  for (const url of [
    'https://github.com/o/r.git', 'http://h/r', 'git://h/r', 'file:///r', '/path/r.git', 'C:/path', 'C:\\path', 'r',
    '-oProxyCommand@h:r', 'h$(id):r', 'ssh://h$(id)/r', 'ssh://-oProxyCommand=x/r', 'ssh://h:0/r', 'ssh://h:70000/r',
    'ssh://h:2x/r', 'a b:r', '', null, 'git@[::1;id]:r', `${'u'.repeat(65)}@h:r`,
  ]) {
    assert.equal(splitRemote(url), null, String(url));
  }
});

test('sshCommand: with and without port and user; an IPv6 host without its brackets', () => {
  assert.equal(sshCommand({ host: 'github.com', user: 'git' }), 'ssh -T git@github.com');
  assert.equal(sshCommand({ host: 'h', port: 2222, user: 'deploy' }), 'ssh -T -p 2222 deploy@h');
  assert.equal(sshCommand({ host: 'github-work' }), 'ssh -T github-work');
  assert.equal(sshCommand({ host: '[::1]', port: 22, user: 'git' }), 'ssh -T -p 22 git@::1');
});

test('asciiHost: an IDN host in its punycode form; ASCII hosts and the unreadable as they are', () => {
  assert.equal(asciiHost('bücher.example'), 'xn--bcher-kva.example');
  const lookalike = asciiHost('g\u0456thub.com'); // a Cyrillic і, no Latin i
  assert.match(lookalike, /^xn--g[a-z]*-[a-z0-9]+\.com$/);
  assert.notEqual(lookalike, 'github.com');
  assert.equal(asciiHost('github.com'), 'github.com');
  assert.equal(asciiHost('[::1]'), '[::1]');
  assert.equal(asciiHost(''), '');
});

test('the module requires nothing, and works as a plain browser script', () => {
  const before = new Set(Object.keys(require.cache));
  delete require.cache[require.resolve(SRC)];
  require(SRC);
  assert.deepEqual(Object.keys(require.cache).filter((k) => !before.has(k)), [], 'no module loaded besides itself');
  const vm = require('node:vm');
  const window = {};
  vm.runInNewContext(fs.readFileSync(SRC, 'utf8'), { window, URL });
  assert.equal(window.PLSshText.sshCommand({ host: 'h', user: 'git' }), 'ssh -T git@h');
  assert.equal(window.PLSshText.sshFacts(['Host key verification failed.']).kind, 'host-key');
});
