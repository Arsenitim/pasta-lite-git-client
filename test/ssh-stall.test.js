'use strict';
// The ssh stall watchdog (src/ssh-stall.js) with injected timers: how it splits git's stderr into
// lines, when it arms, re-arms, disarms and fires, and what it keeps. No git runs; the real thing
// against git and a fake ssh is test/remote-ssh.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSshWatch, defaultStallMs, STALL_MS, _internal: { MAX_LINES, MAX_LINE, MAX_TAIL, MAX_TEXT } } = require('../src/ssh-stall');

const DENY = 'git@h: Permission denied (publickey).';

/** A watch with fake timers: {w, timers (the armed ones), stalls (how often it fired), tick()}. */
function watch(stallMs = 500) {
  const timers = new Set();
  let stalls = 0;
  const w = createSshWatch({
    stallMs,
    onStall: () => { stalls++; },
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
  });
  const tick = () => {
    for (const t of [...timers]) {
      timers.delete(t);
      t.fn();
    }
  };
  return { w, timers, tick, stalls: () => stalls };
}
const feed = (w, ...chunks) => { for (const c of chunks) w.chunk(Buffer.from(c)); };

test('defaultStallMs: 10 s on Windows, no timer elsewhere', () => {
  assert.equal(STALL_MS, 10000);
  assert.equal(defaultStallMs('win32'), 10000);
  assert.equal(defaultStallMs('darwin'), 0);
  assert.equal(defaultStallMs('linux'), 0);
  assert.equal(defaultStallMs(), process.platform === 'win32' ? 10000 : 0);
});

test('lines: split across chunks, on \\n, \\r\\n and a lone \\r (progress frames); the incomplete tail waits', () => {
  const { w } = watch(0);
  feed(w, 'Cloning in', "to 'x'...\nremote: Counting: 1%\rremote: Counting: 100%\r", '\nfatal: a\r\nfatal: ', 'b');
  assert.deepEqual(w.lines(), ["Cloning into 'x'...", 'remote: Counting: 1%', 'remote: Counting: 100%', 'fatal: a']);
  feed(w, '\n');
  assert.deepEqual(w.lines().slice(-1), ['fatal: b']);
  assert.equal(w.text(), "Cloning into 'x'...\nremote: Counting: 1%\nremote: Counting: 100%\nfatal: a\nfatal: b");
});

test('a \\r\\n split between chunks is one line end: no empty line, no disarm', () => {
  const { w, timers } = watch();
  feed(w, `${DENY}\r`);
  assert.equal(timers.size, 0, 'the line is not complete before its \\n (or another byte) comes');
  feed(w, '\n');
  assert.equal(timers.size, 1, 'armed on the complete line');
  feed(w, '\r', '\n', '\r\n');
  assert.equal(timers.size, 1, 'empty lines never disarm');
  assert.deepEqual(w.lines(), [DENY]);
});

test('a multi-byte character split across chunks stays whole', () => {
  const { w } = watch(0);
  const bytes = Buffer.from('remote: café ✓\n');
  const cut = bytes.indexOf(Buffer.from('✓')) + 1; // inside the 3-byte character
  w.chunk(bytes.subarray(0, cut));
  w.chunk(bytes.subarray(cut));
  assert.deepEqual(w.lines(), ['remote: café ✓']);
});

test('the tail cap: an endless line without a line end keeps its first MAX_TAIL characters', () => {
  const { w } = watch(0);
  for (let i = 0; i < 10; i++) feed(w, 'x'.repeat(1000));
  feed(w, '\n');
  assert.equal(w.lines()[0].length, Math.min(MAX_TAIL, MAX_LINE));
  assert.equal(MAX_TAIL, 4096);
});

test('arms on an ending, re-arms on a second (ProxyJump), and a non-ending line disarms', () => {
  const { w, timers, tick, stalls } = watch(500);
  feed(w, 'warning: something\n');
  assert.equal(timers.size, 0, 'not an ending');
  feed(w, 'git@jump.invalid: Permission denied (publickey).\r\n');
  const first = [...timers][0];
  assert.equal(first.ms, 500);
  feed(w, 'Connection closed by UNKNOWN port 65535\r\n');
  assert.equal(timers.size, 1);
  assert.notEqual([...timers][0], first, 're-armed: a new timer for the later ending');
  feed(w, 'remote: Enumerating objects: 3, done.\n');
  assert.equal(timers.size, 0, 'something else came: ssh went on');
  feed(w, 'kex_exchange_identification: read: Connection reset by peer\n');
  tick();
  assert.equal(stalls(), 1);
  assert.equal(w.fired, true);
  feed(w, `${DENY}\n`);
  tick();
  assert.equal(stalls(), 1, 'fires once');
  assert.equal(timers.size, 0, 'never armed again');
});

