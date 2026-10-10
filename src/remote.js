'use strict';
// Talking to remotes: fetch (never force-updating local tags), push with an explicit refspec,
// setting an upstream, and which remotes are mirrors whose fetch would rewrite local branches.
// git.js re-exports all of it.
//
// A failed fetch or push is told apart as clone tells it (gitErrors.CONNECT_RULES: auth, host-key,
// not-found, unreachable; docs/plans/ssh-remote-errors.md), carries the remote it failed on
// (`remote`), and for an ssh remote's auth or host-key failure the ssh target the message names
// (`ssh`, sshTarget). git's stderr goes to an ssh watch (src/ssh-stall.js): on Windows by default
// it ends a git whose ssh printed its error and then hangs (Windows' OpenSSH on a pipe), and the
// failure is reported as what ssh said (`stalled`); a user's cancel keeps ssh's line (`said`).
// On Windows ssh gets Git for Windows' false.exe as its askpass (src/ssh-env.js), so it fails
// instead of prompting on a console nobody can see.
const { GitError, kindError, tagError, run, out, tryOut } = require('./exec');
const { headState } = require('./repo-dirs');
const { verify, remotes, upstreamOf } = require('./git-reads');
const { PREFIX, after, branchOf, fullBranch, isRefspecSafe } = require('./gitref');
const gitErrors = require('./git-errors');
const { sshFacts, splitRemote, asciiHost, unbracket } = require('./ssh-text');
const { createSshWatch, defaultStallMs, saidOf } = require('./ssh-stall');
const { askpassEnv } = require('./ssh-env');
const { userOk } = require('./clone-url');
const { logger } = require('./log');

const log = logger.child('git');

/** Default timeout for commands that talk to a remote (fetch / push). */
const REMOTE_TIMEOUT_MS = 120000;

/** Pass-through options for commands that talk to a remote. */
const remoteOpts = ({ signal, timeout = REMOTE_TIMEOUT_MS } = {}) => ({ timeout, signal });

function checkRemoteName(remote) {
  if (typeof remote !== 'string' || !remote || remote.startsWith('-')) throw kindError('invalid-args', `Invalid remote: '${remote}'`);
}

/**
 * True when fetching with refspec `spec` (a remote.<r>.fetch value) writes local branches: its
 * destination is under refs/heads/ or a pattern that covers it ('+refs/*:refs/*' of a mirror).
 * A destination not starting with refs/ is spelled the way git completes it (heads/x, tags/x,
 * remotes/x get refs/; anything else is a branch). Negative and destination-less refspecs write
 * no ref.
 */
function writesBranches(spec) {
  const s = String(spec).replace(/^\+/, '');
  const colon = s.indexOf(':');
  if (s.startsWith('^') || colon < 0 || colon === s.length - 1) return false;
  let dst = s.slice(colon + 1);
  if (!dst.startsWith('refs/')) dst = /^(heads|tags|remotes)\//.test(dst) ? `refs/${dst}` : `refs/heads/${dst}`;
  const star = dst.indexOf('*');
  if (star < 0) return dst.startsWith('refs/heads/');
  const prefix = dst.slice(0, star);
  return prefix.startsWith('refs/heads/') || 'refs/heads/'.startsWith(prefix);
}

/**
 * The remotes whose fetch would overwrite or delete local branches (a `git clone
 * --mirror` sets remote.<r>.mirror and '+refs/*:refs/*'): [{remote, why}], `why` the refspec
 * (or 'remote.<r>.mirror'). [] for an ordinary clone.
 */
async function mirrorRemotes(cwd) {
  const raw = await out(cwd, ['config', '-z', '--get-regexp', '^remote\\..+\\.(mirror|fetch)$'], { okCodes: [0, 1] });
  const found = new Map();
  for (const rec of raw.split('\0')) {
    const nl = rec.indexOf('\n');
    const key = nl < 0 ? rec : rec.slice(0, nl);
    const value = nl < 0 ? null : rec.slice(nl + 1); // null: a bare `mirror` line, which is true
    const m = /^remote\.(.+)\.(mirror|fetch)$/.exec(key);
    if (!m || found.has(m[1])) continue;
    if (m[2] === 'mirror' ? value === null || /^(true|yes|on|1)$/i.test(value) : writesBranches(value)) {
      found.set(m[1], m[2] === 'mirror' ? `remote.${m[1]}.mirror` : value);
    }
  }
  return [...found].map(([remote, why]) => ({ remote, why }));
}

