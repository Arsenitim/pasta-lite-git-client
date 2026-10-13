'use strict';
// Check that a release tag, package.json and CHANGELOG.md agree:
//   node scripts/release-check.js [<tag>]     (default: v<package.json version>)
// The release workflow (.github/workflows/release.yml) runs it first on a pushed v* tag, so a tag
// whose version isn't in package.json, package-lock.json or a dated "## [X.Y.Z] - YYYY-MM-DD"
// section of CHANGELOG.md fails before anything is built. Run it before tagging too. Errors exit 1;
// warnings (no link reference for the version, entries left under [Unreleased]) don't.
const fs = require('node:fs');
const path = require('node:path');
const { parseChangelog, report } = require('./changelog');

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

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
  const section = sections.find((s) => s.name === version);
  if (!section) {
    errors.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section: move the [Unreleased] entries under one.`);
  } else {
    if (!section.date) errors.push(`CHANGELOG.md's [${version}] heading has no release date ("## [${version}] - YYYY-MM-DD").`);
    if (!section.body) errors.push(`CHANGELOG.md's [${version}] section is empty.`);
    if (!links.has(version.toLowerCase())) warnings.push(`CHANGELOG.md has no link reference for [${version}] at its end.`);
  }
  const unreleased = sections.find((s) => s.name.toLowerCase() === 'unreleased');
  if (unreleased && unreleased.body) warnings.push(`CHANGELOG.md's [Unreleased] section still has entries: they aren't in ${tag}'s notes.`);
  return { errors, warnings };
}

function main(argv) {
  const root = path.join(__dirname, '..');
  const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const pkg = readJson('package.json');
  const tag = argv[0] || `v${pkg.version}`;
  const { errors, warnings } = releaseProblems({
    tag, pkg, lock: readJson('package-lock.json'), changelog: fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
  });
  for (const w of warnings) report('warning', w);
  for (const e of errors) report('error', e);
  if (!errors.length) console.log(`${tag}: package.json, package-lock.json and CHANGELOG.md agree.`);
  return errors.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { releaseProblems };
