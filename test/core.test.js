'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BashJS = require('../bash.js');

function callbacks() {
  const fs = BashJS.memfs();
  return { fs, read: fs.read, write: fs.write, delete: fs.delete, move: fs.move };
}

test('word splitting follows IFS for unquoted expansion and preserves quoted values', async () => {
  const shell = BashJS.create(Object.assign(callbacks(), { env: { X: 'a  b\nc', IFS: ' \t\n' } }));
  let seen;
  BashJS.registerCommand('capture_split_test', async ctx => { seen = ctx.args; });
  await shell.exec('capture_split_test $X');
  assert.deepEqual(seen, ['a', 'b', 'c']);
  await shell.exec('capture_split_test "$X"');
  assert.deepEqual(seen, ['a  b\nc']);
});

test('pathname expansion traverses VFS levels, filters hidden names, and sorts matches', async () => {
  const fs = BashJS.memfs({
    '/work/b.txt': 'b', '/work/a.txt': 'a', '/work/.secret': 's',
    '/work/dir': { type: 'dir', entries: ['x.js', '.hidden.js'] },
    '/work/dir/x.js': 'x', '/work/dir/.hidden.js': 'h',
    '/work/file1': '1', '/work/file2': '2', '/work/fileA': 'A'
  });
  const shell = BashJS.create({ read: fs.read, write: fs.write, delete: fs.delete, move: fs.move, cwd: '/work' });
  let got;
  BashJS.registerCommand('glob_capture_test', ctx => { got = ctx.args; });
  await shell.exec('glob_capture_test *.txt');
  assert.deepEqual(got, ['a.txt', 'b.txt']);
  await shell.exec('glob_capture_test dir/*.js');
  assert.deepEqual(got, ['dir/x.js']);
  // `.*.js` matches nothing in /work, so bash keeps it literal.
  await shell.exec('glob_capture_test .secret .*.js dir/.*.js');
  assert.deepEqual(got, ['.secret', '.*.js', 'dir/.hidden.js']);
  await shell.exec('glob_capture_test file[12]');
  assert.deepEqual(got, ['file1', 'file2']);
  await shell.exec('glob_capture_test file[!1]');
  assert.deepEqual(got, ['file2', 'fileA']);
  await shell.exec('glob_capture_test no-match-*');
  assert.deepEqual(got, ['no-match-*']);
});

test('quoted, escaped, and mixed quoted/unquoted glob segments retain provenance', async () => {
  const fs = BashJS.memfs({ '/a*': 'literal', '/ab': 'b', '/ac': 'c', '/pre*x': 'literal', '/preax': 'a', '/prebx': 'b' });
  const shell = BashJS.create({ read: fs.read, write: fs.write, delete: fs.delete, move: fs.move });
  let got;
  BashJS.registerCommand('glob_quote_test', ctx => { got = ctx.args; });
  await shell.exec(String.raw`glob_quote_test '*' \* "a"* pre"*"x`);
  // `"a"*` is a glob on the unquoted `*`; it also matches the file named `a*`.
  assert.deepEqual(got, ['*', '*', 'a*', 'ab', 'ac', 'pre*x']);
});

test('custom IFS, empty expansions, substitutions, and assignment values', async () => {
  const shell = BashJS.create(Object.assign(callbacks(), { env: { X: 'a::b:', IFS: ':' } }));
  let seen;
  BashJS.registerCommand('capture_split_test', async ctx => { seen = ctx.args; });
  await shell.exec('capture_split_test $X');
  assert.deepEqual(seen, ['a', '', 'b']);
  shell.setEnv('X', '');
  await shell.exec('capture_split_test $X');
  assert.deepEqual(seen, []);
  await shell.exec('capture_split_test "$X"');
  assert.deepEqual(seen, ['']);
  shell.setEnv('IFS', ' \t\n');
  await shell.exec("capture_split_test $(echo 'a b')");
  assert.deepEqual(seen, ['a', 'b']);
  await shell.exec('X="a b"');
  assert.equal(shell.getEnv().X, 'a b');
});

test('quoted and unquoted expansion segments compose with field splitting', async () => {
  const shell = BashJS.create(Object.assign(callbacks(), { env: { A: 'a b', B: 'c d', IFS: ' \t\n' } }));
  let seen;
  BashJS.registerCommand('capture_segment_test', async ctx => { seen = ctx.args; });
  await shell.exec('capture_segment_test "$A"$B');
  assert.deepEqual(seen, ['a b', 'c', 'd']);
  await shell.exec('capture_segment_test pre"$A"post');
  assert.deepEqual(seen, ['prea bpost']);
  await shell.exec('capture_segment_test ""$B');
  assert.deepEqual(seen, ['c', 'd']);
  await shell.exec('IFS=:; capture_segment_test $(echo "c:d")');
  assert.deepEqual(seen, ['c', 'd']);
  await shell.exec('A=$B');
  assert.equal(shell.getEnv().A, 'c d');
});

test('literal legacy placeholder-shaped text is preserved in words and heredocs', async () => {
  const shell = BashJS.create(callbacks());
  const literal = '\u00100\u0011 \u00120\u0013';
  let r = await shell.exec(`echo '${literal}'`);
  assert.equal(r.stdout, literal + '\n');

  r = await shell.exec(`cat <<'END'\n${literal}\nEND\n`);
  assert.equal(r.stdout, literal + '\n');

  r = await shell.exec(`cat <<END\n${literal}\nEND\n`);
  assert.equal(r.stdout, literal + '\n');
});

test('environment values containing an internal marker prefix stay literal', async () => {
  const literal = '\u0010BASHJS0\u0011C0\u0011';
  const shell = BashJS.create(Object.assign(callbacks(), { env: { X: literal } }));
  const r = await shell.exec('echo "$X"');
  assert.equal(r.stdout, literal + '\n');
});

test('concatenated environment pieces of the old marker stay literal beside substitutions', async () => {
  const first = '\u0010BASH';
  const second = 'JS0\u0011C0\u0011';
  const shell = BashJS.create(Object.assign(callbacks(), {
    env: { FIRST: first, SECOND: second }
  }));
  const r = await shell.exec('echo $FIRST$SECOND');
  assert.equal(r.stdout, first + second + '\n');
});