// The host ssh names in its refusal (the resolved HostName): shown as text only, never in a command.
const SHOWN_HOST = /^[A-Za-z0-9._:[\]-]{1,253}$/;
const sameHost = (a, b) => unbracket(a).toLowerCase() === unbracket(b).toLowerCase();

/**
 * The ssh target of an 'auth' or 'host-key' failure of `remote`, for the message's `ssh -T`
 * command: {host?, port?, user?, shownAs?, changed?, fingerprint?, keyName?}, or null when the
 * remote's URL is no ssh URL splitRemote can show (an https remote's auth text stays as it is).
 * The host and the port come from the URL git used (`remote get-url` applies insteadOf /
 * pushInsteadOf), never from ssh's line, which names the resolved host and no alias: that one is
 * only shown, as `shownAs`. A fetch uses the remote's first URL, as git does; a push every push
 * URL, and with several (pushurls) no host: the failing one can't be told apart. The user is
 * ssh's effective one (`facts.user`, which includes a User from ~/.ssh/config) when userOk accepts
 * it and ssh named the URL's own host (with ProxyJump the refusal may be the jump host's, whose user
 * is no target's), else the URL's (splitRemote: userOk too). A changed key's `keyName` is the
 * known_hosts name ssh printed (the resolved host, '[host]:port'), which `ssh-keygen -R` needs.
 * `facts`: sshFacts of git's stderr, or null. Never rejects: no signal (a cancel's explanation asks
 * too), a 10 s timeout, and a broken config is no target.
 */
async function sshTarget(cwd, remote, facts, { push = false } = {}) {
  const raw = await tryOut(cwd, ['remote', 'get-url', ...(push ? ['--push', '--all'] : []), remote], { signal: null, timeout: 10000 })
    .catch(() => null);
  const urls = String(raw || '').split('\n').map((u) => u.trim()).filter(Boolean);
  const split = urls.length === 1 ? splitRemote(urls[0]) : null;
  if (!split && !(urls.length > 1 && facts)) return null;
  const ssh = {};
  if (split) {
    ssh.host = split.host;
    if (split.port) ssh.port = split.port;
  }
  const named = facts && facts.host && SHOWN_HOST.test(facts.host) ? facts.host : null;
  const user = split && named && sameHost(named, split.host) && userOk(facts.user) ? facts.user : split && split.user;
  if (user) ssh.user = user;
  if (named && !(split && sameHost(named, split.host))) ssh.shownAs = asciiHost(named);
  if (facts && facts.changed) ssh.changed = true;
  if (facts && facts.fingerprint) ssh.fingerprint = facts.fingerprint;
  if (facts && facts.keyName) ssh.keyName = facts.keyName;
  return ssh;
}

/** {ssh} for an 'auth' or 'host-key' failure of an ssh remote (sshTarget), else {}. */
async function sshOf(cwd, remote, kind, facts, o) {
  if (kind !== 'auth' && kind !== 'host-key') return {};
  const ssh = await sshTarget(cwd, remote, facts, o);
  return ssh ? { ssh } : {};
}

/**
 * A remote command's run options under an ssh watch: {watch, opts}. git's stderr goes to the
 * watch; with a timer (`stallMs`, default defaultStallMs(): Windows only) git runs under
 * watch.signalFor(the op's signal), so a stall ends git through the Cancel path (spawnGit's kill,
 * signalGroup). Without a signal (a test) the stall alone can end it. On Windows the askpass
 * variables too (askpassEnv).
 */
function watched({ signal, timeout, stallMs }) {
  const watch = createSshWatch({ stallMs: stallMs === undefined ? defaultStallMs() : stallMs });
  const opts = { ...remoteOpts({ signal, timeout }), signal: watch.signalFor(signal), env: askpassEnv(), onStderr: (c) => watch.chunk(c) };
  return { watch, opts };
}

/** True for a user's cancel: kind 'aborted' with the op's own signal aborted (not a stall). */
const userCancel = (err, signal) => !!err && err.kind === 'aborted' && !!signal && signal.aborted;

/**
 * A stall made into the failure it is: git was ended by the watch and not by the user
 * (watch.isStall: a cancel at the same moment wins), so the error is git's text again (the
 * watch's lines: spawnGit replaced it with "git was cancelled"), unclassified and `stalled`, for
 * the caller's classification. Any other error is returned as it is.
 */
function unstall(err, watch, signal) {
  if (!watch.isStall(err, signal) || !(err instanceof GitError)) return err;
  const text = watch.text();
  err.kind = undefined;
  err.stderr = text;
  err.message = text.trim() || err.message;
  err.stalled = true;
  return err;
}

