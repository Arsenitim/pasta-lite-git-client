'use strict';
// Print one version's section of CHANGELOG.md, without its heading:
//   node scripts/changelog-section.js <version> [--unwrap] [--file <path>]
// <version>: 0.3.0, v0.3.0 (a tag) or Unreleased. --unwrap puts each paragraph and list item on
// one line, for a GitHub release's notes (scripts/changelog.js unwrap). .github/workflows/release.yml
// makes the tag's release notes with it, so the notes are the curated changelog. Exits 1 if the
// section is missing or empty.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { findSection, sectionName, unwrap, report } = require('./changelog');

const USAGE = 'Usage: node scripts/changelog-section.js <version> [--unwrap] [--file <path>]';

function main(argv) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { unwrap: { type: 'boolean', default: false }, file: { type: 'string', default: path.join(__dirname, '..', 'CHANGELOG.md') } },
    }));
  } catch (err) {
    return fail(`${err.message}\n${USAGE}`);
  }
  if (positionals.length !== 1) return fail(USAGE);
  const [version] = positionals;
  const name = path.basename(values.file);
  let text;
  try {
    text = fs.readFileSync(values.file, 'utf8');
  } catch (err) {
    return fail(`Can't read ${values.file}: ${err.message}`);
  }
  const section = findSection(text, version);
  if (!section) return fail(`${name} has no "## [${sectionName(version)}]" section.`);
  if (!section.body) return fail(`The [${section.name}] section of ${name} is empty.`);
  process.stdout.write(`${values.unwrap ? unwrap(section.body) : section.body}\n`);
  return 0;
}

function fail(message) {
  report('error', message);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