test('input process substitutions capture isolated output for multiple operands and pipelines', async () => {
  const shell = BashJS.create(callbacks());
  await shell.exec('x=parent');
  let r = await shell.exec('cat <(echo hi)');
  assert.equal(r.stdout, 'hi\n');
  r = await shell.exec('cat <(echo one) <(echo two)');
  assert.equal(r.stdout, 'one\ntwo\n');
  r = await shell.exec('cat <(echo nested | cat)');
  assert.equal(r.stdout, 'nested\n');
  r = await shell.exec('cat <(x=child; echo $x); echo $x');
  assert.equal(r.stdout, 'child\nparent\n');
});

test('output process substitutions inherit current stdout in redirection order', async () => {
  const shell = BashJS.create(callbacks());
  let r = await shell.exec('echo x > >(cat)');
  assert.equal(r.stdout, 'x\n');
  assert.equal(r.stderr, '');

  r = await shell.exec('echo x 2> >(echo E)');
  assert.equal(r.stdout, 'x\nE\n');
  assert.equal(r.stderr, '');

  r = await shell.exec('echo x > >(echo O) 2> >(echo E)');
  assert.equal(r.stdout, 'O\n');
  assert.equal(r.stderr, '');
});

test('empty redirected process-substitution output does not reach the host stdout callback', async () => {
  const fs = BashJS.memfs();
  const chunks = [];
  const shell = BashJS.create({
    read: fs.read, write: fs.write, delete: fs.delete, move: fs.move,
    stdout(chunk) { chunks.push(chunk); }
  });
  await shell.exec('echo x > >(cat) > out');
  assert.equal(chunks.includes(''), false);
});

test('process substitution syntax stays literal in quotes, escapes, and quoted heredocs', async () => {
  const shell = BashJS.create(callbacks());
  let r = await shell.exec(`echo '<(echo no)' ">(echo no)" "<(echo no)"`);
  assert.equal(r.stdout, '<(echo no) >(echo no) <(echo no)\n');
  r = await shell.exec(String.raw`echo \<(echo no)`);
  assert.equal(r.stdout, '<(echo no)\n');
  r = await shell.exec(String.raw`echo \\<(echo no)`);
  assert.equal(r.stdout, '\\<(echo no)\n');
  r = await shell.exec("cat <<'EOF'\n<(echo no)\nEOF");
  assert.equal(r.stdout, '<(echo no)\n');
  r = await shell.exec("cat <<'EOF'\n>(echo no)\nEOF");
  assert.equal(r.stdout, '>(echo no)\n');
});

test('escaped process substitutions remain literal in quoted and unquoted heredocs', async () => {
  const shell = BashJS.create(callbacks());
  for (const [quote, expected] of [["'", String.raw`\<(echo hi)` + '\n' + String.raw`\>(echo hi)` + '\n'], ['', String.raw`\<(echo hi)` + '\n' + String.raw`\>(echo hi)` + '\n']]) {
    const r = await shell.exec(`cat <<${quote}EOF${quote}\n\\<(echo hi)\n\\>(echo hi)\nEOF`);
    assert.equal(r.stdout, expected);
    assert.equal(r.stderr, '');
  }
});

test('registered commands can read process substitution files through ctx.vfs', async () => {
  BashJS.registerCommand('readvirtual', async ctx => { ctx.stdout.write(await ctx.vfs.readFile(ctx.args[0])); return 0; });
  const fs = BashJS.memfs();
  let reads = 0;
  const shell = BashJS.create({
    read(path) { reads++; return fs.read(path); },
    write: fs.write, delete: fs.delete, move: fs.move
  });
  const r = await shell.exec('readvirtual <(echo virtual)');
  assert.equal(r.stdout, 'virtual\n');
  assert.equal(reads, 0);
});

test('process substitution operands never invoke host VFS reads', async () => {
  const fs = BashJS.memfs();
  let reads = 0;
  const shell = BashJS.create({
    read(path) { reads++; return fs.read(path); },
    write: fs.write, delete: fs.delete, move: fs.move
  });
  const r = await shell.exec('cat <(echo hi)');
  assert.equal(r.stdout, 'hi\n');
  assert.equal(reads, 0);
});

test('process substitutions are deferred until their simple command runs', async () => {
  let childRan = false;
  const shell = BashJS.create({ ...callbacks(), commands: { mark(ctx) { childRan = true; return 0; } } });
  const r = await shell.exec('false && cat <(mark)');
  assert.equal(r.exitCode, 1);
  assert.equal(childRan, false);
});

test('process substitution stdout reaches the host callback only through its consumer', async () => {
  const fs = BashJS.memfs();
  let hostOutput = '';
  const shell = BashJS.create({ read: fs.read, write: fs.write, delete: fs.delete, move: fs.move, stdout(s) { hostOutput += s; } });
  const r = await shell.exec('cat <(echo once)');
  assert.equal(r.stdout, 'once\n');
  assert.equal(hostOutput, 'once\n');
});

test('process substitution paths do not leak to later commands, including after failures', async () => {
  const shell = BashJS.create(callbacks());
  let r = await shell.exec('cat <(echo secret); cat /dev/fd/10');
  assert.equal(r.stdout, 'secret\n');
  assert.match(r.stderr, /No such file or directory|Bad file descriptor/);
  r = await shell.exec('cat <(echo secret) >/dev/fd/99; cat /dev/fd/10');
  assert.match(r.stderr, /Bad file descriptor/);
  assert.doesNotMatch(r.stderr, /secret/);
});

test('output process substitutions feed buffered owner output to the child', async () => {
  const shell = BashJS.create(callbacks());
  const r = await shell.exec('echo text > >(cat)');
  assert.equal(r.stdout, 'text\n');
  assert.equal(r.stderr, '');
});

test('stdout and stderr output substitutions send child output to the parent streams', async () => {
  const shell = BashJS.create(callbacks());
  const r = await shell.exec('echo x > >(echo O) 2> >(echo E)');
  assert.equal(r.stdout, 'O\n');
  assert.equal(r.stderr, '');
});

