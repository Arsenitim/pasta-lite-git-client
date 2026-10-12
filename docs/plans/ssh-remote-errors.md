# Pasta Lite: ssh failures on every remote op

Plan for the SSH follow-up that [clone-repository.md](clone-repository.md) §15 ("Follow-up (a
separate PR after #9)") records, together with §9.3, §13 Q5 and QA row 6 there. In short:
- say "unknown host key" (and the other connection failures clone already explains) on fetch,
  pull and push too
- stop waiting for an ssh that has already failed but never exits (Windows' OpenSSH on a pipe)
- keep what ssh said when the user cancels
- stop Windows' OpenSSH from prompting on a console nobody can see
- make the auth and host-key messages say which host and what to run

Status: **plan**. Written 2026-10-10 on `fix/ssh-remote-errors`, branched from `main` at
`76dbbc3` (the merge of PR #9, Clone Repository). Revised the same day after an expert review
(findings C1, H1–H4, M1–M10, L1–L9; the decisions on its open questions are in §10). No code is
changed by this document. **Built** the same day, S0–S4 on this branch (S3 in its own commits);
where the build differs is §12, and the Windows QA is §13: on an interactive desktop W6 passed and
Windows' OpenSSH exits after its error with its whole message; the exit hang and the
first-write-only relay happen only when git runs inside an sshd session. S2 is kept as insurance
(§12); S3 fixes the hidden-prompt hang, which is real on the desktop.

**Sources.**
- The code, read directly (file and line numbers below are from `76dbbc3`).
- **Windows QA** (run for clone's QA row 6): Windows 11, Git for Windows 2.52.0.windows.1, Node
  22.23.3, the app's own path (`cloneRepo` → `gitAt` → `spawnGit` with `windowsHide`, not detached
  on Windows, `GIT_TERMINAL_PROMPT=0`), a throwaway passphrase-protected key with no `.pub`,
  github.com. Marked **(Windows QA)**.
- Facts marked **(verified)** were checked for this plan on macOS 15 with OpenSSH_9.9p2 (LibreSSL
  3.3.6), git 2.51.2 and Node, in the session scratchpad: a non-root `sshd` on 127.0.0.1 with
  throwaway keys (`PerSourcePenalties no`), a Node HTTP server answering 401, a fake ssh (a Node
  script as `GIT_SSH_COMMAND`), and a prototype of the watchdog (§4.3) run against the real
  `spawnGit` through `onStderr` and an abort. No real credentials, no network beyond 127.0.0.1.
  The fake ssh has run on macOS only so far: S0 (§8) runs it on Windows before anything else.

**Size scale** (as in the other plans, tests included): **S** < 500 LOC, **M** 500–1,500.

---

## 1. Summary

### 1.1 Milestones

| Milestone | Scope | Size |
|---|---|---|
| **S0** | Two checks before any code merges: **QA row W6** on the Windows box (does Windows' OpenSSH hang after a *successful* connection?), and the fake ssh's `serve` mode plus one `deny` test green on Windows CI (and on the box) | S |
| **S1** | Classification and messages, no change to how processes run: one shared rule list for connection failures (`auth`, `host-key`, `not-found`, `unreachable`) on fetch, pull, push and clone; the auth rule anchored to ssh's real line; a changed host key told apart from an unknown one; the remote's ssh host / port / user on the error; the remote's name on the error; shared renderer texts with the `ssh -T` command and per-platform ssh-agent hints | S (~500 LOC, half tests) |
| **S2** | The stall watchdog and what ssh said on a cancel, both built **in the callers** (`src/remote.js`, `src/clone.js`) on `spawnGit`'s existing `onStderr` and an abort: a watchdog that cancels git when its stderr ends with one of ssh's endings and nothing follows for 10 s (Windows by default); the ssh line kept for a user's cancel. `spawnGit` is unchanged | S (~500 LOC, most of it tests) |
| **S3** | Windows only, gated: `SSH_ASKPASS` = Git for Windows' `usr\bin\false.exe` with `SSH_ASKPASS_REQUIRE=force` for remote ops, when the user set neither variable. Turns the hidden-console prompt hang into a fast failure. Merged only after its Windows QA rows pass | S (~150 LOC) |
| **S4** | Docs and the rest of the manual QA (§7.5): CHANGELOG, SECURITY.md, CONTRIBUTING's architecture note, the pointers in clone-repository.md §15 and roadmap.md §3.5 | S |

Each milestone ends with `npm test` and `npm run lint` green on macOS, Ubuntu and Windows CI and is
reviewable on its own. S0 gates S1 (W6 decides one sentence of the Windows hint, §4.5, and the
fake ssh must work on Windows before tests are written against it). S2 needs S1's patterns. S3
needs S2's watchdog (Windows' OpenSSH turns the prompt into an error line and then hangs on exit).

### 1.2 Key decisions

1. **One list of connection rules, used by every remote op.** Clone tries
   `auth, hostKey, remoteNotFound, unreachable` first (`src/clone.js:55`); fetch only tries `auth`
   (`src/remote.js:85`) and push only `auth` (`src/git-errors.js:187`). A new `CONNECT_RULES` in
   `src/git-errors.js` holds those four; clone's `RULE_ORDER` starts with it, and fetch (so pull)
   and push use it. No new error kinds: all four exist (`src/error-kinds.js:18`, `:34`, `:51`,
   `:75`).
2. **ssh's lines live in one require-free module.** `src/ssh-text.js` holds the ssh line patterns,
   `sshFacts(lines)` and the display helpers, and requires nothing. `src/git-errors.js` builds its
   rules from it and the watcher reads it. A module that requires `git-errors.js` from the process
   layer would close a cycle: `git-errors.js:8` destructures `{GitError, tagError}` from `./exec`
   at load, and `exec.js:12` destructures from `./git-process`.
3. **`spawnGit` is not changed.** The watchdog and the cancel's `said` are built in the callers
   with what `spawnGit` already offers: `onStderr` (`src/git-process.js:555-562`, not called once
   git is being killed) and a signal. A stall aborts an `AbortController` linked to the op's
   signal with `AbortSignal.any`, which is exactly the Cancel path the Windows QA measured. The
   process layer keeps no ssh knowledge.
4. **A changed host key is never "unknown".** ssh ends both cases with the same line, "Host key
   verification failed." **(verified)**. Today clone tells the user to connect once and accept
   the key (`renderer/clone.js:104-111`), which for a changed key is the wrong advice. A changed
   key gets its own text, with the fingerprint, that never suggests accepting it.
5. **The watchdog arms on ssh's endings and cancels on silence after them.** It arms on a complete
   stderr line from its own list of ssh endings (§4.3; wider than the classification rules) and
   cancels git after **10 s** with no further non-empty stderr line. OpenSSH prints the publickey
   line only after every key failed, and exits in the same millisecond **(verified)**; git dies on
   the first failed connection and tries no other URL **(verified, two pushurls)**.
6. **The watchdog's timer is on by default on Windows only.** The hang is Windows' OpenSSH's
   (Windows QA). On macOS and Linux ssh exits with its error **(verified)**, so a timer there would
   add risk (a wrapper script that retries silently for longer than 10 s) and no benefit. The
   tests run it on every platform through an explicit `stallMs`.
7. **`said` is for a user's cancel only.** On POSIX ssh exits as soon as it prints its line, and
   on Windows the watchdog acts at 10 s, long before the 120 s timeout, so a timeout carrying an
   ssh line is not a real case. A cancel during the 10 s (or with the timer off) shows the line.
8. **The askpass is Git for Windows' `false.exe`, not a program of ours.** The packaged app can't
   run as Node (`"runAsNode": false`, `package.json:84`; `src/rebase-editor.js:8-9`), and a file
   inside `app.asar` can't be executed by ssh. `<Git for Windows>\usr\bin\false.exe` is found the
   way `msysShell` finds `sh.exe` (`src/git-process.js:190-200`), ignores the prompt argument,
   prints nothing and exits 1. It is set only on Windows, only for fetch / push / clone, and only
   when the user's environment has neither `SSH_ASKPASS` nor `SSH_ASKPASS_REQUIRE`. P3a later
   swaps the binary for its real askpass UI (roadmap.md §3.5) with the same env scope.
9. **The `ssh -T` target comes from the remote's URL; only the user comes from ssh.** ssh prints
   the resolved `HostName` with no alias and no port **(verified: `Host myalias` / `HostName
   127.0.0.1` / `Port 22222` → `az@127.0.0.1: Permission denied (publickey).`)**, so its host would
   make `ssh -T` test the wrong key for a `github-work:` alias. Main reads the host and port from
   `git remote get-url --all` (which applies `insteadOf`) with a lenient, shell-safe split, and
   takes only the effective user from ssh's line, after the user-name and token-shape checks.
   ssh's host is shown as text only. The URL itself never leaves main.

---

## 2. Scope

### 2.1 In this plan

- Fetch (and Fetch All), pull (its fetch step) and push classify `host-key`, `not-found` and
  `unreachable` as clone does, in addition to `auth`.
- The texts for `auth` (ssh variant, and "too many authentication failures"), `host-key`, a changed
  host key, `not-found` and `unreachable` on every remote op, with the host, the `ssh -T` command
  and per-platform hints. Clone's dialog uses the same texts.
- The stall watchdog (timer on Windows by default) for fetch, pull's fetch, push and clone.
- What ssh said before a user's cancel, in the cancel's explanation.
- Windows, gated: `SSH_ASKPASS` = `false.exe` with `SSH_ASKPASS_REQUIRE=force` for fetch, push and
  clone.

### 2.2 Non-goals and later

| Item | Why not here |
|---|---|
| A real passphrase / host-key prompt | Roadmap P3a (roadmap.md §3.5): a helper, a socket, a token, a modal. S3's env scope is what P3a fills in |
| "Which key" in the message | ssh names the key only in its prompt (verified: "Enter passphrase for key '…'") or with `-v`. `false.exe` discards the prompt. P3a's helper gets `keyPath` |
| Detecting which ssh git runs (bundled, Windows' OpenSSH, plink) to tailor the hint | Needs `core.sshCommand`, `GIT_SSH_COMMAND`, `GIT_SSH` and the installer's choice read and interpreted. The Windows hint names the setups instead (§4.5). Later, if users ask |
| `BatchMode` | Decided against in clone-repository.md §13 Q5; nothing here changes that |
| A timeout that carries ssh's line | Not a real case (decision 7) |
| Network done by non-remote ops: Git LFS smudge during checkout / merge / rebase (git-lfs may run `ssh … git-lfs-authenticate`), lazy fetches in a partial clone opened from elsewhere | Not remote ops: no ssh env, no watchdog. Reads of image blobs already pass `GIT_NO_LAZY_FETCH` (`src/blob-revisions.js:48`). Recorded in §9 |
| Redacting `err.message` of every remote failure | Today a GitError's message (git's stderr) goes to the page as it is (`src/ipc-errors.js:68`); git itself strips credentials from URLs it prints. Only the new `said.line` is redacted here. A separate hardening |
| Friendlier `timeout` text ("git timed out after 120000 ms", `src/git-process.js:572`) | Unrelated wording |
| plink / TortoisePlink | They ignore `SSH_ASKPASS` and print other lines, so nothing here changes them (§4.4). TortoisePlink shows its own dialogs |
| Windows 10's inbox OpenSSH 8.1 | It predates `SSH_ASKPASS_REQUIRE` (OpenSSH 8.4), so S3 can't help it; Cancel and the 120 s timeout remain (§9, Q7) |
| A stdout tap on `spawnGit` | Would let stdout bytes disarm the watchdog too, but `spawnGit` stays unchanged (decision 3). The residual risk is in §9; Q10 |

### 2.3 Dependencies

- PR #9 (merged): `onStderr` (`src/git-process.js:555-562`), the clone rules, `parseCloneUrl`.
- `AbortSignal.any`: Node ≥ 20.3; the app runs Electron 44 (`package.json:39`) and the tests run on
  Node 22.
- Nothing from P3a. P3a, when built, replaces S3's `false.exe` with its helper and keeps the same
  scope rules (§4.4).

---

## 3. What is known

### 3.1 The remote ops (all of them)

| Op | Where git runs | Timeout | Classified today |
|---|---|---|---|
| fetch (Fetch, Fetch *remote*, Fetch All: one `git fetch` per remote) | `src/remote.js:79`, loop `:106`; op `src/ops.js:539-542` | 120 s (`REMOTE_TIMEOUT_MS`, `src/remote.js:13`, `:16`) | `auth`, `checked-out-elsewhere` (`:85`) |
| pull (any mode) | its fetch step: `src/pull.js:49` (mode `fetch`), `:55`; op `src/ops.js:545-553` | fetch's | as fetch |
| push | `src/remote.js:141`; op `src/ops.js:554-563` | 120 s | ref rejections, `auth`, `mirror-repo` (`classifyPush`, `src/git-errors.js:171-192`) |
| clone | `src/clone.js:181-183`; app op `src/ops.js:777` | none (by design, clone-repository.md decision 5) | `RULE_ORDER` (`src/clone.js:55`) |

There is no `ls-remote`, no background or automatic fetch (roadmap P3b, not built) and no
submodule command (`GLOBAL_ARGS`, `src/git-process.js:90-103`). Remote names are always configured
ones (`remoteName`, `src/op-validators.js:105-109`). Every op runs inside `exec.withSignal` with its
signal (`src/runner.js:52`), and the ops also pass it explicitly (`src/ops.js:542`, `:553`, `:563`,
`:777`). Indirect network use (LFS, lazy fetch) is out of scope (§2.2).

### 3.2 Windows QA (from clone's QA row 6)

- **Git for Windows' bundled ssh** (`/usr/bin/ssh`, OpenSSH_10.2p1, the default) **fails fast**:
  a passphrase needed → about 0.9 s, exit 128, `git@github.com: Permission denied (publickey).`
  (kind `auth`); an unknown host key → about 0.6 s, `Host key verification failed.` (kind
  `host-key`). It can't open `/dev/tty` and skips the prompt. `SSH_ASKPASS`,
  `SSH_ASKPASS_REQUIRE`, `DISPLAY` and `GIT_ASKPASS` were all unset in ssh's environment.
  `BatchMode=yes` gave byte-identical output.
- **Windows' own OpenSSH** (`C:/Windows/System32/OpenSSH/ssh.exe`, OpenSSH_for_Windows_9.5p2)
  **hangs**. git runs it when:
  - the user sets `core.sshCommand`, `GIT_SSH_COMMAND` or `GIT_SSH` to it;
  - Git for Windows was installed with **"Use external OpenSSH"** (git then runs the `ssh` it
    finds on `PATH`, which is Windows' own);
  - git is **MinGit**, which bundles no ssh (and no `false.exe`, §4.4).

  The two hangs:
  1. *Prompt hang*: without BatchMode, for a passphrase or an unknown host key, it waits on git's
     hidden console. Nothing beyond "Cloning into…" is printed; it never ends (watched for 150 s).
  2. *Exit hang*: on any failure (with BatchMode too) it prints its error line, then never exits
     while its stderr is a pipe. Reproduced outside the app (`git ls-remote … 2>&1 | findstr`).
     With stderr to a file it exits in about 0.5 s with 255. **Unknown:** whether a successful
     connection hangs the same way (QA row W6, run first: S0).
     **Answered by the Windows QA of this branch (§13), and it depends on the session.** On an
     interactive desktop (the user's, the packaged 0.2.1 build, which starts git as this branch
     does: `windowsHide`, stderr a pipe) Windows' OpenSSH works: a successful connection ends
     normally (W6 passes), and a refused key fails within seconds with git's whole stderr (ssh's
     line, "fatal: Could not read from remote repository." and the access-rights hint). Only when
     git runs inside an **sshd session** (the box's QA over ssh, and most likely clone's QA row 6)
     does it relay no stdout and only its first stderr write, and never exit, after a failure and
     after a success alike; a changed key's warning then reaches git only as its `@@@…` frame
     (W8). The *prompt hang* (1) is real on the desktop: an unknown host key with Windows' OpenSSH
     left the app at "Working…" with no console to answer in (0.2.1, no S3).
- **Cancel always worked**: the op settled about 120 ms after the abort, the whole tree (git shim,
  git, sh, ssh) gone. Since `signalGroup` skips `taskkill` once git has exited
  (`src/git-process.js:303-306`), that ssh died in the `taskkill /T` tree **implies git was still
  running** during the exit hang, waiting for ssh. W-rows confirm it by name (§7.5); §9 has the
  case where it isn't.
- **What ssh said is lost on a cancel**: `spawnGit` replaces stderr with "git was cancelled"
  (`src/git-process.js:570-577`), and clone drops it.
- **`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`** in git's env: the bundled ssh called the helper
  for the passphrase and the host-key prompt, and failed fast when it failed. Windows' OpenSSH
  called a `.cmd` helper for the passphrase; for the host key it printed "Host key verification
  failed." without prompting. Either way the prompt hang becomes an error line, which then hits
  the exit hang.

### 3.3 Verified on macOS for this plan

ssh runs exactly as git runs it from the app: detached (no controlling terminal), stdio on pipes
(`src/git-process.js:509-511`), `-F /dev/null`, `IdentitiesOnly`, no agent.

| # | Case | Result |
|---|---|---|
| V1 | passphrase key, no askpass | `az@127.0.0.1: Permission denied (publickey).`, exit 255, ~20 ms |
| V2 | unknown host, no askpass | `Host key verification failed.`, exit 255, ~16 ms |
| V3 | passphrase key / unknown host with `SSH_ASKPASS` (a logging helper that exits 1) and `SSH_ASKPASS_REQUIRE=force`, no `DISPLAY` | the helper is called with `Enter passphrase for key '…':` / `The authenticity of host … Are you sure you want to continue connecting (yes/no/[fingerprint])?`; the same last lines as V1 / V2; exit 255 in ~25 ms |
| V4 | a good key with the forced helper | success, the helper never called, output unchanged |
| V5 | a wrong key, then the good one | success, **no** "Permission denied" line |
| V6 | a wrong key, then the passphrase key | one `Permission denied (publickey).` line, printed in the same millisecond ssh exits |
| V7 | `DISPLAY` + `SSH_ASKPASS`, no `SSH_ASKPASS_REQUIRE` | **the user's helper is called**: a desktop's own askpass works today without a tty, so the app must never replace it |
| V8 | `StrictHostKeyChecking=yes`, unknown host | `No ED25519 host key is known for [127.0.0.1]:22222 and you have requested strict checking.`, then `Host key verification failed.` |
| V9 | a changed host key | the `@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@` block, `The fingerprint for the ED25519 key sent by the remote host is` / `SHA256:…`, `Offending ED25519 key in <file>:1`, `Host key for [127.0.0.1]:22222 has changed and you have requested strict checking.`, `Host key verification failed.` |
| V10 | `git fetch` / `git push` over that sshd, passphrase key and unknown host | exit 128 in ~40 ms: ssh's line, then `fatal: Could not read from remote repository.` and git's hint |
| V11 | `git push` to a remote with two `pushurl`s, the first refused | git exits 128 at the first; the second URL is never contacted (its repository unchanged). Reversed: the first is pushed, the second fails, exit 128. git never retries after an ssh failure |
| V12 | `git ls-remote` of an HTTP URL answering 401, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS=/usr/bin/false` | **git calls `SSH_ASKPASS` for its own https prompt** (no `GIT_ASKPASS` / `core.askPass`): stderr gains `error: unable to read askpass response from '/usr/bin/false'` before the usual `fatal: could not read Username for '…': terminal prompts disabled` |
| V13 | a fake ssh that prints the publickey (or host-key) line and never exits | `git fetch` never exits (killed by the harness at 4 s) |
| V14 | the watchdog prototyped in a caller: `onStderr` arms on the line, an `AbortController` aborts after N = 1 s of silence, against the real `spawnGit` | the hang settled ~1.05 s after the line, kind `aborted` with "git was cancelled" (so the caller must re-tag it, §4.3); a fake ssh that prints the line and then serves the fetch after 300 ms: no abort, the fetch succeeds; after 1,500 ms: aborted (the trade-off of decision 5) |
| V15 | a fake ssh as `GIT_SSH_COMMAND` with an `ssh://host:port` URL | `fatal: ssh variant 'simple' does not support setting port`: the tests set `GIT_SSH_VARIANT=ssh` (allowed through, `src/git-process.js:125`) or use scp-like URLs |
| V16 | ssh with `Host myalias` / `HostName 127.0.0.1` / `Port 22222` | `az@127.0.0.1: Permission denied (publickey).`: the resolved host, no alias, no port (decision 9) |
| V17 | `git remote get-url --push --all` of a remote with two `pushurl`s | both URLs, one per line; without `--all` only the first |
| V18 | `parseCloneUrl` on configured-remote shapes | refuses `git@github_work:o/r.git` ("The host name isn't valid") and `ssh://deploy+ci@host/r` ("This user name can't be used"), accepts `github-work:o/r.git`: the clone parser is too strict for remotes the user already has (§4.1) |

---

## 4. Design

### 4.1 Classification on every remote op (S1)

**`src/ssh-text.js`** (new; pure, **requires nothing**; CommonJS-or-window like
`src/error-kinds.js:91`, exposing `window.PLSshText` to the renderer):
- `SSH_LINES`: the patterns of ssh's own lines, by kind. Anchored, each tolerating a trailing
  `\r` (Windows writes `\r\n`):
  - `auth`: `^\S+@\S+: Permission denied \([a-z0-9@.,-]+\)\.?\r?$` (ssh always prints
    `user@host: `: V1, V6, V16, Windows QA; so `(keyboard-interactive)` or `(password)` first match
    too, and hook output or a ref name can't fake it);
    `^Received disconnect from .*: Too many authentication failures` (its own message, §4.5).
  - `host-key`: `^Host key verification failed`, `^No .* host key is known for` (today's,
    `src/git-errors.js:90`).
  - `changed`: `^@+\s*WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED`,
    `^Host key for \S+ has changed and you have requested strict checking` (V9). A fact, not a
    kind: the kind stays `host-key`.
  - `unreachable`: today's ssh lines (`src/git-errors.js:95-96`), with `No route to host` and
    `Host is down` added to the `connect to host` reasons.
- `SSH_ENDINGS`: the watchdog's arming list (§4.3): every `SSH_LINES` pattern plus the endings ssh
  prints that classify to nothing: `^kex_exchange_identification: `, `^Connection closed by `,
  `^Connection reset by `, `^Unable to negotiate with `, `^Received disconnect from `,
  `^ssh: connect to host `, `^ssh: Could not resolve hostname `.
- `sshFacts(lines)` → `{kind, line, user, host, changed, fingerprint}` or null, from an array of
  stderr lines: `kind` and `line` of the **last** `SSH_LINES` match; `user` / `host` from that
  line's `user@host:` prefix (raw strings: main validates them, below); `changed` when a `changed`
  pattern matched; `fingerprint` from the line after "The fingerprint for the … key sent by the
  remote host is", when it is `^SHA256:[A-Za-z0-9+/]{43}\.?\r?$`. The one place these are parsed,
  for fetch, push, clone and the watcher.
- `splitRemote(url)` → `{host, port, user}` or null: a **lenient, shell-safe display split** of a
  configured remote's URL, not a validator. `ssh://[user@]host[:port]/…` (also `git+ssh://`,
  `ssh+git://`) and scp-like `[user@]host:path`. `host`: `[A-Za-z0-9._-]+` not starting with `-`,
  or a bracketed IPv6 `\[[0-9A-Fa-f:.]+\]`; `port`: 1–65535; `user`: `[A-Za-z0-9._+-]{1,64}` not
  starting with `-`. Anything else (another scheme, a local path, an odd character) → null. It
  accepts `git@github_work:o/r.git` and `ssh://deploy+ci@host/r`, which `parseCloneUrl` refuses
  (V18).
- `sshCommand({host, port, user})` → `ssh -T [-p <port>] [<user>@]<host>`; `asciiHost(host)` →
  the host's ASCII (punycode) form through WHATWG `URL`, so the text a user copies is the name ssh
  saved or will save, never a lookalike (L7). Both used by the renderer.

**`src/git-errors.js`**
- The ssh entries of `auth` (`:41`, today the unanchored `/Permission denied \(publickey/`),
  `hostKey` (`:90`) and `unreachable` (`:95-96`) come from `SSH_LINES`. Requiring
  `./ssh-text` adds no cycle: it requires nothing.
- `CONNECT_RULES = ['auth', 'hostKey', 'remoteNotFound', 'unreachable']`, exported. Clone's
  `RULE_ORDER` (`src/clone.js:55`) becomes `[...CONNECT_RULES, 'dubiousOwnership', …]`.
- `classifyPush` (`:171-192`): after the ref lines, `kindFor(err, ...CONNECT_RULES)` replaces the
  lone `matches(err, 'auth')` (`:187`); `mirrorPush` stays after it.

**`src/clone-url.js`**: exports `userOk(name)`: today's `USER` rule (`:41`) and not
`tokenShaped` (`:47-48`). Main applies it to a user taken from ssh's line (and `splitRemote`'s own
charset already keeps shell syntax out of a remote's user). `parseCloneUrl` also returns `port`
from `parseSchemeUrl` (`:90`), for clone's `ssh -T` with a port.

**`src/remote.js`**
- `fetchRemote` (`:81-92`): `gitErrors.kindFor(err, ...CONNECT_RULES, 'checkedOutElsewhere')`
  instead of `('auth', 'checkedOutElsewhere')`. The tag-conflict retry still only sees an
  unclassified error (`:87`). Pull inherits this through `fetch` (`src/pull.js:49`, `:55`).
- Every error thrown by `fetchRemote` and `push` gets `err.remote` (the configured name): Fetch All
  loops over remotes (`:106`) and today rethrows with no name, so "Couldn't reach *remote*" had
  nothing to say. No error sets a `remote` field today (checked).
- `sshTarget(cwd, remote, facts, {push})` (new, internal), for a failure (or a cancel's `said`,
  §4.2) whose kind is `auth` or `host-key`:
  1. `git remote get-url [--push] --all <remote>` (`tryOut`, `signal: null`, a 10 s timeout: a
     cancel never blocks it, a broken config gives null). `get-url` applies `insteadOf` /
     `pushInsteadOf`, so these are the URLs ssh was given. **More than one URL** (several
     `pushurl`s, V17) → no host: the failing one can't be told apart.
  2. `splitRemote(url)` → host and port. A URL it doesn't split (https, a path) → no `ssh` field:
     the https auth text stays today's.
  3. The user: `facts.user` (ssh's effective user, which includes a `User` from `~/.ssh/config`)
     when `userOk` accepts it, else the URL's user, else none.
  4. `facts.host`, if it differs from the URL's host, is kept as `shownAs` (display text only, ASCII
     via `asciiHost`), never used in the command.
  The result: `err.ssh = {host?, port?, user?, shownAs?, changed?, fingerprint?}`.

**`src/clone.js`**: `RULE_ORDER` from `CONNECT_RULES`. Clone's host, port and user come from the
typed URL in the renderer as today (`renderer/clone.js:88-92`, now with `port`); `changed` and
`fingerprint` come from `sshFacts` of the watcher's lines (§4.3), set in `classified()`
(`:234-241`). Clone's message stays its parser's text lines (`:194`, `told`).

**`src/ipc-errors.js`**: `EXTRA_FIELDS` (`:17-34`) gains `ssh`, `said` (§4.2) and `remote`, all
plain data. `serializeError` (`:65-82`) carries them to the page for ops and for clone
(`src/clone-service.js:216`).

**`src/error-kinds.js:34`**: the `host-key` meaning becomes "ssh doesn't know the remote's host
key, or it changed (`ssh.changed`), and can't ask (no terminal)".

### 4.2 What ssh said before a cancel (S2)

- The callers' stderr watcher (§4.3) keeps the complete non-empty lines git wrote (the last 200,
  each cut at 1,000 characters). `onStderr` is not called once git is being killed
  (`src/git-process.js:556`), so after a cancel it holds exactly what came before it.
- **`src/remote.js`**: for an `aborted` error whose op signal was aborted (a user's cancel, not a
  stall), `facts = sshFacts(watch.lines())`; when there is one, `err.said = {kind, line}` with
  `line` through `redactString(line, 300)` (`src/redact.js:82-88`) and stripped of `INVISIBLE`
  characters (`src/display-text.js`), and `sshTarget` runs for `auth` / `host-key` (the host for
  the message).
- **`src/clone.js`**: the same in its cancel branch (`:191-193`), from its watcher's lines.
- No `said` for a `timeout` (decision 7), and none from a second splitter: the watcher's lines are
  the only source.
- The lines never reach a log, and on a cancel only `said.line` crosses IPC, redacted. After a
  stall (§4.3) they become the error's message: the same text git's stderr gives a failure that
  ends by itself, which the page shows today.

### 4.3 The ssh stall watchdog (S2)

**`src/ssh-stall.js`** (new; requires only `./ssh-text`; injectable timers):
```
createSshWatch({stallMs, onStall, setTimer = setTimeout, clearTimer = clearTimeout})
  -> {chunk(buf), lines(), text(), fired, stop()}
```
- **Splitting.** Bytes are decoded as UTF-8 (a `StringDecoder`, so a character split across chunks
  stays whole) and split on `\n`, `\r\n` and a lone `\r` (git's progress separator). A trailing
  `\r` is **held until the next byte**, so a `\r\n` split across two chunks is one line end, not a
  lone `\r` followed by an empty line (M2). The incomplete tail is kept for the next chunk (at most
  4 KiB, then cut).
- **Arming.** A complete line matching `SSH_ENDINGS` arms the timer for `stallMs`, or re-arms it:
  with ProxyJump the jump host's `Permission denied` is followed by the outer ssh's `Connection
  closed by …`, which is an ending too.
- **Disarming.** A complete **non-empty** line that is not an ending clears the timer. Empty lines
  (a `\r\n` pair's halves, blank lines) never do.
- **Firing.** Once: `fired` is set and `onStall()` runs. `stop()` clears the timer (git exited).
  `lines()` and `text()` (the lines joined, at most 64 KiB) are what the caller reports.
- With `stallMs` 0 the watcher still collects lines (for `sshFacts` and `said`) and never arms.

**Wiring, in the callers** (`spawnGit` unchanged):
```js
const stall = new AbortController();
const watch = createSshWatch({ stallMs, onStall: () => stall.abort() });
const opts = {
  ...remoteOpts({ timeout }),
  signal: stallMs ? AbortSignal.any([signal, stall.signal].filter(Boolean)) : signal,
  onStderr: (c) => watch.chunk(c),   // clone: also its progress parser (src/clone.js:178)
};
try { await run(cwd, args, opts); } finally { watch.stop(); }
```
- `signal` is the op's signal (passed explicitly by every op, §3.1). With none (a test), the
  composed signal holds the stall only, and the ambient signal of `withSignal` isn't consulted;
  no production path calls without one.
- **On a stall** the abort takes the Cancel path: `kill('aborted')` (`src/git-process.js:531-535`,
  `:539-540`) → `signalGroup`, which on Windows is `taskkill /T /F` of git's tree plus the MSYS
  kill by token (`:265-318`). `fetch`, `push` and `clone` don't write the index
  (`INDEX_WRITERS`, `:340-343`), so no lock is released.
- **Re-tagging.** The rejection is a GitError with kind `aborted` and "git was cancelled" (V14).
  When `watch.fired` and the op's own signal is **not** aborted (a user's cancel at the same moment
  wins), the caller turns it into the failure it is: `err.kind = undefined`, `err.stderr =
  watch.text()`, `err.message = watch.text().trim() || err.message`, then the normal
  classification (`kindFor(err, ...CONNECT_RULES, …)`, which the same `SSH_LINES` drive), then
  `tagError(err, kind, {stalled: true})`, or with no kind (an unclassified ending such as
  `kex_exchange_identification: …`) just `stalled: true` and git's text. In clone: the cancel test
  at `src/clone.js:191` gains `&& !watch.fired` (unless the signal was aborted), so a stall goes
  to `classified()` with the parser's text and keeps its folder for the cleanup (`err.made`).
- The caller logs `warn('ssh stalled after its error; git was ended', {op, kind, ms})`, no text;
  `spawnGit`'s own record says `killed: 'aborted'` (`:514-520`).

**Threading `stallMs`** (no `platform` option drives it):
- `fetch(cwd, {remote, signal, timeout, stallMs})` → `fetchRemote(..., {signal, timeout,
  stallMs})` (`src/remote.js:102-107`).
- `pull(cwd, {mode, signal, stallMs})` forwards `stallMs` to both `fetch` calls (`src/pull.js:45`,
  `:49`, `:55`).
- `push(cwd, {…, signal, timeout, stallMs})` (`src/remote.js:116`).
- `cloneRepo({…, stallMs})` (`src/clone.js:145`). Its existing `platform` option keeps driving the
  name rules only.
- The default, in one place (`src/ssh-stall.js` `defaultStallMs()`): `process.platform ===
  'win32' ? 10000 : 0`, used when `stallMs` is `undefined`. Tests pass `stallMs` explicitly.
- The ops build their arguments themselves (`src/ops.js:539-563`, `:777`; `cloneCheck`), so no
  request from a page can set or clear it.

**Why the silence rule, and why 10 s.**
- After its line a well-behaved ssh is gone within milliseconds (V6; the bundled ssh's whole op
  takes 0.6–0.9 s, Windows QA) and git dies right after (V10, V11). So the only legitimate
  continuation is something *else* after ssh: a `GIT_SSH_COMMAND` wrapper that retries with
  another key or host, or a `pre-push` hook that prints such a line and goes on.
- A retrying wrapper's second connection is silent on stderr until git exits (git fetch prints
  nothing without `--progress`), so the silence after the line is its connect time plus the
  transfer: under a second normally, a few seconds over a VPN, longer for a large transfer or a
  hardware-key touch. V14 shows both sides with N = 1 s.
- 10 s is ten times the bundled ssh's whole failed op and above any unattended reconnect, and it
  still ends Windows' OpenSSH's exit hang in a twelfth of the fetch timeout (120 s) instead of
  never for clone.
- Hook output: the line must be ssh's exact `user@host: Permission denied (…).` (or another
  ending), and the hook must then stay silent on stderr for 10 s with git not exiting.
- **Not on POSIX by default**: there is no hang to end there (V1–V10), so any false positive would
  be pure loss.

### 4.4 Windows: no prompt on a hidden console (S3, gated)

**What it fixes.** Windows' OpenSSH's prompt hang (§3.2, 1) prints nothing, so neither the
watchdog nor `said` can help: fetch and push wait for their 120 s timeout, clone until Cancel.
With `SSH_ASKPASS` failing at once and `SSH_ASKPASS_REQUIRE=force`, ssh asks the helper instead of
the console, gets no answer, and prints its error line (Windows QA), which the watchdog ends 10 s
later. Total: about 10 s, with the right message.

**`src/ssh-env.js`** (new, small): `askpassEnv({platform, env, gitExe, isFile})` returns
`{SSH_ASKPASS, SSH_ASKPASS_REQUIRE: 'force'}` or `{}`:
- `{}` unless `platform === 'win32'`. On macOS and Linux ssh already fails fast without a tty, and
  a user's own askpass may be in use (V7): never touched.
- `{}` when `env.SSH_ASKPASS` or `env.SSH_ASKPASS_REQUIRE` is set and not empty. Those reach git
  through `baseEnv` today (`src/git-process.js:127-133`, only `GIT_*` is filtered), so a user's
  own askpass keeps working exactly as before.
- `SSH_ASKPASS` = `<root>/usr/bin/false.exe` next to the `sh.exe` that `msysShell` finds for the
  git in use (`src/git-process.js:190-200`, cached per git by `msysShellOf`, `:202-212`), written
  with forward slashes (spaces in `C:/Program Files/Git` are QA row W11). `{}` when there is no
  such file (MinGit, another build).
- Computed once per git binary. Its unit tests inject `platform`; the callers pass
  `process.platform`.

**Applied** by `src/remote.js` (fetch, push) and `src/clone.js` only: not by commits (ssh signing),
not by hooks of other ops, not by reads.

**Why it breaks no setup that works today.** Case by case, on Windows:

| Setup | Today | With S3 |
|---|---|---|
| Bundled ssh, key in an agent reachable through `SSH_AUTH_SOCK`, or no passphrase; host known | works | works: ssh asks nothing, so the helper never runs (V4) |
| Bundled ssh, a prompt needed | fails fast (no tty, no askpass, no `DISPLAY`) | fails fast, same last line (Windows QA) |
| Windows' OpenSSH (sshCommand, "Use external OpenSSH", MinGit), key in Windows' ssh-agent service, host known | works if W6 passes | unchanged: no prompt, helper unused |
| Windows' OpenSSH, a prompt needed | hangs on the hidden console | fails, then the watchdog ends it in ~10 s (MinGit: no `false.exe`, so as today) |
| The user set `SSH_ASKPASS` / `SSH_ASKPASS_REQUIRE` (a GUI askpass) | their helper | their helper: S3 stands down |
| PuTTY / TortoisePlink (`GIT_SSH`) | plink fails or TortoisePlink shows its dialog | unchanged: they don't read `SSH_ASKPASS` |
| FIDO / sk keys | the touch works; no notification without askpass | the touch works; ssh's "Confirm user presence" notifier runs `false.exe`, whose result ssh ignores. A PIN (`verify-required`) can't be typed today either (no tty) |
| ssh-agent confirmations (`ssh-add -c`), 1Password, Secretive, Windows Hello | the **agent** asks, with its own environment and UI | unchanged: ssh's env doesn't reach the agent |
| ProxyJump / ProxyCommand ssh | the inner ssh inherits the env; its prompts hang like the outer one's | the inner ssh fails fast too |
| ControlMaster (bundled ssh) | a master started by the app keeps the app's env | the same; a master only exists after auth succeeded, and needs no prompt after that |
| HTTPS with Git Credential Manager | GCM's window | GCM's window. If GCM returns nothing (the user closes it), git falls back to `SSH_ASKPASS` for its own prompt (V12): `false.exe`, one extra `error: unable to read askpass response from '…'` line, the same `auth` kind. The line is left in the error and filtered **only when displayed** (§4.5) |
| Windows 10's OpenSSH 8.1 | prompt hang | prompt hang: it ignores `SSH_ASKPASS_REQUIRE` (OpenSSH < 8.4). Cancel / timeout as today (Q7) |

**Why `false.exe`.** No file of ours to ship or unpack from `app.asar`, no `.cmd` quoting (a
`.cmd` worked for Windows' OpenSSH in QA, but whether MSYS ssh can exec one is unknown), no Node
(`runAsNode` is off). It is part of Git for Windows (MSYS coreutils, next to the `sh.exe` the
cancel path already relies on), needs only `msys-2.0.dll` from the same folder, ignores its
argument (the prompt), prints nothing, exits 1. The cost: MinGit users get no S3. W-rows check that
running it flashes no console window (§7.5). P3a replaces the value with its helper; the conditions
above stay.

**Ship now:** yes, Windows only, under the conditions above, **and only after its QA rows (W3,
W4, W10, W11, W12, W15) pass**, with W6 run first (S0). If any fails, S3 is dropped from this PR
(S1, S2 stand alone) and the prompt hang waits for P3a.

### 4.5 Messages (S1, S2)

Shared by the flows and the clone dialog, in `renderer/flows-kit.js` next to `authMessage`
(`:222-224`), using `window.PLSshText` (§4.1):

- The command: `sshCommand(ssh)` with `asciiHost(host)`. For clone, from `parseCloneUrl` of the
  typed URL (replacing `sshTarget`, `renderer/clone.js:88-92`), now with its port. With no host
  (several push URLs, an unsplittable URL): `ssh -T git@<host>`. A host that isn't ASCII is shown
  in its ASCII form, with "(the server's name in ASCII)" after it.
- `connectView(e, {op, platform})` → `{title, message, detail}`:
  - **`host-key`, unknown**: "Unknown host key". "ssh doesn't know *host* yet and can't ask here.
    Connect once from a terminal (`ssh -T …`) to check its key and accept it, then try again."
    (clone's text, `renderer/clone.js:107-109`).
  - **`host-key`, `ssh.changed`**: "The server's host key changed". "*host* now presents a
    different key than the one saved for it. Someone may be intercepting the connection, or the
    server was reinstalled. Check the key (*fingerprint*) with the server's admin or its published
    fingerprints before you remove the saved one (`ssh-keygen -R host`, or with a port other than
    22, `ssh-keygen -R '[host]:port'`)." No "accept".
  - **`auth`, with `ssh`** (an ssh remote): "SSH authentication failed". "*user@host* didn't
    accept any of your SSH keys. Pasta Lite can't ask for a key's passphrase: add the key to
    ssh-agent first, then check it from a terminal (`ssh -T …`)." (with `shownAs`: "ssh connected
    to *shownAs*"), plus the platform hint:
    - **macOS**: `ssh-add --apple-use-keychain ~/.ssh/<key>`, and in `~/.ssh/config`
      `UseKeychain yes` and `AddKeysToAgent yes`, so the key comes back after a restart (launchd
      gives every app the agent).
    - **Windows**: "Git for Windows' own ssh doesn't use Windows' ssh-agent service." Then:
      - The service is disabled by default; to use it, in an administrator PowerShell:
        `Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent`, then `ssh-add`.
      - **Only if W6 passes** (Q9): "and let git use Windows' OpenSSH: `git config --global
        core.sshCommand C:/Windows/System32/OpenSSH/ssh.exe`". Without W6 passing, this sentence
        is not shipped, and the hint names Pageant only.
      - "Or load the key in PuTTY's Pageant and set `GIT_SSH` to plink; restart Pasta Lite after
        setting `GIT_SSH` (the app reads its environment when it starts)."
    - **Linux**: `ssh-add ~/.ssh/<key>` in the session the app was started from (it needs that
      session's `SSH_AUTH_SOCK`).
  - **`auth`, "Too many authentication failures"** (the matched line): "ssh offered more keys than
    *host* accepts before the right one. Add `IdentitiesOnly yes` and an `IdentityFile` for this
    host in `~/.ssh/config`, or remove keys you don't use from ssh-agent." No ssh-agent hint.
  - **`auth`, https** (no `ssh`): today's `authMessage` (`:222-224`), unchanged.
  - **`not-found`**: "Repository not found", clone's text (`renderer/clone.js:114`).
  - **`unreachable`**: for fetch and pull a **toast**: "Couldn't reach *remote*: *git's line*"
    (`e.remote`, §4.1; the line matters because `unreachable` includes TLS failures,
    `src/git-errors.js:94`); push and clone keep a dialog ("Can't reach the server").
  - **A stall with no kind** (`stalled`, an unclassified ending): today's toast of git's text.
  - `detail`: git's message, as today, **with the `error: unable to read askpass response from …`
    line dropped when shown** (V12; the error itself is not rewritten, L4).
- **`said`** (a user's cancel only): the kind's view with the title "*Op* cancelled" and `detail`
  "ssh said: *line*". Without `said`, today's notice ("Fetch cancelled",
  `renderer/flows-sync.js:31`).

**`renderer/flows-sync.js`**: `fetchInner` (`:24-36`), `pullError` (`:88-140`) and `pushError`
(`:253-306`) call `connectView` for those kinds and for `aborted` with `said`; `PULL_QUIET`
(`:60`), `PUSH_QUIET` (`:204`) and fetch's quiet list (`:27`) gain `host-key`, `not-found` and
`unreachable`. `authAlert` (`renderer/flows-kit.js:226`) becomes a `connectView` alert.

**`renderer/clone.js`**: `errorView` (`:98-144`) uses `connectView` for `auth`, `host-key`,
`not-found` and `unreachable` (the changed key and "too many" are new); the cancel paths
(`:479-480`, `:501`) show the explanation when `said` is set. Its 30 s "Waiting…" hint
(`:378-383`: "Pasta Lite can't ask for it yet" plus `authMessage`) **is unchanged**: it is still
true for https, for MinGit, for Windows 10's OpenSSH and for anyone with S3 off.

`renderer/index.html` loads `src/ssh-text.js` before the flows, and `eslint.config.js` gets the
`PLSshText` global (as for `PLErrorKinds` / `PLCloneUrl`).

All of it reaches the DOM through the dialogs' and toasts' `textContent`, as now
(`renderer/flows-kit.js:52`).

### 4.6 File-level changes

| File | Milestone | Change |
|---|---|---|
| `src/ssh-text.js` (new) | S1 | `SSH_LINES`, `SSH_ENDINGS`, `sshFacts`, `splitRemote`, `sshCommand`, `asciiHost`; requires nothing |
| `src/git-errors.js` | S1 | ssh entries from `SSH_LINES`; `CONNECT_RULES`; `classifyPush` uses it |
| `src/error-kinds.js` | S1 | the `host-key` meaning (`:34`) covers a changed key |
| `src/clone-url.js` | S1 | `userOk` exported; `port` in the accepted result |
| `src/remote.js` | S1–S3 | fetch classification; `err.remote`; `sshTarget`; the watcher, the stall re-tag, `said`, `stallMs` threading; the askpass env |
| `src/pull.js` | S2 | `stallMs` forwarded to `fetch` |
| `src/clone.js` | S1–S3 | `RULE_ORDER` from `CONNECT_RULES`; `changed` / `fingerprint` from `sshFacts`; the watcher next to the progress parser; the stall path; `said` on cancel; `stallMs`; the askpass env |
| `src/ipc-errors.js` | S1, S2 | `ssh`, `said`, `remote` in `EXTRA_FIELDS` |
| `src/ssh-stall.js` (new) | S2 | `createSshWatch`, `defaultStallMs` |
| `src/ssh-env.js` (new) | S3 | `askpassEnv` |
| `src/git-process.js`, `src/exec.js` | — | **unchanged** |
| `renderer/flows-kit.js` | S1, S2 | `connectView`, the hints; `authAlert` via `connectView`; the askpass line filtered for display |
| `renderer/flows-sync.js` | S1, S2 | the new kinds, `said`, the quiet lists |
| `renderer/clone.js` | S1, S2 | `errorView` via `connectView`; the changed key; `said` on cancel |
| `renderer/index.html`, `eslint.config.js` | S1 | `src/ssh-text.js`, `PLSshText` |
| `test/fixtures/fake-ssh.js` (new) | S0, S1 | the fake ssh (§7.2): `serve` and `deny` in S0, the fast modes in S1, the `-hang` modes in S2 |
| tests | S0–S3 | §7 |
| `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/plans/clone-repository.md` §15, `docs/plans/roadmap.md` §3.5 | S4 | §8 |

---

## 5. Security

| Concern | Answer |
|---|---|
| New inputs from the page | None. No new channel; the ops' arguments are built by their validators (`src/ops.js:539-563`, `:777`), so `stallMs` and the askpass env can't be set by a request |
| The env allowlist | Unchanged (`GIT_ENV_ALLOW`, `src/git-process.js:125`). S3 adds two non-`GIT_` variables for three commands, with constant values: a path derived from git's own installation (never from repo config, the page or the remote) and `force`. The user's own `SSH_ASKPASS*` win |
| A repo's `core.sshCommand` | Runs as today (asked about by the trust check, SECURITY.md "Scope"). It also sees `SSH_ASKPASS` = `false.exe`, which can do nothing |
| Killing | The watchdog aborts the op's own composed signal: the existing cancel path (`signalGroup`, `src/git-process.js:265-318`). No new pid-based kill, no new window for pid reuse, no change to the process layer |
| Leaks through `said` | Only a line that matches a fixed ssh pattern; `redactString` (URL userinfo, token shapes, the home folder); `INVISIBLE` stripped; at most 300 characters; `textContent` only. The watcher's lines never reach a log; after a stall they are the error's message, as git's stderr is for any failure |
| Leaks through `ssh` | A host and port from a shell-safe split (letters, digits, `.`, `_`, `-`, or bracketed IPv6; no path, no password), a user that passed `userOk` (no token shapes) or the same charset, a display-only `shownAs`, and a public fingerprint. The `ssh -T` text is shown, never run |
| Lookalike hosts | A non-ASCII host is shown in its ASCII form, so the user copies the name ssh uses |
| Server-controlled text | An ssh server's banner is printed to stderr after the host key was verified, so a server could print a fake ending: the watchdog would then end that server's own op (a self-inflicted failure), or a fake "host key changed" block would show a warning about itself. Nothing is executed or accepted because of it |
| Advice that weakens security | The changed-key text never suggests accepting the key or `StrictHostKeyChecking=no`; `ssh-keygen -R` is offered only after the user checked the fingerprint |

SECURITY.md (S4): one sentence in "Scope": on Windows, fetch, pull, push and clone run ssh with
`SSH_ASKPASS` set to Git for Windows' `false.exe` (unless the user set an askpass), so ssh fails
instead of prompting where nobody can answer.

---

## 6. Platforms

- **Windows**: everything in this plan. The watchdog's timer is on; S3 applies under its
  conditions. Settle times are the cancel path's (about 120 ms after the abort, Windows QA).
- **macOS, Linux**: S1, and S2's watcher for `said` (no timer); no S3. No change in how ssh runs.

---

## 7. Test plan

No test touches the network. ssh is either the fake of §7.2 or absent.

### 7.1 Unit (all platforms)

| File | Covers |
|---|---|
| `test/ssh-text.test.js` (new) | each `SSH_LINES` pattern, with `\r\n`; lookalikes don't match (`error: unable to create 'x': Permission denied`, `remote: Permission denied (publickey)`, a branch named `Host key verification failed` mid-line); `SSH_ENDINGS` includes them all plus `kex_exchange_identification:`, `Connection closed by`, `Connection reset by`, `Unable to negotiate with`, `No route to host`, `Host is down`; `sshFacts` on V1, V8, V9 (`changed`, the fingerprint with and without `\r`) and V16's lines, last match wins; `splitRemote` (`github-work:o/r.git`, `git@github_work:o/r.git`, `ssh://deploy+ci@host:2222/r`, `git+ssh://`, `[::1]`; refused: `https://…`, `/path`, `C:/path`, `-oProxyCommand@h:r`, `h$(id):r`, a port of 0 or 70000); `sshCommand` with and without port and user; `asciiHost` of an IDN host; the module requires nothing (`require.cache` check) |
| `test/ssh-stall.test.js` (new) | lines split across chunks; `\r\n` split between chunks as `…\r` + `\n…` (one line end, no disarm); a lone `\r` (progress frames); empty lines never disarm; a multi-byte character split across chunks; the tail cap; arming on an ending, re-arming on a second (ProxyJump: `Permission denied` then `Connection closed by UNKNOWN port 65535`); a non-ending non-empty line disarms; fires once; `stop()`; `stallMs` 0 never arms but collects; `lines()` / `text()` caps; fake timers |
| `test/git-errors.test.js` | `CONNECT_RULES` order; the anchored `auth` entry and its refusals; "Too many authentication failures"; `No route to host` / `Host is down` → `unreachable`; `classifyPush`: ref lines still first, then `host-key`, `not-found`, `unreachable`; `src/git-errors.js` still loads first and alone (no cycle: `require` it in a fresh process, then `exec.js`, and the reverse) |
| `test/clone-url.test.js` | `port` for `ssh://h:2222/r`, none for scp-like; `userOk` |
| `test/ssh-env.test.js` (new) | `askpassEnv`: `{}` on darwin / linux; `{}` when `SSH_ASKPASS` or `SSH_ASKPASS_REQUIRE` is set; `{}` with no `false.exe` (MinGit layout); the forward-slash path from a Git for Windows layout and a Scoop shim (`isFile` / `readFile` injected, like `msysShell`'s test, `test/exec.test.js:464`) |
| `test/ipc-contract.test.js` / ipc-errors | `ssh`, `said` and `remote` serialized as plain data |
| `test/redact.test.js` | a `said` line with a token-shaped user and a home path comes out masked |

### 7.2 Fake-ssh integration (all platforms, CI on macOS, Ubuntu, Windows)

`test/fixtures/fake-ssh.js`, a Node script used as `GIT_SSH_COMMAND="<node>" "<fixture>"`
(forward slashes, quoted) with `GIT_SSH_VARIANT=ssh` (V15), set on `process.env` for the test as
`test/clone.test.js:392-395` does. Its mode comes from `FAKE_SSH_MODE` (a non-`GIT_` variable, so
it reaches ssh through `baseEnv`). Prototyped on macOS (V13, V14).

**On Windows** git starts `GIT_SSH_COMMAND` through MSYS `sh`, and `sh` → `node.exe` applies MSYS's
argument conversion: the scp path `C:/…` and the quoted `git-upload-pack 'C:/…'` must reach the
fixture intact, and `serve` must run Git for Windows' `git upload-pack` / `receive-pack` on it.
**S0 lands `serve` and one `deny` test and gets them green on Windows CI (and on the box) before
the rest is written.** If the conversion mangles the path, the fixture takes the path from an env
variable (`FAKE_SSH_REPO`) instead of the argument.

| Mode | Does | Milestone |
|---|---|---|
| `serve` | runs the requested `git-upload-pack` / `git-receive-pack` locally (a working ssh) | S0 |
| `deny` | prints `git@fake.invalid: Permission denied (publickey).`, exits 255 (the bundled ssh) | S0 |
| `hostkey`, `unreachable`, `changed`, `too-many` | prints that ending (V2, `ssh: connect to host fake.invalid port 22: Connection refused`, V9's block, `Received disconnect from 192.0.2.1 port 22:2: Too many authentication failures`), exits 255: the usual fast path | S1 |
| `not-found` | prints `ERROR: Repository not found.`, exits 1 | S1 |
| `deny-hang`, `hostkey-hang`, `unreachable-hang`, `changed-hang`, `kex-hang` | prints that ending (`\r\n`, as Windows writes it), never exits (Windows' OpenSSH on a pipe) | S2 |
| `proxyjump-hang` | prints `Permission denied (publickey).` for a jump host, then `Connection closed by UNKNOWN port 65535`, never exits | S2 |
| `silent-hang` | prints nothing, never exits (the prompt hang) | S2 |
| `deny-then-serve` | prints the publickey line, waits `FAKE_SSH_DELAY` ms, then serves (a retrying wrapper that succeeds) | S2 |
| `env` | writes whether `SSH_ASKPASS` / `SSH_ASKPASS_REQUIRE` reached it to `FAKE_SSH_OUT`, then serves | S3 |
| any | `-G` exits 0 (git's variant probe); writes its pid to `FAKE_SSH_PID` when set (the Windows-only test) | S0 |

The remote is scp-like, `fake.invalid:<absolute path of a local bare repo>`: nothing resolves the
host. Timing bounds are measured **from the moment the fake printed its line** (it writes a
timestamp to `FAKE_SSH_OUT`), with the slack the Windows cancel test uses (10 s,
`test/exec.test.js:843`), not from the start of the op.

New file `test/remote-ssh.test.js`:
- **S0**: `serve`: fetch and push succeed; `deny`: fetch fails with `auth`.
- **S1**, each for **fetch, pull, push and clone**: `deny` → `auth`; `hostkey` → `host-key`;
  `changed` → `host-key` with `ssh.changed` and the fingerprint; `unreachable` → `unreachable`;
  `too-many` → `auth`; `not-found` → `not-found`; `err.remote` set (fetch, pull, push), also for
  the second remote of a Fetch All.
- **S1, `sshTarget`**: a remote `git@fake-alias:…` where the fake prints
  `git@192.0.2.7: Permission denied (publickey).` (an alias resolved by ssh) → `ssh.host`
  `fake-alias`, `user` `git`, `shownAs` `192.0.2.7`, so the command is `ssh -T git@fake-alias`
  (H1); an `ssh://git@fake.invalid:2222/…` remote → `port` `2222`; a remote with two `pushurl`s →
  no host; an https remote's `auth` → no `ssh`; an `insteadOf` rewrite → the rewritten host; a
  token-shaped user in ssh's line → the URL's user instead.
- **S2**: each `-hang` mode with `stallMs: 500` → the kind (none for `kex-hang`) and `stalled:
  true`, git's text as the message; `proxyjump-hang` → `auth` (re-armed by the ending after it);
  `deny-hang` with the timer off and a user's cancel → `aborted` with `said: {kind: 'auth',
  line}`; `silent-hang` with a cancel → `aborted`, no `said`; a cancel landing as the stall fires →
  `aborted` (the user's wins); `deny-then-serve` with `FAKE_SSH_DELAY` 200 and the app's own
  window (`STALL_MS`, 10 s) → the fetch and the push succeed (no false kill); a `pre-push` hook
  printing the publickey line, then `sleep 1` → the push succeeds. The window holds the whole rest
  of the op after ssh's line (the transfer prints nothing on stderr): a 2 s one ended a fetch on a
  slow Windows runner (CI run 38249106151). Pull forwards `stallMs` (a `deny-hang`
  pull stalls); push to two `pushurl`s, the first `deny` → `auth`, the second repository unchanged
  (V11 as a regression test of the git behaviour the watchdog relies on).
- **S2, clone** (`test/clone.test.js`, with `localFixtures`): `deny-hang` + `stallMs: 500` →
  `auth`, `stalled`, `err.made` set and removed by the cleanup; a cancel during `hostkey-hang` →
  `aborted` with `said`.

### 7.3 Windows-only tests (CI's Windows job)

- **The stall ends the whole tree**: `deny-hang` with `FAKE_SSH_PID`, `stallMs: 1000`: the op
  settles with `auth`, and the fake ssh's process (named by pid, image and start time with
  `winProcesses` / `runningAfterKill`, `test/exec.test.js:733-765`) is gone, like the cancel test
  (`:767-853`).
- **The askpass env reaches ssh** (S3): `env` mode on a real fetch → `SSH_ASKPASS` is the Git for
  Windows `false.exe` path and `SSH_ASKPASS_REQUIRE` is `force`; with `SSH_ASKPASS` pre-set in
  `process.env` → the user's value, no `force` from us; a commit's hook (not a remote op) never
  sees ours.
- **`false.exe` runs and fails silently** (S3) when started the way ssh starts it (an argument with
  spaces, quotes and newlines): exit 1, no output.

### 7.4 Renderer (`test/flows.test.js`, `test/clone-ui.test.js`)

- fetch, pull, push: `host-key` (unknown; then `changed` with the fingerprint, `ssh-keygen -R
  '[host]:2222'` for a port, and no "accept"); `auth` with `ssh` per platform (the macOS hint with
  `UseKeychain`; the Windows hint with the service commands and the `GIT_SSH` restart note, and
  the `core.sshCommand` sentence only when enabled, Q9; the Linux hint) and without (`authMessage`,
  as `test/flows.test.js:223-236`); "too many authentication failures"; `shownAs`; `not-found`
  dialog; `unreachable` toast for fetch and pull naming `e.remote` and git's line, dialog for push;
  `aborted` with `said` (the explanation) and without (today's notice,
  `test/flows.test.js:210-217`); the askpass line dropped from a displayed detail.
- `sshCommand` / `asciiHost` in the text: a port, a user, no host, an IDN host.
- clone: `errorView` for the four kinds through `connectView` (`test/clone-ui.test.js:448-449`
  keep passing), the changed key, the cancel with `said`, the "Waiting…" hint unchanged.
- A host or line with `<img>` shows as text.

### 7.5 Manual QA

**Windows 11** (the Windows test box; Git for Windows 2.52, installed in `C:\Program Files\Git`).
A throwaway passphrase-protected key and a test repository; host-key cases use a throwaway
`UserKnownHostsFile` through `GIT_SSH_COMMAND` / `core.sshCommand` options, never the user's own
`known_hosts`. Process checks with Task Manager by **name** only (no command lines). Each row
records the op, the settle time (from the click, and from ssh's line where the detail shows it) and
what is left running.

**W6 runs first (S0), before S1 merges.**

| # | Setup | Op(s) | Case | Expected |
|---|---|---|---|---|
| W6 | Windows' OpenSSH as `core.sshCommand`, key in Windows' ssh-agent service, known host | Fetch, Pull, Push, Clone | success | all succeed in normal time. **If any ends only at the timeout (the exit hang on success, §3.2), stop**: record it; the `core.sshCommand` sentence is not shipped (Q9) and §9's row applies |
| W1 | bundled ssh (default) | Fetch, Pull, Push, Clone | passphrase key not in an agent | the ssh auth dialog within ~1 s, with `git@github.com` and the Windows hint; no ssh or git left |
| W2 | bundled ssh | Fetch, Clone | unknown host (empty known_hosts) | "Unknown host key" within ~1 s, `ssh -T git@github.com` |
| W16 | Windows' OpenSSH as `core.sshCommand`, **S3 off** (the S2 build, before S3) | Fetch, Pull, Push, Clone | a key **without** a passphrase that the server doesn't accept (so ssh prints its line with no prompt), **no cancel** | the auth dialog, `stalled`, about 10 s after ssh's line; **during the wait, `git.exe` is listed in Task Manager** (§3.2, M3); after it, no `git.exe` / `ssh.exe` left; a clone's folder removed |
| W17 | Windows' OpenSSH | Fetch, Push | unreachable (a host on the LAN that drops port 22, or a typo'd host) | "Can't reach" (toast for Fetch, dialog for Push) after ~10 s at most, or at once if ssh exits |
| W3 | Windows' OpenSSH, **S3 on** | Fetch, Pull, Push, Clone | passphrase key not in its agent | the auth dialog after ~10 s, no hang; **no console window flashes** when `false.exe` runs; nothing left running |
| W4 | Windows' OpenSSH, S3 on | Fetch, Clone | unknown host | "Unknown host key" after ~10 s; no console window |
| W5 | Windows' OpenSSH, S3 standing down (`SSH_ASKPASS_REQUIRE` set by hand to `never`) | Fetch, Clone | passphrase key not in its agent | the prompt hang as today; Cancel → "Fetch cancelled" (no `said`: nothing was printed); Fetch ends at 120 s with a timeout |
| W7 | as W16 | Fetch | Cancel within 10 s of ssh's line | "Fetch cancelled" alert with "ssh said: git@github.com: Permission denied (publickey)." |
| W8 | Windows' OpenSSH | Fetch, Clone | changed host key (throwaway known_hosts with another key for github.com) | "The server's host key changed", the fingerprint, no "accept" |
| W9 | bundled ssh | Fetch, Push, Clone | network off | toast naming the remote and git's line / dialog / clone outcome "Can't reach the server" |
| W10 | either ssh | Fetch | `SSH_ASKPASS` and `SSH_ASKPASS_REQUIRE` set in the user environment | the app leaves them alone: the user's helper is the one called |
| W11 | default install path (with a space) | Fetch | W3 and W1 | `false.exe` runs for both ssh flavours (no "not found" / "cannot execute" line in the detail) |
| W12 | HTTPS, Git Credential Manager | Fetch, Clone | sign in; then close GCM's window instead | the sign-in works; when closed, "Authentication failed", its detail without "unable to read askpass response" |
| W15 | Git for Windows reinstalled (or a second install) with **"Use external OpenSSH"** | Fetch, Clone | W6, W16, W3 | the same results as with `core.sshCommand`: git runs Windows' OpenSSH from `PATH` |
| W13 | PuTTY / TortoisePlink as `GIT_SSH`, if installed (restart the app after setting it) | Fetch | the key in Pageant; without | works; TortoisePlink's own dialog as before |
| W14 | a Windows 10 box, if one exists | Fetch | W3 | record: OpenSSH 8.1 ignores `SSH_ASKPASS_REQUIRE` (expected: the prompt hang; Cancel works) |
| W18 | after W1–W17 | — | Help → Copy Diagnostics | no key path, no URL with credentials, no home path, no ssh lines beyond `kind` |

**macOS** (each with Fetch, Push and Clone unless noted):

| # | Case | Expected |
|---|---|---|
| M1 | key in the agent | unchanged success |
| M2 | passphrase key not in the agent (`ssh-add -D` first) | the ssh auth dialog at once, with `ssh-add --apple-use-keychain` and the `UseKeychain` / `AddKeysToAgent` lines |
| M3 | unknown host (throwaway known_hosts) | "Unknown host key" at once |
| M4 | changed host key | the changed-key dialog |
| M5 | a `Host github-work` alias remote with a refused key | the command reads `ssh -T git@github-work`, not the resolved host |
| M6 | Wi-Fi off | Fetch: toast naming the remote; Push: dialog; Clone: outcome |
| M7 | Cancel a slow clone | "Clone cancelled" as today (no `said`) |
| M8 | Help → Copy Diagnostics after M2–M6 | no key path, no URL with credentials, no home path |

---

## 8. Phases (file by file)

### S0: checks first
1. **W6** on the Windows box (§7.5). Its result decides Q9 and the Windows hint's
   `core.sshCommand` sentence.
2. `test/fixtures/fake-ssh.js` with `serve`, `deny`, `-G` and `FAKE_SSH_PID`;
   `test/remote-ssh.test.js` with the S0 cases. Green on macOS, Ubuntu and **Windows CI**, and run
   once on the box. Fix the MSYS argument handling here if needed (§7.2).

*Done when* W6 is recorded and the S0 tests pass on all three platforms.

### S1: classification and messages
1. `src/ssh-text.js` and `test/ssh-text.test.js`.
2. `src/git-errors.js`: the ssh entries from `SSH_LINES`, `CONNECT_RULES`, `classifyPush`. Tests in
   `test/git-errors.test.js`, including the load-order check.
3. `src/clone-url.js`: `userOk`, `port`. `src/error-kinds.js`: the `host-key` meaning.
4. `src/remote.js`: fetch's classification, `err.remote`, `sshTarget`. `src/clone.js`:
   `RULE_ORDER`, `changed` / `fingerprint` (through a watcher with `stallMs` 0, which S2 then arms).
   `src/ipc-errors.js`: `ssh`, `remote`.
5. Renderer: §4.5 without `said`; `renderer/index.html`, `eslint.config.js`.
6. Tests: the fast fake-ssh modes and the S1 cases of §7.2 for fetch, pull, push and clone; §7.4.

*Done when* fetch, pull, push and clone report `auth`, `host-key` (and a changed key),
`not-found` and `unreachable` with the new texts on all three CI platforms.

### S2: the watchdog and `said`
1. `src/ssh-stall.js` and `test/ssh-stall.test.js`.
2. `src/remote.js`, `src/pull.js`, `src/clone.js`: the composed signal, the stall re-tag,
   `stallMs` threading and default, `said` on a user's cancel. `src/ipc-errors.js`: `said`.
3. Renderer: `said` in the cancel paths.
4. Tests: the `-hang` modes and the S2 cases of §7.2, §7.3's first item, §7.4's `said` cases.
5. QA rows W16, W17, W7 on the box.

*Done when* every fake-ssh case passes on macOS, Ubuntu and Windows CI, the Windows-only tree test
passes, and W16 shows `git.exe` alive during the hang.

### S3: Windows askpass (gated)
1. `src/ssh-env.js` and `test/ssh-env.test.js`.
2. `src/remote.js`, `src/clone.js`: the env.
3. §7.3's other two items.
4. **Gate**: rows W3, W4, W10, W11, W12, W15 on the Windows box. If one fails, revert S3 and note
   it in clone-repository.md §15 and roadmap.md §3.5.

### S4: docs and QA
- **CHANGELOG** `[Unreleased]`: Changed: fetch, pull and push explain unknown and changed ssh host
  keys, missing repositories and unreachable servers as clone does, with the host and the command
  to check it; Fixed: on Windows, an ssh that had already failed no longer keeps the op waiting
  (Windows' OpenSSH), and a cancelled op says what ssh reported.
- **SECURITY.md**: §5's sentence.
- **CONTRIBUTING.md** Architecture: one line for `src/ssh-text.js` (require-free, shared with the
  renderer), the watchdog in the callers and `src/ssh-env.js`.
- **clone-repository.md** §15 "Follow-up": a pointer to this plan; §12's first risk row updated.
- **roadmap.md** §3.5: S3's env scope exists; P3a replaces `false.exe` with its helper.
- **QA**: §7.5's remaining rows written up as a flow table (steps, expected, observed, result).

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| The watchdog ends a working setup: a wrapper that retries and then transfers silently on stderr for more than 10 s (stdout isn't watched, `spawnGit` being unchanged); a hook that prints one of ssh's endings and then stays silent | a failed op where the terminal works (Windows only) | anchored endings, the silence rule, 10 s, Windows only; the message is ssh's own line, so the cause is visible. No escape hatch (decided); Q10 records the stdout tap as the follow-up if it happens |
| Windows' OpenSSH also hangs after a **successful** connection (§3.2) | every fetch / push with that setup ends at the 120 s timeout, clone never (Cancel ends both in about 120 ms) | **Doesn't happen on a desktop: W6 passed there** (§13), so the hint recommends it (`RECOMMEND_WINDOWS_OPENSSH`). It does happen when git runs inside an sshd session (the box's first W6 run): there Windows' OpenSSH relays only its first stderr write and never exits. Not a setup the app is used in; S2's watchdog still ends a failure there |
| During the exit hang **only ssh** holds git's stderr and git has exited (contrary to the inference in §3.2) | git's own `fatal: Could not read from remote repository.` (not an ending) disarms the watchdog, and an abort would skip `taskkill` (`src/git-process.js:303-306`) and run only the MSYS kill, which doesn't reach a native `ssh.exe`: the op still hangs until the user cancels, and even that may not end it | **Doesn't happen:** W16 saw `git.exe` (and `sh.exe`, `ssh.exe`) alive during every hang, and nothing left after the stall |
| `false.exe` can't be started by one ssh flavour (path with spaces, forward slashes) | S3 does nothing for that flavour, and the error detail gains ssh's "cannot execute" line | W11; fallback forms (backslashes, the 8.3 short path) tried in that order in QA before S3 merges; else S3 is dropped |
| `false.exe` (an MSYS console program) flashes a console window when Windows' OpenSSH starts it | a visible flicker on each failure | W3 / W4 check it; if it flashes, S3 is dropped (no window-hiding wrapper is worth its complexity before P3a) |
| `SSH_ASKPASS` reaching git's own https prompt (V12) | one extra line in the https auth detail on Windows | filtered when displayed (§4.5); the kind is unchanged |
| The fake ssh behaves differently on Windows (MSYS argument conversion) | the CI tests don't test what they claim | S0 runs it on Windows CI and on the box first; `FAKE_SSH_REPO` fallback |
| Windows 10's OpenSSH 8.1 | the prompt hang stays | Cancel, the 120 s timeout, clone's "Waiting…" with the auth hint; Q7 |
| ssh's wording changes between versions | a failure no longer classified (back to git's raw text) or the watchdog not arming (back to today's hang) | the patterns are the ones in use since OpenSSH 7.x, tested against the captured lines of V1–V16 and the Windows QA; a miss degrades to today's behaviour, never to a wrong kill |
| A localized ssh | the same as a wording change | ssh doesn't translate these messages; git runs with `LC_ALL=C` (`src/git-process.js:136`) |
| LFS or a lazy fetch hanging in a non-remote op on Windows' OpenSSH | an op without the watchdog waits | out of scope (§2.2); its op's own timeout or Cancel |

---

## 10. Open questions (decided after the review, with the reasons)

1. **N for the watchdog: 10 s** (§4.3).
2. **An escape hatch: none.** It would be another untested path; anchored endings plus the silence
   rule make a false kill unlikely.
3. **The watchdog's timer on macOS and Linux: no** (decision 6).
4. **S3 now, gated** on its W-rows, with W6 first (§4.4).
5. **`false.exe`**, not a `.cmd` of ours: nothing to package, no Node; MinGit users go without.
6. **`unreachable` on fetch and pull: a toast naming the remote, with git's line**; push and clone
   keep a dialog.
7. **Windows 10's OpenSSH 8.1: no `DISPLAY`.** Untested, and `DISPLAY` means something to other
   programs git may start. Accept the gap; P3a can revisit it.
8. **The fingerprint of a changed key: shown**, parsed once by `sshFacts`.
9. **No `core.sshCommand` recommendation before W6 passes.** The Windows hint's sentence is behind
   that result; without it the hint names the agent service and Pageant only.
10. **A generic stdout tap on `spawnGit`** (so stdout bytes disarm the watchdog too): not in this
    PR (decision 3). *Recommended* as the first follow-up if a false stall is ever reported: it is
    generic (no ssh knowledge, no new require), a few lines next to `onStderr`.

---

## 11. Acceptance criteria

1. **Checks first.** W6 is recorded and the fake ssh's `serve` / `deny` pass on Windows CI before
   S1 merges.
2. **Same kinds everywhere.** Fetch, Fetch All, Pull (every mode) and Push report `auth`,
   `host-key`, `not-found` and `unreachable` from the same rules as Clone, through both the fast
   (exit 255) and, on Windows, the hanging ssh paths, proven with the fake ssh on macOS, Ubuntu and
   Windows CI.
3. **Changed keys.** A changed host key is reported as such on every remote op, with the
   fingerprint and the right `ssh-keygen -R` form, and no text suggests accepting it.
4. **Messages.** The ssh `auth` and `host-key` dialogs name the remote's host (an alias as
   written, in ASCII), port and effective user and the `ssh -T` command, with the platform's hint;
   "too many authentication failures" gets its own text; https auth keeps today's text; the
   `core.sshCommand` sentence appears only if W6 passed. "Couldn't reach" names the remote.
5. **No wait after a failure on Windows.** With Windows' OpenSSH, an ssh failure that prints an
   ending ends about 10 s after that line instead of at the 120 s timeout (fetch, push) or never
   (clone), with no git or ssh process left. The bundled ssh's timings are unchanged (~1 s).
6. **No false kill in the tests.** A retrying ssh that succeeds within the window, a ProxyJump
   failure followed by its outer ending (armed, not disarmed), and a hook that prints ssh's line and
   goes on all behave as specified.
7. **A cancel keeps the reason.** A user's cancel after ssh printed its error shows that error; one
   with nothing printed shows today's notice.
8. **S3 (if merged).** On Windows, with Windows' OpenSSH, a needed passphrase or an unknown host
   fails within about 10 s instead of hanging, with no console window; the user's own
   `SSH_ASKPASS` / `SSH_ASKPASS_REQUIRE` are never replaced; macOS and Linux never get either
   variable from the app.
9. **No new leaks, no new coupling.** The watcher's lines never reach a log (a stall's message is git's own stderr, as for any failure);
   `said.line` is redacted and capped; `ssh` carries only a shell-safe host, port and user, a
   display-only `shownAs` and a public fingerprint; `src/ssh-text.js` requires nothing and
   `src/git-process.js` / `src/exec.js` are unchanged; Copy Diagnostics after the QA cases holds no
   URL credentials, key paths or home path.
10. **Green CI.** `npm test` and `npm run lint` pass on macOS, Ubuntu and Windows.

---

## 12. Deviations (where the build differs)

Recorded while building S0–S3; none changes a decision of §1.2 or §10.

**Review fixes (after S4; the expert and security reviews).**
- A changed host key carries `keyName`, the known_hosts name ssh printed ("Host key for
  `[127.0.0.1]:22222` has changed"), checked against a shell-safe pattern; `ssh-keygen -R` uses it,
  so an alias or a port from `~/.ssh/config` names the right entry. The fingerprint and the name are
  the first after the warning (a server's banner can print a forged block later).
- "Received disconnect … 11:" (a normal "Bye") is no ending: a successful fetch may print it and
  then transfer in silence for longer than the window. A bare `Permission denied (publickey).`
  (older and vendor ssh) is `auth` again, as before S1.
- §4.3's wiring lives in the watch: `createSshWatch` owns its abort, `signalFor(signal)` (the
  composed signal), `isStall(err, signal)` (the race rule, unit-tested) and `logStall(op, err)`;
  remote.js and clone.js use them. They are methods of the watch rather than separate exports:
  the callers' `require('./ssh-stall')` lines sit next to S3's `require('./ssh-env')`, and a later
  change to them would keep S3's commit from reverting cleanly. For the same reason the composed
  signal stays inline in the two lines S3 changed (they also set the askpass env) until the S3
  review commit moves them to `signalFor`; with S3 reverted, those two lines keep the S2 form.
- A fetch's target is the remote's first URL (`get-url` without `--all`), as git fetches from it;
  a push still reads every push URL.
- ssh's user counts only when ssh named the URL's own host; with ProxyJump the refusal can be the
  jump host's. Several push URLs therefore give no user either.
- One user-name rule, §13 Q7's (`USER` and `tokenShaped` in `src/ssh-text.js`, which
  `src/clone-url.js` now uses; `src/ssh-text.js` loads before it in the page): a remote's URL user
  outside it refuses the split (`ssh://deploy+ci@host/r` too, which §4.1 allowed), a token-shaped
  one is left out. A bracketed scp host must be an IPv6 literal (two colons at least): git reads
  `[host:port]:path` as a host and a port, which the split refuses instead of misreading.
- The Windows hint (§4.5) leads with Pageant and plink, which work with Git for Windows' own ssh:
  that ssh uses neither Windows' agent service nor an agent from Git Bash or start-ssh-agent.cmd
  (those serve their own console only). The service's steps are for a git that runs Windows'
  OpenSSH already; with `RECOMMEND_WINDOWS_OPENSSH` they become the recommendation.
  `ssh-keygen -R '[h]:p'` is double-quoted on Windows (PowerShell and cmd).
- The stall test's lower bound is 300 ms after the fake's timestamp (written once its lines are
  out, a moment after git may have read them), not 450.
- `remote._internal` is gone (the race test moved to `test/ssh-stall.test.js`), and so are
  `authAlert` and the frozen-error guard in `withRemote`.

**Windows QA follow-up: what the desktop showed, S2 kept, and W8.**
- **Decision (the user's): S1, S2 and S3 all stay.** On an interactive desktop Windows' OpenSSH
  exits after its error with its whole message (§3.2, §13), so the exit hang S2's watchdog ends
  was seen only with git inside an sshd session. S2 (the watchdog, `said` on a cancel, the W8 fix
  below) is kept as insurance: it costs nothing when ssh exits (the timer never fires: §4.3's
  silence rule, Windows only), and `said` helps on every platform. S3's motivation is now the
  hidden-prompt hang, confirmed on the desktop.
- W8 inside an sshd session: Windows' OpenSSH passed git only its first stderr write, so of a
  changed key's warning git saw one line, the `@@@…` frame, and no ending ever came: fetch ran into
  its 120 s timeout and clone hung until cancelled. Most likely a session artifact like the exit
  hang; the fix is kept as insurance. A bare frame (`^@{20,}\r?$`, `BANNER` in
  `src/ssh-text.js`) is now an ending, so the watchdog arms on it.
- A stall whose ssh lines are only that frame, with no other warning named in it (an unprotected
  key file, possible DNS spoofing), reads as `host-key` with `ssh.changed` and `ssh.bannerOnly`
  (`sshFacts`, `watch.stallKind`). It is a stall-only reading: a git that exits by itself is
  classified by its lines as before. A changed key's warning that lacks its last line reads as
  `host-key` too, with what it said.
- The page says "ssh stopped at a security warning": most often a changed host key, read the whole
  warning with `ssh -T` from a terminal, check the key before removing the saved one; never
  "accept". With no fingerprint or key name, `ssh-keygen -R` falls back to the URL's host.
- The bundled ssh's full block reads as before (its last line decides; the first fingerprint and
  key name win); after its frame come lines that are no endings, so an unprotected key's warning
  followed by a successful connection never stalls. Fake mode `banner-hang`; tests for fetch,
  pull, push and clone.

**S0, the fake ssh.**
- The tests set `FAKE_SSH_REPO` on Windows from the start (the fake prefers it to the path in git's
  command), instead of only after Windows CI showed MSYS mangling the path: CI had not run when the
  fake was written. macOS and Linux exercise the path from git's command. Every test that serves
  uses one repository, so one variable is enough.
- Two more variables for the `sshTarget` cases: `FAKE_SSH_WHO` (the `user@host` of the refusal:
  the alias and token-shaped-user cases) and `FAKE_SSH_LOG` (one line per run: proves git ran ssh
  once for two push URLs).

**S1.**
- The two-`pushurl` regression test (V11, planned for S2) landed with S1's "several push URLs → no
  host" case: one setup proves both.
- `classifyPush` tries `CONNECT_RULES` with `matches` (any error object, as its `auth` check did),
  not `kindFor` (GitErrors only); its caller still classifies only an unclassified GitError.
- `err.remote` is set on every error of a git command (fetch's loop over remotes, push's catch),
  not on push's refusals before git runs (`detached`, `no-upstream`), which have no remote yet.
- `parseCloneUrl` keeps refusing an empty port (`ssh://h:/r`); `port` is a number or null.
- Clone's `changed` / `fingerprint` came from the progress parser's text lines in S1 (no watch
  existed yet); S2 reads them from the watch's lines, as §4.1 says.
- "Too many authentication failures" is recognised in the page from the error's text and `said`
  (`TOO_MANY`, exported by `src/ssh-text.js`): `ssh` carries no ssh line.
- The page shows a `not-found` as "Repository not found" only when the error names a remote
  (`e.remote`, set by fetch and push; clone always): another op's `not-found` (a branch) keeps its
  toast. For fetch, pull and push the text says "Check the URL of *remote*" (clone: "Check the URL").
- The Windows hint follows §10 Q9 (the ssh-agent service and Pageant; §4.5's "names Pageant only"
  read as older wording). The `core.sshCommand` clause is behind one constant,
  `RECOMMEND_WINDOWS_OPENSSH` in `renderer/flows-kit.js` (false): set it to true when W6 passes,
  and turn the `doesNotMatch(windows, /core\.sshCommand/)` assertion in `test/flows.test.js`
  ("the ssh-agent hint per platform") into a `match`.

**S2.**
- `saidOf(facts)` (the redacted, bounded `said`) lives in `src/ssh-stall.js` next to the watch, so
  remote.js and clone.js share it: that module also requires `src/redact.js` and
  `src/display-text.js` (both pure, nothing of the git layer), not only `./ssh-text`.
- "A cancel landing as the stall fires → the user's wins" is a unit test of the re-tag
  (`remote._internal.unstall`): the race can't be timed from outside the process layer.
- `proxyjump-hang` waits `FAKE_SSH_DELAY` (default 300 ms) between the jump host's refusal and the
  outer `Connection closed by`, so the re-arm is observable (the stall comes 500 ms after the second
  line). A hanging fake exits on its own after two minutes, so a failed test leaves nothing for long.
- The Windows-only tree test uses `stallMs: 5000`, not 1000: the fake ssh is named by pid, image
  and start time while it surely hangs, and PowerShell takes seconds to start on a CI runner.
- `winProcesses`, `stillRunning` and `runningAfterKill` moved from `test/exec.test.js` to
  `test/helpers.js` (with `fakeSsh`), so `test/remote-ssh.test.js` and `test/clone.test.js` share them.
- A clone the watchdog ended never counts as a checkout failure (its text can't say so anyway).
- `stalled` stays on the error in main (and in the log record's `kind`); it is not sent to the page,
  which shows a stalled failure as its kind (or git's text) like any other.

**S3 (its own commit, so it can be reverted alone if a W-row fails).**
- `src/git-process.js` exports `gitExecutable` and `msysShell` (both existed; `msysShell` was in
  `_internal`): `src/ssh-env.js` needs the git in use and its Git for Windows root. No behaviour of
  the process layer changes. It uses `msysShell` directly, not the cached `msysShellOf`, whose
  warning is about the cancel path and would be logged for MinGit on every first remote op.
- `askpassEnv` caches its answer per git binary only when nothing is injected (tests inject
  `isFile` / `readFile` and are never cached).
- The "never on macOS / Linux", "the user's own SSH_ASKPASS reaches ssh" and "a commit's hook never
  sees ours" checks run on every platform (the fake's `env` mode), not on Windows CI only; the
  path and `force` are asserted on Windows, their absence elsewhere.
- Review fixes, in S3's own commit so that S3 still reverts cleanly: the two lines S3 changed in
  remote.js and clone.js now take git's signal from `watch.signalFor` (§12, review fixes); a
  remote op's own hooks (`pre-push`, `reference-transaction`) inherit the askpass variables, which
  `src/ssh-env.js` and SECURITY.md now say ("never other ops' hooks"); SECURITY.md's paragraph is
  its own and says the behaviour is pending Windows QA, as does the changelog's entry; and
  `askpassEnv`'s production path (no injection: `gitExecutable()`, the cache) has a test that runs
  where Git for Windows is installed (Windows CI).
- After the Windows QA (§13): S3's automated rows passed (W3, W4, W10, W11, W15, W12's automated
  part), and on a desktop the hidden-prompt hang it fixes is real (an unknown host key with
  Windows' OpenSSH: stuck at "Working…", 0.2.1 without S3). S3 is kept. The desktop run of this
  branch passed (§13, D-A to D-flash: host-key in 0.7 s, auth in 1.1 s, no console window); the
  changelog's entry and SECURITY.md state it as fact and name the one manual check left, GCM's
  sign-in window (W12).

---

## 13. QA log

The rows of §7.5, as a flow: steps and expected result there, observed and result here. Three runs:
1. **The box, over ssh** (Windows 11, `195bea0`, Git for Windows 2.52 in `C:\Program Files\Git`,
   Windows' OpenSSH 9.5p2, a local sshd and throwaway keys and known_hosts files): every automated
   row. git ran inside an **sshd session** there, where Windows' OpenSSH relays only its first
   stderr write and never exits (§3.2): the Windows-OpenSSH timings of W16, W17, W3, W4, W10 and
   W15 (about 10.1 s) are the watchdog ending that session artifact, not desktop behaviour.
2. **The user's interactive desktop** (the packaged 0.2.1 build, which starts git as this branch
   does): W6 and the failure and prompt cases with Windows' OpenSSH, against github.com.
3. **This branch on the desktop** (`415ccec`; rows D-A to D-flash below): in alex's interactive
   session (session 2, over RDP), the branch's real `src/remote.js` fetch as `ops.fetch` runs it
   (the default 120 s timeout, the 10 s stall), started by electron.exe (Electron 44.4.5) with
   `ELECTRON_RUN_AS_NODE=1` after `FreeConsole` (no console, as the app has none), Git 2.52.0, and
   S3's env from the real `askpassEnv()` (`SSH_ASKPASS=C:/Program Files/Git/usr/bin/false.exe`,
   `SSH_ASKPASS_REQUIRE=force`). Cases without S3 set `SSH_ASKPASS_REQUIRE=never` (S3 stands down)
   and were cancelled at 40 s. A window watcher (an event hook plus a 30 ms poll) looked for any
   window shown or created by ssh.exe, conhost.exe, false.exe, git.exe, sh.exe, taskkill.exe or
   electron.exe.

**Where it stands.**
1. The suite on Windows: 1876 tests, 1847 pass, 0 fail, 29 skipped; every fake-ssh and
   Windows-only test ran and passed (the stall tree kill, `false.exe`, `askpassEnv`'s production
   path, the askpass integration). **Pass.**
2. **W6: pass on the desktop** (it failed only inside the sshd session). `RECOMMEND_WINDOWS_OPENSSH`
   is on.
3. **S2's rows** (W16, W17, W7): pass inside the sshd session, `git.exe` alive during every hang.
   On the desktop there is no exit hang to end: a refused key fails within seconds by itself. S2
   is kept as insurance (§12).
4. **S3's rows**: W3, W4, W10, W11, W15 and W12's automated part pass, and **pass on the desktop
   with this branch** (run 3): an unknown host key and a passphrase key through Windows' OpenSSH
   fail in 0.7–1.1 s instead of hanging, and no console window flashes. The prompt hang S3 fixes is
   real there (0.2.1, and this branch with S3 standing down: hung until cancelled).
5. **Still manual**: Git Credential Manager's sign-in window (W12); W8 and a W6 success on this
   build on the desktop; W13, W14, W18; the macOS rows.

The changelog's askpass bullet and SECURITY.md's "ssh on Windows" paragraph state the desktop
results as fact and name W12's GCM check as the one left.

| # | Steps (§7.5) | Expected | Observed | Result |
|---|---|---|---|---|
| CI | the suite on Windows (the box) | green; every fake-ssh and Windows-only test runs | 1876 tests, 1847 pass, 0 fail, 29 skipped; all of those ran | pass |
| W6 | Windows' OpenSSH as `core.sshCommand`, key in its agent service, known host | all succeed in normal time | **desktop**: from the console ls-remote 2.0 s, clone 15.1 s (6.6 MiB), fetch 2.4 s; in the app three Pulls in 2.1–2.6 s. Inside the sshd session every op hung (ls-remote and clone to the 60 s deadline; the app's ops until Cancel), while the bundled ssh succeeded in 0.34–0.49 s | **pass** (desktop); session artifact |
| W6b | desktop, Windows' OpenSSH, a refused key, in the app (0.2.1) | auth, fast | "Authentication failed" within a few seconds, with git's whole stderr (ssh's line, "fatal: Could not read from remote repository.", the access-rights lines) | pass: no exit hang on the desktop |
| W6c | desktop, Windows' OpenSSH, an unknown host key (`ssh://git@ssh.github.com:443/…`), in the app (0.2.1, no S3) | — (the prompt hang, §3.2) | stuck at "Working…", no console window to answer in | reproduced: S3's case |
| D-A | run 3: Windows' OpenSSH, unknown host (`ssh.github.com:443`), S3 on | `host-key`, fast | `host-key` in 703 ms; ssh exited by itself (no stall); `false.exe` seen as a child of System32's ssh.exe | pass |
| D-A0 | as D-A, S3 standing down (`SSH_ASKPASS_REQUIRE=never`) | the prompt hang | hung; aborted by the 40 s cancel, settled 142 ms after it | reproduced (S3's case) |
| D-B | run 3: Windows' OpenSSH, a passphrase-protected PEM key with no `.pub`, S3 on | `auth`, fast | `auth` in 1108 ms | pass |
| D-B0 | as D-B, S3 off | the prompt hang | hung until the 40 s cancel, settled 122 ms after it | reproduced (S3's case) |
| D-C | run 3: bundled ssh, unknown host, S3 on | `host-key`, fast | `host-key` in 722 ms; `false.exe` seen as a child of the MSYS ssh.exe | pass |
| D-flash | run 3, every case above | no console window | none: no window shown or created by ssh.exe, conhost.exe, false.exe, git.exe, sh.exe, taskkill.exe or electron.exe; each git's conhost never created one. No process left; `~/.ssh/known_hosts` byte-identical | pass |
| W1 | bundled ssh, passphrase key not in an agent | auth within ~1 s, nothing left | `auth` 115–189 ms after the start (Fetch, Pull, Push, Clone) | pass |
| W2 | bundled ssh, unknown host | `host-key` within ~1 s | `host-key`, 114 ms (Clone), 139 ms (Fetch) | pass |
| W16 | Windows' OpenSSH, S3 off, refused key (sshd session) | `auth` ~10 s after ssh's line, `git.exe` alive, nothing left | `auth`, stalled; fire 10.015–10.016 s, settled 10.13–10.17 s after the line; git, sh, ssh alive during the hang; nothing left | pass (the session artifact, ended) |
| W17 | Windows' OpenSSH, unreachable (sshd session) | `unreachable` within ~10 s | `unreachable`, stalled; settled 10.13–10.14 s after the line (Fetch, Push, Clone) | pass (as W16) |
| W3 | Windows' OpenSSH, S3 on, passphrase key (sshd session) | auth, no console window | `auth`, stalled, 10.12–10.15 s after the line; `false.exe` reached ssh. Desktop: D-B, D-flash | pass |
| W4 | Windows' OpenSSH, S3 on, unknown host (sshd session) | `host-key`, no console window | `host-key`, stalled, 10.13–10.14 s. Desktop: D-A, D-C, D-flash | pass |
| W5 | S3 standing down (`SSH_ASKPASS_REQUIRE=never`) | the prompt hang; Cancel → aborted; Fetch ends at 120 s | Cancel settled 116–118 ms after it; Fetch's timeout at 120.15 s | pass |
| W7 | as W16, Cancel within 10 s | aborted with `said` | aborted, `said` `auth` with ssh's line; settled 120–141 ms after the Cancel | pass |
| W8 | Windows' OpenSSH, changed host key (sshd session) | the changed-key dialog, no "accept" | at `195bea0` only the `@@@…` frame reached git: Fetch timed out at 120 s, Clone hung until cancelled; most likely the session artifact. The bundled ssh: `host-key` with `changed`, the fingerprint and `keyName` in 0.12 s | fixed since as insurance (§12); desktop re-run to do |
| W9 | bundled ssh, unreachable | toast / dialog | `unreachable` 4 ms after the line (Fetch, Push) | pass |
| W10 | user's own `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE` | the user's helper is called | the user's `.cmd` helper was called (by both ssh flavours); the app set nothing | pass |
| W11 | default install path (with a space), W3 and W1 | `false.exe` runs for both ssh flavours | `C:/Program Files/Git/usr/bin/false.exe` ran for both; control with a missing askpass: Windows' OpenSSH hung to the timeout | pass |
| W12 | HTTPS: no helper, and GCM; then close GCM's window | `auth`, without the askpass line shown | `auth`; the error keeps git's "unable to read askpass response" line, which the page drops (§4.5). GCM's sign-in window: manual, not run | pass (automated) / manual |
| W15 | git running Windows' OpenSSH from `PATH` | as with `core.sshCommand` | a private Git copy without `usr\bin\ssh*.exe`, so git ran System32's ssh from `PATH`: W16's case (S3 off) and W3's (with that copy's `false.exe`) stalled as `auth`, settled 10.13–10.16 s after the line (sshd session) | pass |
| W13 | PuTTY / TortoisePlink as `GIT_SSH` | works; TortoisePlink's own dialog | not run | manual |
| W14 | Windows 10, OpenSSH 8.1, W3 | the prompt hang (recorded, expected) | not run | manual |
| W18 | Copy Diagnostics after W1–W17 | no key path, URL credentials, home path or ssh lines | not run | manual |
| M1–M8 | macOS rows of §7.5 | as listed there | not run | manual |
