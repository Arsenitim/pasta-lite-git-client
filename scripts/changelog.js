'use strict';
// CHANGELOG.md and commit subjects, for the changelog scripts next to this file:
//   changelog-draft.js     a draft of what changed since the last release, from merged PRs and commits
//   changelog-section.js   one version's section of CHANGELOG.md (the GitHub release's notes)
//   changelog-pr-check.js  does a PR that changes the app add to the [Unreleased] section?
//   release-check.js       do the tag, package.json and CHANGELOG.md agree?
// CHANGELOG.md is written by hand (Keep a Changelog: "## [0.2.1] - 2026-10-04" headings, then
// "### Added" and so on): these scripts read it and never write it. Plain Node and the git CLI only,
// so they run the same on macOS, Linux and Windows.
const { execFileSync } = require('node:child_process');

// "## [0.2.1] - 2026-10-04", "## [Unreleased]". The date is optional here (release-check.js
// requires it for a release).
const VERSION_HEADING = /^##\s+\[([^\]]+)\](.*)$/;
// A fenced code block's opening line: three or more backticks or tildes, then an info string (one
// without backticks after backticks). CommonMark allows 0-3 spaces before it; any indentation is
// allowed here, as a fence inside a list item is indented by the item's.
const FENCE_OPEN = /^\s*(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
// A link reference definition, like the "[0.2.1]: https://..." lines at the end of the file.
const LINK_REF = /^\[([^\]]+)\]:\s*(\S+)/;

/**
 * The fenced code block open after `line`, given `fence`, the one open before it (null outside
 * code). As in CommonMark, only a line of the opening's character, at least as many of them and
 * nothing else closes it: a ~~~ line inside a ``` block, or a ``` line inside a ```` block, is code.
 */
function nextFence(fence, line) {
  if (!fence) {
    const open = FENCE_OPEN.exec(line);
    return open ? open[1] : null;
  }
  const close = FENCE_CLOSE.exec(line);
  return close && close[1][0] === fence[0] && close[1].length >= fence.length ? null : fence;
}

/**
 * The version sections of a Keep a Changelog file, in file order: [{name, date, body}], `body`
 * being the text under the heading up to the next "## " heading, trimmed, without the link
 * reference definitions that end the file. `links`: the link references by lower-cased name.
 * Headings inside fenced code blocks don't count.
 */
function parseChangelog(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  const links = new Map();
  let current = null;
  let fence = null;
  const close = () => {
    if (!current) return;
    const body = current.lines;
    while (body.length && (!body[body.length - 1].trim() || LINK_REF.test(body[body.length - 1]))) body.pop();
    while (body.length && !body[0].trim()) body.shift();
    sections.push({ name: current.name, date: current.date, body: body.join('\n') });
    current = null;
  };
  for (const line of lines) {
    // The fence lines themselves are code too.
    const code = fence !== null || FENCE_OPEN.test(line);
    fence = nextFence(fence, line);
    const link = !code && LINK_REF.exec(line);
    if (link) links.set(link[1].toLowerCase(), link[2]);
    const heading = !code && VERSION_HEADING.exec(line);
    if (heading) {
      close();
      const date = /^\s*-\s*(\d{4}-\d{2}-\d{2})\b/.exec(heading[2]);
      current = { name: heading[1].trim(), date: date ? date[1] : null, lines: [] };
    } else if (!code && /^#{1,2}\s/.test(line)) {
      close(); // another level-1 or level-2 heading ends the version's section
    } else if (current) {
      current.lines.push(line);
    }
  }
  close();
  return { sections, links };
}

/** "0.3.0", "v0.3.0", "Unreleased" (any case) → the name as CHANGELOG.md's headings spell it. */
function sectionName(version) {
  const v = String(version).trim();
  return v.toLowerCase() === 'unreleased' ? 'Unreleased' : v.replace(/^v(?=\d)/, '');
}

/** The section of `text` for `version` (sectionName), or null. */
function findSection(text, version) {
  const name = sectionName(version).toLowerCase();
  return parseChangelog(text).sections.find((s) => s.name.toLowerCase() === name) || null;
}

// The blocks unwrap tells from a paragraph's text (CommonMark's, and GitHub's tables). A line
// that starts one of them is never joined to the line before it.
const HEADING = /^\s*#{1,6}(\s|$)/; // "#12" at the start of a wrapped line is text
const BULLET = /^\s*[-*+]\s/;
const ORDERED = /^\s*(\d{1,9})[.)]\s/;
const QUOTE = /^\s*>/;
// A thematic break (***, - - -) or a setext heading's underline (===, ---).
const RULE = /^ {0,3}(([-*_])(\s*\2){2,}|=+|-+)\s*$/;
// A table's delimiter row, "| --- | :-: |" or "--- | ---" (it must have a pipe): the line above
// it is the table's header.
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const BLANK = /^\s*$/;
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|'
  + 'fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|'
  + 'nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
// The HTML blocks that can interrupt a paragraph (CommonMark's kinds 1 to 6), each with the line
// that ends it: its closing marker, or for a block-level tag a blank line. An inline tag such as
// <kbd> at the start of a wrapped line is text.
const HTML_BLOCKS = [
  [/^\s*<(pre|script|style|textarea)(\s|>|$)/i, /<\/(pre|script|style|textarea)>/i],
  [/^\s*<!--/, /-->/],
  [/^\s*<\?/, /\?>/],
  [/^\s*<!\[CDATA\[/, /\]\]>/],
  [/^\s*<![A-Za-z]/, />/],
  [new RegExp(`^\\s*</?(${BLOCK_TAGS})(\\s|/?>|$)`, 'i'), BLANK],
];
// A hard line break: two or more spaces, or an unescaped backslash, at the end of the line.
const HARD_BREAK = /( {2,}|(^|[^\\])(\\\\)*\\)$/;

