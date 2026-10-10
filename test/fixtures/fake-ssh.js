'use strict';
// A fake ssh for the remote-op tests (docs/plans/ssh-remote-errors.md §7.2): git runs it as
// GIT_SSH_COMMAND='"<node>" "<this file>"' with GIT_SSH_VARIANT=ssh, so nothing leaves the machine.
// What it does comes from FAKE_SSH_MODE (a non-GIT_ variable: it reaches ssh through the app's
// env allowlist):
//   serve   run the git-upload-pack / git-receive-pack git asked for on the local repository (a
//           working ssh)
//   deny    print ssh's publickey refusal and exit 255 (Git for Windows' bundled ssh)
// `-G` (git's ssh variant probe) exits 0. FAKE_SSH_PID: a file this process writes its pid to.
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

/** ssh's own words on stderr, then its exit code. */
function fail(lines, code = 255) {
  process.stderr.write(lines.map((l) => `${l}\n`).join(''));
  process.exit(code);
}

/** Run the service git asked for on the local repository, as sshd would. */
function serve() {
  const m = /^(git-upload-pack|git-receive-pack|git-upload-archive) '((?:[^']|'\\'')*)'$/.exec(command);
  if (!m) fail([`fake-ssh: unexpected command: ${command}`], 1);
  const repo = env.FAKE_SSH_REPO || m[2].replace(/'\\''/g, "'");
  // The child git finds its repository by the argument only (as on a server).
  const childEnv = { ...env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete childEnv[k];
  const child = spawn('git', [m[1].slice(4), repo], { stdio: 'inherit', env: childEnv });
  child.on('error', (e) => fail([`fake-ssh: ${e.message}`], 1));
  child.on('exit', (code) => process.exit(code === null ? 255 : code));
}

switch (mode) {
  case 'serve':
    serve();
    break;
  case 'deny':
    fail(['git@fake.invalid: Permission denied (publickey).']);
    break;
  default:
    fail([`fake-ssh: unknown mode ${mode}`], 1);
}
