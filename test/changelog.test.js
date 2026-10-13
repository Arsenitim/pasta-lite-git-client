'use strict';
// scripts/changelog*.js and scripts/release-check.js: CHANGELOG.md's sections, the draft from
// merged PRs and commits, the PR check of [Unreleased], and the release tag check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { git, initRepo, tmpDir, write } = require('./helpers');
const { parseChangelog, findSection, sectionName, unwrap, parseSubject, sectionOf, isEntry } = require('../scripts/changelog');
const { draft, render } = require('../scripts/changelog-draft');
const { prChanges, verdict } = require('../scripts/changelog-pr-check');
const { releaseProblems } = require('../scripts/release-check');

const FIXTURE = path.join(__dirname, 'fixtures', 'changelog', 'CHANGELOG.md');
const fixture = fs.readFileSync(FIXTURE, 'utf8');
const SCRIPTS = path.join(__dirname, '..', 'scripts');

/** A changelog with an [Unreleased] section holding `unreleased` and a 1.0.0 one holding `released`. */
const changelog = (unreleased = '', released = '- The first release.') =>
  `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n\n## [1.0.0] - 2026-09-01\n\n### Added\n\n${released}\n\n[1.0.0]: https://example.com/v1.0.0\n`;

test('parseChangelog: the version sections, their dates and bodies, and the link references', () => {
  const { sections, links } = parseChangelog(fixture);
  assert.deepEqual(sections.map((s) => [s.name, s.date]), [['Unreleased', null], ['1.1.0', '2026-10-01'], ['1.0.0', '2026-09-01']]);
  // A "## [" line in a fenced block is part of the section, not a heading.
  assert.match(sections[1].body, /^### Fixed\n/);
  assert.match(sections[1].body, /## \[9\.9\.9\] - not a heading inside a fence\nkeep\nthese lines\n```$/);
  // The link references at the end aren't part of the last section.
  assert.equal(sections[2].body, '### Added\n\n- The first release.');
  assert.equal(links.get('1.1.0'), 'https://example.com/compare/v1.0.0...v1.1.0');
  assert.equal(links.get('unreleased'), 'https://example.com/compare/v1.1.0...HEAD');
});

test('parseChangelog: CRLF line endings, and a section ended by another level-2 heading', () => {
  const text = '## [Unreleased]\r\n\r\n- a\r\n\r\n## Notes\r\n\r\nnot a version\r\n## [1.0.0] - 2026-09-01 [YANKED]\r\n- b\r\n';
  assert.deepEqual(parseChangelog(text).sections, [
    { name: 'Unreleased', date: null, body: '- a' },
    { name: '1.0.0', date: '2026-09-01', body: '- b' },
  ]);
});

test('findSection: by version, tag or Unreleased in any case', () => {
  assert.equal(sectionName('v1.1.0'), '1.1.0');
  assert.equal(sectionName('UNRELEASED'), 'Unreleased');
  assert.equal(findSection(fixture, 'v1.0.0').name, '1.0.0');
  assert.equal(findSection(fixture, '1.0.0').body, '### Added\n\n- The first release.');
  assert.match(findSection(fixture, 'unreleased').body, /^### Added\n\n- A new widget/);
  assert.equal(findSection(fixture, '9.9.9'), null);
  assert.equal(findSection(fixture, '1.0'), null);
});

test('unwrap: paragraphs and list items on one line; fences, headings, nested items and line breaks kept', () => {
  assert.equal(unwrap(findSection(fixture, '1.1.0').body), [
    '### Fixed',
    '',
    '- A fix whose entry has a nested list:',
    '  - one point,',
    '  - another point.',
    '',
    'On Windows:',
    '',
    '- A Windows fix.',
    '',
    'A paragraph that ends in a line break,  ',
    'and goes on.',
    '',
    '```sh',
    '## [9.9.9] - not a heading inside a fence',
    'keep',
    'these lines',
    '```',
  ].join('\n'));
  assert.equal(unwrap(findSection(fixture, 'Unreleased').body),
    "### Added\n\n- A new widget that wraps over two lines, as CHANGELOG.md's entries do at a hundred columns, with `code` in it.");
  assert.equal(unwrap('Some text\n1. first\n2. second\n> quote\n| a | b |\n| - | - |'), 'Some text\n1. first\n2. second\n> quote\n| a | b |\n| - | - |');
});

test('unwrap: what starts a block, and what a wrapped line is joined to', () => {
  const same = (md) => assert.equal(unwrap(md), md, md);
  // "#12" and an inline tag are text; "# x" is a heading and a block-level tag an HTML block.
  assert.equal(unwrap('Fixes the crash from\n#12 and\n<kbd>Ctrl</kbd> keys.'), 'Fixes the crash from #12 and <kbd>Ctrl</kbd> keys.');
  same('Text\n# Heading\nText');
  // An HTML block is copied as it is up to a blank line; a one-line comment ends where it starts.
  assert.equal(unwrap('<details>\n<summary>More</summary>\nhidden\ntext\n</details>\n\nAfter\nmore'),
    '<details>\n<summary>More</summary>\nhidden\ntext\n</details>\n\nAfter more');
  assert.equal(unwrap('<!-- a note -->\nText\nmore'), '<!-- a note -->\nText more');
  // Only "1." starts a list in the middle of a paragraph; in a list, "2." is the next item.
  assert.equal(unwrap('Released in\n2026. Then\nmore.'), 'Released in 2026. Then more.');
  same('Steps:\n1. one\n2. two\n3) three');
  same('- a bullet\n2. then a numbered list');
  assert.equal(unwrap('1. one that\nwraps\n2. two'), '1. one that wraps\n2. two');
  // Hard line breaks: two spaces or a backslash, also at the end of a joined line; an escaped
  // backslash isn't one.
  same('a\\\nb');
  assert.equal(unwrap('a\\\\\nb'), 'a\\\\ b');
  assert.equal(unwrap('a\nb  \nc'), 'a b  \nc');
  // Setext underlines and thematic breaks end the paragraph above and are joined to nothing.
  assert.equal(unwrap('Title\nwrapped\n=====\nText\nmore'), 'Title wrapped\n=====\nText more');
  same('Sub\n---\nx');
  same('a\n* * *\nb');
  // A table, with or without outer pipes, is copied as it is up to a blank line.
  assert.equal(unwrap('Intro\na | b\n--- | :-:\n1 | 2\nrow\n\nAfter\nmore'), 'Intro\na | b\n--- | :-:\n1 | 2\nrow\n\nAfter more');
  assert.equal(unwrap('Pipes | in text\nare text'), 'Pipes | in text are text');
  // Link reference definitions keep a line each.
  same('[a]: https://example.com/a\n[b]: https://example.com/b');
});

test('unwrap and parseChangelog: a fence ends at a line of its own character, at least as long', () => {
  // A ~~~ line in a ``` block, and a ``` line in a ```` block, are code.
  assert.equal(unwrap('```\n~~~\nkeep\nthis\n```\nwrapped\ntext'), '```\n~~~\nkeep\nthis\n```\nwrapped text');
  assert.equal(unwrap('````md\n```\nkeep\nthis\n```\n````\nwrapped\ntext'), '````md\n```\nkeep\nthis\n```\n````\nwrapped text');
  // A closing line has no info string; an opening backtick line has no backtick after the fence.
  assert.equal(unwrap('```\n```js\nkeep\n```\nwrapped\ntext'), '```\n```js\nkeep\n```\nwrapped text');
  assert.equal(unwrap('```inline``` code\nwraps'), '```inline``` code wraps');
  const text = [
    '## [1.0.0] - 2026-09-01', '', '````md', '```', '## [9.9.9] - inside', '```', '````', '',
    '~~~', '```', '## [8.8.8] - inside', '~~~', '', '## [0.9.0] - 2026-08-01', '', '- x',
  ].join('\n');
  assert.deepEqual(parseChangelog(text).sections.map((s) => s.name), ['1.0.0', '0.9.0']);
  // An unclosed fence runs to the end.
  assert.deepEqual(parseChangelog('## [1.0.0]\n\n```\n## [0.9.0]\n').sections.map((s) => s.name), ['1.0.0']);
});

test('parseSubject, sectionOf and isEntry: conventional types to Keep a Changelog sections', () => {
  assert.deepEqual(parseSubject('feat(renderer)!: drop the old view'), { type: 'feat', scope: 'renderer', breaking: true, description: 'drop the old view' });
  assert.deepEqual(parseSubject('Windows alpha builds'), { type: null, scope: null, breaking: false, description: 'Windows alpha builds' });
  const of = (s) => sectionOf(parseSubject(s));
  assert.equal(of('feat(clone): Clone Repository dialog'), 'Added');
  assert.equal(of('fix(remote): explain ssh failures'), 'Fixed');
  assert.equal(of('perf(graph): faster lanes'), 'Changed');
  assert.equal(of('revert: feat(x): y'), 'Changed');
  // Security: the scope, or the word, wins over feat and fix.
  assert.equal(of('fix(security): harden trust checks'), 'Security');
  assert.equal(of('fix(src): patch CVE-2026-12345 in the parser'), 'Security');
  assert.equal(of('feat: a security setting'), 'Security');
  // Not user-facing, whatever the subject says.
  for (const s of ['test(remote): x', 'docs: security policy', 'chore: release 0.2.1', 'ci: run on Windows', 'build: pin eslint', 'refactor(src): y', 'style: z']) {
    assert.equal(of(s), 'skip', s);
  }
  // Nothing to go on.
  assert.equal(of('Windows alpha builds'), 'unknown');
  assert.equal(of('release(x): 1.0'), 'unknown');
  assert.deepEqual(['Added', 'Security', 'skip', 'unknown'].map(isEntry), [true, true, false, false]);
});

test('releaseProblems: the tag, package.json, package-lock.json and the dated section agree', () => {
  const ok = { tag: 'v1.0.0', pkg: { version: '1.0.0' }, lock: { version: '1.0.0', packages: { '': { version: '1.0.0' } } }, changelog: changelog() };
  assert.deepEqual(releaseProblems(ok), { errors: [], warnings: [] });
  assert.deepEqual(releaseProblems({ ...ok, tag: 'v1.0' }).errors, ["The tag v1.0 isn't a version tag (v<major>.<minor>.<patch>)."]);
  assert.deepEqual(releaseProblems({ ...ok, tag: 'release-1.0.0' }).errors.length, 1);
  assert.deepEqual(releaseProblems({ ...ok, pkg: { version: '0.9.0' } }).errors, ["package.json version 0.9.0 doesn't match the tag v1.0.0."]);
  assert.match(releaseProblems({ ...ok, lock: { version: '1.0.0', packages: { '': { version: '0.9.0' } } } }).errors[0],
    /^package-lock\.json version 0\.9\.0 doesn't match the tag v1\.0\.0/);
  // A prerelease tag needs the same prerelease version everywhere.
  const pre = { tag: 'v1.1.0-beta.1', pkg: { version: '1.1.0-beta.1' }, lock: { version: '1.1.0-beta.1', packages: { '': { version: '1.1.0-beta.1' } } } };
  assert.deepEqual(releaseProblems({ ...pre, changelog: changelog().replace('[1.0.0] - ', '[1.1.0-beta.1] - ') }).errors, []);
});

test('releaseProblems: a missing, undated or empty section fails; a missing link or leftover [Unreleased] warns', () => {
  const base = { pkg: { version: '1.1.0' }, lock: { version: '1.1.0', packages: { '': { version: '1.1.0' } } }, tag: 'v1.1.0' };
  assert.deepEqual(releaseProblems({ ...base, changelog: changelog('### Added\n\n- New.') }), {
    errors: ['CHANGELOG.md has no "## [1.1.0] - YYYY-MM-DD" section: move the [Unreleased] entries under one.'],
    warnings: ["CHANGELOG.md's [Unreleased] section still has entries: they aren't in v1.1.0's notes."],
  });
  assert.deepEqual(releaseProblems({ ...base, changelog: '## [Unreleased]\n\n## [1.1.0]\n\n- New.\n\n[1.1.0]: https://x\n' }).errors,
    ['CHANGELOG.md\'s [1.1.0] heading has no release date ("## [1.1.0] - YYYY-MM-DD").']);
  assert.deepEqual(releaseProblems({ ...base, changelog: '## [1.1.0] - 2026-10-13\n\n## [1.0.0] - 2026-09-01\n\n- Old.\n\n[1.1.0]: https://x\n' }).errors,
    ["CHANGELOG.md's [1.1.0] section is empty."]);
  assert.deepEqual(releaseProblems({ ...base, changelog: '## [Unreleased]\n\n## [1.1.0] - 2026-10-13\n\n- New.\n' }), {
    errors: [], warnings: ['CHANGELOG.md has no link reference for [1.1.0] at its end.'],
  });
});

test('changelog-section.js: prints a section, unwrapped on request; a missing or empty one exits 1', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'changelog-section.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' },
  });
  let r = run('v1.0.0', '--file', FIXTURE);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '### Added\n\n- The first release.\n');
  r = run('Unreleased', '--unwrap', '--file', FIXTURE);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^### Added\n\n- A new widget that wraps over two lines, as CHANGELOG\.md's entries do at a hundred columns, with `code` in it\.\n$/);
  r = run('v2.0.0', '--file', FIXTURE);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /has no "## \[2\.0\.0\]" section/);
  const dir = tmpDir();
  write(dir, 'CHANGELOG.md', '## [Unreleased]\n\n## [1.0.0] - 2026-09-01\n\n- x\n');
  r = run('Unreleased', '--file', path.join(dir, 'CHANGELOG.md'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: The \[Unreleased\] section of CHANGELOG\.md is empty/);
  r = run('v1.0.0', '--file', path.join(dir, 'missing.md'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: Can't read .*missing\.md: /);
  for (const args of [[], ['1.0.0', '1.1.0'], ['1.0.0', '--bogus'], ['1.0.0', '--file']]) {
    r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /Usage: node scripts\/changelog-section\.js/, args.join(' '));
  }
});

