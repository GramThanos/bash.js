'use strict';
// Regression tests for the bugs listed in review.md. Expected values were
// checked against GNU bash 5.
const test = require('node:test');
const assert = require('node:assert/strict');
const BashJS = require('../bash.js');

function shellWith(tree, extra) {
  const fs = BashJS.memfs(tree || {});
  let host = '';
  const shell = BashJS.create(Object.assign({
    read: fs.read, write: fs.write, delete: fs.delete, move: fs.move,
    stdout: s => { host += s; }, stderr: () => {}, cwd: '/w', env: { HOME: '/home/u' }
  }, extra || {}));
  return { fs, shell, host: () => host };
}

async function run(cmd, tree) {
  const { shell, host, fs } = shellWith(Object.assign({ '/w': { type: 'dir', entries: [] } }, tree || {}));
  const r = await shell.exec(cmd);
  return Object.assign(r, { host: host(), fs });
}

test('#1 a here-document followed by more lines parses once', async () => {
  const r = await run('cat <<EOF\na\nEOF\necho b\necho c');
  assert.equal(r.stdout, 'a\nb\nc\n');
  assert.equal(r.exitCode, 0);
});

test('#2 command substitution output does not reach the host stdout callback', async () => {
  const r = await run('echo X$(echo inner)');
  assert.equal(r.host, 'Xinner\n');
});

test('#3 substitution output is not re-expanded', async () => {
  const r = await run("echo $(echo '$HOME {a,b} ~')");
  assert.equal(r.stdout, '$HOME {a,b} ~\n');
  const f = await run('echo "$(< f)"', { '/w/f': '$HOME `x`' });
  assert.equal(f.stdout, '$HOME `x`\n');
});

test('#4 $(< file) reads the file when its command runs', async () => {
  const r = await run('echo hi > f; echo "[$(< f)]"');
  assert.equal(r.stdout, '[hi]\n');
  assert.equal(r.stderr, '');
  const missing = await run('x=$(< nope)');
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /bash: nope: No such file or directory/);
});

test('#5 child-session writes and host edits are visible (no stale cache)', async () => {
  const r = await run('cat f; x=$(echo new > f); cat f', { '/w/f': 'old\n' });
  assert.equal(r.stdout, 'old\nnew\n');
  const { shell, fs } = shellWith({ '/w/f': 'one\n' });
  await shell.exec('cat f');
  fs.write('/w/f', 'two\n');
  assert.equal((await shell.exec('cat f')).stdout, 'two\n');
});

test('#6 an assignment-only command takes the substitution status', async () => {
  assert.equal((await run('x=$(false) || echo failed')).stdout, 'failed\n');
  assert.equal((await run('x=$(true) && echo ok')).stdout, 'ok\n');
  BashJS.registerCommand('status_three_test', () => 3);
  assert.equal((await run('x=$(status_three_test); echo $?')).stdout, '3\n');
});

test('#7 brace expansion covers the whole word and never quoted text', async () => {
  assert.equal((await run('x=1; echo "p"{a,b}$x')).stdout, 'pa1 pb1\n');
  assert.equal((await run('x=1; echo "a{1,2}$x"')).stdout, 'a{1,2}1\n');
  assert.equal((await run("x=1; echo '{a,b}'$x")).stdout, '{a,b}1\n');
  assert.equal((await run('x=1; echo {a,b}"$x"')).stdout, 'a1 b1\n');
  assert.equal((await run('echo {x}{a,b} {0..3} {08..10}')).stdout, '{x}a {x}b 0 1 2 3 08 09 10\n');
});

test('#8 braces inside ${...} are not brace-expanded', async () => {
  assert.equal((await run('echo ${u:-a,b}')).stdout, 'a,b\n');
  assert.equal((await run('f=x.tar.gz; echo "${f%.*}" ${f#*.}')).stdout, 'x.tar tar.gz\n');
});

test('#9 here-document bodies get no brace or tilde expansion', async () => {
  const r = await run('x=1; cat <<EOF\n{a,b} ~ $x\nEOF');
  assert.equal(r.stdout, '{a,b} ~ 1\n');
});

