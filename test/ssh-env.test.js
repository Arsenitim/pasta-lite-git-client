'use strict';
// The Windows askpass variables of the remote ops (src/ssh-env.js askpassEnv): only on Windows,
// only when the user set neither, only with Git for Windows' false.exe next to its sh.exe. The
// layouts are injected (isFile / readFile, as msysShell's test does); the real fetch and the
// Windows-only checks are in test/remote-ssh.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { askpassEnv } = require('../src/ssh-env');

const GFW = 'C:\\Program Files\\Git';
const files = (...list) => {
  const have = new Set(list);
  return (p) => have.has(p);
};
const gfw = files(`${GFW}\\usr\\bin\\sh.exe`, `${GFW}\\usr\\bin\\false.exe`);
const FORCE = { SSH_ASKPASS: 'C:/Program Files/Git/usr/bin/false.exe', SSH_ASKPASS_REQUIRE: 'force' };
const noShim = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

test('Windows, Git for Windows: false.exe next to its sh.exe, with forward slashes, and force', () => {
  for (const dir of ['cmd', 'bin', 'mingw64\\bin', 'mingw64\\libexec\\git-core']) {
    assert.deepEqual(askpassEnv({ platform: 'win32', env: {}, gitExe: `${GFW}\\${dir}\\git.exe`, isFile: gfw, readFile: noShim }), FORCE, dir);
  }
});

test('a Scoop shim: the false.exe of the git it runs', () => {
  const root = 'C:\\Users\\u\\scoop\\apps\\git\\current';
  const readFile = (p) => {
    if (p === 'C:\\Users\\u\\scoop\\shims\\git.shim') return `path = "${root}\\mingw64\\bin\\git.exe"\r\n`;
    return noShim();
  };
  const isFile = files(`${root}\\usr\\bin\\sh.exe`, `${root}\\usr\\bin\\false.exe`);
  assert.deepEqual(askpassEnv({ platform: 'win32', env: {}, gitExe: 'C:\\Users\\u\\scoop\\shims\\git.exe', isFile, readFile }),
    { SSH_ASKPASS: 'C:/Users/u/scoop/apps/git/current/usr/bin/false.exe', SSH_ASKPASS_REQUIRE: 'force' });
});

test('nothing on macOS and Linux, whatever is installed (ssh fails fast there; a desktop askpass may be in use)', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(askpassEnv({ platform, env: {}, gitExe: `${GFW}\\cmd\\git.exe`, isFile: gfw, readFile: noShim }), {}, platform);
  }
});

test('nothing when the user set SSH_ASKPASS or SSH_ASKPASS_REQUIRE (their askpass keeps working); empty counts as unset', () => {
  const o = { platform: 'win32', gitExe: `${GFW}\\cmd\\git.exe`, isFile: gfw, readFile: noShim };
  assert.deepEqual(askpassEnv({ ...o, env: { SSH_ASKPASS: 'C:/tools/askpass.exe' } }), {});
  assert.deepEqual(askpassEnv({ ...o, env: { SSH_ASKPASS_REQUIRE: 'never' } }), {});
  assert.deepEqual(askpassEnv({ ...o, env: { SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: '' } }), FORCE);
});

test('nothing without a false.exe: MinGit (no sh.exe), or an sh.exe alone', () => {
  const o = { platform: 'win32', env: {}, readFile: noShim };
  assert.deepEqual(askpassEnv({ ...o, gitExe: 'C:\\MinGit\\cmd\\git.exe', isFile: files() }), {});
  assert.deepEqual(askpassEnv({ ...o, gitExe: `${GFW}\\cmd\\git.exe`, isFile: files(`${GFW}\\usr\\bin\\sh.exe`) }), {});
  assert.deepEqual(askpassEnv({ ...o, gitExe: 'C:\\elsewhere\\git.exe', isFile: gfw }), {}, 'git outside a Git for Windows layout');
});

test('the production path (no injection): the git every command runs, cached; Git for Windows\' false.exe on Windows, nothing elsewhere', { skip: process.platform === 'win32' && !require('../src/git-process').msysShell(require('../src/git-process').gitExecutable()) && 'no Git for Windows sh next to the git in use (MinGit)' }, () => {
  const first = askpassEnv({ env: {} });
  if (process.platform !== 'win32') {
    assert.deepEqual(first, {});
    return;
  }
  assert.match(first.SSH_ASKPASS, /^[A-Za-z]:\/.*\/usr\/bin\/false\.exe$/i, 'forward slashes, next to git\'s sh.exe');
  assert.equal(first.SSH_ASKPASS_REQUIRE, 'force');
  assert.deepEqual(askpassEnv({ env: {} }), first, 'the same answer from the cache');
  assert.deepEqual(askpassEnv({ env: { SSH_ASKPASS: 'C:/mine.exe' } }), {}, 'the user\'s own still wins over the cache');
});
