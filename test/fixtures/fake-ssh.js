'use strict';
// A fake ssh for the remote-op tests (docs/plans/ssh-remote-errors.md §7.2): git runs it as
// GIT_SSH_COMMAND='"<node>" "<this file>"' with GIT_SSH_VARIANT=ssh, so nothing leaves the machine.
// What it does comes from FAKE_SSH_MODE (a non-GIT_ variable: it reaches ssh through the app's
// env allowlist):
//   serve      run the git-upload-pack / git-receive-pack git asked for on the local repository
//              (a working ssh)
//   deny       print ssh's publickey refusal (`<FAKE_SSH_WHO or git@fake.invalid>: Permission
//              denied (publickey).`) and exit 255 (Git for Windows' bundled ssh)
//   hostkey, unreachable, changed, too-many   print that failure's lines and exit 255: an unknown
//              host key, a refused connection, a changed host key (with its fingerprint, saved as
//              FAKE_SSH_KEYNAME or fake.invalid), ssh's "Too many authentication failures"
//   not-found  print GitHub's "ERROR: Repository not found." and exit 1
//   deny-hang, hostkey-hang, unreachable-hang, changed-hang, kex-hang   print that failure's lines
//              (with '\r\n', as Windows writes them; kex: "kex_exchange_identification: read:
//              Connection reset by peer") and never exit (Windows' OpenSSH on a pipe)
//   proxyjump-hang  a jump host's publickey refusal, FAKE_SSH_DELAY ms (default 300) later the
//              outer ssh's "Connection closed by UNKNOWN port 65535", then never exit
//   silent-hang     print nothing and never exit (the prompt hang)
//   deny-then-serve print the publickey refusal, wait FAKE_SSH_DELAY ms, then serve (a wrapper
//              that retries with another key and succeeds)
//   env        write {askpass, askpassRequire} (SSH_ASKPASS / SSH_ASKPASS_REQUIRE as they reached
//              ssh, or null) to FAKE_SSH_OUT, then serve
// FAKE_SSH_OUT: a file it writes {printedAt} to (ms since the epoch) once its lines are out.
// A "never exit" ends after two minutes anyway, so a failed test leaves nothing behind for long.
// `-G` (git's ssh variant probe) exits 0. FAKE_SSH_PID: a file this process writes its pid to.
// FAKE_SSH_LOG: a file it appends git's command to, one line per run.
// The repository is the one in git's command ('<path>'), or FAKE_SSH_REPO when that is set: on
// Windows git starts this through MSYS sh, whose argument conversion could mangle a path.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const env = process.env;
const mode = env.FAKE_SSH_MODE || 'serve';

if (env.FAKE_SSH_PID) fs.writeFileSync(env.FAKE_SSH_PID, String(process.pid));

// ssh [-p port] [-o opt] [-4|-6] host 'git-upload-pack '\''<path>'\'''
const argv = process.argv.slice(2);
if (argv.includes('-G')) process.exit(0);
let i = 0;
while (i < argv.length && argv[i].startsWith('-')) i += ['-p', '-o', '-l', '-i', '-F'].includes(argv[i]) ? 2 : 1;
const command = argv.slice(i + 1).join(' ');
if (env.FAKE_SSH_LOG) fs.appendFileSync(env.FAKE_SSH_LOG, `${command}\n`);

// A fingerprint's shape (43 base64 characters), built here rather than written out.
const FINGERPRINT = `SHA256:${'Fk7+/'.repeat(9).slice(0, 43)}`;

// What ssh prints for each failure (OpenSSH 9.9: docs/plans/ssh-remote-errors.md §3.3).
const LINES = {
  deny: () => [`${env.FAKE_SSH_WHO || 'git@fake.invalid'}: Permission denied (publickey).`],
  hostkey: () => ['Host key verification failed.'],
  unreachable: () => ['ssh: connect to host fake.invalid port 22: Connection refused'],
  changed: () => [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Someone could be eavesdropping on you right now (man-in-the-middle attack)!',
    'It is also possible that a host key has just been changed.',
    'The fingerprint for the ED25519 key sent by the remote host is',
    `${FINGERPRINT}.`,
    'Please contact your system administrator.',
    'Add correct host key in /home/u/.ssh/known_hosts to get rid of this message.',
    'Offending ED25519 key in /home/u/.ssh/known_hosts:1',
    `Host key for ${env.FAKE_SSH_KEYNAME || 'fake.invalid'} has changed and you have requested strict checking.`,
    'Host key verification failed.',
  ],
  'too-many': () => ['Received disconnect from 192.0.2.1 port 22:2: Too many authentication failures', 'Disconnected from 192.0.2.1 port 22'],
  kex: () => ['kex_exchange_identification: read: Connection reset by peer'],
};
const DELAY = Number(env.FAKE_SSH_DELAY) || 300;

/** Note when the lines are out (FAKE_SSH_OUT): the tests' timing starts there. */
const printed = () => { if (env.FAKE_SSH_OUT) fs.writeFileSync(env.FAKE_SSH_OUT, JSON.stringify({ printedAt: Date.now() })); };

/** Write `lines` to stderr ('\r\n'), then `then` once they are out. */
function say(lines, then) {
  process.stderr.write(lines.map((l) => `${l}\r\n`).join(''), then);
}

/** Never exit (until a kill, or two minutes as a safety net). */
function hang() {
  printed();
  setTimeout(() => process.exit(255), 120000);
}

/** ssh's own words on stderr, then its exit code (once they are written: a pipe may be asynchronous). */
function fail(lines, code = 255) {
  process.stderr.write(lines.map((l) => `${l}\n`).join(''), () => process.exit(code));
}

/** Run the service git asked for on the local repository, as sshd would. */
function serve() {
  const m = /^(git-upload-pack|git-receive-pack|git-upload-archive) '((?:[^']|'\\'')*)'$/.exec(command);
  if (!m) {
    fail([`fake-ssh: unexpected command: ${command}`], 1);
    return;
  }
  const repo = env.FAKE_SSH_REPO || m[2].replace(/'\\''/g, "'");
  // The child git finds its repository by the argument only (as on a server).
  const childEnv = { ...env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete childEnv[k];
  const child = spawn('git', [m[1].slice(4), repo], { stdio: 'inherit', env: childEnv });
  child.on('error', (e) => fail([`fake-ssh: ${e.message}`], 1));
  child.on('exit', (code) => process.exit(code === null ? 255 : code));
}

const hangs = /^(deny|hostkey|unreachable|changed|kex)-hang$/.exec(mode);
if (mode === 'serve') serve();
else if (mode === 'not-found') fail(['ERROR: Repository not found.'], 1);
else if (hangs) say(LINES[hangs[1]](), hang);
else if (mode === 'proxyjump-hang') {
  say(['git@jump.invalid: Permission denied (publickey).'], () => setTimeout(() => say(['Connection closed by UNKNOWN port 65535'], hang), DELAY));
} else if (mode === 'silent-hang') hang();
else if (mode === 'deny-then-serve') say(LINES.deny(), () => setTimeout(serve, DELAY));
else if (mode === 'env') {
  fs.writeFileSync(env.FAKE_SSH_OUT, JSON.stringify({ askpass: env.SSH_ASKPASS || null, askpassRequire: env.SSH_ASKPASS_REQUIRE || null }));
  serve();
}
else if (LINES[mode]) fail(LINES[mode]());
else fail([`fake-ssh: unknown mode ${mode}`], 1);
