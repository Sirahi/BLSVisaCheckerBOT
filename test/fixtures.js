const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DIR = path.join(__dirname, '..', '..', 'Archive', 'Html_Pages');

function fixturePath(name) {
  return path.join(DIR, `${name}.html`);
}

// Chrome's "Save Page As" writes: <!-- saved from url=(0054)https://... -->
// Predicates that test the URL need the ORIGINAL url, not the file:// path.
function fixtureUrl(name) {
  const html = fs.readFileSync(fixturePath(name), 'utf8');
  const m = html.match(/saved from url=\(\d+\)(\S+)/);
  if (!m) throw new Error(`No "saved from url" comment in fixture: ${name}`);
  return m[1];
}

function fixtureFileUrl(name) {
  return pathToFileURL(fixturePath(name)).href;
}

module.exports = { fixturePath, fixtureUrl, fixtureFileUrl };