test('output process substitutions run after the owner, and short-circuit lazily', async () => {
  let childRan = false;
  BashJS.registerCommand('markout', ctx => { childRan = true; ctx.stdout.write(ctx.stdin.readAll()); return 0; });
  const shell = BashJS.create(callbacks());
  let r = await shell.exec('echo x > >(markout)');
  assert.equal(r.stdout, 'x\n');
  assert.equal(childRan, true);
  childRan = false;
  r = await shell.exec('false && echo x > >(markout)');
  assert.equal(r.exitCode, 1);
  assert.equal(childRan, false);
});

test('output process substitutions avoid VFS and work for utilities and pipeline stages', async () => {
  const fs = BashJS.memfs();
  let reads = 0, writes = 0;
  const shell = BashJS.create({
    read(path) { reads++; return fs.read(path); },
    write(path, data, opts) { writes++; return fs.write(path, data, opts); },
    delete: fs.delete, move: fs.move
  });
  let r = await shell.exec('cat <<EOF > >(cat)\nutility\nEOF');
  assert.equal(r.stdout, 'utility\n');
  r = await shell.exec('echo pipe | cat > >(cat)');
  assert.equal(r.stdout, 'pipe\n');
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('output process substitution cleanup survives owner and redirection errors', async () => {
  const shell = BashJS.create(callbacks());
  let r = await shell.exec('echo x > >(cat) 2>&99');
  assert.notEqual(r.exitCode, 0);
  assert.equal(r.stdout, '');
  r = await shell.exec('cat /dev/fd/10');
  assert.match(r.stderr, /No such file or directory|Bad file descriptor/);
  assert.equal(r.stdout, '');
});

test('arithmetic expansion supports precedence, literals, and assignment updates', async () => {
  const shell = BashJS.create(callbacks());
  await shell.exec('n=3');
  let r = await shell.exec('echo $((1 + 2 * 3)) $((0x10 + 010 + 16#ff)) $((n++)) $n $((++n))');
  assert.equal(r.stdout, '7 279 3 4 5\n');
  r = await shell.exec('echo $((2 ** 3 ** 2)) $((1 << 4)) $((1 ? 7 : 8))');
  assert.equal(r.stdout, '512 16 7\n');
});

test('arithmetic base#digits supports Bash digit ordering through base 64', async () => {
  const shell = BashJS.create(callbacks());
  const r = await shell.exec('echo $((2#101)) $((36#z)) $((37#A)) $((62#Z)) $((63#@)) $((64#_))');
  assert.equal(r.stdout, '5 35 36 61 62 63\n');
});

test('arithmetic base#digits validates bases and digits', async () => {
  const shell = BashJS.create(callbacks());
  for (const literal of ['1#0', '65#0', '2#2', '36#@', '63#_', '64#?', '10#']) {
    const r = await shell.exec(`echo $(( ${literal} ))`);
    assert.equal(r.exitCode, 1, literal);
    assert.match(r.stderr, /syntax error/, literal);
  }
});

test('arithmetic expansion nests and reports division by zero without evaluating JavaScript', async () => {
  const shell = BashJS.create(callbacks());
  let r = await shell.exec('echo $((1 + (2 * 3)))');
  assert.equal(r.stdout, '7\n');
  r = await shell.exec('echo $((1 / 0))');
  assert.equal(r.exitCode, 1);
  assert.equal(r.stdout, '\n');
  assert.match(r.stderr, /division by 0/);
  r = await shell.exec('echo $((1+))');
  assert.equal(r.exitCode, 1);
  assert.equal(r.stdout, '\n');
  assert.match(r.stderr, /syntax error/);
  r = await shell.exec('echo $((globalThis.process.exit()))');
  assert.equal(r.exitCode, 1);
});

test('arithmetic substitutions resolve words in lexical order', async () => {
  const shell = BashJS.create(callbacks());
  const r = await shell.exec('x=1; echo $x $((x=2)) $x');
  assert.equal(r.stdout, '1 2 2\n');
});

test('arithmetic assignments in a pipeline do not change the parent shell', async () => {
  const shell = BashJS.create(callbacks());
  const r = await shell.exec('x=1; echo $((x=2)) | cat; echo $x');
  assert.equal(r.stdout, '2\n1\n');
});

test('negative arithmetic exponent has an arithmetic error and status 1', async () => {
  const shell = BashJS.create(callbacks());
  const r = await shell.exec('echo $((2**-1))');
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /negative exponent/);
  assert.doesNotMatch(r.stderr, /syntax error/);
});

test('arithmetic preserves lvalues, recursively evaluates variables, and uses shell exponent precedence', async () => {
  const shell = BashJS.create(callbacks());
  const r = await shell.exec('x=2+3; echo $((x)) $((-2**2)) $((x=2, x+=3)) $x');
  // Unary minus binds tighter than ** in bash: $((-2**2)) is 4.
  assert.equal(r.stdout, '5 4 5 5\n');
});

test('arithmetic logical and conditional operators skip unevaluated branches', async () => {
  const shell = BashJS.create(callbacks());
  const r = await shell.exec('echo $((1 || 1/0)) $((0 && 1/0)) $((1 ? 7 : 1/0)) $((0 ? 1/0 : 8))');
  assert.equal(r.stdout, '1 0 7 8\n');
  assert.equal(r.exitCode, 0);
});

test('failed arithmetic expansion does not override a later successful command status', async () => {
  const shell = BashJS.create(callbacks());
  const r = await shell.exec('echo $((1/0)); true');
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr, /division by 0/);
});

test('command substitutions capture output, nest, strip newlines and isolate state', async () => {
  const shell = BashJS.create(callbacks());
  let r = await shell.exec('echo "$(echo "$(echo deep)")"; echo `echo old`');
  assert.equal(r.stdout, 'deep\nold\n');
  r = await shell.exec('echo `echo `echo `echo hi```');
  assert.equal(r.stdout, 'hi\n');
  r = await shell.exec('A=$(echo value); echo "$A"');
  assert.equal(r.stdout, 'value\n');
  r = await shell.exec('X=outer; echo $(echo $X)');
  assert.equal(r.stdout, 'outer\n');
  r = await shell.exec('echo `echo $(echo nested)`');
  assert.equal(r.stdout, 'nested\n');
  await shell.exec('X=outer');
  const cwd = shell.getCwd();
  await shell.exec('echo $(X=inner; cd /; echo ok)');
  assert.equal(shell.getEnv().X, 'outer');
  assert.equal(shell.getCwd(), cwd);
});