test('stop(): no timer once git exited; a listener that throws is ignored', () => {
  const { w, timers, stalls } = watch();
  feed(w, `${DENY}\n`);
  assert.equal(timers.size, 1);
  w.stop();
  assert.equal(timers.size, 0);
  feed(w, `${DENY}\n`);
  assert.equal(timers.size, 0);
  assert.equal(stalls(), 0);
  assert.equal(w.fired, false);
  const boom = createSshWatch({ stallMs: 1, onStall: () => { throw new Error('bug'); }, setTimer: (fn) => { fn(); return 1; }, clearTimer: () => {} });
  assert.doesNotThrow(() => boom.chunk(Buffer.from(`${DENY}\n`)));
  assert.equal(boom.fired, true);
});

test('stallMs 0: never arms, still collects (what ssh said before a cancel)', () => {
  const { w, timers } = watch(0);
  feed(w, `${DENY}\n`, 'fatal: Could not read from remote repository.\n');
  assert.equal(timers.size, 0);
  assert.deepEqual(w.lines(), [DENY, 'fatal: Could not read from remote repository.']);
});

test('lines() keeps the last MAX_LINES, each cut to MAX_LINE; text() at most MAX_TEXT (the last part)', () => {
  const { w } = watch(0);
  for (let i = 0; i < MAX_LINES + 10; i++) feed(w, `${i}:${'y'.repeat(MAX_LINE + 50)}\n`);
  const lines = w.lines();
  assert.equal(lines.length, MAX_LINES);
  assert.ok(lines[0].startsWith('10:'));
  assert.ok(lines.every((l) => l.length === MAX_LINE));
  assert.equal(w.text().length, MAX_TEXT);
  assert.ok(w.text().endsWith('y'));
  lines.push('mutated');
  assert.equal(w.lines().length, MAX_LINES, 'a copy');
});

test('a real timer fires after stallMs of silence', async () => {
  let fired = 0;
  const w = createSshWatch({ stallMs: 30, onStall: () => { fired++; } });
  w.chunk(Buffer.from(`${DENY}\n`));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fired, 1);
  w.stop();
});

test('saidOf: ssh\'s line as a cancel carries it: no invisible characters, a token-shaped user and the home folder masked, bounded', (t) => {
  const { saidOf, _internal: { SAID_MAX } } = require('../src/ssh-stall');
  const redact = require('../src/redact');
  redact._internal.setHome('/Users/ada');
  t.after(() => redact._internal.setHome());
  const tokenish = ['gh', 'p_', 'Xy34'.repeat(8)].join(''); // built from parts, never written out
  const said = saidOf({ kind: 'auth', line: `${tokenish}@h‮: Permission denied (publickey). /Users/ada/.ssh/id_ed25519` });
  assert.equal(said.kind, 'auth');
  assert.equal(said.line, '***@h: Permission denied (publickey). ~/.ssh/id_ed25519');
  assert.ok(saidOf({ kind: 'auth', line: 'x'.repeat(2000) }).line.length < SAID_MAX + 20);
  assert.equal(SAID_MAX, 300);
});

