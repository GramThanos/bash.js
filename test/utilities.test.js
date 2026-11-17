'use strict';
// Tests for behaviour the golden suite cannot cover: ripgrep (expected output
// follows ripgrep's documented non-tty behaviour), session state changed by
// builtins, and the command API.
const test = require('node:test');
const assert = require('node:assert/strict');
const BashJS = require('../bash.js');

function session(tree, options) {
  const fs = BashJS.memfs(Object.assign({ '/w': { type: 'dir', entries: [] } }, tree || {}));
  return { fs, shell: BashJS.create(Object.assign({ read: fs.read, write: fs.write, delete: fs.delete, move: fs.move, cwd: '/w', env: { HOME: '/home/u' } }, options || {})) };
}
async function run(cmd, tree, options) { return session(tree, options).shell.exec(cmd); }

const PROJECT = {
  '/w/src/app.js': 'const foo = 1;\nfunction Foo() {}\n',
  '/w/src/util.ts': 'export const foobar = 2;\n',
  '/w/docs/readme.md': '# Foo\nuse foo here\n',
  '/w/.hidden.js': 'foo hidden\n',
  '/w/build/out.js': 'foo built\n',
  '/w/notes.txt': 'nothing\n'
};

test('rg: recursive search, sorted paths, no line numbers when not a tty', async () => {
  const r = await run('rg foo', PROJECT);
  assert.equal(r.stdout, 'build/out.js:foo built\ndocs/readme.md:use foo here\nsrc/app.js:const foo = 1;\nsrc/util.ts:export const foobar = 2;\n');
  assert.equal(r.exitCode, 0);
});

test('rg: .gitignore applies inside a git repository, .ignore always', async () => {
  const withGit = Object.assign({}, PROJECT, { '/w/.git': { type: 'dir', entries: [] }, '/w/.gitignore': 'build/\n' });
  assert.equal((await run('rg -l foo', withGit)).stdout, 'docs/readme.md\nsrc/app.js\nsrc/util.ts\n');
  const noGit = Object.assign({}, PROJECT, { '/w/.gitignore': 'build/\n' });
  assert.equal((await run('rg -l foo', noGit)).stdout, 'build/out.js\ndocs/readme.md\nsrc/app.js\nsrc/util.ts\n');
  const dotIgnore = Object.assign({}, PROJECT, { '/w/.ignore': '*.md\n!keep.md\n' });
  assert.equal((await run('rg -l foo', dotIgnore)).stdout, 'build/out.js\nsrc/app.js\nsrc/util.ts\n');
  assert.equal((await run('rg -l --no-ignore foo', withGit)).stdout, 'build/out.js\ndocs/readme.md\nsrc/app.js\nsrc/util.ts\n');
});

test('rg: hidden files need --hidden or -uu', async () => {
  assert.match((await run('rg -l --hidden foo', PROJECT)).stdout, /^\.hidden\.js$/m);
  assert.match((await run('rg -l -uu foo', PROJECT)).stdout, /^\.hidden\.js$/m);
  assert.doesNotMatch((await run('rg -l foo', PROJECT)).stdout, /hidden/);
});

test('rg: a single file operand prints no file name; -n adds line numbers', async () => {
  assert.equal((await run('rg -n foo src/app.js', PROJECT)).stdout, '1:const foo = 1;\n');
  assert.equal((await run('rg -H foo src/app.js', PROJECT)).stdout, 'src/app.js:const foo = 1;\n');
  assert.equal((await run('rg foo src', PROJECT)).stdout, 'src/app.js:const foo = 1;\nsrc/util.ts:export const foobar = 2;\n');
});

test('rg: case modes, word match, fixed strings and only-matching', async () => {
  assert.equal((await run('rg -i -n foo src/app.js', PROJECT)).stdout, '1:const foo = 1;\n2:function Foo() {}\n');
  assert.equal((await run('rg -S Foo src/app.js', PROJECT)).stdout, 'function Foo() {}\n');
  assert.equal((await run('rg -S foo src/app.js', PROJECT)).stdout, 'const foo = 1;\nfunction Foo() {}\n');
  assert.equal((await run('rg -w foo src', PROJECT)).stdout, 'src/app.js:const foo = 1;\n');
  assert.equal((await run("rg -F 'Foo()' src", PROJECT)).stdout, 'src/app.js:function Foo() {}\n');
  assert.equal((await run("rg -o 'foo\\w*' src", PROJECT)).stdout, 'src/app.js:foo\nsrc/util.ts:foobar\n');
});

test('rg: globs, types, counts, files and replace', async () => {
  assert.equal((await run("rg -l -g '*.md' foo", PROJECT)).stdout, 'docs/readme.md\n');
  assert.equal((await run("rg -l -g '!*.js' foo", PROJECT)).stdout, 'docs/readme.md\nsrc/util.ts\n');
  assert.equal((await run('rg -l -t ts foo', PROJECT)).stdout, 'src/util.ts\n');
  assert.equal((await run('rg -l -T js foo', PROJECT)).stdout, 'docs/readme.md\nsrc/util.ts\n');
  assert.equal((await run('rg -c foo', PROJECT)).stdout, 'build/out.js:1\ndocs/readme.md:1\nsrc/app.js:1\nsrc/util.ts:1\n');
  assert.equal((await run('rg --files src', PROJECT)).stdout, 'src/app.js\nsrc/util.ts\n');
  assert.equal((await run("rg -r 'bar' foo src/app.js", PROJECT)).stdout, 'const bar = 1;\n');
  assert.equal((await run("rg '(\\w+) = (\\d)' -r '$2=$1' src/app.js", PROJECT)).stdout, 'const 1=foo;\n');
});

