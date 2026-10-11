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
 *   watchdog arms on them). A normal "Received disconnect … 11: Bye" is no ending; the bare
 *   '@@@…' frame of ssh's security warnings is one (BANNER: Windows' own OpenSSH passes git only
 *   its first write, which for a changed host key is that frame alone).
 * TOO_MANY: the "Too many authentication failures" disconnect (an 'auth' line of its own).
 * sshFacts(lines) -> {kind, line, user, host, changed, fingerprint, keyName, bannerOnly} | null.
 * splitRemote(url) -> {host, port, user} | null: a lenient, shell-safe split of a configured remote.
 * sshCommand({host, port, user}) -> 'ssh -T [-p <port>] [<user>@]<host>'.
 * asciiHost(host) -> the host's ASCII (punycode) form; unbracket(host): an IPv6 host without '[]'.
 * USER, tokenShaped(name), userOk(name): the one rule for a user name the app shows or keeps in a
 *   URL (clone-repository.md §13 Q7; src/clone-url.js uses it too).
 */
(function (exports) {
  'use strict';

  // The starts of ssh's lines more than one pattern below is built from.
  const RESOLVE = '^ssh: Could not resolve hostname';
  const CONNECT = '^ssh: connect to host ';
  const DISCONNECT = '^Received disconnect from ';

  const SSH_LINES = Object.freeze({
    // OpenSSH names user@host before its refusal (the resolved HostName, never an alias or a port),
    // so "(keyboard-interactive)" or "(password)" first match too; older and vendor builds print
    // the refusal alone. Either way the whole line, from its start.
    auth: Object.freeze([
      /^\S+@\S+: Permission denied \([a-z0-9@.,-]+\)\.?\r?$/m,
      /^Permission denied \([a-z0-9@.,-]+\)\.?\r?$/m,
      new RegExp(`${DISCONNECT}.*: Too many authentication failures`, 'm'),
    ]),
    'host-key': Object.freeze([/^Host key verification failed/m, /^No .* host key is known for/m]),
    changed: Object.freeze([
      /^@+\s*WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED/m,
      /^Host key for \S+ has changed and you have requested strict checking/m,
    ]),
    unreachable: Object.freeze([
      new RegExp(RESOLVE, 'm'),
      new RegExp(`${CONNECT}.* (?:Connection refused|Operation timed out|Connection timed out|Network is unreachable|No route to host|Host is down)`, 'm'),
    ]),
  });

  // The frame around ssh's security warnings (a changed host key, an unprotected key file, possible
  // DNS spoofing): a line of '@' alone.
  const BANNER = /^@{20,}\r?$/;
  // The warning a frame holds, when it isn't a changed host key's.
  const OTHER_WARNING = /^@+\s*WARNING: (?!REMOTE HOST IDENTIFICATION HAS CHANGED)/;

  const SSH_ENDINGS = Object.freeze([
    ...Object.values(SSH_LINES).flat(),
    BANNER,
    /^kex_exchange_identification: /,
    /^Connection closed by /,
    /^Connection reset by /,
    /^Unable to negotiate with /,
    // Any disconnect but reason 11 (SSH2_DISCONNECT_BY_APPLICATION: a normal "Bye", which a
    // successful fetch can print before a long silent transfer).
    new RegExp(`${DISCONNECT}(?!.*:\\s?11:\\s)`),
    // A connection that failed for a reason the unreachable rule doesn't name.
    new RegExp(CONNECT),
  ]);

  const TOO_MANY = SSH_LINES.auth[2];
  // The kinds sshFacts reports, in SSH_LINES (`changed` is a fact of a 'host-key' failure).
  const KINDS = ['auth', 'host-key', 'unreachable'];
  const FINGERPRINT_LEAD = /^The fingerprint for the \S+ key sent by the remote host is\r?$/;
  const FINGERPRINT = /^(SHA256:[A-Za-z0-9+/]{43})\.?\r?$/;
  const KEY_FOR = /^Host key for (\S+) has changed and you have requested strict checking/;
  // The name ssh saved the key under (its known_hosts entry): the resolved host, '[host]:port'
  // for a port other than 22. Shown in an `ssh-keygen -R` command, so nothing a shell would read.
  const KEY_NAME = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*|\[[A-Za-z0-9._:-]+\](?::\d{1,5})?)$/;
  const PERMISSION_DENIED = ': Permission denied (';

  const any = (res, s) => res.some((re) => re.test(s));

  /**
   * What ssh said, from git's stderr `lines` (an array): `kind` and `line` of the last SSH_LINES
   * line ('auth', 'host-key' or 'unreachable'; the line without its '\r'); `user` and `host` from
   * an auth line's `user@host: ` prefix (raw: the caller checks them before any use); `changed`
   * when ssh said the host key changed; then `fingerprint`, the key it was sent ('SHA256:…'), and
   * `keyName`, the known_hosts name of the saved key ('[127.0.0.1]:22222'; KEY_NAME only), each the
   * FIRST after the warning: a later block (a server's banner can print anything) never replaces
   * them; null when ssh said none. Without a line of a kind, a changed key's warning still reads as
   * 'host-key' (changed), and so does a lone BANNER with no other warning named (`bannerOnly`:
   * Windows' own OpenSSH passed only its first line, so all that is known is "a changed host key,
   * or another ssh security warning"). null when no line is ssh's.
   */
  function sshFacts(lines) {
    const list = Array.isArray(lines) ? lines.map((l) => String(l)) : [];
    let hit = null;
    let changed = false;
    let fingerprint = null;
    let keyName = null;
    list.forEach((l, i) => {
      if (any(SSH_LINES.changed, l)) changed = true;
      if (changed && fingerprint === null && FINGERPRINT_LEAD.test(l)) {
        const m = FINGERPRINT.exec(list[i + 1] || '');
        if (m) fingerprint = m[1];
      }
      const key = changed && keyName === null ? KEY_FOR.exec(l) : null;
      if (key && KEY_NAME.test(key[1])) keyName = key[1];
      const kind = KINDS.find((k) => any(SSH_LINES[k], l));
      if (kind) hit = { kind, line: l.replace(/\r$/, '') };
    });
    if (!hit) {
      const banner = list.find((l) => BANNER.test(l));
      if (changed || (banner && !list.some((l) => OTHER_WARNING.test(l)))) {
        const line = (changed ? list.find((l) => any(SSH_LINES.changed, l)) : banner).replace(/\r$/, '');
        return { kind: 'host-key', line, user: null, host: null, changed: true, fingerprint, keyName, bannerOnly: !changed };
      }
      return null;
    }
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
    return { kind: hit.kind, line: hit.line, user, host, changed, fingerprint, keyName, bannerOnly: false };
  }

  // A user name the app shows or keeps in a URL (clone-repository.md §13 Q7): never an option
  // ('-oProxyCommand@h' would reach ssh as one), nothing a shell would read.
  const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,38}$/;
  // Known token prefixes (the shapes src/redact.js masks, and a few more hosts'), or a long run of
  // letters and digits that mixes both (what a generated token looks like, not a person's name).
  const TOKEN_PREFIX = /^(?:github_pat_|gh[pousr]_|glpat-|glptt-|hf_|npm_|pypi-|xox[abpr]-|(?:AKIA|ASIA)[0-9A-Z]{12})/;
  const tokenShaped = (u) => TOKEN_PREFIX.test(u) || (/^[A-Za-z0-9]{24,}$/.test(u) && /[A-Za-z]/.test(u) && /\d/.test(u));
  /** True for a user name that may be shown and used: USER's characters, and not token-shaped. */
  const userOk = (name) => typeof name === 'string' && USER.test(name) && !tokenShaped(name);

  // What a remote's URL may hold to be shown (and copied into a command): a host name or an IPv4
  // address (letters, digits, '.', '_', '-', never a leading '-'), or a bracketed IPv6 literal
  // (two colons at least: '[cafe:22]' is no IPv6 address); a port of 1-65535. Nothing a shell
  // would read.
  const HOST = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*|\[(?=[^\]]*:[^\]]*:)[0-9A-Fa-f:.]+\])$/;
  const MAX_PORT = 65535;

  /**
   * {host, port, user} when the host and port may be shown, else null. A user outside USER's
   * characters refuses the whole URL; a token-shaped one is left out (never shown).
   */
  function parts(user, host, port) {
    if (!host || !HOST.test(host)) return null;
    if (user !== null && !USER.test(user)) return null;
    if (port !== null && port !== '' && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > MAX_PORT)) return null;
    return { host, port: port ? Number(port) : null, user: user !== null && userOk(user) ? user : null };
  }

  /**
   * A configured remote's URL split for display: `ssh://[user@]host[:port]/…` (also git+ssh://
   * and ssh+git://) or scp-like `[user@]host:path`. Not a validator: lenient where the clone
   * parser is strict (`git@github_work:o/r.git`), but null for anything it can't show safely,
   * another scheme, a local path (`C:/x`, `/x`), or a bracketed scp host that isn't an IPv6
   * literal (git reads `[host:port]:path` as a host and a port; it is refused here instead).
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
  const unbracket = (host) => String(host).replace(/^\[(.*)\]$/, '$1');

  /** `ssh -T [-p <port>] [<user>@]<host>`: the command that checks a connection from a terminal. */
  function sshCommand({ host, port, user } = {}) {
    const target = `${user ? `${user}@` : ''}${unbracket(host)}`;
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
  exports.BANNER = BANNER;
  exports.sshFacts = sshFacts;
  exports.splitRemote = splitRemote;
  exports.sshCommand = sshCommand;
  exports.asciiHost = asciiHost;
  exports.unbracket = unbracket;
  exports.USER = USER;
  exports.tokenShaped = tokenShaped;
  exports.userOk = userOk;
})(typeof module !== 'undefined' ? module.exports : (window.PLSshText = {})); // NOSONAR(S1121): the CommonJS-or-window export idiom
