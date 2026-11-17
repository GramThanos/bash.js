'use strict';
// Records golden expectations by running every case in real GNU bash.
// Usage: node test/golden/record.js [suite...]   (suites: cases, engines;
//        default: all). Set BASH_PATH to choose the bash binary.
// Needs bash with GNU coreutils, findutils and grep (Git Bash, Linux, WSL).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' : 'bash');
const SUITES = { cases: 'expected.json', engines: 'engines.expected.json', shell: 'shell.expected.json' };

function writeTree(root, TREE) {
  Object.keys(TREE).forEach((rel) => {
    const full = path.join(root, rel);
    if (TREE[rel] === null) fs.mkdirSync(full, { recursive: true });
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, TREE[rel]); }
  });
}

// Snapshot of the tree after the command: relative path -> content (null for directories).
function readTree(root) {
  const out = {};
  (function walk(dir, rel) {
    fs.readdirSync(dir).sort().forEach((name) => {
      const full = path.join(dir, name), r = rel ? rel + '/' + name : name;
      if (fs.statSync(full).isDirectory()) { out[r] = null; walk(full, r); }
      else out[r] = fs.readFileSync(full, 'utf8');
    });
  })(root, '');
  return out;
}

// Strip what only differs because this is a real shell run from a script.
function normalizeStderr(text) {
  // "<script path>: line N: " (or without the line part) becomes "bash: ".
  // The script path may start with a Windows drive letter ("C:\...").
  return text.replace(/^(?:[A-Za-z]:)?[^\n:]*case\.sh: (?:line \d+: )?/gm, 'bash: ');
}

// The command is passed in a script file: on Windows, passing it as an
// argument lets the MSYS runtime rewrite backslash sequences.
const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bashjs-scripts-'));
process.on('exit', () => fs.rmSync(scriptDir, { recursive: true, force: true }));

function record(suite) {
  const { TREE, CASES } = require('./' + suite);
  const results = CASES.map((cmd) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bashjs-golden-'));
    writeTree(root, TREE);
    const script = path.join(scriptDir, 'case.sh');
    fs.writeFileSync(script, cmd + '\n');
    const r = spawnSync(bash, [script], {
      cwd: root, encoding: 'utf8',
      env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C', TZ: 'UTC', HOME: '/home/u', USER: 'user' })
    });
    const result = { cmd, stdout: r.stdout, stderr: normalizeStderr(r.stderr), exitCode: r.status, tree: readTree(root) };
    fs.rmSync(root, { recursive: true, force: true });
    return result;
  });
  fs.writeFileSync(path.join(__dirname, SUITES[suite]), JSON.stringify(results, null, 1) + '\n');
  console.log(suite + ': recorded ' + results.length + ' cases');
}

(process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SUITES)).forEach(record);
