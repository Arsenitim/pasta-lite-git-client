'use strict';
// Print one version's section of CHANGELOG.md, without its heading:
//   node scripts/changelog-section.js <version> [--unwrap] [--file <path>]
// <version>: 0.3.0, v0.3.0 (a tag) or Unreleased. --unwrap puts each paragraph and list item on
// one line, for a GitHub release's notes (scripts/changelog.js unwrap). .github/workflows/release.yml
// makes the tag's release notes with it, so the notes are the curated changelog. Exits 1 if the
// section is missing or empty.
const fs = require('node:fs');
const path = require('node:path');
const { findSection, sectionName, unwrap } = require('./changelog');

function main(argv) {
  let file = path.join(__dirname, '..', 'CHANGELOG.md');
  let version = null;
  let flat = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--unwrap') flat = true;
    else if (argv[i] === '--file' && i + 1 < argv.length) file = argv[++i];
    else if (!argv[i].startsWith('-') && version === null) version = argv[i];
    else return fail(`Unexpected argument: ${argv[i]}`);
  }
  if (!version) return fail('Usage: node scripts/changelog-section.js <version> [--unwrap] [--file <path>]');
  const section = findSection(fs.readFileSync(file, 'utf8'), version);
  if (!section) return fail(`${path.basename(file)} has no "## [${sectionName(version)}]" section.`);
  if (!section.body) return fail(`The [${section.name}] section of ${path.basename(file)} is empty.`);
  process.stdout.write(`${flat ? unwrap(section.body) : section.body}\n`);
  return 0;
}

function fail(message) {
  console.error(message);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
