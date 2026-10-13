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
const FENCE = /^\s*(```|~~~)/;
// A link reference definition, like the "[0.2.1]: https://..." lines at the end of the file.
const LINK_REF = /^\[([^\]]+)\]:\s*(\S+)/;

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
  let fence = false;
  const close = () => {
    if (!current) return;
    const body = current.lines;
    while (body.length && (!body[body.length - 1].trim() || LINK_REF.test(body[body.length - 1]))) body.pop();
    while (body.length && !body[0].trim()) body.shift();
    sections.push({ name: current.name, date: current.date, body: body.join('\n') });
    current = null;
  };
  for (const line of lines) {
    if (FENCE.test(line)) fence = !fence;
    const link = !fence && LINK_REF.exec(line);
    if (link) links.set(link[1].toLowerCase(), link[2]);
    const heading = !fence && VERSION_HEADING.exec(line);
    if (heading) {
      close();
      const date = /^\s*-\s*(\d{4}-\d{2}-\d{2})\b/.exec(heading[2]);
      current = { name: heading[1].trim(), date: date ? date[1] : null, lines: [] };
    } else if (!fence && /^#{1,2}\s/.test(line)) {
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

/**
 * `markdown` with each paragraph and list item on one line. CHANGELOG.md is wrapped at 100
 * columns, and a GitHub release's notes show every newline as a line break. Fenced code, headings,
 * tables and a line ending in two spaces (a Markdown line break) keep their newlines.
 */
function unwrap(markdown) {
  const out = [];
  let fence = false;
  let joinable = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      fence = !fence;
      out.push(line);
      joinable = false;
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    const blank = !line.trim();
    // A line that starts a block of its own: a list item, a heading, a quote, a table row, HTML.
    const starts = /^\s*([-*+]\s|\d+[.)]\s|#|>|\||<)/.test(line);
    if (joinable && !blank && !starts) {
      out[out.length - 1] += ` ${line.trim()}`;
    } else {
      out.push(line);
    }
    const last = out[out.length - 1];
    joinable = !blank && !/^\s*(#|\|)/.test(last) && !/ {2}$/.test(last);
  }
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

/** A message for the user: a GitHub annotation (::error:: / ::warning::) when running in Actions. */
function report(level, message) {
  // A workflow command's message escapes %, CR and LF (GitHub's toolkit does the same).
  const escaped = () => message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${level}::${escaped()}`);
  else (level === 'error' ? console.error : console.log)(`${level}: ${message}`);
}

module.exports = {
  parseChangelog, sectionName, findSection, unwrap, parseSubject, sectionOf, isEntry, git, checkRev, report,
};