let fileCount = 0;
/** Commit `files` ({name: content}; default a new file) in `dir` with `message`; its short sha. */
function commit(dir, message, files = { [`f${++fileCount}.txt`]: 'x\n' }) {
  for (const [name, content] of Object.entries(files)) write(dir, name, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim().slice(0, 7);
}

/** Merge `branch` into the checked-out branch as GitHub merges PR `number` titled `title`. */
function mergePr(dir, number, branch, title) {
  git(dir, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${number} from owner/${branch}`, '-m', title, branch);
}

/** A branch off `main` with `messages` committed, back on main afterwards. */
function branch(dir, name, messages) {
  git(dir, 'switch', '-q', '-c', name, 'main');
  for (const m of messages) commit(dir, m);
  git(dir, 'switch', '-q', 'main');
}

test('draft: merged PRs and direct commits, grouped by section, the rest left out', () => {
  const dir = initRepo();
  git(dir, 'tag', 'v1.0.0');
  branch(dir, 'feat/widget', ['feat(ui): the widget', 'fix(ui): review fixes to the widget', 'test(ui): widget tests']);
  mergePr(dir, 1, 'feat/widget', 'feat(ui): add a widget');
  // A title that isn't conventional: the branch's prefix decides.
  branch(dir, 'fix/windows', ['fix(win): paths', 'docs: notes']);
  mergePr(dir, 2, 'fix/windows', 'Windows fixes');
  // Neither title nor branch says: the commits do (a feat wins over a fix).
  branch(dir, 'misc', ['fix: one thing', 'feat: another']);
  mergePr(dir, 3, 'misc', 'Assorted improvements');
  branch(dir, 'test/more', ['test: more tests', 'fix: a test helper']);
  mergePr(dir, 4, 'test/more', 'test: more tests');
  const security = commit(dir, 'fix(security): refuse a hostile config');
  commit(dir, 'docs: README');
  // A squash-merged PR.
  commit(dir, 'perf(graph): faster lanes (#5)');
  const breaking = commit(dir, 'feat(api)!: drop the old flag');
  const plain = commit(dir, 'Tidy up the toolbar');
  // A merge that isn't a PR: its commits count one by one.
  git(dir, 'switch', '-q', '-c', 'side');
  const side = commit(dir, 'fix: from a side branch');
  commit(dir, 'chore: side chores');
  git(dir, 'switch', '-q', 'main');
  git(dir, 'merge', '-q', '--no-ff', '-m', "Merge branch 'side'", 'side');
  // The initial commit is the tag's, so not in the draft.
  const d = draft(dir);
  assert.equal(d.from, 'v1.0.0');
  assert.equal(d.to, 'HEAD');
  assert.deepEqual(d.entries.map(({ section, text, ref }) => [section, text, ref]), [
    ['Added', 'Add a widget', '#1'],
    ['Fixed', 'Windows fixes', '#2'],
    ['Added', 'Assorted improvements', '#3'],
    ['Security', 'Refuse a hostile config', security],
    ['Changed', 'Faster lanes', '#5'],
    ['Added', '**Breaking:** Drop the old flag', breaking],
    ['Changed', 'Tidy up the toolbar', plain],
    ['Fixed', 'From a side branch', side],
  ]);
  // A PR's feat and fix commits are listed under it; its test and docs commits aren't.
  assert.deepEqual(d.entries[0].details.map((x) => x.replace(/ \([0-9a-f]{7}\)$/, '')), ['feat(ui): the widget', 'fix(ui): review fixes to the widget']);
  assert.deepEqual(d.entries[1].details.map((x) => x.replace(/ \([0-9a-f]{7}\)$/, '')), ['fix(win): paths']);
  assert.deepEqual(d.entries[4].details, []);
  assert.deepEqual(d.left.map((l) => l.subject), ['test: more tests', 'docs: README', 'chore: side chores']);
  assert.equal(d.left[0].ref, '#4');

  const md = render(d);
  assert.match(md, /^<!-- Draft from v1\.0\.0\.\.HEAD\. /);
  // Keep a Changelog's order, whatever the order in history.
  assert.deepEqual([...md.matchAll(/^### (\w+)$/gm)].map((m) => m[1]), ['Added', 'Changed', 'Fixed', 'Security']);
  assert.match(md, /\n### Added\n\n- Add a widget \(#1\)\n {2}- feat\(ui\): the widget \([0-9a-f]{7}\)\n/);
  assert.match(md, /\n<!--\nLeft out as not user-facing \(3\):\n- #4 test: more tests\n- [0-9a-f]{7} docs: README\n- [0-9a-f]{7} chore: side chores\n-->\n$/);
  const summary = render(d, { summary: true });
  assert.match(summary, /^Draft from v1\.0\.0\.\.HEAD\. /);
  assert.match(summary, /\n<details><summary>Left out as not user-facing \(3\):<\/summary>\n\n- #4 test: more tests\n/);
});

test('draft: the default range starts at the last v* tag before HEAD, or covers all of history', () => {
  const dir = initRepo({ commits: false });
  commit(dir, 'feat: first');
  let d = draft(dir);
  assert.equal(d.from, null);
  assert.deepEqual(d.entries.map((e) => e.text), ['First']);
  assert.match(render(d), /^<!-- Draft from HEAD\. /);
  // At a release tag, the draft is that release's: here the first, so all of history again.
  git(dir, 'tag', 'v1.0.0');
  assert.deepEqual(draft(dir).entries.map((e) => e.text), ['First']);
  commit(dir, 'docs: notes');
  assert.deepEqual(draft(dir).entries, []);
  assert.match(render(draft(dir)), /\nNothing user-facing in v1\.0\.0\.\.HEAD\.\n\n<!--\n/);
  commit(dir, 'fix: second');
  git(dir, 'tag', 'other-tag');
  commit(dir, 'feat: third');
  // At a later release tag: from the tag before it.
  git(dir, 'tag', 'v1.1.0');
  d = draft(dir);
  assert.equal(d.from, 'v1.0.0');
  assert.deepEqual(d.entries.map((e) => e.text), ['Second', 'Third']);
  // An explicit range, or a start alone.
  assert.deepEqual(draft(dir, 'v1.0.0..other-tag').entries.map((e) => e.text), ['Second']);
  assert.deepEqual(draft(dir, 'other-tag').entries.map((e) => e.text), ['Third']);
  assert.throws(() => draft(dir, '--output=x'), /Not a revision/);
  assert.throws(() => draft(dir, 'v1.0.0...HEAD'), /Not a range: "v1\.0\.0\.\.\.HEAD"/);
  assert.throws(() => draft(dir, 'nope..HEAD'), /Not a commit: nope/);
});

test('changelog-draft.js: prints the draft; a bad range exits 1', () => {
  const dir = initRepo({ commits: false });
  commit(dir, 'feat: <b>bold</b> idea');
  const run = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'changelog-draft.js'), ...args], { cwd: dir, encoding: 'utf8' });
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\n### Added\n\n- <b>bold<\/b> idea \([0-9a-f]{7}\)\n$/);
  // A job summary shows commit text as text.
  r = run('--summary');
  assert.match(r.stdout, /\n- &lt;b&gt;bold&lt;\/b&gt; idea \([0-9a-f]{7}\)\n$/);
  r = run('nope');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Not a commit: nope/);
  assert.equal(run('-x').status, 1);
  r = run('HEAD', 'HEAD');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Unexpected argument: HEAD\nUsage: /);
});

/** A repo whose main has CHANGELOG.md with an empty [Unreleased] section and src/app.js. */
function prRepo() {
  const dir = initRepo({ commits: false });
  commit(dir, 'chore: start', { 'CHANGELOG.md': changelog(), 'src/app.js': '1\n', 'docs/a.md': 'a\n' });
  return dir;
}

test('prChanges/verdict: a PR that changes the app needs an [Unreleased] entry', () => {
  const dir = prRepo();
  git(dir, 'switch', '-q', '-c', 'pr');
  commit(dir, 'feat(ui): a widget', { 'renderer/widget.js': 'w\n' });
  let c = prChanges(dir, 'main', 'pr');
  assert.deepEqual(c, { commits: ['feat(ui): a widget'], files: ['renderer/widget.js'], changelog: false });
  let v = verdict(c);
  assert.equal(v.ok, false);
  assert.match(v.message, /^This pull request changes the app \(1 user-facing commit \(feat\(ui\): a widget\) and 1 app file \(renderer\/widget\.js\)\) but not the \[Unreleased\] section of CHANGELOG\.md\. /);
  assert.match(v.message, /add the skip-changelog label\.$/);
  // An entry under an older release's section doesn't count.
  commit(dir, 'docs: changelog', { 'CHANGELOG.md': changelog('', '- The first release.\n- A widget.') });
  assert.equal(verdict(prChanges(dir, 'main', 'pr')).ok, false);
  commit(dir, 'docs: changelog', { 'CHANGELOG.md': changelog('### Added\n\n- A widget.') });
  c = prChanges(dir, 'main', 'pr');
  assert.equal(c.changelog, true);
  assert.deepEqual(verdict(c), { ok: true, message: 'The [Unreleased] section of CHANGELOG.md is updated.' });
});

test('prChanges/verdict: app files alone count; docs, tests and CI don\'t; main moving on is not the PR', () => {
  const dir = prRepo();
  git(dir, 'switch', '-q', '-c', 'refactor');
  commit(dir, 'refactor(src): tidy', { 'src/app.js': '2\n' });
  assert.deepEqual(prChanges(dir, 'main', 'refactor').files, ['src/app.js']);
  assert.equal(verdict(prChanges(dir, 'main', 'refactor')).ok, false);
  for (const file of ['main.js', 'preload.js', 'preload-tabs.js', 'main/menu.js']) {
    git(dir, 'switch', '-q', '-C', 'one', 'main');
    commit(dir, 'chore: x', { [file]: 'x\n' });
    assert.deepEqual(prChanges(dir, 'main', 'one').files, [file]);
  }
  git(dir, 'switch', '-q', '-C', 'docs', 'main');
  commit(dir, 'docs: notes', { 'docs/a.md': 'b\n', 'test/x.test.js': 't\n', '.github/workflows/x.yml': 'y\n', 'scripts/s.js': 's\n' });
  assert.deepEqual(verdict(prChanges(dir, 'main', 'docs')), { ok: true, message: 'No user-facing change: no changelog entry needed.' });
  // A fix commit counts even outside the app's folders.
  commit(dir, 'fix(scripts): the demo repo', { 'scripts/s.js': 't\n' });
  assert.equal(verdict(prChanges(dir, 'main', 'docs')).ok, false);
  // Another PR's entry, merged into main after this one branched off, isn't this PR's.
  git(dir, 'switch', '-q', 'main');
  commit(dir, 'docs: changelog', { 'CHANGELOG.md': changelog('### Added\n\n- Someone else\'s entry.') });
  assert.equal(prChanges(dir, 'main', 'refactor').changelog, false);
  // Nor once the PR merged main in.
  git(dir, 'switch', '-q', 'refactor');
  git(dir, 'merge', '-q', '--no-edit', 'main');
  assert.equal(prChanges(dir, 'main', 'refactor').changelog, false);
  // A release PR moves [Unreleased] under a version: that changes the section.
  git(dir, 'switch', '-q', '-C', 'release', 'main');
  commit(dir, 'chore: release 1.1.0', { 'CHANGELOG.md': changelog().replace('## [1.0.0]', '## [1.1.0] - 2026-10-13\n\n### Added\n\n- Someone else\'s entry.\n\n## [1.0.0]'), 'src/app.js': '3\n' });
  assert.equal(verdict(prChanges(dir, 'main', 'release')).ok, true);
});

test('prChanges/verdict: assets, and the parts of package.json that ship, count; its scripts don\'t', () => {
  const dir = prRepo();
  const pkg = {
    name: 'app', version: '1.0.0', main: 'main.js', scripts: { test: 'node --test' },
    devDependencies: { electron: '44.0.0', eslint: '10.0.0' }, build: { appId: 'x', files: ['main.js'] },
  };
  const json = (p) => `${JSON.stringify(p, null, 2)}\n`;
  commit(dir, 'chore: package.json', { 'package.json': json(pkg) });
  const pr = (name, message, files) => {
    git(dir, 'switch', '-q', '-C', name, 'main');
    commit(dir, message, files);
    return prChanges(dir, 'main', name);
  };
  // A new icon, whatever the commit's type says.
  let c = pr('icon', 'chore(deps): new icon', { 'assets/icon.png': 'png\n' });
  assert.deepEqual(c.files, ['assets/icon.png']);
  assert.equal(verdict(c).ok, false);
  assert.deepEqual(pr('entitlements', 'chore: entitlements', { 'build/entitlements.mac.plist': 'p\n' }).files, ['build/entitlements.mac.plist']);
  // Electron's version, the build settings, a runtime dependency, the entry point.
  c = pr('electron', 'chore(deps): bump electron to 45 and new icon', {
    'package.json': json({ ...pkg, devDependencies: { ...pkg.devDependencies, electron: '45.0.0' }, build: { ...pkg.build, appId: 'y' } }),
    'assets/icon.png': 'png\n',
  });
  assert.deepEqual(c.files, ['assets/icon.png', 'package.json (electron, build)']);
  assert.match(verdict(c).message, /\(2 app files \(assets\/icon\.png, package\.json \(electron, build\)\)\)/);
  assert.deepEqual(pr('dep', 'chore: a dependency', { 'package.json': json({ ...pkg, dependencies: { lib: '1.0.0' } }) }).files,
    ['package.json (dependencies)']);
  assert.deepEqual(pr('entry', 'chore: entry point', { 'package.json': json({ ...pkg, main: 'app.js' }) }).files, ['package.json (main)']);
  // Scripts, other dev tools, the version, and the same settings in another key order don't ship.
  c = pr('scripts', 'chore: scripts', {
    'package.json': json({
      ...pkg, version: '1.0.1', scripts: { ...pkg.scripts, lint: 'eslint .' },
      devDependencies: { ...pkg.devDependencies, eslint: '10.1.0' }, build: { files: ['main.js'], appId: 'x' },
    }),
  });
  assert.deepEqual(c, { commits: [], files: [], changelog: false });
  assert.equal(verdict(c).ok, true);
  // A package.json that isn't JSON (yet) counts as a change to everything.
  assert.deepEqual(pr('broken', 'chore: broken', { 'package.json': '{\n' }).files, ['package.json (main, electron, build)']);
});

test('changelog-pr-check.js: exits 1 with an annotation in Actions, 0 when the PR is fine', () => {
  const dir = prRepo();
  git(dir, 'switch', '-q', '-c', 'pr');
  commit(dir, 'fix: a bug', { 'src/app.js': '2\n' });
  const run = (env, ...args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'changelog-pr-check.js'), ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', ...env },
  });
  let r = run({ GITHUB_ACTIONS: 'true' }, '--base', 'main', '--head', 'pr');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error::This pull request changes the app \(1 user-facing commit \(fix: a bug\) and 1 app file \(src\/app\.js\)\)/);
  r = run({}, '--base', 'main', '--head', 'pr');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: This pull request changes the app/);
  commit(dir, 'docs: changelog', { 'CHANGELOG.md': changelog('### Fixed\n\n- A bug.') });
  r = run({}, '--base', 'main', '--head', 'pr');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'The [Unreleased] section of CHANGELOG.md is updated.\n');
  assert.equal(run({}, '--base', '--upload-pack=x', '--head', 'pr').status, 1);
  r = run({}, '--base=--upload-pack=x', '--head', 'pr');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: Not a revision for --base: "--upload-pack=x"/);
  r = run({}, '--bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: node scripts\/changelog-pr-check\.js/);
  // A git failure is git's own message.
  r = run({}, '--base', 'no-such-branch');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: .*no-such-branch/);
});

test('release-check.js: package.json\'s version has a dated CHANGELOG.md section, and a wrong tag fails', () => {
  // The repository's own files: package.json's version is the last release (or the one being
  // released), so CHANGELOG.md has its section. With no tag the script checks v<that version>.
  const run = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'release-check.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' },
  });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /: package\.json, package-lock\.json and CHANGELOG\.md agree\.\n$/);
  const bad = run('v0.0.0-not.a.release');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^error: package\.json version .* doesn't match the tag v0\.0\.0-not\.a\.release\.$/m);
  assert.match(bad.stderr, /^error: CHANGELOG\.md has no "## \[0\.0\.0-not\.a\.release\] - YYYY-MM-DD" section/m);
});
