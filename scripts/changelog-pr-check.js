'use strict';
// Does a pull request that changes the app add to CHANGELOG.md's [Unreleased] section?
//   node scripts/changelog-pr-check.js [--base <rev>] [--head <rev>]   (default: origin/main, HEAD)
// The PR is its commits and files since the merge base of <base> and <head>. It changes the app
// when one of its commits is a feat, fix, perf or revert (or has a security scope or word,
// scripts/changelog.js sectionOf), or when it touches the app's code: main.js, the preloads, main/,
// renderer/ or src/. Then [Unreleased] must differ between the merge base and <head>. Exits 1 when
// it doesn't. .github/workflows/changelog.yml runs it on each PR, unless the PR has the
// skip-changelog label (for a change no user notices: a refactor, a test-only fix in src/).
const { git, checkRev, findSection, parseSubject, sectionOf, isEntry, report } = require('./changelog');

const APP_FILES = /^(main\.js|preload[^/]*\.js|(main|renderer|src)\/)/;

/** CHANGELOG.md's [Unreleased] section at `rev` ('' when the file or the section isn't there). */
function unreleasedAt(cwd, rev) {
  let text;
  try {
    text = git(cwd, ['show', `${rev}:CHANGELOG.md`]);
  } catch {
    return '';
  }
  const section = findSection(text, 'Unreleased');
  return section ? section.body : '';
}

/**
 * {commits, files, changelog}: the PR's user-facing commit subjects and app files, and whether it
 * changed the [Unreleased] section.
 */
function prChanges(cwd, base, head) {
  const mergeBase = git(cwd, ['merge-base', '--end-of-options', base, head]).trim();
  const subjects = git(cwd, ['log', '--no-merges', '--format=%s', '--end-of-options', `${mergeBase}..${head}`]).split('\n').filter(Boolean);
  const commits = subjects.filter((s) => isEntry(sectionOf(parseSubject(s))));
  const files = git(cwd, ['diff', '--name-only', '--no-renames', mergeBase, head, '--']).split('\n').filter((f) => APP_FILES.test(f));
  return { commits, files, changelog: unreleasedAt(cwd, mergeBase) !== unreleasedAt(cwd, head) };
}

/** The finding for prChanges' result: {ok, message}. */
function verdict({ commits, files, changelog }) {
  if (!commits.length && !files.length) return { ok: true, message: 'No user-facing change: no changelog entry needed.' };
  if (changelog) return { ok: true, message: 'The [Unreleased] section of CHANGELOG.md is updated.' };
  const why = [
    commits.length && `${commits.length} feat/fix commit${commits.length > 1 ? 's' : ''} (${commits.slice(0, 3).join('; ')}${commits.length > 3 ? '; ...' : ''})`,
    files.length && `${files.length} app file${files.length > 1 ? 's' : ''} (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', ...' : ''})`,
  ].filter(Boolean).join(' and ');
  return {
    ok: false,
    message: `This pull request changes the app (${why}) but not the [Unreleased] section of CHANGELOG.md. `
      + 'Add an entry there that says what a user notices (CONTRIBUTING.md, "Changelog"), or, if nothing '
      + 'here is worth one (a refactor, a change to tests), add the skip-changelog label.',
  };
}

function main(argv) {
  let base = 'origin/main';
  let head = 'HEAD';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && i + 1 < argv.length) base = argv[++i];
    else if (argv[i] === '--head' && i + 1 < argv.length) head = argv[++i];
    else {
      console.error('Usage: node scripts/changelog-pr-check.js [--base <rev>] [--head <rev>]');
      return 1;
    }
  }
  try {
    const { ok, message } = verdict(prChanges(process.cwd(), checkRev(base, '--base'), checkRev(head, '--head')));
    if (ok) console.log(message);
    else report('error', message);
    return ok ? 0 : 1;
  } catch (err) {
    console.error(err.stderr ? String(err.stderr).trim() || err.message : err.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { prChanges, verdict };