/**
 * `markdown` with each paragraph and list item on one line. CHANGELOG.md is wrapped at 100
 * columns, and a GitHub release's notes show every newline as a line break. Everything else keeps
 * its newlines: fenced code, headings, setext underlines and thematic breaks, quotes, tables
 * (verbatim up to a blank line), HTML blocks, link reference definitions, and a hard line break.
 *
 * A numbered line in the middle of a paragraph: as in CommonMark, only "1." (or "1)") starts a list
 * there, so "released in\n2026. Then" stays one paragraph; but after a list item, "2." is that
 * list's next item. (CommonMark would make an indented "2." inside a bullet's wrapped text part of
 * the text; the changelog doesn't wrap that way.)
 */
function unwrap(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let fence = null;
  let verbatim = null; // the end of the HTML block or table being copied, see HTML_BLOCKS
  let joinable = false; // whether the next line may continue out's last line
  lines.forEach((line, i) => {
    if (verbatim || fence !== null || FENCE_OPEN.test(line)) {
      if (verbatim) {
        if (verbatim.test(line)) verbatim = null;
      } else {
        fence = nextFence(fence, line);
      }
      out.push(line);
      joinable = false;
      return;
    }
    const html = HTML_BLOCKS.find(([open]) => open.test(line));
    const next = lines[i + 1] || '';
    const table = line.includes('|') && next.includes('|') && TABLE_DELIMITER.test(next);
    const prev = out.length ? out[out.length - 1] : '';
    const rule = RULE.test(line); // "* * *" isn't a list item
    const item = !rule && (BULLET.test(line)
      || (ORDERED.test(line) && (Number(ORDERED.exec(line)[1]) === 1 || BULLET.test(prev) || ORDERED.test(prev))));
    const starts = item || rule || BLANK.test(line) || html || table || HEADING.test(line) || QUOTE.test(line)
      || LINK_REF.test(line);
    if (joinable && !starts) out[out.length - 1] += ` ${line.trimStart()}`;
    else out.push(line);
    if (html) verbatim = html[1].test(line) ? null : html[1]; // <!-- a one-line comment -->
    if (table) verbatim = BLANK;
    // A paragraph, a list item or a quote goes on, unless this line ends in a hard line break.
    joinable = !verbatim && (!starts || item || QUOTE.test(line)) && !HARD_BREAK.test(out[out.length - 1]);
  });
  return out.join('\n');
}

// Conventional Commits: "feat(scope)!: description". Types that never make a changelog entry by
// themselves (CONTRIBUTING.md "Commits"), and where the others go.
const NOT_USER_FACING = new Set(['test', 'docs', 'chore', 'ci', 'build', 'style', 'refactor']);
const TYPE_SECTIONS = { feat: 'Added', fix: 'Fixed', perf: 'Changed', revert: 'Changed' };
const SECURITY = /\b(security|vulnerabilit(?:y|ies)|CVE-\d{4}-\d+)\b/i;

/** {type, scope, breaking, description} of a commit subject or PR title; type null if it isn't conventional. */
function parseSubject(subject) {
  const m = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject.trim());
  if (!m) return { type: null, scope: null, breaking: false, description: subject.trim() };
  return { type: m[1].toLowerCase(), scope: m[2] ? m[2].trim().toLowerCase() : null, breaking: !!m[3], description: m[4].trim() };
}

/**
 * The Keep a Changelog section a parsed subject belongs in: 'Added', 'Changed', 'Fixed' or
 * 'Security'; 'skip' for a type that isn't user-facing (test, docs, ...); 'unknown' when the
 * subject says nothing (not conventional, or a type of its own). A security scope or word wins
 * over the type. isEntry tells a section from the other two.
 */
function sectionOf(parsed) {
  if (!parsed.type) return 'unknown';
  if (NOT_USER_FACING.has(parsed.type)) return 'skip';
  if (parsed.type === 'security' || parsed.scope === 'security' || SECURITY.test(parsed.description)) return 'Security';
  return Object.hasOwn(TYPE_SECTIONS, parsed.type) ? TYPE_SECTIONS[parsed.type] : 'unknown';
}

/** Whether sectionOf's `section` is a changelog section (not 'skip' or 'unknown'). */
const isEntry = (section) => section !== 'skip' && section !== 'unknown';

/**
 * Synchronous git in `cwd`, its stdout. The -c overrides keep a user's config from changing what
 * the scripts parse.
 */
function git(cwd, args) {
  return execFileSync('git', ['-c', 'log.showSignature=false', '-c', 'core.quotePath=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
}

/** A revision from the command line or a workflow input: never an option to git. */
function checkRev(rev, what) {
  if (!rev || rev.startsWith('-') || /\s/.test(rev)) throw new Error(`Not a revision for ${what}: ${JSON.stringify(rev)}`);
  return rev;
}

/** What to tell the user about a failure: git's own stderr when git failed, else the message. */
function errorText(err) {
  return (err.stderr && String(err.stderr).trim()) || err.message;
}

/** A message for the user: a GitHub annotation (::error:: / ::warning::) when running in Actions. */
function report(level, message) {
  // A workflow command's message escapes %, CR and LF (GitHub's toolkit does the same).
  const escaped = () => message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${level}::${escaped()}`);
  else (level === 'error' ? console.error : console.log)(`${level}: ${message}`);
}

module.exports = {
  parseChangelog, sectionName, findSection, unwrap, parseSubject, sectionOf, isEntry,
  git, checkRev, errorText, report,
};