test('command substitutions run after heredocs and in unquoted heredoc bodies', async () => {
  const shell = BashJS.create(callbacks());
  let r = await shell.exec('cat <<EOF\n$(echo body)\nEOF\necho $(echo after)');
  assert.equal(r.stdout, 'body\nafter\n');
  r = await shell.exec('cat <<\'EOF\'\n$(echo literal)\nEOF');
  assert.equal(r.stdout, '$(echo literal)\n');
  r = await shell.exec("cat <<A <<'B'\nfirst\nA\n$(echo literal)\nB");
  assert.equal(r.stdout, '$(echo literal)\n');
  r = await shell.exec("cat <<'$(echo DELIM)'\nbody\n$(echo DELIM)");
  assert.equal(r.stdout, 'body\n');
  assert.equal(r.stderr, '');
});

test('substitution stderr routes outward, shortcut reads files, and pipelines work', async () => {
  const { fs, ...cb } = callbacks();
  const shell = BashJS.create(cb);
  await fs.write('/sample', 'file\n\n');
  BashJS.registerCommand('suberr', async ctx => { ctx.stderr.write('diagnostic\n'); ctx.stdout.write('data\n'); });
  let r = await shell.exec('echo "$(suberr)" | cat');
  assert.equal(r.stdout, 'data\n');
  assert.equal(r.stderr, 'diagnostic\n');
  r = await shell.exec('echo $(< sample)');
  assert.equal(r.stdout, 'file\n');
});

test('finite /dev/zero input is NUL and normalized device paths bypass host VFS', async () => {
  let calls = 0;
  const shell = BashJS.create({ read() { calls++; return ''; }, write() { calls++; }, delete() { calls++; }, move() { calls++; },
    stat() { calls++; }, exists() { calls++; return false; } });
  const result = await shell.exec('cat < /dev/../dev/zero');
  assert.equal(result.stdout, '\0');
  assert.equal(result.exitCode, 0);
  assert.equal(calls, 0);
});

test('>& file routes stdout and stderr to one file without changing fd duplication/close', async () => {
  const { fs, ...cb } = callbacks();
  const shell = BashJS.create(cb);
  BashJS.registerCommand('both', async ctx => { ctx.stdout.write('out'); ctx.stderr.write('err'); });
  await shell.exec('both >& target');
  assert.equal((await fs.read('/target')).content, 'outerr');
  const result = await shell.exec('echo ok 3>&1 4>&-');
  assert.equal(result.stdout, 'ok\n');
});

test('explicit fd duplication with a nonnumeric target is rejected before command execution', async () => {
  const { fs, ...cb } = callbacks();
  const shell = BashJS.create(cb);
  let ran = false;
  BashJS.registerCommand('explicit-fd-file-target', async () => { ran = true; });
  const result = await shell.exec('explicit-fd-file-target 2>&file');
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /ambiguous redirect|Bad file descriptor/);
  assert.equal(ran, false);
  assert.equal(fs.read('/file'), null);
  const bare = await shell.exec('echo bare >& file');
  assert.equal(bare.exitCode, 0);
  assert.equal(fs.read('/file').content, 'bare\n');
});

test('|& routes both output streams into the next pipeline stage', async () => {
  const shell = BashJS.create(callbacks());
  BashJS.registerCommand('emit', async ctx => { ctx.stdout.write('out'); ctx.stderr.write('err'); });
  const result = await shell.exec('emit |& cat');
  assert.equal(result.stdout, 'outerr');
  assert.equal(result.stderr, '');
  assert.equal(BashJS.parse('emit |& cat').body.items[0].node.pipeStderr[0], true);
});

test('|& stderr sink survives list and conditional recursive runs', async () => {
  const shell = BashJS.create(callbacks());
  BashJS.registerCommand('emit', async ctx => { ctx.stdout.write('out'); ctx.stderr.write('err'); });

  const list = await shell.exec('emit |& cat; true');
  assert.equal(list.stdout, 'outerr');
  assert.equal(list.stderr, '');

  const conditional = await shell.exec('true && emit |& cat');
  assert.equal(conditional.stdout, 'outerr');
  assert.equal(conditional.stderr, '');
});

test('parses list, conditional and pipeline structure', () => {
  const ast = BashJS.parse('echo a | cat && echo b; false || echo c');
  assert.equal(ast.type, 'Script');
  assert.equal(ast.body.items[0].node.type, 'AndOr');
  assert.equal(ast.body.items[0].node.left.type, 'Pipeline');
  assert.equal(ast.body.items.length, 2);
});

test('comments start at word boundaries after operators but not inside words', async () => {
  const cb = callbacks();
  const r = await BashJS.exec('echo a;# comment\necho foo#bar', '/', cb);
  assert.equal(r.stdout, 'a\nfoo#bar\n');
  assert.equal(r.exitCode, 0);
  assert.equal(BashJS.parse('echo a;# comment').body.items.length, 1);
});

test('echo a b | cat captures and forwards output', async () => {
  const cb = callbacks();
  let forwarded = '';
  const result = await BashJS.exec('echo a b | cat', '/', {
    read: cb.read, write: cb.write, delete: cb.delete, move: cb.move,
    stdout: s => { forwarded += s; }
  });
  assert.equal(result.stdout, 'a b\n');
  assert.equal(forwarded, 'a b\n');
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, 0);
});

test('and/or short-circuit and variable expansion', async () => {
  const cb = callbacks();
  const result = await BashJS.exec('false && echo no || echo $X', '/', cb, { env: { X: 'yes' } });
  assert.equal(result.stdout, 'yes\n');
  assert.equal(result.exitCode, 0);
});

test('quotes retain literal expansion and empty arguments', async () => {
  const cb = callbacks();
  const r = await BashJS.exec(`echo '$X'; echo ""`, '/', cb, { env: { X: 'expanded' } });
  assert.equal(r.stdout, '$X\n\n');
});

test('prefix assignments are temporary but assignment-only persists', async () => {
  const cb = callbacks();
  const s = BashJS.create(cb);
  await s.exec('X=old');
  const r = await s.exec('X=temp echo $X; echo $X');
  assert.equal(r.stdout, 'old\nold\n');
  assert.equal(s.getEnv().X, 'old');
});