/**
 * A user's cancel after ssh said why it failed: `said` {kind, line} (saidOf: redacted, at most 300
 * characters) and, for auth / host-key, the ssh target the explanation names.
 */
async function cancelSaid(cwd, remote, err, facts, o) {
  if (!facts) return err;
  err.said = saidOf(facts);
  Object.assign(err, await sshOf(cwd, remote, facts.kind, facts, o));
  return err;
}

/** `err` with the remote it failed on (`remote`), unless it names one already. */
function withRemote(err, remote) {
  if (err && typeof err === 'object' && err.remote === undefined) err.remote = remote;
  return err;
}

/**
 * `fetch --prune --tags` one remote. Local tags that differ from the remote's are never
 * overwritten: git rejects them ("would clobber existing tag") and the whole fetch fails, so
 * we re-fetch with the remote's configured refspecs plus a negative refspec per conflicting
 * tag. Returns the conflicting tag names.
 */
async function fetchRemote(cwd, remote, opts, skipTags = []) {
  let refspecs = [];
  if (skipTags.length) {
    const configured = ((await tryOut(cwd, ['config', '--get-all', `remote.${remote}.fetch`])) || '').split('\n').filter(Boolean);
    // Negative refspecs alone fetch nothing: without configured ones, use git's clone default.
    const positive = configured.length ? configured : [`+refs/heads/*:refs/remotes/${remote}/*`];
    refspecs = [...positive, ...skipTags.map((t) => `^refs/tags/${t}`)];
  }
  const { watch, opts: runOpts } = watched(opts);
  try {
    // Never into submodules (their config and hooks are their own): on the command line, since
    // .gitmodules can turn fetch.recurseSubmodules back on per submodule.
    await run(cwd, ['fetch', '--porcelain', '--prune', '--tags', '--no-recurse-submodules', remote, ...refspecs], runOpts)
      .finally(() => watch.stop());
    return skipTags;
  } catch (e) {
    const err = unstall(e, watch, opts.signal);
    const facts = sshFacts(watch.lines());
    // A connection failure (the anchored patterns push and clone use), or "refusing to fetch into
    // branch 'refs/heads/x' checked out at '<path>'": the refspec writes local branches and a
    // worktree has that one checked out (git's message kept).
    const kind = gitErrors.kindFor(err, ...gitErrors.CONNECT_RULES, 'checkedOutElsewhere');
    if (kind) tagError(err, kind, await sshOf(cwd, remote, kind, facts));
    if (err.stalled) watch.logStall('fetch', err);
    if (kind || err.stalled) throw err;
    if (userCancel(err, opts.signal)) throw await cancelSaid(cwd, remote, err, facts);
    const rejected = gitErrors.unclassified(err) ? gitErrors.rejectedFetchRefs(err.stdout) : [];
    const tags = rejected.map((r) => after(r, PREFIX.TAGS)).filter((t) => t !== null);
    const next = [...new Set([...skipTags, ...tags])];
    if (!tags.length || tags.length !== rejected.length || next.length === skipTags.length) throw err;
    return fetchRemote(cwd, remote, opts, next);
  }
}

/**
 * Fetch `remote` (default: every remote) with --prune --tags, never force-updating local tags.
 * @param {{remote?: string, signal?: AbortSignal, timeout?: number, stallMs?: number}} [opts]
 *   timeout per remote, default REMOTE_TIMEOUT_MS; a timeout/abort throws kind 'timeout'/'aborted'
 *   (a user's cancel with `said` when ssh had said why it failed). stallMs: the ssh watchdog's
 *   silence after ssh's ending (default defaultStallMs(): 10 s on Windows, off elsewhere; 0: off).
 * @returns {Promise<{tagConflicts: string[]}>} local tags left alone because the remote's differ.
 * Connection failures throw kind 'auth', 'host-key', 'not-found' or 'unreachable' (as push and
 * clone do), so pull reports them the same way. Every error names the remote it failed on
 * (`remote`: Fetch All fetches one after another).
 */
async function fetch(cwd, { remote, signal, timeout, stallMs } = {}) {
  if (remote !== undefined) checkRemoteName(remote);
  const names = remote !== undefined ? [remote] : await remotes(cwd);
  const tagConflicts = [];
  for (const name of names) {
    try {
      tagConflicts.push(...(await fetchRemote(cwd, name, { signal, timeout, stallMs })));
    } catch (err) {
      throw withRemote(err, name);
    }
  }
  return { tagConflicts: [...new Set(tagConflicts)] };
}

