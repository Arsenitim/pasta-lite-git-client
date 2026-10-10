'use strict';
// User-facing git flows, the shared part (plain script; exposes window.PLFlows and window.PLFlowKit):
// the dialogs, follow-up questions and messages around one git operation, shared by the toolbar,
// sidebar, graph and keybindings. This file holds the flow wrapper, the kit the other flow files
// build on, and the few flows that are no git write of their own.
//
// Contract: every flow takes the store first and returns Promise<boolean> — true when the git
// operation ran and succeeded, false when it was cancelled, refused or failed. A flow never throws:
// errors are shown (toast or dialog) unless store.actions.write already toasted them. While the
// repo is busy (state.busy) or another flow of this store is still running (including its
// dialogs), a flow does nothing and returns false. Exceptions: PLPolicy.FREE_FLOWS (openTerminal,
// cancel, cancelInteractiveRebase, openWorktree, revealWorktree and copyWorktreePath) work while busy.
// In a bare repository (repo.bare) the flows that need a working tree
// (PLPolicy.WORKTREE_FLOWS, and pull in any mode but Fetch All) refuse with a notice
// ("Checkout — needs a working tree (bare repository)") before doing anything; so do the flows that
// start a conflicting op while a rebase / merge / … is in progress (PLPolicy.opBlocked:
// "Checkout — finish or abort the rebase first"). The menus disable them already, this also covers
// double-clicks and shortcuts.
// A flow belongs to the repository that was open when it started. The native menu can open another
// one mid-flow (the lock is per store, not per repo), so the body gets a scoped store (scoped()):
// once another repository is open, its writes and reads refuse (kind 'repo-changed', shown as
// nothing), its notices and store changes do nothing and its dialogs (kit dialog(store)) answer
// "cancel" without showing: every follow-up of the old repo's op stands down.
//
// Files (index.html order; each adds its flows to window.PLFlows through window.PLFlowKit.register):
//   flows-kit.js      the wrapper (flow, scoped, NO_DIALOG, settle), the kept-stash wording and
//                     reportOutcome, the remote ops' connection failures (connectView, connectAlert),
//                     tagConflictsAlert, and the flows below
//   flows-sync.js     fetch, pull, pullMode / setPullMode / PULL_MODES, push, setUpstream
//   flows-branch.js   checkout, createBranch, deleteBranch, deleteBranches, branchNameError
//   flows-stash.js    stashSave, stashPop, stashApply, stashDrop
//   flows-worktree.js stage, unstage, stageAll, unstageAll, discard, markResolved, commit and the hunk /
//                     line selections (the WIP panel and the diff view)
//   flows-linked-worktrees.js  removeWorktree, pruneWorktrees, lockWorktree, unlockWorktree, revealWorktree,
//                     copyWorktreePath (the LINKED worktrees of the sidebar section; not the working tree)
//   flows-op.js       a rebase / merge in progress (R1, keep-a-side) and what merge / rebase starts share
//   flows-merge.js    merge (R2)          flows-rebase.js   rebase from the menus (R2), interactive rebase (R3)
// Each file's header lists its flows (flows-op.js / flows-merge.js / flows-rebase.js: their own).
//
//   undo(store), redo(store)
//   openTerminal(store)
//   openWorktree(store, path)   show a linked worktree of this repository: the tab that has it open, else
//                               a new tab (the bare banner's buttons; main accepts only a path its own
//                               worktree list has)
//   cancel(store) -> Promise<boolean>   aborts the running cancellable op (state.remoteOp): fetch, pull,
//                               push, rebaseContinue, rebaseSkip, rebase, rebaseInteractive
//   isRunning(store) -> boolean  a flow of this store is in progress
//   shortcutFor(keydown, state, ctx), shortcutBlocked(keydown, state, ctx)   PLPolicy's (the global shortcuts)
// Kit (window.PLFlowKit): C, flow, settle, report, dialog, dn, short, Op, status, currentBranch,
// localBranches, upstreamOf, keptStashTitle, keptStashText, stashNote, reportOutcome, authMessage and
// connectView (also the clone dialog's, renderer/clone.js), connectAlert, CONNECT_KINDS, tagConflictsAlert,
// register; flows-sync.js adds forcePush, flows-branch.js checkoutInner and syntaxError, flows-op.js its
// start helpers.
// All git-derived text reaches the DOM through the dialogs / toasts (textContent only).
(function () {
  const C = window.Components;
  const P = window.PLPolicy; // policy.js loads before this script
  const running = new WeakMap(); // store -> name of the flow in progress

  const dn = (s) => C.util.displayName(s);
  const { short, report } = C.util;
  const Op = () => window.PLOp;

  /** False once `store` (a flow's scoped store) belongs to a repository that is no longer open. */
  const stillHere = (store) => !store || typeof store.stillHere !== 'function' || store.stillHere();

  // What a flow's dialogs do once its repository is no longer open: nothing is shown, every
  // question is answered "cancel".
  const NO_DIALOG = Object.freeze({
    alert: async () => undefined, confirm: async () => false, choose: async () => null, prompt: async () => null,
    editMessage: async () => null, confirmDiscard: async () => false, pathListText: (paths, max) => C.dialog.pathListText(paths, max),
  });

  /** Components.dialog for a flow of `store` (NO_DIALOG once its repository was switched away from). */
  const dialog = (store) => (stillHere(store) ? C.dialog : NO_DIALOG);

  /**
   * The store a flow body works with: `store` (state, helpers) whose actions, set and invoke stand
   * down once another repository is open (stillHere() false): write / invoke reject with kind
   * 'repo-changed' (marked toasted, so nothing is shown), the other actions and set do nothing.
   */
  function scoped(store) {
    const root = store.state.repo.root;
    const here = () => !!store.state.repo && store.state.repo.root === root;
    const gone = () => Promise.reject(Object.assign(new Error('Another repository was opened meanwhile'), { kind: 'repo-changed', toasted: true }));
    const REFUSE = new Set(['write']);
    const actions = new Proxy(store.actions, {
      get(target, k) {
        const v = target[k];
        if (typeof v !== 'function') return v;
        return (...a) => {
          if (here()) return target[k](...a);
          return REFUSE.has(k) ? gone() : undefined;
        };
      },
    });
    return Object.create(store, {
      actions: { value: actions },
      set: { value: (patch) => { if (here()) store.set(patch); } },
      invoke: { value: (...a) => (here() ? store.invoke(...a) : gone()) },
      stillHere: { value: here },
    });
  }

  /** {value} when `p` resolves, {error} when it rejects (keeps results const, no try/let). */
  const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));

  /**
   * Wrap a flow body: the busy / one-flow-at-a-time guard, the bare / in-progress refusals, and never
   * throwing. PLPolicy.FREE_FLOWS skip the guard (and don't take the lock).
   */
  function flow(name, body) {
    const free = P.FREE_FLOWS.has(name);
    return async (store, ...args) => {
      if (!store || !store.state || !store.state.repo) return false;
      if (!free && (store.state.busy || running.has(store))) return false;
      const refused = P.bareBlocked(store.state, name, args) || P.opBlocked(store.state, name, args);
      if (refused) {
        store.actions.notify(refused);
        return false;
      }
      if (!free) running.set(store, name);
      const view = scoped(store);
      try {
        return (await body(view, ...args)) === true;
      } catch (e) {
        report(view, e);
        return false;
      } finally {
        if (!free && running.get(store) === name) running.delete(store);
      }
    };
  }


  const status = (store) => store.state.status || null;
  /** The checked-out branch (raw; null when detached, also mid-rebase): PLPolicy.headView. */
  const currentBranch = (store) => P.headView(store.state).branch;
  const localBranches = (store) => (store.state.refs && store.state.refs.local) || [];

  /** The upstream ('origin/main') of `branch`, from status for the current branch, else from refs. */
  function upstreamOf(store, branch) {
    const st = status(store);
    if (st && st.branch === branch) return st.upstream || null;
    const b = localBranches(store).find((x) => x.name === branch);
    return (b && b.upstream) || null;
  }

  // ---------------------------------------------------------------- kept stashes (the one wording)
  // A stash of the user's changes that didn't come back: a result's stash {kept, sha, reason} or an
  // error's stashKept / stash / reason. reason: 'conflict' (or none) the re-apply conflicted and the
  // tree was reset; 'index' git gave up on it; 'dirty' the tree had other changes to tracked files;
  // 'untracked' untracked files are where the stash's untracked files go (nothing was applied).
  // `banner`: the stash is our recorded autostash (a rebase / merge / Pull (rebase)), which the
  // banner's Restore re-applies once the tree allows it ('dirty', 'untracked': its ref is kept).

  const REAPPLY_BLOCKED = new Set(['dirty', 'untracked', 'index']);

  /** Why the stashed changes didn't come back, after "Your local changes …". `left`: the tree after a reset ('clean', 'as pulled'). */
  function stashWhy(reason, resetFailed, { left = 'clean' } = {}) {
    if (reason === 'dirty') return 'were not re-applied, because the working tree has other changes now (it was left as it is)';
    if (reason === 'untracked') return 'were not re-applied, because untracked files in the working tree are in the way of files in the stash (nothing was changed)';
    const what = reason === 'index' ? 'could not be re-applied' : 'could not be re-applied without conflicts';
    return resetFailed
      ? `${what}, and the working tree couldn't be reset afterwards: check your files for conflict markers before you go on`
      : `${what}, so the working tree was left ${left}`;
  }

  /** "They are safe in a stash (a1b2c3d): <what to do next>." (`lead`: the sentence's subject). */
  function keptStashNote(sha, { reason, banner = false, lead = 'They' } = {}) {
    const where = `${lead} are safe in a stash${sha ? ` (${short(sha)})` : ''}`;
    const restore = banner && (reason === 'dirty' || reason === 'untracked');
    if (reason === 'untracked') return `${where}: move or delete the untracked files that are in the way, then ${restore ? 'click Restore in the banner' : 'pop the stash from the Stashes list'}.`;
    if (restore) return `${where}: commit, stash or discard your other changes, then click Restore in the banner.`;
    return `${where}: pop it from the Stashes list when you're ready.`;
  }

  /** The full explanation of a kept stash for a dialog: "Your local changes <why>.\n\nThey are safe …". */
  const keptStashText = ({ sha, reason, resetFailed, banner, left }) => `Your local changes ${stashWhy(reason, resetFailed, { left })}.\n\n${keptStashNote(sha, { reason, banner })}`;

  /** "<done>, but your changes weren't re-applied" / "…conflicted": the title of a kept-stash alert. */
  const keptStashTitle = (done, reason) => `${done}, but ${REAPPLY_BLOCKED.has(reason) ? "your changes weren't re-applied" : 'your changes conflicted'}`;

  /** A note about the stash an error kept (e.stashKept), appended to a dialog's message; '' without one. */
  const stashNote = (e, { banner = false } = {}) => (e && e.stashKept
    ? `\n\n${keptStashNote(e.stash, { reason: e.reason, banner, lead: 'Your local changes' })}`
    : '');

  /**
   * The ONE place a finished op's result fields are explained (docs/plans/rebase.md §3.8; pull,
   * rebase, continue, skip, interactive, merge, mergeCommit, the aborts, restoreAutostash): a kept
   * stash ({stash: {kept, sha, reason}}) or a failed reset (resetFailed) gets an alert ("<done>, but
   * your changes conflicted" / "… weren't re-applied", or `title`); otherwise `notice` is shown, with
   * a note when the changes came back without their staged / unstaged split (indexRestored: false).
   * `banner`: the stash is our recorded autostash (default true: every op but pull's merge modes).
   * Resolves true when the alert was shown.
   */
  async function reportOutcome(store, res, { done, notice, title, banner = true, left }) {
    const stash = res && res.stash && res.stash.kept ? res.stash : null;
    const resetFailed = !!(res && res.resetFailed);
    if (stash || resetFailed) {
      const reason = stash ? stash.reason : null;
      const why = `Your local changes from before ${stashWhy(reason, resetFailed, { left })}.`;
      await dialog(store).alert({
        title: title || keptStashTitle(done, reason),
        message: stash ? `${why}\n\n${keptStashNote(stash.sha, { reason, banner })}` : why,
      });
      return true;
    }
    const split = res && res.indexRestored === false ? '. Your local changes came back, but their staged part could not be restored, so all of them are unstaged' : '';
    if (notice) store.actions.notify(`${notice}${split}`);
    return false;
  }

  // A credential helper to suggest on `platform` ('darwin' | 'win32' | other: Linux and the rest).
  const CREDENTIAL_HELPERS = {
    darwin: 'git config --global credential.helper osxkeychain',
    win32: 'Git Credential Manager, which Git for Windows installs',
  };
  const credentialHelperHint = (platform) => CREDENTIAL_HELPERS[platform]
    || 'Git Credential Manager, or git config --global credential.helper libsecret';

  /** The "Authentication failed" dialog text, its credential helper example for `platform`. */
  const authMessage = (platform = C.util.PLATFORM) => 'Git could not authenticate with the remote. Pasta Lite uses your existing git setup and never asks for passwords itself:\n\n'
    + `• HTTPS remotes: store your credentials with a credential helper (e.g. ${credentialHelperHint(platform)}) or sign in once from a terminal.\n`
    + '• SSH remotes: add your key to ssh-agent (ssh-add) and check that the remote accepts it.\n\nThen try again.';

  // ---------------------------------------------------------------- connection failures
  // What a remote op (fetch, pull, push; clone's dialog too) says about a connection that failed
  // (docs/plans/ssh-remote-errors.md §4.5): auth (an ssh remote's, ssh's "Too many authentication
  // failures", an https one's), host-key (unknown, or changed: never "accept"), not-found and
  // unreachable. `e.ssh` is main's ssh target of an ssh remote ({host, port, user, shownAs,
  // changed, fingerprint}: shell-safe parts, src/remote.js sshTarget); the commands are shown,
  // never run.

  const SshText = () => window.PLSshText; // ../src/ssh-text.js, loaded before components.js
  // The kinds connectAlert explains (the remote ops' write() calls keep them quiet: flows-sync.js).
  const CONNECT_KINDS = Object.freeze(['auth', 'host-key', 'not-found', 'unreachable']);
  const OP_NAMES = { fetch: 'Fetch', pull: 'Pull', push: 'Push', clone: 'Clone' };

  // W6 gate (docs/plans/ssh-remote-errors.md §4.5 and §10 Q9): the Windows hint recommends Windows'
  // own OpenSSH as core.sshCommand only once manual QA row W6 showed that it doesn't hang after a
  // successful connection. Until then this stays false: the hint leads with Pageant (what works
  // with Git for Windows' own ssh in an app started from the Start menu) and gives the ssh-agent
  // service's steps only to those whose git runs Windows' OpenSSH already. Set it to true (and
  // update the hint's test in test/flows.test.js) when W6 passes.
  const RECOMMEND_WINDOWS_OPENSSH = false;
  const SERVICE_STEPS = 'its ssh-agent service is disabled by default. In an administrator PowerShell: Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent, then ssh-add';

  /**
   * How to make the key usable without a prompt on `platform`. Windows: Git for Windows' own ssh
   * (the default) uses neither Windows' ssh-agent service nor an agent started in a Git Bash or
   * by start-ssh-agent.cmd (that one serves its own console's session only), so a passphrase key
   * needs Pageant and plink there; the service serves Windows' OpenSSH.
   */
  function sshAgentHint(platform, { windowsOpenSsh = RECOMMEND_WINDOWS_OPENSSH } = {}) {
    if (platform === 'darwin') {
      return 'On macOS: ssh-add --apple-use-keychain ~/.ssh/<key>, and in ~/.ssh/config UseKeychain yes and AddKeysToAgent yes, so the key comes back after a restart.';
    }
    if (platform === 'win32') {
      const openSsh = windowsOpenSsh
        ? `Or let git use Windows' OpenSSH and its ssh-agent service: git config --global core.sshCommand C:/Windows/System32/OpenSSH/ssh.exe; ${SERVICE_STEPS}.`
        : `If git runs Windows' own OpenSSH (core.sshCommand or GIT_SSH_COMMAND names it, or Git for Windows was installed with "Use external OpenSSH"): ${SERVICE_STEPS}.`;
      return 'Git for Windows\' own ssh can\'t use a key that needs its passphrase here, and it doesn\'t use Windows\' ssh-agent service. '
        + 'Load the key in PuTTY\'s Pageant and set the GIT_SSH environment variable to PuTTY\'s plink.exe; restart Pasta Lite after setting it (it reads its environment when it starts).'
        + `\n\n${openSsh}`;
    }
    return 'Add it with ssh-add ~/.ssh/<key> in the session Pasta Lite was started from (it needs that session\'s SSH_AUTH_SOCK).';
  }

  /** The ASCII form of `host` (asciiHost: what ssh saves), or '' without one. */
  const ascii = (host) => (host ? SshText().asciiHost(host) : '');

  /** The host as a message names it: its ASCII form, said so when it differs; 'the server' without one. */
  function hostText(host) {
    if (!host) return 'the server';
    return ascii(host) === host ? dn(host) : `${dn(ascii(host))} (the server's name in ASCII)`;
  }

  /** The `ssh -T` command for `ssh` ({host, port, user}); `ssh -T git@<host>` without a host. */
  const sshCommandText = (ssh) => (ssh && ssh.host ? dn(SshText().sshCommand({ ...ssh, host: ascii(ssh.host) })) : 'ssh -T git@<host>');

  /**
   * `ssh-keygen -R` of the saved key: the known_hosts name ssh printed (`ssh.keyName`: the resolved
   * host, '[host]:port'), else the URL's host, '[host]:port' with a port other than 22 (how ssh
   * saves it). A bracketed name is quoted: single quotes for a POSIX shell, double quotes on
   * Windows (they work in PowerShell and in cmd).
   */
  function keygenText(ssh, platform) {
    let name = '<host>';
    if (ssh && ssh.keyName) name = dn(ssh.keyName);
    else if (ssh && ssh.host) {
      const host = dn(SshText().unbracket(ascii(ssh.host)));
      name = ssh.port && ssh.port !== 22 ? `[${host}]:${ssh.port}` : host;
    }
    const q = platform === 'win32' ? '"' : "'";
    return `ssh-keygen -R ${name.startsWith('[') ? `${q}${name}${q}` : name}`;
  }

  // git's own https prompt falls back to SSH_ASKPASS when one is set (docs/plans/ssh-remote-errors.md
  // V12), and the askpass may fail: its line is left in the error and dropped only where it is shown.
  const ASKPASS_LINE = /^error: unable to read askpass response from .*(?:\r?\n|$)/gm;
  const shownDetail = (text) => String(text || '').replace(ASKPASS_LINE, '').trim();
  const firstLine = (text) => String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

  /** The {title, message} of connection failure `kind` (CONNECT_KINDS), or null. */
  function connectText(kind, e, ssh, { op, platform }) {
    const host = hostText(ssh && ssh.host);
    switch (kind) {
      case 'host-key':
        if (ssh && ssh.changed) {
          return {
            title: 'The server\'s host key changed',
            message: `${host} now presents a different key than the one saved for it. Someone may be intercepting the connection, or the server was reinstalled. `
              + `Check the key${ssh.fingerprint ? ` (${dn(ssh.fingerprint)})` : ''} with the server's admin or its published fingerprints before you remove the saved one (${keygenText(ssh, platform)}).`,
          };
        }
        return { title: 'Unknown host key', message: `ssh doesn't know ${host} yet and can't ask here. Connect once from a terminal (${sshCommandText(ssh)}) to check its key and accept it, then try again.` };
      case 'auth': {
        const said = [e.said && e.said.line, e.message].filter(Boolean).join('\n');
        if (SshText().TOO_MANY.test(said)) {
          return {
            title: 'SSH authentication failed',
            message: `ssh offered more keys than ${host} accepts before the right one. Add IdentitiesOnly yes and an IdentityFile for this host in ~/.ssh/config, or remove keys you don't use from ssh-agent.`,
          };
        }
        if (!ssh) return { title: 'Authentication failed', message: authMessage(platform) };
        const who = ssh.host && ssh.user ? `${dn(ssh.user)}@${host}` : host;
        return {
          title: 'SSH authentication failed',
          message: `${who} didn't accept any of your SSH keys${ssh.shownAs ? ` (ssh connected to ${dn(ssh.shownAs)})` : ''}. `
            + `Pasta Lite can't ask for a key's passphrase: add the key to ssh-agent first, then check it from a terminal (${sshCommandText(ssh)}).\n\n${sshAgentHint(platform)}`,
        };
      }
      case 'not-found':
        return {
          title: 'Repository not found',
          message: `Check the ${op === 'clone' || !e.remote ? 'URL' : `URL of ${dn(e.remote)}`}. For a private repository this can also mean you aren't signed in (many hosts answer "not found" instead of "forbidden").`,
        };
      case 'unreachable':
        return { title: 'Can\'t reach the server', message: 'Check the address and your network connection, then try again.' };
      default:
        return null;
    }
  }

  /** What ssh said before the user cancelled `e` ({kind, line}: main's, redacted), or null. */
  const saidOf = (e) => (e && e.kind === 'aborted' && e.said && typeof e.said.line === 'string' ? e.said : null);

  /**
   * What to tell the user about remote op `op`'s ('fetch', 'pull', 'push', 'clone') connection
   * failure `e` (kind in CONNECT_KINDS): {title, message, detail}, or null for another kind.
   * detail: git's text, without the askpass line. A user's cancel after ssh said why it failed
   * (`e.said`) gets that kind's text, titled "<Op> cancelled", with "ssh said: <line>" as its
   * detail. `platform`: the agent hint's (default the app's).
   */
  function connectView(e, { op, platform = C.util.PLATFORM } = {}) {
    const said = saidOf(e);
    const view = e ? connectText(said ? said.kind : e.kind, e, e.ssh || null, { op, platform }) : null;
    if (!view) return null;
    if (said) return { ...view, title: `${OP_NAMES[op] || 'Operation'} cancelled`, detail: `ssh said: ${dn(said.line)}` };
    return { ...view, detail: shownDetail(e.message) };
  }

  /** The toast of an unreachable fetch / pull: "Couldn't reach origin: <git's line>". */
  const unreachableText = (e) => `Couldn't reach ${e.remote ? dn(e.remote) : 'the remote'}: ${dn(firstLine(shownDetail(e.message)))}`;

  /**
   * Show remote op `op`'s connection failure `e`, or a cancel after ssh said why it failed
   * (`said`): a dialog (connectView), or for an unreachable fetch or pull a toast naming the
   * remote. Resolves false (nothing shown) for any other error (a cancel without `said` keeps its
   * notice), and for a 'not-found' that names no remote (not the remote's: fetch and push set `remote`).
   */
  async function connectAlert(store, e, { op } = {}) {
    const said = saidOf(e) ? connectView(e, { op }) : null;
    if (said) {
      await dialog(store).alert(said);
      return true;
    }
    if (!e || !CONNECT_KINDS.includes(e.kind)) return false;
    if (e.kind === 'not-found' && op !== 'clone' && !e.remote) return false;
    if (e.kind === 'unreachable' && (op === 'fetch' || op === 'pull')) {
      report(store, Object.assign(new Error(unreachableText(e)), { kind: e.kind }));
      return true;
    }
    await dialog(store).alert(connectView(e, { op }));
    return true;
  }

  async function tagConflictsAlert(store, res) {
    const tags = (res && res.tagConflicts) || [];
    if (!tags.length) return;
    await dialog(store).alert({
      title: 'Some tags were not updated',
      message: `${C.util.plural(tags.length, 'local tag')} ${tags.length === 1 ? 'differs' : 'differ'} from the remote's copy and ${tags.length === 1 ? 'was' : 'were'} kept as is. Branches were updated.`,
      detail: dialog(store).pathListText(tags),
    });
  }

  // ---------------------------------------------------------------- undo / redo

  const pastTense = (description) => String(description || '').replace(/^Undo /, 'Undid ').replace(/^Redo /, 'Redid ');

  function undoFlow(dir) {
    return async (store) => {
      const u = store.state.undo;
      const target = u && u[dir];
      if (!target) {
        const blocked = u && u[`${dir}Blocked`];
        if (u && u.busy) store.actions.notify(`${dir === 'undo' ? 'Undo' : 'Redo'} is unavailable while a merge, rebase or similar operation is in progress`);
        else if (blocked) store.actions.notify(`Can't ${dir}: ${blocked}`);
        else store.actions.notify(`Nothing to ${dir}`);
        return false;
      }
      const res = await store.actions.write(dir, []);
      const note = res && res.upstreamRestored === false ? ' (its upstream could not be restored)' : '';
      store.actions.notify(`${pastTense((res && res.description) || target.description)}${note}`);
      return true;
    };
  }

  // ---------------------------------------------------------------- misc

  async function openTerminalFlow() {
    const api = window.api;
    if (!api || !api.app || typeof api.app.openTerminal !== 'function') throw new Error('Opening a terminal is not available');
    try {
      await api.app.openTerminal();
    } catch (e) {
      throw C.util.toError(e);
    }
    return true;
  }

  async function openWorktreeFlow(store, path) {
    if (typeof path !== 'string' || !path) return false;
    const api = window.api;
    if (!api || !api.app || typeof api.app.openWorktree !== 'function') throw new Error('Opening a worktree is not available');
    try {
      await api.app.openWorktree(path);
    } catch (e) {
      throw C.util.toError(e);
    }
    return true;
  }

  window.PLFlows = {
    undo: flow('undo', undoFlow('undo')),
    redo: flow('redo', undoFlow('redo')),
    openTerminal: flow('openTerminal', openTerminalFlow),
    openWorktree: flow('openWorktree', openWorktreeFlow),
    cancel: async (store) => {
      try {
        return !!(store && store.actions && (await store.actions.cancelRemote()));
      } catch {
        return false;
      }
    },
    isRunning: (store) => running.has(store),
    shortcutFor: P.shortcutFor,
    shortcutBlocked: P.shortcutBlocked,
  };

  // What the other flow files build on (they add their flows to PLFlows, and their shared helpers here).
  window.PLFlowKit = {
    C, flow, settle, report, dialog, dn, short, Op, status, currentBranch, localBranches, upstreamOf,
    keptStashTitle, keptStashText, stashNote, reportOutcome, authMessage, connectView, connectAlert, CONNECT_KINDS, tagConflictsAlert,
    /** Add flows to window.PLFlows: {name: body} (bodies as for flow(); PLPolicy.FREE_FLOWS skip the guard). */
    register(bodies) {
      for (const [name, body] of Object.entries(bodies)) window.PLFlows[name] = flow(name, body);
    },
    _internal: { authMessage, sshAgentHint }, // exported for unit tests only
  };
})();
