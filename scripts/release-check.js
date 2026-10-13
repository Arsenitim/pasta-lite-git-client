'use strict';
// Check that a release tag, package.json and CHANGELOG.md agree:
//   node scripts/release-check.js [<tag>]     (default: v<package.json version>)
// The release workflow (.github/workflows/release.yml) runs it first on a pushed v* tag, so a tag
// whose version isn't in package.json, package-lock.json or a dated "## [X.Y.Z] - YYYY-MM-DD"
// section of CHANGELOG.md (a real date, the version's only section) fails before anything is
// built. Run it before tagging too. Errors exit 1; warnings (no link reference for the version,
// entries left under [Unreleased]) don't.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { parseChangelog, report } = require('./changelog');

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** Whether YYYY-MM-DD `date` is a day of the calendar (not 2026-13-99 or 2026-02-30). */
function calendarDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/**
 * {errors, warnings} for releasing `tag` from these files' contents: `pkg` and `lock` parsed
 * package.json and package-lock.json, `changelog` CHANGELOG.md's text.
 */
function releaseProblems({ tag, pkg, lock, changelog }) {
  const errors = [];
  const warnings = [];
  const m = TAG.exec(tag);
  if (!m) return { errors: [`The tag ${tag} isn't a version tag (v<major>.<minor>.<patch>).`], warnings };
  const version = m[1];
  if (pkg.version !== version) errors.push(`package.json version ${pkg.version} doesn't match the tag ${tag}.`);
  const locked = [lock.version, lock.packages && lock.packages[''] && lock.packages[''].version];
  if (locked.some((v) => v !== version)) {
    errors.push(`package-lock.json version ${locked.find((v) => v !== version)} doesn't match the tag ${tag} (run npm install after changing package.json).`);
  }
  const { sections, links } = parseChangelog(changelog);
  const seen = new Set();
  for (const { name } of sections) {
    if (seen.has(name.toLowerCase())) errors.push(`CHANGELOG.md has more than one "## [${name}]" section.`);
    seen.add(name.toLowerCase());
  }
  const section = sections.find((s) => s.name === version);
  if (!section) {
    errors.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section: move the [Unreleased] entries under one.`);
  } else {
    if (!section.date) errors.push(`CHANGELOG.md's [${version}] heading has no release date ("## [${version}] - YYYY-MM-DD").`);
    else if (!calendarDate(section.date)) errors.push(`CHANGELOG.md's [${version}] heading has ${section.date}, which isn't a date.`);
    if (!section.body) errors.push(`CHANGELOG.md's [${version}] section is empty.`);
    if (!links.has(version.toLowerCase())) warnings.push(`CHANGELOG.md has no link reference for [${version}] at its end.`);
  }
  const unreleased = sections.find((s) => s.name.toLowerCase() === 'unreleased');
  if (unreleased && unreleased.body) warnings.push(`CHANGELOG.md's [Unreleased] section still has entries: they aren't in ${tag}'s notes.`);
  return { errors, warnings };
}

/** The repository's file `file` (relative to `root`); an error that says which file and why. */
function readFile(root, file) {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch (err) {
    throw new Error(`Can't read ${file}: ${err.code === 'ENOENT' ? 'there is no such file' : err.message}.`, { cause: err });
  }
}

function readJson(root, file) {
  const text = readFile(root, file);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} isn't valid JSON: ${err.message}.`, { cause: err });
  }
}

function main(argv) {
  let positionals;
  try {
    ({ positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} }));
    if (positionals.length > 1) throw new Error(`Unexpected argument: ${positionals[1]}`);
  } catch (err) {
    report('error', `${err.message}\nUsage: node scripts/release-check.js [<tag>]`);
    return 1;
  }
  const root = path.join(__dirname, '..');
  let files;
  try {
    files = { pkg: readJson(root, 'package.json'), lock: readJson(root, 'package-lock.json'), changelog: readFile(root, 'CHANGELOG.md') };
  } catch (err) {
    report('error', err.message);
    return 1;
  }
  const tag = positionals[0] || `v${files.pkg.version}`;
  const { errors, warnings } = releaseProblems({ tag, ...files });
  for (const w of warnings) report('warning', w);
  for (const e of errors) report('error', e);
  if (!errors.length) console.log(`${tag}: package.json, package-lock.json and CHANGELOG.md agree.`);
  return errors.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { releaseProblems };
