'use strict';
// Windows: no ssh prompt on a console nobody can see (docs/plans/ssh-remote-errors.md §4.4). git
// and ssh share a hidden console there, and Windows' own OpenSSH waits on it for a passphrase or a
// host-key answer, printing nothing: fetch and push sat until their timeout, clone until Cancel.
// With SSH_ASKPASS set to a program that fails at once and SSH_ASKPASS_REQUIRE=force, ssh asks
// that program instead, gets no answer and prints its error line, which the stall watchdog
// (src/ssh-stall.js) then ends. The program is Git for Windows' own usr\bin\false.exe (MSYS
// coreutils, next to the sh.exe the cancel path already uses): nothing of ours to ship or unpack
// from app.asar, no Node (runAsNode is off), and it ignores its argument (the prompt), prints
// nothing and exits 1.
//
// askpassEnv({platform, env, gitExe, isFile, readFile}) -> {SSH_ASKPASS, SSH_ASKPASS_REQUIRE} | {}
// Only on Windows; only when the user's environment sets neither variable (their own askpass
// keeps working as before); only when the git in use has a false.exe (not MinGit). Applied by the
// remote ops alone (src/remote.js fetch / push, src/clone.js), so the hooks git runs for them
// (pre-push, reference-transaction) inherit it too; never other ops (commits and their hooks,
// reads). P3a (roadmap.md §3.5) later puts its askpass helper in place of false.exe, under the
// same rules.
const path = require('node:path');
const { gitExecutable, msysShell } = require('./git-process');
const { isRunnable } = require('./which');

const found = new Map(); // git.exe -> its false.exe (forward slashes), or null: once per git

/** `<root>/usr/bin/false.exe` next to the sh.exe msysShell finds for `gitExe`, with '/', or null. */
function falseExe(gitExe, { isFile = (p) => isRunnable(p, 'win32'), readFile } = {}) {
  const sh = msysShell(gitExe, { isFile, ...(readFile ? { readFile } : {}) });
  if (!sh) return null;
  const exe = path.win32.join(path.win32.dirname(sh), 'false.exe');
  return isFile(exe) ? exe.replace(/\\/g, '/') : null;
}

/**
 * The askpass variables for a remote op's git (see the header), or {}. `platform` / `env`: default
 * process.platform / process.env; `gitExe`: the git in use (default the one every command runs);
 * `isFile` / `readFile` for tests (as msysShell's; nothing is cached then).
 */
function askpassEnv({ platform = process.platform, env = process.env, gitExe, isFile, readFile } = {}) {
  if (platform !== 'win32') return {};
  if (env.SSH_ASKPASS || env.SSH_ASKPASS_REQUIRE) return {};
  let exe = gitExe;
  if (!exe) {
    try {
      exe = gitExecutable();
    } catch {
      return {}; // no git: the command itself will say so
    }
  }
  const injected = !!(isFile || readFile);
  if (injected || !found.has(exe)) {
    const f = falseExe(exe, { ...(isFile ? { isFile } : {}), ...(readFile ? { readFile } : {}) });
    if (injected) return f ? { SSH_ASKPASS: f, SSH_ASKPASS_REQUIRE: 'force' } : {};
    found.set(exe, f);
  }
  const f = found.get(exe);
  return f ? { SSH_ASKPASS: f, SSH_ASKPASS_REQUIRE: 'force' } : {};
}

module.exports = { askpassEnv };