test('pipeline uses last stage status and optional pipefail', async () => {
  const cb = callbacks();
  assert.equal((await BashJS.exec('false | true', '/', cb)).exitCode, 0);
  assert.equal((await BashJS.exec('false | true', '/', cb, { pipefail: true })).exitCode, 1);
});

test('host output callback failures are not syntax errors', async () => {
  const cb = callbacks();
  const r = await BashJS.exec('echo hi', '/', { ...cb, stdout: () => { throw new Error('host failed'); } });
  assert.equal(r.exitCode, 1);
  assert.doesNotMatch(r.stderr, /syntax error/);
});

test('memfs refuses moving root and a file onto a directory', () => {
  const fs = BashJS.memfs({ '/file': 'data', '/dir': { type: 'dir', entries: [] } });
  assert.throws(() => fs.move('/', '/elsewhere'), { code: 'EBUSY' });
  assert.throws(() => fs.move('/file', '/dir'), { code: 'EISDIR' });
  assert.equal(fs.read('/file').content, 'data');
});

test('memfs recursive deletion cannot remove the root directory', () => {
  const fs = BashJS.memfs({ '/keep': 'data' });
  assert.throws(() => fs.delete('/', { recursive: true }), { code: 'EBUSY' });
  assert.equal(fs.stat('/').type, 'dir');
  assert.equal(fs.read('/keep').content, 'data');
});

test('memfs refuses writing file content over directories without orphaning descendants', () => {
  const fs = BashJS.memfs({
    '/empty': { type: 'dir', entries: [] },
    '/nonempty': { type: 'dir', entries: ['child'] }
  });
  assert.throws(() => fs.write('/empty', 'data'), { code: 'EISDIR' });
  assert.throws(() => fs.write('/nonempty', 'data'), { code: 'EISDIR' });
  assert.equal(fs.stat('/empty').type, 'dir');
  assert.equal(fs.stat('/nonempty').type, 'dir');
  assert.equal(fs.stat('/nonempty/child').type, 'file');
});

test('memfs refuses moving directories onto files without changing either path', () => {
  const fs = BashJS.memfs({
    '/empty': { type: 'dir', entries: [] },
    '/nonempty': { type: 'dir', entries: ['child'] },
    '/empty-target': 'keep empty target',
    '/nonempty-target': 'keep nonempty target'
  });
  assert.throws(() => fs.move('/empty', '/empty-target'), { code: 'ENOTDIR' });
  assert.throws(() => fs.move('/nonempty', '/nonempty-target'), { code: 'ENOTDIR' });
  assert.equal(fs.stat('/empty').type, 'dir');
  assert.equal(fs.stat('/nonempty').type, 'dir');
  assert.equal(fs.read('/empty-target').content, 'keep empty target');
  assert.equal(fs.read('/nonempty-target').content, 'keep nonempty target');
  assert.equal(fs.stat('/nonempty/child').type, 'file');
});

test('memfs move replaces an empty directory and preserves nested entry types', () => {
  const fs = BashJS.memfs({
    '/source': { type: 'dir', entries: ['nested', 'file'] },
    '/source/nested': { type: 'dir', entries: ['leaf'] },
    '/source/nested/leaf': 'data',
    '/source/file': 'other',
    '/target': { type: 'dir', entries: [] }
  });
  fs.move('/source', '/target');
  assert.deepEqual(fs.read('/').entries, [{ name: 'target', type: 'dir' }]);
  assert.deepEqual(fs.read('/target').entries, [
    { name: 'nested', type: 'dir' },
    { name: 'file', type: 'file' }
  ]);
  assert.deepEqual(fs.read('/target/nested').entries, [{ name: 'leaf', type: 'file' }]);
  assert.equal(fs.stat('/target/nested/leaf').type, 'file');
  assert.equal(fs.stat('/source'), null);
});

test('escaped dollars stay literal outside and inside double quotes', async () => {
  const cb = callbacks();
  const r = await BashJS.exec('echo \\$X; echo "\\$X"', '/', cb, { env: { X: 'expanded' } });
  assert.equal(r.stdout, '$X\n$X\n');
});

test('stderr callback exceptions never reject exec', async () => {
  const cb = callbacks();
  const r = await BashJS.exec('missing-command', '/', { ...cb, stderr: () => { throw new Error('host failed'); } });
  assert.equal(r.exitCode, 127);
  assert.match(r.stderr, /command not found/);
});

test('& runs synchronously and exposes fake $! with successful list status', async () => {
  const cb = callbacks();
  const r = await BashJS.exec('false & echo "$!: $?"', '/', cb);
  assert.match(r.stdout, /^\d+: 0\n$/);
  assert.equal(r.exitCode, 0);
});

test('redirections truncate, append, and apply in source order', async () => {
  const cb = callbacks();
  cb.fs.write('/f', 'old');
  let r = await BashJS.exec('echo first > f; echo next >> f; echo kept > f 2>&1', '/', cb);
  assert.equal(cb.fs.read('/f').content, 'kept\n');
  assert.equal(r.stdout, '');
  BashJS.registerCommand('redirection-test-writer', async ctx => { ctx.stdout.write('out\n'); ctx.stderr.write('err\n'); return 0; });
  r = await BashJS.exec('redirection-test-writer 2>&1 > out', '/', cb);
  assert.equal(r.stdout, 'err\n');
  assert.equal(cb.fs.read('/out').content, 'out\n');
});

test('input redirection and here-string feed cat', async () => {
  const cb = callbacks();
  cb.fs.write('/in', 'from-file');
  const r = await BashJS.exec('cat < in; cat <<< word', '/', cb);
  assert.equal(r.stdout, 'from-fileword\n');
});

test('here-documents preserve quoted bodies, expand unquoted bodies, strip tabs, and queue in order', async () => {
  const cb = callbacks();
  const r = await BashJS.exec("X=world; cat <<'LIT' <<-EXP\n$X literal\nLIT\n\t$X expanded\n\tEXP\n", '/', cb);
  assert.equal(r.stdout, 'world expanded\n');
  const literal = await BashJS.exec("cat <<'END'\n$X literal\nEND\n", '/', cb);
  assert.equal(literal.stdout, '$X literal\n');
});

test('unquoted here-doc expands braced variables and preserves backslash-escaped dollars', async () => {
  const cb = callbacks();
  const r = await BashJS.exec('cat <<END\n${NAME} \\$NAME\nEND\n', '/', cb, { env: { NAME: 'value' } });
  assert.equal(r.stdout, 'value $value\n');
});

