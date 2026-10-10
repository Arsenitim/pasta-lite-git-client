/*
 * Pasta Lite - what ssh prints when a connection fails, and how a remote's ssh target is shown
 * (docs/plans/ssh-remote-errors.md §4.1). The one place ssh's lines are parsed: src/git-errors.js
 * builds its connection rules from SSH_LINES, the callers' stderr watch (src/ssh-stall.js) arms on
 * SSH_ENDINGS, and fetch, push, clone and the page read sshFacts.
 *
 * Pure and requires nothing: src/git-errors.js loads it while src/exec.js is still loading, so a
 * require here could close a cycle. Works in Node (`require('./src/ssh-text.js')`) and in the
 * browser as a plain <script> (exposes `window.PLSshText`), like src/error-kinds.js.
 *
 * SSH_LINES: {auth, 'host-key', changed, unreachable}: ssh's own lines, anchored (a hook's output
 *   or a ref name can't fake one mid-line), each tolerating the '\r' of Windows' '\r\n'. `changed`
 *   (a host key that changed) is a fact, not a kind: its kind is 'host-key'.
 * SSH_ENDINGS: every SSH_LINES pattern plus the endings ssh prints that classify to nothing (the
 *   watchdog arms on them).
 * TOO_MANY: the "Too many authentication failures" disconnect (an 'auth' line of its own).
 * sshFacts(lines) -> {kind, line, user, host, changed, fingerprint} | null.
 * splitRemote(url) -> {host, port, user} | null: a lenient, shell-safe split of a configured remote.
 * sshCommand({host, port, user}) -> 'ssh -T [-p <port>] [<user>@]<host>'.
 * asciiHost(host) -> the host's ASCII (punycode) form.
 */