/**
 * Push a local branch with an explicit refspec. Target defaults to the branch's upstream;
 * `remoteBranch` overrides the remote branch name. `force`: false | 'lease' | truthy (plain).
 * Rejections throw kind rejected-behind | rejected-stale | rejected-hook (with remoteMessage)
 * | rejected | auth | host-key | not-found | unreachable | mirror-repo | timeout | aborted; a
 * failure of git names the remote (`remote`), an ssh auth / host-key one its target (`ssh`).
 * stallMs, `stalled` and `said`: as fetch.
 */
async function push(cwd, { remote, branch, remoteBranch, force, signal, timeout, stallMs } = {}) {
  for (const [what, v] of [['branch', branch], ['remoteBranch', remoteBranch]]) {
    if (v !== undefined && v !== null && !isRefspecSafe(v)) {
      throw kindError('invalid-args', `Invalid ${what}: '${v}'`);
    }
  }
  const local = branch || (await headState(cwd)).branch;
  if (!local) throw kindError('detached', 'Cannot push with a detached HEAD');
  const up = await upstreamOf(cwd, local);
  const upRemote = up && up.remote !== '.' ? up.remote : null;
  if (!remote && !upRemote) {
    throw kindError('no-upstream', `Branch '${local}' has no upstream`, { remotes: await remotes(cwd) });
  }
  const target = remote || upRemote;
  checkRemoteName(target);
  const dst = remoteBranch
    || (up && up.remote === target && branchOf(up.remoteRef) !== null ? branchOf(up.remoteRef) : local);
  let forceArgs = [];
  if (force === 'lease') {
    forceArgs = [`--force-with-lease=refs/heads/${dst}:${(await verify(cwd, `refs/remotes/${target}/${dst}`)) || ''}`];
  } else if (force) {
    forceArgs = ['--force'];
  }
  const { watch, opts } = watched({ signal, timeout, stallMs });
  try {
    // --recurse-submodules=no: never checks or pushes submodules (fetch, above).
    await run(cwd, ['push', '--porcelain', '--recurse-submodules=no', ...forceArgs, target, `refs/heads/${local}:refs/heads/${dst}`], opts)
      .finally(() => watch.stop());
  } catch (e) {
    const err = unstall(e, watch, signal);
    const facts = sshFacts(watch.lines());
    const c = gitErrors.unclassified(err) && gitErrors.classifyPush(err);
    if (c) tagError(err, c.kind, { ...c.extra, ...(await sshOf(cwd, target, c.kind, facts, { push: true })) });
    else if (userCancel(err, signal)) await cancelSaid(cwd, target, err, facts, { push: true });
    if (err.stalled) watch.logStall('push', err);
    throw withRemote(err, target);
  }
  return { remote: target, branch: local, remoteBranch: dst, forced: force || false };
}

/**
 * Make refs/remotes/<remote>/<remoteBranch> the upstream of `localBranch`, creating that
 * tracking ref at the local tip when absent (so a not-yet-pushed branch can be tracked). A ref
 * created here is removed again if setting the upstream fails (e.g. unknown remote).
 */
async function setUpstream(cwd, localBranch, remote, remoteBranch) {
  checkRemoteName(remote);
  const tracking = `refs/remotes/${remote}/${remoteBranch}`;
  let created = null;
  if (!(await verify(cwd, tracking))) {
    const sha = (await out(cwd, ['rev-parse', '--verify', fullBranch(localBranch)])).trim();
    // Empty old-value = create only if still absent.
    await run(cwd, ['update-ref', tracking, sha, '']);
    created = sha;
  }
  try {
    // Full ref name: `origin/x` would be ambiguous with a local branch called 'origin/x'.
    await run(cwd, ['branch', '-q', `--set-upstream-to=${tracking}`, localBranch]);
  } catch (err) {
    // Delete only if it still points where we put it.
    if (created) {
      await run(cwd, ['update-ref', '-d', tracking, created])
        .catch((e) => log.warn('could not remove tracking ref', { ref: tracking, err: e }));
    }
    // No fetch refspec of the remote maps a branch to refs/remotes/<remote>/ (`git clone --bare`
    // sets none), so git can't tell which remote branch that ref tracks.
    throw gitErrors.classify(err, ['noTrackingRefspec'], {
      message: `Remote '${remote}' has no fetch refspec for refs/remotes/${remote}/ (a bare clone sets none), so no upstream can be tracked there. `
        + `Add one with: git config remote.${remote}.fetch '+refs/heads/*:refs/remotes/${remote}/*'`,
    });
  }
}

module.exports = { REMOTE_TIMEOUT_MS, checkRemoteName, writesBranches, mirrorRemotes, fetch, push, setUpstream };