test('rg: context, heading, stdin and exit codes', async () => {
  const tree = { '/w/f.txt': 'a\nfoo\nb\nc\nd\nfoo\ne\n' };
  assert.equal((await run('rg -n -C1 foo f.txt', tree)).stdout, '1-a\n2:foo\n3-b\n--\n5-d\n6:foo\n7-e\n');
  assert.equal((await run('rg --heading foo', PROJECT)).stdout,
    'build/out.js\nfoo built\n\ndocs/readme.md\nuse foo here\n\nsrc/app.js\nconst foo = 1;\n\nsrc/util.ts\nexport const foobar = 2;\n');
  assert.equal((await run('echo xyz | rg y')).stdout, 'xyz\n');
  assert.equal((await run('rg zzz', PROJECT)).exitCode, 1);
  const missing = await run('rg foo nope', PROJECT);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /^rg: nope: No such file or directory/);
  assert.equal((await run('rg', PROJECT)).exitCode, 2);
});

test('cd and pwd persist across exec calls; subshell-like pipelines do not leak', async () => {
  const { shell } = session({ '/w/sub/deep': { type: 'dir', entries: [] } });
  assert.equal((await shell.exec('cd sub; pwd')).stdout, '/w/sub\n');
  assert.equal((await shell.exec('pwd; echo $OLDPWD')).stdout, '/w/sub\n/w\n');
  assert.equal(shell.getCwd(), '/w/sub');
  assert.equal((await shell.exec('cd deep | true; pwd')).stdout, '/w/sub\n');
  assert.equal((await shell.exec('cd; pwd')).stderr, 'bash: cd: /home/u: No such file or directory\n');
  assert.equal((await shell.exec('cd /; cd -')).stdout, '/w/sub\n');
});

test('exit stops the script and sets the status; export/unset change the session', async () => {
  const { shell } = session();
  const r = await shell.exec('echo a; exit 7; echo b');
  assert.equal(r.stdout, 'a\n');
  assert.equal(r.exitCode, 7);
  assert.equal((await shell.exec('echo $(exit 3; echo no) $?')).stdout, '0\n');
  await shell.exec('export GREETING=hi');
  assert.equal((await shell.exec('echo $GREETING')).stdout, 'hi\n');
  await shell.exec('unset GREETING');
  assert.equal((await shell.exec('echo "[$GREETING]"')).stdout, '[]\n');
});

test('date uses the injected clock and time zone', async () => {
  const now = () => new Date(Date.UTC(2026, 10, 17, 9, 30, 0));
  assert.equal((await run('date', {}, { now, timezone: 'UTC' })).stdout, 'Tue Nov 17 09:30:00 UTC 2026\n');
  // Intl has no abbreviation for most non-US zones, so %Z falls back to the
  // numeric form GNU uses for such zones.
  assert.equal((await run("date +'%F %H:%M %Z %z'", {}, { now, timezone: 'Europe/Athens' })).stdout, '2026-11-17 11:30 +02 +0200\n');
  assert.equal((await run("date +'%H:%M %Z'", {}, { now, timezone: 'America/New_York' })).stdout, '04:30 EST\n');
  assert.equal((await run("date -d 'tomorrow' +%F", {}, { now, timezone: 'UTC' })).stdout, '2026-11-18\n');
  assert.equal((await run("date -d 'next friday' +%F", {}, { now, timezone: 'UTC' })).stdout, '2026-11-20\n');
});

test('builtins win over registered commands, which win over bundled utilities', async () => {
  BashJS.registerCommand('wc', (ctx) => { ctx.stdout.write('custom wc\n'); return 0; });
  BashJS.registerCommand('echo', (ctx) => { ctx.stdout.write('custom echo\n'); return 0; });
  try {
    assert.equal((await run('wc; echo real')).stdout, 'custom wc\nreal\n');
  } finally {
    BashJS.unregisterCommand('wc');
    BashJS.unregisterCommand('echo');
  }
  assert.equal((await run('echo a | wc -l')).stdout, '1\n');
  const names = BashJS.commands();
  ['cd', 'grep', 'rg', 'find', 'sort', 'date', '[', 'test'].forEach((n) => assert.ok(names.includes(n), n));
});

test('find -exec runs commands through the interpreter', async () => {
  const r = await run("find . -name '*.txt' -exec cat {} \\;", { '/w/a.txt': 'A\n', '/w/d/b.txt': 'B\n' });
  assert.equal(r.stdout, 'A\nB\n');
  const del = session({ '/w/a.tmp': '', '/w/keep.txt': '', '/w/d/b.tmp': '' });
  await del.shell.exec("find . -name '*.tmp' -delete");
  assert.deepEqual(Object.keys(del.fs.snapshot()).filter((p) => p.startsWith('/w/')).sort(), ['/w/d', '/w/keep.txt']);
});