(function (exports) {
  'use strict';

  const SSH_LINES = Object.freeze({
    // ssh always names user@host before its refusal (the resolved HostName, never an alias or a
    // port), so "(keyboard-interactive)" or "(password)" first match too.
    auth: Object.freeze([
      /^\S+@\S+: Permission denied \([a-z0-9@.,-]+\)\.?\r?$/m,
      /^Received disconnect from .*: Too many authentication failures/m,
    ]),
    'host-key': Object.freeze([/^Host key verification failed/m, /^No .* host key is known for/m]),
    changed: Object.freeze([
      /^@+\s*WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED/m,
      /^Host key for \S+ has changed and you have requested strict checking/m,
    ]),
    unreachable: Object.freeze([
      /^ssh: Could not resolve hostname/m,
      /^ssh: connect to host .* (?:Connection refused|Operation timed out|Connection timed out|Network is unreachable|No route to host|Host is down)/m,
    ]),
  });

  const SSH_ENDINGS = Object.freeze([
    ...Object.values(SSH_LINES).flat(),
    /^kex_exchange_identification: /,
    /^Connection closed by /,
    /^Connection reset by /,
    /^Unable to negotiate with /,
    /^Received disconnect from /,
    /^ssh: connect to host /,
    /^ssh: Could not resolve hostname /,
  ]);

  const TOO_MANY = SSH_LINES.auth[1];
  // The kinds sshFacts reports, in SSH_LINES (`changed` is a fact of a 'host-key' failure).
  const KINDS = ['auth', 'host-key', 'unreachable'];
  const FINGERPRINT_LEAD = /^The fingerprint for the \S+ key sent by the remote host is\r?$/;
  const FINGERPRINT = /^(SHA256:[A-Za-z0-9+/]{43})\.?\r?$/;
  const PERMISSION_DENIED = ': Permission denied (';

  const any = (res, s) => res.some((re) => re.test(s));

  /**
   * What ssh said, from git's stderr `lines` (an array): `kind` and `line` of the last SSH_LINES
   * line ('auth', 'host-key' or 'unreachable'; the line without its '\r'); `user` and `host` from
   * an auth line's `user@host: ` prefix (raw: the caller checks them before any use); `changed`
   * when ssh said the host key changed; `fingerprint` the key it was sent then ('SHA256:…', or
   * null). null when no line is ssh's.
   */
  function sshFacts(lines) {
    const list = Array.isArray(lines) ? lines.map((l) => String(l)) : [];
    let hit = null;
    let changed = false;
    let fingerprint = null;
    list.forEach((l, i) => {
      if (any(SSH_LINES.changed, l)) changed = true;
      if (FINGERPRINT_LEAD.test(l)) {
        const m = FINGERPRINT.exec(list[i + 1] || '');
        if (m) fingerprint = m[1];
      }
      const kind = KINDS.find((k) => any(SSH_LINES[k], l));
      if (kind) hit = { kind, line: l.replace(/\r$/, '') };
    });
    if (!hit) return null;
    let user = null;
    let host = null;
    const cut = hit.kind === 'auth' ? hit.line.indexOf(PERMISSION_DENIED) : -1;
    if (cut > 0) {
      const who = hit.line.slice(0, cut);
      const at = who.lastIndexOf('@');
      if (at > 0 && at < who.length - 1) {
        user = who.slice(0, at);
        host = who.slice(at + 1);
      }
    }
    return { kind: hit.kind, line: hit.line, user, host, changed, fingerprint };
  }

  // What a remote's URL may hold to be shown (and copied into a command): a host name or an IPv4
  // address (letters, digits, '.', '_', '-', never a leading '-'), or a bracketed IPv6 address; a
  // port of 1-65535; a user of the same letters plus '+'. Nothing a shell would read.
  const HOST = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\])$/;
  const USER = /^[A-Za-z0-9._+][A-Za-z0-9._+-]{0,63}$/;
  const MAX_PORT = 65535;

  /** {host, port, user} when every part may be shown, else null. */
  function parts(user, host, port) {
    if (!host || !HOST.test(host)) return null;
    if (user !== null && !USER.test(user)) return null;
    if (port !== null && port !== '' && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > MAX_PORT)) return null;
    return { host, port: port ? Number(port) : null, user };
  }

  /**
   * A configured remote's URL split for display: `ssh://[user@]host[:port]/…` (also git+ssh://
   * and ssh+git://) or scp-like `[user@]host:path`. Not a validator: lenient where the clone
   * parser is strict (`git@github_work:o/r.git`, `ssh://deploy+ci@host/r`), but null for anything
   * it can't show safely, another scheme, or a local path (`C:/x`, `/x`).
   */
  function splitRemote(url) {
    const s = String(url == null ? '' : url).trim();
    const scheme = /^(?:ssh|git\+ssh|ssh\+git):\/\/([^/]*)(?:\/|$)/i.exec(s);
    if (scheme) {
      const at = scheme[1].lastIndexOf('@');
      const m = /^(\[[^\]]*\]|[^:]*)(?::([^:]*))?$/.exec(scheme[1].slice(at + 1));
      return m ? parts(at < 0 ? null : scheme[1].slice(0, at), m[1], m[2] === undefined ? null : m[2]) : null;
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s)) return null;
    // scp-like, as git reads it: a ':' before any '/', with a bracketed host as one piece.
    const bracketed = /^(?:([^@/[\]]*)@)?(\[[^\]/]*\]):/.exec(s);
    if (bracketed) return parts(bracketed[1] === undefined ? null : bracketed[1], bracketed[2], null);
    const colon = s.indexOf(':');
    const slash = s.indexOf('/');
    if (colon < 0 || (slash >= 0 && slash < colon)) return null;
    const left = s.slice(0, colon);
    const at = left.lastIndexOf('@');
    const host = left.slice(at + 1);
    if (host.length < 2) return null; // a drive letter (C:/x), not a host
    return parts(at < 0 ? null : left.slice(0, at), host, null);
  }

  /** The host as ssh takes it on a command line: an IPv6 address without its brackets. */
  const bare = (host) => String(host).replace(/^\[(.*)\]$/, '$1');

  /** `ssh -T [-p <port>] [<user>@]<host>`: the command that checks a connection from a terminal. */
  function sshCommand({ host, port, user } = {}) {
    const target = `${user ? `${user}@` : ''}${bare(host)}`;
    return `ssh -T ${port ? `-p ${port} ` : ''}${target}`;
  }

  /**
   * `host` in ASCII: a name with other letters in its punycode form (WHATWG URL), the name ssh saved
   * or will save, never a lookalike. A host that is ASCII already, or that URL can't read, is
   * returned as it is.
   */
  function asciiHost(host) {
    const h = String(host == null ? '' : host);
    if (/^[\x21-\x7e]*$/.test(h)) return h;
    try {
      return new URL(`http://${h}/`).hostname || h;
    } catch {
      return h;
    }
  }

  exports.SSH_LINES = SSH_LINES;
  exports.SSH_ENDINGS = SSH_ENDINGS;
  exports.TOO_MANY = TOO_MANY;
  exports.sshFacts = sshFacts;
  exports.splitRemote = splitRemote;
  exports.sshCommand = sshCommand;
  exports.asciiHost = asciiHost;
})(typeof module !== 'undefined' ? module.exports : (window.PLSshText = {})); // NOSONAR(S1121): the CommonJS-or-window export idiom
