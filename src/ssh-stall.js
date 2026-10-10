'use strict';
// The ssh stall watchdog (docs/plans/ssh-remote-errors.md §4.3): a remote op's caller (src/remote.js,
// src/clone.js) feeds it git's stderr through spawnGit's onStderr. It keeps git's lines (what ssh
// said before a cancel, §4.2) and, with a timer, ends an ssh that has already failed but never
// exits: Windows' own OpenSSH prints its error and then waits forever while its stderr is a pipe,
// and git waits for it. Once a complete line is one of ssh's endings (SSH_ENDINGS) and nothing
// follows on stderr for `stallMs`, onStall() runs: the caller aborts git through the op's own
// cancel path and reports the failure ssh named. spawnGit stays unaware of ssh.
//
// createSshWatch({stallMs, onStall, setTimer, clearTimer}) -> {chunk(buf), lines(), text(), fired, stop()}
// defaultStallMs(platform) -> 10000 on Windows (where the hang is), 0 (no timer) elsewhere.
// saidOf(facts) -> {kind, line}: what ssh said (sshFacts of the watch's lines), as a cancel's
//   explanation carries it to the page (redacted, visible characters only, bounded). The watch's
//   lines themselves never cross IPC or reach a log.
//
// The lines: bytes decoded as UTF-8 (a character split across chunks stays whole), split on '\n',
// '\r\n' and a lone '\r' (git's progress frames); a trailing '\r' is held until the next byte, so a
// '\r\n' split between chunks is one line end. The incomplete tail waits for the next chunk (at
// most MAX_TAIL characters of it are kept). An ending arms the timer, a second one re-arms it
// (ProxyJump: the jump host's refusal, then the outer ssh's "Connection closed by"); any other
// non-empty line disarms it; empty lines never do. It fires once. With `stallMs` 0 the watch only
// collects lines.
const { StringDecoder } = require('node:string_decoder');
const { SSH_ENDINGS } = require('./ssh-text');
const { redactString } = require('./redact');
const { INVISIBLE } = require('./display-text');

const STALL_MS = 10000; // ten times the bundled ssh's whole failed op (§4.3), a twelfth of the fetch timeout
const MAX_LINES = 200;
const MAX_LINE = 1000;
const MAX_TAIL = 4096;
const MAX_TEXT = 64 * 1024;
const SAID_MAX = 300;

/** The watchdog's timer by default: on Windows only, where Windows' OpenSSH hangs (decision 6). */
const defaultStallMs = (platform = process.platform) => (platform === 'win32' ? STALL_MS : 0);

const isEnding = (line) => SSH_ENDINGS.some((re) => re.test(line));

/**
 * A watch over one git command's stderr (see the header). lines(): the last MAX_LINES complete
 * non-empty lines, each cut to MAX_LINE characters; text(): them joined by '\n', at most MAX_TEXT
 * characters (the last ones); fired: true once onStall ran; stop(): no timer from now on (git
 * exited). A listener that throws is ignored.
 */
function createSshWatch({ stallMs = 0, onStall = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const decoder = new StringDecoder('utf8');
  const kept = [];
  let tail = '';
  let heldCr = false;
  let timer = null;
  let fired = false;
  let stopped = false;

  const disarm = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };
  const fire = () => {
    timer = null;
    if (fired || stopped) return;
    fired = true;
    try {
      onStall();
    } catch { /* the caller's bug never breaks the command */ }
  };
  const arm = () => {
    disarm();
    if (stallMs > 0 && !fired && !stopped) timer = setTimer(fire, stallMs);
  };
  const line = (l) => {
    if (!l) return;
    kept.push(l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l);
    if (kept.length > MAX_LINES) kept.shift();
    if (isEnding(l)) arm();
    else disarm();
  };

  return {
    chunk(buf) {
      let s = `${tail}${heldCr ? '\r' : ''}${decoder.write(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)))}`;
      heldCr = s.endsWith('\r');
      if (heldCr) s = s.slice(0, -1);
      const parts = s.split(/\r\n|\n|\r/);
      tail = parts.pop();
      if (tail.length > MAX_TAIL) tail = tail.slice(0, MAX_TAIL);
      for (const l of parts) line(l);
    },
    lines: () => [...kept],
    text() {
      const t = kept.join('\n');
      return t.length > MAX_TEXT ? t.slice(-MAX_TEXT) : t;
    },
    get fired() { return fired; },
    stop() {
      stopped = true;
      disarm();
    },
  };
}

/**
 * ssh's line `facts` (sshFacts) as `said`: {kind, line}, the line without invisible characters,
 * redacted (redactString: URL userinfo, token shapes, the home folder) and at most SAID_MAX
 * characters.
 */
const saidOf = (facts) => ({ kind: facts.kind, line: redactString(String(facts.line).replace(INVISIBLE, ''), SAID_MAX) });

module.exports = { createSshWatch, defaultStallMs, saidOf, STALL_MS, _internal: { MAX_LINES, MAX_LINE, MAX_TAIL, MAX_TEXT, SAID_MAX } };