test('backslash-quoted here-doc delimiter keeps the body literal', async () => {
  const cb = callbacks();
  const r = await BashJS.exec('cat <<\\END\n$NAME `echo expanded`\nEND\n', '/', cb, { env: { NAME: 'value' } });
  assert.equal(r.stdout, '$NAME `echo expanded`\n');
});

test('here-doc delimiter accepts CRLF and reports a missing delimiter', async () => {
  const cb = callbacks();
  const ok = await BashJS.exec('cat <<END\r\nbody\r\nEND\r\n', '/', cb);
  assert.equal(ok.stdout, 'body\n');
  const missing = await BashJS.exec('cat <<END\nbody\n', '/', cb);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /missing here-document delimiter: END/);
});

test('duplication and close redirections route descriptors', async () => {
  const cb = callbacks();
  BashJS.registerCommand('redirection-test-both', async ctx => { ctx.stdout.write('out\n'); ctx.stderr.write('err\n'); return 0; });
  const r = await BashJS.exec('redirection-test-both > f 2>&1', '/', cb);
  assert.equal(r.stdout, '');
  assert.equal(cb.fs.read('/f').content, 'out\nerr\n');
});

test('redirection errors are reported', async () => {
  const cb = callbacks();
  const r = await BashJS.exec('echo nope > missing/file', '/', cb);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /No such file or directory/);
});

test('invalid descriptor duplication prevents command execution and early cat flushes output', async () => {
  const cb = callbacks();
  let ran = false;
  BashJS.registerCommand('redirection-should-not-run', async () => { ran = true; });
  const bad = await BashJS.exec('redirection-should-not-run 2>&9', '/', cb);
  assert.equal(bad.exitCode, 1);
  assert.equal(ran, false);
  await BashJS.exec('cat > empty-file', '/', cb);
  assert.equal(cb.fs.read('/empty-file').content, '');
});

test('descriptor duplication supports 3-9 and mismatched aliases fail only when used', async () => {
  const cb = callbacks();
  const unsupported = await BashJS.exec('echo no 9>&1', '/', cb);
  assert.equal(unsupported.exitCode, 0);
  assert.equal(unsupported.stdout, 'no\n');
  const inputAlias = await BashJS.exec('cat <<< hidden 0<&1', '/', cb);
  assert.equal(inputAlias.exitCode, 1);
  assert.match(inputAlias.stderr, /Bad file descriptor/);
  const outputAlias = await BashJS.exec('echo hidden 1>&0', '/', cb);
  assert.equal(outputAlias.exitCode, 1);
  assert.match(outputAlias.stderr, /Bad file descriptor/);
  let invoked = false;
  BashJS.registerCommand('descriptor-use-time', async ctx => {
    invoked = true;
    ctx.stdout.write('written');
    return 0;
  });
  const used = await BashJS.exec('descriptor-use-time 1>&0', '/', cb);
  assert.equal(invoked, true);
  assert.match(used.stderr, /Bad file descriptor/);
  assert.equal((await BashJS.exec('echo visible', '/', cb)).stdout, 'visible\n');
});

test('descriptor aliases preserve left-to-right stream routing and closed descriptors', async () => {
  const cb = callbacks();
  BashJS.registerCommand('descriptor-streams', async ctx => {
    ctx.stdout.write('stdout\n'); ctx.stderr.write('stderr\n'); return 0;
  });
  const r = await BashJS.exec('descriptor-streams 2>&1 1>&2', '/', cb);
  assert.equal(r.stdout, 'stdout\nstderr\n');
  assert.equal(r.stderr, '');
  for (const command of ['descriptor-streams 1>&-', 'cat 0<&-']) {
    const result = await BashJS.exec(command, '/', cb);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Bad file descriptor/);
  }
});

test('here-doc backslash parity before dollar and backtick', async () => {
  const cb = callbacks();
  const r = await BashJS.exec('X=value; cat <<END\n\\$X\n\\\\$X\n\\\\\\$X\nEND\n', '/', cb);
  assert.equal(r.stdout, String.raw`$value
\value
\$value
`);
});

test('brace alternatives and ranges, tilde paths, and parameter operators', async () => {
  const shell = BashJS.create({ ...callbacks(), cwd: '/work', env: { HOME: '/home/u', OLDPWD: '/old', V: 'abcdef', EMPTY: '' } });
  const r = await shell.exec('echo {a,{b,c}} {03..07..2} {a..e..2}; echo ~/x ~+ ~-; echo ${V:2:2} ${#V} ${V#abc} ${V##a*} ${V%c*} ${V%%*c}; echo ${EMPTY:-fallback} ${EMPTY-word} ${EMPTY:+yes}; X=${EMPTY:=set}; echo $X');
  assert.equal(r.stdout, 'a b c 03 05 07 a c e\n/home/u/x /work /old\ncd 6 def ab abcdef\nfallback\nset\n');
});

test('parameter substring and shortest/longest pattern trimming', async () => {
  const shell = BashJS.create({ ...callbacks(), env: { V: 'abcabc' } });
  const r = await shell.exec('echo ${V:2:2}; echo ${V#a*} ${V##a*}; echo ${V%*c} ${V%%*c}');
  assert.equal(r.stdout, 'ca\nbcabc\nabcab\n');
});

test('suffix trimming chooses shortest and longest matching glob', async () => {
  const shell = BashJS.create({ ...callbacks(), env: { V: 'abcabc' } });
  const r = await shell.exec('echo ${V%c*} ${V%%c*}');
  assert.equal(r.stdout, 'abcab ab\n');
});

test('parameter trimming checks longest prefix and suffix patterns', async () => {
  const shell = BashJS.create({ ...callbacks(), env: { X: 'abcabc' } });
  const result = await shell.exec('echo ${X#*b} ${X##*b} ${X%*c} ${X%%*c}');
  assert.equal(result.stdout, 'cabc c abcab\n');
});

test('parameter trimming bracket classes support positive and negated shell classes', async () => {
  const shell = BashJS.create({ ...callbacks(), env: { X: 'abcabc' } });
  const result = await shell.exec('echo ${X%%[!a]*} ${X%%[a]*}');
  assert.equal(result.stdout, 'a\n');
});

