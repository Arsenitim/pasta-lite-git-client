'use strict';
// Draft the changelog of a range of main's history, from its merged pull requests and commits:
//   node scripts/changelog-draft.js [<from>..<to> | <from>] [--summary]
// Default range: the last v* tag before HEAD..HEAD (all of history if there is no tag yet).
// The draft is a list of what changed, grouped into CHANGELOG.md's sections, for a maintainer to
// curate into the [Unreleased] section in the changelog's own voice: it is never the text to
// publish, and nothing writes it into CHANGELOG.md.
//
// Main's first-parent history is read one entry per pull request ("Merge pull request #N from
// owner/branch", whose body is the PR's title, or a squash-merged "subject (#N)") and one per
// commit made on main directly. A PR goes where its title's type says (feat → Added, fix → Fixed,
// perf and revert → Changed, a security scope or word → Security); a title that isn't conventional
// falls back to its branch's prefix (feat/..., fix/...), then to its commits' types; a commit or
// PR that still says nothing goes under Changed for the curator to sort. A PR's feat and fix
// commits are listed under it. Types that aren't user-facing (test, docs, chore, ci, build,
// style, refactor) are left out and only counted at the end. --summary writes the counts as text
// instead of HTML comments, for a GitHub job summary (.github/workflows/changelog.yml).
const { parseArgs } = require('node:util');
const { git, checkRev, parseSubject, sectionOf, isEntry, errorText } = require('./changelog');

// Keep a Changelog's order.
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const MERGE_PR = /^Merge pull request #(\d+) from (\S+)/;
const SQUASH_PR = /^(.*\S)\s+\(#(\d+)\)$/;
// Where a PR goes from its commits when its title and branch say nothing: the most notable first.
const PRIORITY = ['Security', 'Added', 'Fixed', 'Changed'];
// A commit that says nothing still changed something: it goes under Changed for the curator to sort.
const changed = (section) => (section === 'unknown' ? 'Changed' : section);

/** Commits of `git log <args>`: [{sha, parents, subject, body}]. */
function log(cwd, args) {
  const out = git(cwd, ['log', '--format=%H%x1f%P%x1f%s%x1f%b%x1e', ...args]);
  return out.split('\x1e').map((r) => r.replace(/^\r?\n/, '')).filter(Boolean).map((r) => {
    const [sha, parents, subject, body = ''] = r.split('\x1f');
    return { sha, parents: parents.split(' ').filter(Boolean), subject, body: body.replace(/\r\n?/g, '\n').trim() };
  });
}

/** `rev`'s commit id, or null if it doesn't name one. */
function commitOf(cwd, rev) {
  try {
    return git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]).trim();
  } catch {
    return null;
  }
}

/** The last v* tag before `to` (not `to`'s own tag: drafting at a release tag drafts that release), or null. */
function lastTag(cwd, to) {
  const describe = (rev) => {
    try {
      return git(cwd, ['describe', '--tags', '--abbrev=0', '--match', 'v*', '--end-of-options', rev]).trim();
    } catch {
      return null; // no tag, or `rev` has no parent
    }
  };
  const tag = describe(to);
  if (tag && commitOf(cwd, tag) === commitOf(cwd, to)) return describe(`${to}^`);
  return tag;
}

/** {from, to, revs}: the git log arguments for a range argument (see the header), or the default. */
function resolveRange(cwd, arg) {
  // A ref name can't hold "..": a symmetric "a...b" or "a..b..c" is a mistake, not a range.
  const [a, b = '', ...rest] = arg ? arg.split('..') : [];
  if (rest.length || (arg && arg.includes('...'))) throw new Error(`Not a range: ${JSON.stringify(arg)} (<from>..<to> or <from>)`);
  const to = b ? checkRev(b, 'the range end') : 'HEAD';
  const from = arg ? checkRev(a, 'the range start') : lastTag(cwd, to);
  for (const rev of [from, to]) if (rev && !commitOf(cwd, rev)) throw new Error(`Not a commit: ${rev}`);
  return { from, to, revs: from ? [`${from}..${to}`] : [to] };
}

/** The description with a capital first letter, as CHANGELOG.md's entries start; marked if breaking. */
function entryText(parsed) {
  const d = parsed.description;
  return `${parsed.breaking ? '**Breaking:** ' : ''}${d.charAt(0).toUpperCase()}${d.slice(1)}`;
}

/**
 * A commit as a draft item: {subject, sha, parsed, section} (section: see sectionOf). A
 * "BREAKING CHANGE:" footer in its body makes it breaking, like a "!" after the type.
 */
function commitItem(c) {
  const parsed = parseSubject(c.subject);
  if (/^BREAKING[ -]CHANGE:/m.test(c.body)) parsed.breaking = true;
  return { subject: c.subject, sha: c.sha, parsed, section: sectionOf(parsed) };
}