test('#10 comments, here-strings and arithmetic shifts do not confuse the pre-scan', async () => {
  assert.equal((await run("echo a # don't\necho $(echo b)")).stdout, 'a\nb\n');
  assert.equal((await run("cat <<< 'x'\necho $(echo b)")).stdout, 'x\nb\n');
  assert.equal((await run('echo $((1<<2))\necho $(echo c)')).stdout, '4\nc\n');
  assert.equal((await run("cat <<EOF\nit's\nEOF\necho $(echo d)")).stdout, "it's\nd\n");
});

test('#11 backslash-newline is a line continuation', async () => {
  assert.equal((await run('echo a \\\n b')).stdout, 'a b\n');
  assert.equal((await run('echo "x\\\ny"')).stdout, 'xy\n');
});

test('#12 a write to a closed descriptor fails that command only', async () => {
  const r = await run('echo hi >&-; echo "next $?"');
  assert.equal(r.stdout, 'next 1\n');
  assert.match(r.stderr, /bash: echo: write error: Bad file descriptor/);
});

test('#13 globbing applies to unquoted parts of quoted and expanded words', async () => {
  const tree = { '/w/d/a.txt': 'a', '/w/d/b.txt': 'b', '/w/d/c.md': 'c' };
  assert.equal((await run('echo "d"/*.txt', tree)).stdout, 'd/a.txt d/b.txt\n');
  assert.equal((await run('dir=d; echo "$dir"/*.txt', tree)).stdout, 'd/a.txt d/b.txt\n');
  assert.equal((await run('p="d/*.md"; echo $p "$p"', tree)).stdout, 'd/c.md d/*.md\n');
});

test('#14 glob results keep ./ and ../ prefixes', async () => {
  const tree = { '/w/sub/x': '', '/w/f1': '', '/w/f2': '' };
  assert.equal((await run('echo ./f*', tree)).stdout, './f1 ./f2\n');
  const { shell } = shellWith(tree, { cwd: '/w/sub' });
  assert.equal((await shell.exec('echo ../f*')).stdout, '../f1 ../f2\n');
  assert.equal((await run('echo */', tree)).stdout, 'sub/\n');
});

test('#15 tilde expands only at the start of a word', async () => {
  assert.equal((await run('x=a; echo "$x"~ ~/b')).stdout, 'a~ /home/u/b\n');
});

test('#16 arithmetic precedence and associativity match bash', async () => {
  assert.equal((await run('echo $((-2**2)) $((3<=2<=1)) $((2**3**2))')).stdout, '4 1 512\n');
  const r = await run('a=a; echo $((a))');
  assert.match(r.stderr, /recursion level exceeded/);
});

test('#17 a persistent exec redirection does not override a pipe', async () => {
  const r = await run('exec 1>log; echo a | cat >&2; exec 1>&2; cat log; cat out 2>/dev/null', {});
  assert.equal(r.stderr, 'a\n');
});

test('tabs in words stay tabs', async () => {
  assert.equal((await run('echo "a\tb"')).stdout, 'a\tb\n');
});

test('a newline may follow |, && and ||', async () => {
  assert.equal((await run('echo a |\n cat')).stdout, 'a\n');
  assert.equal((await run('true &&\n echo and ||\n echo or')).stdout, 'and\n');
});

test('redirection targets must be a single word', async () => {
  const r = await run('f="a b"; echo x > $f; echo x > {a,b}; echo "$?"');
  assert.match(r.stderr, /bash: \$f: ambiguous redirect/);
  assert.match(r.stderr, /bash: \{a,b\}: ambiguous redirect/);
  assert.equal(r.stdout, '1\n');
  const missing = await run('cat < nofile');
  assert.equal(missing.stderr, 'bash: nofile: No such file or directory\n');
});

test('assignments before a redirection-only command persist', async () => {
  assert.equal((await run('y=1 >/dev/null; echo "y=$y"')).stdout, 'y=1\n');
});

test('the AST is not mutated by execution', async () => {
  const ast = BashJS.parse('echo $x > $f');
  const before = JSON.stringify(ast);
  const fs = BashJS.memfs({});
  await BashJS.exec('x=1; f=out; echo $x > $f', '/', { read: fs.read, write: fs.write, delete: fs.delete, move: fs.move });
  assert.equal(JSON.stringify(ast), before);
});

test('POSIX bracket classes in globs', async () => {
  const tree = { '/w/a1': '', '/w/b2': '', '/w/c ': '' };
  assert.equal((await run('echo [[:alpha:]][[:digit:]]', tree)).stdout, 'a1 b2\n');
});