test('tilde plus and minus expand with suffix only at word start', async () => {
  const shell = BashJS.create({ ...callbacks(), cwd: '/work', env: { PWD: '/here', OLDPWD: '/there' } });
  const result = await shell.exec('echo ~+suffix ~-suffix x~+suffix "~+suffix" \\~-suffix');
  assert.equal(result.stdout, '/worksuffix /theresuffix x~+suffix ~+suffix ~-suffix\n');
});

test('tilde and brace expansion respect quote provenance within mixed words', async () => {
  const shell = BashJS.create({ ...callbacks(), env: { HOME: '/home/test' } });
  const result = await shell.exec('echo ~ "~" \\~ x"{a,b}"{c,d}');
  assert.equal(result.stdout, '/home/test ~ ~ x{a,b}c x{a,b}d\n');
});

test('zero-step and oversized brace ranges fail explicitly', async () => {
  const shell = BashJS.create(callbacks());
  const zero = await shell.exec('echo {1..5..0}');
  assert.notEqual(zero.exitCode, 0);
  assert.match(zero.stderr, /step cannot be zero/);
  const tooMany = await shell.exec('echo {1..1001}');
  assert.notEqual(tooMany.exitCode, 0);
  assert.match(tooMany.stderr, /exceeds 1000 alternatives/);
  const product = await shell.exec('echo {a,b}{1..1000}');
  assert.notEqual(product.exitCode, 0);
  assert.match(product.stderr, /exceeds 1000 alternatives/);
});

test('here-doc escaped backticks restore as backticks with even/odd slash parity', async () => {
  const cb = callbacks();
  const r = await BashJS.exec('X=value; cat <<END\n\\`tick\\`\n\\\\\\`tick\\`\n\\\\\\`tick\\`\nEND\n', '/', cb);
  assert.equal(r.stdout, ['`tick`', '\\`tick`', '\\`tick`'].join('\n') + '\n');
});

test('exec keeps descriptors 3-9 across session calls; dup and close retain shell ordering', async () => {
  const cb = callbacks();
  const s = BashJS.create(cb);
  assert.equal((await s.exec('exec 3>fd')).exitCode, 0);
  assert.equal((await s.exec('echo saved >&3')).stdout, '');
  assert.equal(cb.fs.read('/fd').content, 'saved\n');
  await s.exec('exec 3>&1');
  const dup = await s.exec('echo visible >&3');
  assert.equal(dup.stdout, 'visible\n');
  await s.exec('exec 3>&-');
  const closed = await s.exec('echo hidden >&3');
  assert.equal(closed.exitCode, 1);
  assert.match(closed.stderr, /Bad file descriptor/);
  assert.equal((await s.exec('echo ordinary 3>scoped; echo still')).stdout, 'ordinary\nstill\n');
  assert.equal(cb.fs.read('/scoped').content, '');
});

test('exec redirection ordering, invalid fds and unsupported arguments', async () => {
  const cb = callbacks();
  const s = BashJS.create(cb);
  const bad = await s.exec('exec 10>bad');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /Bad file descriptor/);
  const unsupported = await s.exec('exec echo nope');
  assert.equal(unsupported.exitCode, 2);
  assert.match(unsupported.stderr, /arguments are not supported/);
  await s.exec('exec 3>ordered 4>&3');
  const result = await s.exec('echo ordered >&4');
  assert.equal(result.exitCode, 0);
  assert.equal(cb.fs.read('/ordered').content, 'ordered\n');
});

test('ordinary redirections do not mutate persistent descriptors and fd 0-2 exec persists', async () => {
  const cb = callbacks();
  const s = BashJS.create(cb);
  await s.exec('exec 3>persist');
  await s.exec('true 3>scoped');
  await s.exec('echo after >&3');
  assert.equal(cb.fs.read('/persist').content, 'after\n');
  assert.equal(cb.fs.read('/scoped').content, '');
  await s.exec('exec > session');
  const later = await s.exec('echo later');
  assert.equal(later.stdout, '');
  assert.equal(cb.fs.read('/session').content, 'later\n');
});

test('IO_NUMBER requires lexical adjacency and force-clobber is parsed', async () => {
  const cb = callbacks();
  cb.fs.write('/f', 'old');
  const spaced = await BashJS.exec('echo 2 >f', '/', cb);
  assert.equal(spaced.stdout, '');
  assert.equal(cb.fs.read('/f').content, '2\n');
  const adjacent = await BashJS.exec('echo 2>f', '/', cb);
  assert.equal(adjacent.stdout, '\n');
  assert.equal(cb.fs.read('/f').content, '');
  cb.fs.write('/f', 'old');
  const forced = await BashJS.exec('echo force >| f', '/', cb);
  assert.equal(forced.stdout, '');
  assert.equal(cb.fs.read('/f').content, 'force\n');
});

test('quoted and escaped numeric words are not IO_NUMBERs', async () => {
  const cb = callbacks();
  let received = [];
  BashJS.registerCommand('numeric-word-test', async ctx => { received = ctx.args; return 0; });
  for (const word of ['"2"', '\\2']) {
    const result = await BashJS.exec(`numeric-word-test ${word}>f`, '/', cb);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(received, ['2']);
    assert.equal(cb.fs.read('/f').content, '');
  }
});

test('exec closes standard descriptors persistently without requiring stdin', async () => {
  const cb = callbacks();
  const s = BashJS.create(cb);
  assert.equal((await s.exec('exec 0<&-')).exitCode, 0);
  assert.equal((await s.exec('echo still works')).stdout, 'still works\n');
  assert.equal((await s.exec('true')).exitCode, 0);
  const cat = await s.exec('cat');
  assert.equal(cat.exitCode, 1);
  assert.match(cat.stderr, /Bad file descriptor/);
  assert.equal((await s.exec('exec 1>&-')).exitCode, 0);
  assert.equal((await s.exec('echo hidden')).exitCode, 1);
});

test('noclobber rejects > on existing files but >| forces overwrite', async () => {
  const cb = callbacks();
  const s = BashJS.create(cb);
  cb.fs.write('/f', 'old');
  await s.exec('set -o noclobber');
  const refused = await s.exec('echo no > f');
  assert.equal(refused.exitCode, 1);
  assert.equal(cb.fs.read('/f').content, 'old');
  const forced = await s.exec('echo yes >| f');
  assert.equal(forced.exitCode, 0);
  assert.equal(cb.fs.read('/f').content, 'yes\n');
  await s.exec('set +o noclobber');
});

