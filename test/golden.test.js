'use strict';
// Compares bash.js with real GNU bash output recorded in golden/expected.json
// and golden/engines.expected.json (regenerate with: node test/golden/record.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const BashJS = require('../bash.js');
const SUITES = [
  { name: 'golden', tree: require('./golden/cases').TREE, expected: require('./golden/expected.json') },
  { name: 'engines', tree: require('./golden/engines').TREE, expected: require('./golden/engines.expected.json') },
  { name: 'shell', tree: require('./golden/shell').TREE, expected: require('./golden/shell.expected.json') }
];

const ROOT = '/w';

function initialTree(TREE) {
  const tree = { [ROOT]: { type: 'dir', entries: [] } };
  Object.keys(TREE).forEach((rel) => {
    tree[ROOT + '/' + rel] = TREE[rel] === null ? { type: 'dir', entries: [] } : TREE[rel];
  });
  return tree;
}

// diff/patch headers carry file timestamps, which can never match a recording.
function stripTimestamps(text) {
  return typeof text === 'string' ? text.replace(/^((?:---|\+\+\+|\*\*\*) [^\t\n]+)\t(?:\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ [+-]\d{4}|\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})$/gm, '$1\t<time>') : text;
}
function normalizeTree(tree) {
  return Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, stripTimestamps(v)]));
}

function snapshot(fs) {
  const out = {};
  Object.entries(fs.snapshot()).forEach(([p, node]) => {
    if (p.indexOf(ROOT + '/') !== 0) return;
    out[p.slice(ROOT.length + 1)] = typeof node === 'string' ? node : null;
  });
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

for (const suite of SUITES) for (const want of suite.expected) {
  test(suite.name + ': ' + want.cmd, async () => {
    const fs = BashJS.memfs(initialTree(suite.tree));
    const r = await BashJS.exec(want.cmd, ROOT,
      { read: fs.read, write: fs.write, delete: fs.delete, move: fs.move },
      { env: { HOME: '/home/u', USER: 'user', LC_ALL: 'C', TZ: 'UTC' }, timezone: 'UTC' });
    assert.equal(stripTimestamps(r.stdout), stripTimestamps(want.stdout), 'stdout');
    assert.equal(r.stderr, want.stderr, 'stderr');
    assert.equal(r.exitCode, want.exitCode, 'exit code');
    assert.deepEqual(normalizeTree(snapshot(fs)), normalizeTree(want.tree), 'file tree');
  });
}