test('signalFor: with a timer, the op\'s signal and the watch\'s abort combined; without one, the op\'s signal as it is', () => {
  const op = new AbortController();
  const off = createSshWatch({ stallMs: 0 });
  assert.equal(off.signalFor(op.signal), op.signal);
  assert.equal(off.signalFor(undefined), undefined, 'no signal: the ambient one applies (spawnGit)');
  let fire = null;
  const on = createSshWatch({ stallMs: 500, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  const s = on.signalFor(op.signal);
  const alone = on.signalFor(undefined);
  assert.equal(s.aborted, false);
  on.chunk(Buffer.from(`${DENY}\n`));
  fire();
  assert.equal(s.aborted, true, 'the stall ends git');
  assert.equal(alone.aborted, true, 'without an op signal, the stall alone');
  assert.equal(op.signal.aborted, false, 'the op itself is not cancelled');
  const user = new AbortController();
  const both = createSshWatch({ stallMs: 500 }).signalFor(user.signal);
  user.abort();
  assert.equal(both.aborted, true, 'a user\'s cancel ends git too');
});

test('isStall: only the watch\'s own abort is a stall; a user\'s cancel landing as it fires wins; other kills and errors are none', () => {
  const aborted = () => Object.assign(new Error('git was cancelled'), { kind: 'aborted' });
  let fire = null;
  const w = createSshWatch({ stallMs: 500, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  assert.equal(w.isStall(aborted(), null), false, 'not fired');
  w.chunk(Buffer.from(`${DENY}\n`));
  fire();
  const quiet = new AbortController();
  assert.equal(w.isStall(aborted(), quiet.signal), true);
  assert.equal(w.isStall(aborted(), undefined), true);
  const user = new AbortController();
  user.abort();
  assert.equal(w.isStall(aborted(), user.signal), false, 'the user\'s cancel at the same moment wins');
  assert.equal(w.isStall(Object.assign(new Error('git timed out'), { kind: 'timeout' }), quiet.signal), false);
  assert.equal(w.isStall(new Error('exit 128'), quiet.signal), false, 'git ended by itself as the timer fired');
  assert.equal(w.isStall(null, quiet.signal), false);
});

test('logStall: one warning with the op, the kind and the timer, never git\'s text', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const h = require('./helpers');
  const { logger } = require('../src/log');
  const dir = h.tmpDir();
  logger.configure({ dir, level: 'debug', mirror: false });
  t.after(() => logger.configure({ dir: null, level: 'info' }));
  createSshWatch({ stallMs: 10000 }).logStall('fetch', Object.assign(new Error(DENY), { kind: 'auth', stderr: DENY }));
  await logger.flush();
  const recs = fs.readFileSync(path.join(dir, 'main.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((r) => /stalled/.test(r.msg));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].level, 'warn');
  assert.deepEqual([recs[0].op, recs[0].kind, recs[0].ms], ['fetch', 'auth', 10000]);
  assert.ok(!JSON.stringify(recs).includes('Permission denied'));
});

test('a normal disconnect ("Received disconnect … 11: Bye") followed by silence never fires; the other reasons arm', () => {
  const { w, timers, tick, stalls } = watch(500);
  feed(w, 'Received disconnect from 192.0.2.1 port 22:11: Bye Bye\r\n');
  assert.equal(timers.size, 0, 'not an ending: a successful fetch may print it and then transfer in silence');
  tick();
  assert.equal(stalls(), 0);
  feed(w, 'Received disconnect from 192.0.2.1 port 22:2: Too many authentication failures\r\n');
  assert.equal(timers.size, 1);
  tick();
  assert.equal(stalls(), 1);
});

test('W8: a lone "@@@" frame (Windows\' OpenSSH passes only its first write) arms and fires; stallKind reads it as host-key', () => {
  const { w, timers, tick, stalls } = watch(500);
  feed(w, `${'@'.repeat(59)}\r\n`);
  assert.equal(timers.size, 1);
  tick();
  assert.equal(stalls(), 1);
  const stalled = Object.assign(new Error('x'), { stalled: true, kind: undefined });
  assert.equal(w.stallKind(stalled), 'host-key');
  assert.equal(w.stallKind(Object.assign(new Error('x'), { stalled: false })), null, 'not a stall');
  assert.equal(w.stallKind(Object.assign(new Error('x'), { stalled: true, kind: 'auth' })), null, 'classified already');
});

test('W8: the bundled ssh\'s warnings end disarmed (their text follows the frame), and an unprotected key\'s frame is no host key', () => {
  const unprotected = ['@'.repeat(59), '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @', '@'.repeat(59),
    "Permissions 0644 for '/home/u/.ssh/id_ed25519' are too open.", 'This private key will be ignored.'];
  const { w, timers } = watch(500);
  feed(w, unprotected.map((l) => `${l}\n`).join(''));
  assert.equal(timers.size, 0, 'ssh went on (another key): no stall');
  assert.equal(w.stallKind(Object.assign(new Error('x'), { stalled: true })), null);
});