test('virtual fd paths alias standard streams and numbered descriptors', async () => {
  const cb = callbacks();
  cb.fs.write('/input', 'from stdin');
  const s = BashJS.create({ ...cb, stdin: 'stdin-data' });
  let r = await s.exec('cat < /dev/stdin');
  assert.equal(r.stdout, 'stdin-data');
  r = await s.exec('echo via-path > /dev/stdout');
  assert.equal(r.stdout, 'via-path\n');
  await s.exec('exec 3>aliased');
  r = await s.exec('echo fd-path > /dev/fd/3');
  assert.equal(cb.fs.read('/aliased').content, 'fd-path\n');
});

test('standard virtual fd paths report capability errors in either redirection direction', async () => {
  const s = BashJS.create(callbacks());
  for (const command of ['cat < /dev/stdout', 'echo no > /dev/stdin']) {
    const result = await s.exec(command);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Bad file descriptor/);
  }
});

test('normalized virtual device paths use virtual descriptors', async () => {
  const cb = callbacks();
  const s = BashJS.create({ ...cb, stdin: 'virtual input' });
  assert.equal((await s.exec('cat < //dev/stdin')).stdout, 'virtual input');
  assert.equal((await s.exec('echo virtual > /dev/../dev/stdout')).stdout, 'virtual\n');
  const bad = await s.exec('cat < /dev/../dev/stdout');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /Bad file descriptor/);
  assert.equal(cb.fs.exists('/dev/../dev/stdout'), false);
});

test('normalized virtual device paths never reach host VFS callbacks', async () => {
  const fs = BashJS.memfs();
  const paths = [];
  const track = (fn) => (...args) => { paths.push(args[0]); return fn(...args); };
  const shell = BashJS.create({
    read: track(fs.read), write: track(fs.write), delete: track(fs.delete), move: track(fs.move),
    stat: track(fs.stat), exists: track(fs.exists), stdin: 'input'
  });
  await shell.exec('cat < /dev/../dev/null');
  await shell.exec('cat < /dev/../dev/zero');
  await shell.exec('cat < /dev/../dev/stdin');
  await shell.exec('echo out > /dev/../dev/stdout');
  await shell.exec('echo err > /dev/../dev/stderr');
  await shell.exec('exec 3>fd-target');
  await shell.exec('echo fd > /dev/../dev/fd/3');
  assert.deepEqual(paths.filter(path => /^\/dev\/(?:null|zero|stdin|stdout|stderr|fd\/\d+)$/.test(path)), []);
  assert.equal(fs.read('/fd-target').content, 'fd\n');
});

test('utility file operands use virtual stdin and /dev/zero writes never reach host VFS', async () => {
  const fs = BashJS.memfs();
  const calls = [];
  const track = (name, fn) => (...args) => { calls.push([name, args[0], args[1]]); return fn(...args); };
  const shell = BashJS.create({
    read: track('read', fs.read), write: track('write', fs.write),
    delete: track('delete', fs.delete), move: track('move', fs.move),
    stdin: 'redirected input'
  });
  let result = await shell.exec('cat /dev/stdin');
  assert.equal(result.stdout, 'redirected input');
  result = await shell.exec('echo piped | cat /dev/stdin');
  assert.equal(result.stdout, 'piped\n');
  result = await shell.exec('echo ignored > /dev/zero');
  assert.equal(result.exitCode, 0);
  assert.equal(calls.some(([, path]) => path === '/dev/stdin' || path === '/dev/zero'), false);
  assert.equal(calls.some(([name, path]) => name === 'write' && path === '/dev/zero'), false);
});

test('failed move duplication validates source capability before closing it', async () => {
  const s = BashJS.create({ ...callbacks(), stdin: 'still open' });
  const bad = await s.exec('exec 3>&0-');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /Bad file descriptor/);
  const check = await s.exec('cat');
  assert.equal(check.exitCode, 0);
  assert.equal(check.stdout, 'still open');
});

test('<> reads and appends writes, while move redirections close the source', async () => {
  const cb = callbacks();
  cb.fs.write('/rw', 'old');
  const s = BashJS.create(cb);
  BashJS.registerCommand('fd-rw-check', async ctx => {
    ctx.stdout.write(ctx.stdin.readAll());
    return 0;
  });
  BashJS.registerCommand('fd-write-three', async ctx => {
    ctx.stdout.write('added\n');
    return 0;
  });
  const rw = await s.exec('fd-rw-check <> rw');
  assert.equal(rw.stdout, 'old');
  const created = await s.exec('fd-rw-check <> missing-rw');
  assert.equal(created.exitCode, 0);
  assert.equal(cb.fs.read('/missing-rw').content, '');
  assert.equal((await s.exec('fd-write-three 3<> rw 1>&3')).exitCode, 0);
  assert.equal(cb.fs.read('/rw').content, 'oldadded\n');
  const moved = await s.exec('echo moved 3>&1- 1>&3');
  assert.equal(moved.stdout, 'moved\n');
  const closed = await s.exec('echo no >&1');
  assert.equal(closed.exitCode, 0);
  const persistent = BashJS.create(cb);
  await persistent.exec('exec 3>&1-');
  const bad = await persistent.exec('echo closed');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /Bad file descriptor/);
});

test('input move redirections close source and replace destination capabilities', async () => {
  const cb = callbacks();
  const s = BashJS.create({ ...cb, stdin: 'moved input' });
  BashJS.registerCommand('read-fd-three', async ctx => {
    ctx.stdout.write(ctx.stdin.readAll());
    return 0;
  });
  const result = await s.exec('read-fd-three 3<&0- 0<&3');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'moved input');

  const persistent = BashJS.create({ ...cb, stdin: 'x' });
  await persistent.exec('exec 3<&0-');
  const closed = await persistent.exec('cat');
  assert.equal(closed.exitCode, 1);
  assert.match(closed.stderr, /Bad file descriptor/);
  const bad = await s.exec('echo no 3<&0- 1>&3');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /Bad file descriptor/);
});
