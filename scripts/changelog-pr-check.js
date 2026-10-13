'use strict';
// Does a pull request that changes the app add to CHANGELOG.md's [Unreleased] section?
//   node scripts/changelog-pr-check.js [--base <rev>] [--head <rev>]   (default: origin/main, HEAD)
// The PR is its commits and files since the merge base of <base> and <head>. It changes the app
// when one of its commits is user-facing: a feat, fix, perf, revert or security commit, or one with
// a security scope or word (scripts/changelog.js sectionOf); when it touches the app's files:
// main.js, the preloads, main/, renderer/, src/, assets/ or build/; or when it changes what
// package.json says about the app that ships (SHIPPED: Electron's version, the runtime
// dependencies, the entry point, the build settings). Then [Unreleased] must differ between the
// merge base and <head>. Exits 1 when it doesn't. .github/workflows/changelog.yml runs it on each
// PR, unless the PR has the skip-changelog label (for a change no user notices: a refactor, a
// test-only fix in src/).
const { parseArgs } = require('node:util');
const { git, checkRev, findSection, parseSubject, sectionOf, isEntry, errorText, report } = require('./changelog');

// The app's own files: its code, and the icons and entitlements it's built with.
const APP_FILES = /^(main\.js|preload[^/]*\.js|(main|renderer|src|assets|build)\/)/;
// What package.json says about the app that ships: its entry point, its runtime dependencies
// (electron-builder packs them in), the Electron it runs on and the build settings. Its scripts
// and other dev tools don't ship.
const SHIPPED = {
  main: (pkg) => pkg.main,
  dependencies: (pkg) => pkg.dependencies,
  electron: (pkg) => pkg.devDependencies && pkg.devDependencies.electron,
  build: (pkg) => pkg.build,
};

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

/** package.json at `rev`, parsed ({} when it's missing or isn't JSON). */
function packageAt(cwd, rev) {
  try {
    return JSON.parse(git(cwd, ['show', `${rev}:package.json`]));
  } catch {
    return {};
  }
}

/** JSON with each object's keys sorted: the same text for the same value, whatever the key order. */
const canonical = (value) => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

/** The SHIPPED fields that differ between package.json at `base` and at `head`, by name. */
function shippedChanges(cwd, base, head) {
  const [before, after] = [packageAt(cwd, base), packageAt(cwd, head)];
  return Object.keys(SHIPPED).filter((k) => canonical(SHIPPED[k](before)) !== canonical(SHIPPED[k](after)));
}

/**
 * {commits, files, changelog}: the PR's user-facing commit subjects and app files ("package.json
 * (electron, build)" for the shipped fields it changes), and whether it changed the [Unreleased]
 * section.
 */
function prChanges(cwd, base, head) {
  const mergeBase = git(cwd, ['merge-base', '--end-of-options', base, head]).trim();
  const subjects = git(cwd, ['log', '--no-merges', '--format=%s', '--end-of-options', `${mergeBase}..${head}`]).split('\n').filter(Boolean);
  const commits = subjects.filter((s) => isEntry(sectionOf(parseSubject(s))));
  const changed = git(cwd, ['diff', '--name-only', '--no-renames', mergeBase, head, '--']).split('\n');
  const files = changed.filter((f) => APP_FILES.test(f));
  const shipped = changed.includes('package.json') ? shippedChanges(cwd, mergeBase, head) : [];
  if (shipped.length) files.push(`package.json (${shipped.join(', ')})`);
  return { commits, files, changelog: unreleasedAt(cwd, mergeBase) !== unreleasedAt(cwd, head) };
}

/** The finding for prChanges' result: {ok, message}. */
function verdict({ commits, files, changelog }) {
  if (!commits.length && !files.length) return { ok: true, message: 'No user-facing change: no changelog entry needed.' };
  if (changelog) return { ok: true, message: 'The [Unreleased] section of CHANGELOG.md is updated.' };
  const why = [
    commits.length && `${commits.length} user-facing commit${commits.length > 1 ? 's' : ''} (${commits.slice(0, 3).join('; ')}${commits.length > 3 ? '; ...' : ''})`,
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
  let values;
  try {
    ({ values } = parseArgs({
      args: argv, options: { base: { type: 'string', default: 'origin/main' }, head: { type: 'string', default: 'HEAD' } },
    }));
  } catch (err) {
    report('error', `${err.message}\nUsage: node scripts/changelog-pr-check.js [--base <rev>] [--head <rev>]`);
    return 1;
  }
  try {
    const { ok, message } = verdict(prChanges(process.cwd(), checkRev(values.base, '--base'), checkRev(values.head, '--head')));
    if (ok) console.log(message);
    else report('error', message);
    return ok ? 0 : 1;
  } catch (err) {
    report('error', errorText(err));
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { prChanges, verdict };