/**
 * The draft of `range` (resolveRange) in the repository at `cwd`: {from, to, entries, left},
 * `entries` [{section, text, ref, details}] in history order, `left` the entries left out as not
 * user-facing [{ref, subject}] (`ref` '#N' for a PR, else the short sha).
 */
function draft(cwd, rangeArg) {
  const { from, to, revs } = resolveRange(cwd, rangeArg);
  const entries = [];
  const left = [];
  const short = (sha) => sha.slice(0, 7);
  const addCommit = (c) => {
    const item = commitItem(c);
    if (item.section === 'skip') left.push({ ref: short(c.sha), subject: c.subject });
    else entries.push({ section: changed(item.section), text: entryText(item.parsed), ref: short(c.sha), details: [] });
  };
  for (const c of log(cwd, ['--first-parent', '--reverse', '--end-of-options', ...revs])) {
    const merge = MERGE_PR.exec(c.subject);
    const squash = !merge && c.parents.length === 1 && SQUASH_PR.exec(c.subject);
    if (merge && c.parents.length > 1) {
      const commits = log(cwd, ['--no-merges', '--reverse', '--end-of-options', `${c.parents[0]}..${c.parents[1]}`]).map(commitItem);
      const title = c.body.split('\n')[0].trim() || c.subject;
      addPr({ number: merge[1], branch: merge[2].replace(/^[^/]+\//, ''), title, commits });
    } else if (squash) {
      addPr({ number: squash[2], branch: '', title: squash[1], commits: [commitItem({ ...c, subject: squash[1] })] });
    } else if (c.parents.length > 1) {
      // Another merge into main (a branch, not a PR): its commits count one by one.
      for (const m of log(cwd, ['--no-merges', '--reverse', '--end-of-options', `${c.parents[0]}..${c.parents[1]}`])) addCommit(m);
    } else {
      addCommit(c);
    }
  }
  return { from, to, entries, left };

  function addPr({ number, branch, title, commits }) {
    const parsed = parseSubject(title);
    if (commits.some((i) => i.parsed.breaking)) parsed.breaking = true;
    let section = sectionOf(parsed);
    if (section === 'unknown') section = sectionOf(parseSubject(branch.replace(/^([a-z]+)[/-]/i, '$1: ')));
    if (section === 'unknown') {
      const found = new Set(commits.map((i) => changed(i.section)));
      section = PRIORITY.find((s) => found.has(s)) || 'skip';
    }
    if (section === 'skip') {
      left.push({ ref: `#${number}`, subject: title });
      return;
    }
    // The PR's own user-facing commits, but not one that repeats its title.
    const details = commits.filter((i) => isEntry(i.section) && i.parsed.description !== parsed.description)
      .map((i) => `${i.subject} (${short(i.sha)})`);
    entries.push({ section, text: entryText(parsed), ref: `#${number}`, details });
  }
}

/**
 * The draft as Markdown, sections in Keep a Changelog's order. In a summary, commit text is
 * escaped (a subject's "<img>" stays text); otherwise it is kept as written, and only a "-->" that
 * would end the trailing HTML comment early is broken.
 */
function render({ from, to, entries, left }, { summary = false } = {}) {
  const range = from ? `${from}..${to}` : to;
  const text = summary ? (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : (s) => s;
  const commented = (s) => s.replace(/-->/g, '--&gt;');
  const note = (s) => (summary ? text(s) : `<!-- ${commented(s)} -->`);
  const out = [note(`Draft from ${range}. Curate it into the [Unreleased] section of CHANGELOG.md: it lists what changed, not the text to publish.`)];
  if (!entries.length) out.push('', text(`Nothing user-facing in ${range}.`));
  for (const section of SECTIONS) {
    const items = entries.filter((e) => e.section === section);
    if (!items.length) continue;
    out.push('', `### ${section}`, '');
    for (const e of items) {
      out.push(`- ${text(e.text)} (${e.ref})`);
      for (const d of e.details) out.push(`  - ${text(d)}`);
    }
  }
  if (left.length) {
    const lines = left.map((l) => `- ${l.ref} ${summary ? text(l.subject) : commented(l.subject)}`);
    const head = `Left out as not user-facing (${left.length}):`;
    out.push('', summary ? [`<details><summary>${head}</summary>`, '', ...lines, '', '</details>'].join('\n')
      : ['<!--', head, ...lines, '-->'].join('\n'));
  }
  return `${out.join('\n')}\n`;
}

// Errors go to stderr, not report()'s annotation on stdout: in Actions, stdout is the job summary.
function main(argv) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { summary: { type: 'boolean', default: false } } }));
    if (positionals.length > 1) throw new Error(`Unexpected argument: ${positionals[1]}`);
  } catch (err) {
    console.error(`${err.message}\nUsage: node scripts/changelog-draft.js [<from>..<to> | <from>] [--summary]`);
    return 1;
  }
  try {
    process.stdout.write(render(draft(process.cwd(), positionals[0]), { summary: values.summary }));
    return 0;
  } catch (err) {
    console.error(errorText(err));
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { draft, render };
