<p align="center">
  <a href="https://gramthanos.github.io/bash.js/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.svg">
      <img alt="bash.js: Bash, in plain JavaScript" src="docs/banner-light.svg" width="720">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://gramthanos.github.io/bash.js/">Website</a> ·
  <a href="https://gramthanos.github.io/bash.js/#playground">Try it in the browser</a> ·
  <a href="https://gramthanos.github.io/bash.js/#api">API</a>
</p>

A single-file, dependency-free JavaScript library that **interprets bash command lines** and executes them entirely through host-supplied callbacks. No real shell, no `child_process`, no Node-only APIs — it runs the same in Node, Deno, Bun, browsers, and workers.

```js
# Examples of what works
bash.exec('grep -rn TODO src | sort | head -5 > todo.txt')
bash.exec('diff -u <(sort a.txt) <(sort b.txt) > ab.patch')
bash.exec('awk -F, "{sum[\$1]+=\$3} END {for (k in sum) print k, sum[k]}" data.csv')
bash.exec('sed -i.bak -E "s/(foo|bar)=([0-9]+)/\\1=\\2\\2/g" settings.conf')
```

---

## Features

- **Full bash parser & interpreter** — pipelines, lists, redirections, here-docs, substitutions, brace/tilde/parameter/command/arithmetic expansion, globbing, control flow (`if`, `for`, `while`, `case`, functions)
- **24 utilities implemented in pure JS** — `grep`, `rg`, `find`, `sed`, `awk`, `cat`, `ls`, `head`, `tail`, `wc`, `nl`, `sort`, `uniq`, `cut`, `mkdir`, `rm`, `mv`, `dirname`, `date`, `diff`, `patch`, `echo`, `printf`, `cd`
- **Host-driven I/O** — you supply 4 filesystem callbacks (`read`, `write`, `delete`, `move`) and 2 stream callbacks (`stdout`, `stderr`); the library has zero I/O of its own
- **Single file, UMD-wrapped** — `bash.js` exposes `BashJS` (browser global / CommonJS / ESM interop)
- **Deterministic, testable** — includes `BashJS.memfs()` for an in-memory filesystem (great for tests and demos)
- **No globals leaked**, no `eval`/`Function()` — safe to run on untrusted command strings

---

## Installation

**Browser:**
```html
<script src="bash.js"></script>
<!-- window.BashJS is available -->
```

**Node / CommonJS:**
```js
const BashJS = require('./bash.js');
```

**ESM (via UMD default interop):**
```js
import BashJS from './bash.js';
```

---

## Quick Start

```js
const fs = require('fs');
const path = require('path');

// 1) Define the host callbacks
const callbacks = {
  read: async (p) => {
    try { return fs.readFileSync(p, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  },
  write: async (p, content, opts) => {
    if (opts?.type === 'dir') { fs.mkdirSync(p, { recursive: true }); return; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, { flag: opts?.append ? 'a' : 'w' });
  },
  delete: async (p, opts) => {
    fs.rmSync(p, { recursive: !!opts?.recursive, force: true });
  },
  move: async (src, dst) => {
    fs.renameSync(src, dst);
  },
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
};

// 2) One-shot execution
const result = await BashJS.exec(
  'grep -rn TODO src | sort | head -5 > todo.txt',
  '/home/user/project',
  callbacks,
  { env: { HOME: '/home/user' } }
);

console.log('exit:', result.exitCode);   // 0
console.log('stdout:', result.stdout);   // captured output
console.log('stderr:', result.stderr);   // captured errors
console.log('cwd:', result.cwd);         // final working directory
console.log('env:', result.env);         // final environment
```

---

## Persistent Session

State (cwd, env vars, functions, `$?`, open file descriptors) survives between calls:

```js
const sh = BashJS.create({
  cwd: '/',
  read: callbacks.read,
  write: callbacks.write,
  delete: callbacks.delete,
  move: callbacks.move,
  stdout: callbacks.stdout,
  stderr: callbacks.stderr,
  env: { PATH: '/usr/bin:/bin' }
});

await sh.exec('cd /tmp && export X=1');
await sh.exec('echo $X; pwd');   // → "1\n/tmp\n"

sh.getCwd();        // '/tmp'
sh.getEnv();        // { X: '1', PATH: ..., PWD: '/tmp', ... }
sh.setEnv('K', 'v');
```

---

## API Reference

### `BashJS.exec(command, cwd, callbacks, options?)`

Execute a single command string.

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | `string` | Bash command line to execute |
| `cwd` | `string` | Initial working directory (absolute POSIX path) |
| `callbacks` | `object` | Host callbacks (see below) |
| `options` | `object` | Optional settings |

**Returns:** `Promise<{ exitCode, stdout, stderr, cwd, env }>`

### `BashJS.create(options)`

Create a persistent shell session.

```js
const sh = BashJS.create({
  cwd: '/',                    // initial working directory
  read, write, delete, move,   // required FS callbacks
  stdout, stderr,              // required stream callbacks
  env: {},                     // initial environment
  now: () => new Date(),       // clock for `date` (deterministic tests)
  timezone: 'UTC',             // timezone for `date`
  maxLoopIterations: 100000,   // safety guard on loops
  maxOutputBytes: 16 * 1024 * 1024,
  maxCallDepth: 200,           // function/subshell recursion guard
  signal: abortSignal,         // AbortSignal to cancel execution
  strict: false                // throw on unsupported syntax instead of error+exit 2
});
```

**Session methods:**
- `await sh.exec(command, options?)` — execute in this session
- `sh.getCwd()` — current working directory
- `sh.getEnv()` — copy of exported environment
- `sh.setEnv(name, value)` — set an environment variable
- `sh.getLastExit()` — `$?` of last command

### `BashJS.parse(command)`

Parse a command string and return the AST (for tooling/debugging).

### `BashJS.registerCommand(name, handler)`

Register a custom utility. The handler receives a `CommandContext`:

```js
BashJS.registerCommand('hello', async (ctx) => {
  ctx.stdout.write('hi\n');
  return 0;
});
```

### `BashJS.commands()`

Returns an array of all registered command names (builtins + utilities + custom).

### `BashJS.memfs(initialTree?)`

Returns an in-memory filesystem adapter implementing the callback contract. Useful for tests and demos.

```js
const memfs = BashJS.memfs({
  '/home/user/file.txt': 'hello',
  '/home/user/dir': ['subdir', 'file2.txt']
});

const result = await BashJS.exec('cat /home/user/file.txt', '/', {
  ...memfs,
  stdout: (c) => console.log('out:', c),
  stderr: (c) => console.error('err:', c)
});
```

### `BashJS.version`

String: `'1.0.0'`

---

## Host Callback Contract

All callbacks may be sync or return a Promise; the library always `await`s them. Paths passed to callbacks are **absolute, normalized POSIX paths** (`/a/b/c`, no `.`/`..`, no trailing `/`).

| Callback | Signature | Semantics |
|----------|-----------|-----------|
| `read` | `read(path) → FileNode \| null` | Return `null`/`undefined` (or throw `ENOENT`) when missing. |
| `write` | `write(path, content, { append?: boolean, type?: 'file'\|'dir' })` | `type:'dir'` creates a directory (`content` ignored). `append:true` appends; otherwise truncates/creates. |
| `delete` | `delete(path, { recursive?: boolean })` | Remove file or directory. |
| `move` | `move(src, dst)` | Rename/move file or directory; `dst` is the final full path. |
| `stdout` | `stdout(chunk)` | Receives top-level fd 1 output in order. |
| `stderr` | `stderr(chunk)` | Receives top-level fd 2 output in order. |

**`FileNode` accepted shapes** (normalized internally by the VFS adapter):

```js
'file contents'                                   // string → regular file
['a.txt', 'sub']                                  // array of names → directory
[{ name: 'a.txt', type: 'file' }, ...]            // directory with typed entries
{ type: 'file', content: '...', size?, mtime?, mode? }
{ type: 'dir',  entries: [...],  mtime?, mode? }
```

**Optional extra callbacks** (used for speed if supplied, emulated otherwise):
- `stat(path) → { type, size, mtime, mode } \| null`
- `exists(path) → boolean`

---

## Supported Bash Features

### Parsing & Execution
- Pipelines (`|`, `|&`), lists (`;`, `&`, `&&`, `||`), subshells (`( … )`), command groups (`{ …; }`)
- Control flow: `if/elif/else/fi`, `for/in`, `while/until`, `case`, `select` (parsing only)
- Functions: `name() { … }`, `function name { … }`, `local`, `return`
- Arithmetic: `(( expr ))`, `$(( expr ))`
- Conditionals: `[[ expr ]]` with glob/regex (`=~`), file tests (`-e`, `-f`, `-d`, `-nt`, …), `&&`/`||`/`!`
- `set -e -u -x -o pipefail -o noclobber`, `shopt` options

### Redirections (full table)
| Syntax | Effect |
|--------|--------|
| `< file`, `n< file` | open for reading on fd 0 / n |
| `> file`, `n> file` | truncate+write (respects `noclobber`) |
| `>| file` | truncate even with `noclobber` |
| `>> file`, `n>> file` | append |
| `<> file` | read/write |
| `&> file`, `>& file` | stdout+stderr → file |
| `&>> file` | stdout+stderr append |
| `n>&m`, `n<&m` | duplicate fd m onto n |
| `>&2`, `2>&1`, `1>&2` | common dups |
| `n>&-`, `n<&-` | close fd |
| `n>&m-` | move fd |
| `<< DELIM`, `<<- DELIM` | here-document |
| `<<< word` | here-string |
| `<(cmd)`, `>(cmd)` | process substitution |
| `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/N` | virtual targets |
| `exec n>file` / `exec n<&-` | persistent fd changes |

### Expansions (in order)
1. **Brace** — `{a,b,c}`, `{1..10}`, `{01..10}`, `{a..z}`, `{1..10..2}`
2. **Tilde** — `~`, `~/x`, `~+` (PWD), `~-` (OLDPWD)
3. **Parameter** — `${var:-default}`, `${var:?msg}`, `${var#pat}`, `${var//pat/rep}`, `${#var}`, arrays `${a[@]}`, `${!a[@]}`, indirection `${!name}`, `${!prefix*}`
4. **Command substitution** — `$(…)`, `` `…` `` (subshell, fd 1 captured, trailing newlines stripped)
5. **Arithmetic** — `$((…))`
6. **Process substitution** — `<(…)`, `>(…)`
7. **Word splitting** — on `$IFS` (default `" \t\n"`)
8. **Globbing** — `*`, `?`, `[…]`, `[!…]`, `[[:class:]]`, `**` with `globstar`, dotfiles hidden unless pattern starts with `.` or `dotglob`
9. **Quote removal**

### Builtins
`cd`, `echo`, `printf`, `pwd`, `true`, `false`, `:`, `exit`, `return`, `export`, `unset`, `readonly`, `local`, `declare`/`typeset`, `set`, `shopt`, `shift`, `read`, `test`/`[`, `eval`, `source`/`.`, `exec` (redirections only), `command`, `type`, `which`, `hash`, `basename`

### Utilities (24)
| Utility | Key Options |
|---------|-------------|
| `cat` | `-n -b -s -E -T -A -v` |
| `ls` | `-a -A -l -h -1 -R -d -F -p -r -t -S -X -U` |
| `mkdir` | `-p -v -m` |
| `rm` | `-r -f -v -d` |
| `mv` | `-f -n -v -T -t DIR` |
| `dirname` | multiple args, `-z` |
| `head` | `-n N`, `-c N`, `-q -v`, legacy `-NUM` |
| `tail` | `-n N`, `-c N`, `-q -v`, legacy `-NUM` |
| `wc` | `-l -w -c -m -L` |
| `nl` | `-b a\|t\|n\|pREGEX`, `-n ln\|rn\|rz`, `-w N`, `-s SEP` |
| `sort` | `-r -n -g -h -V -M -f -b -d -u -s -c -C -o -t -k` |
| `uniq` | `-c -d -D -u -i -f N -s N -w N` |
| `cut` | `-b -c -f` with list syntax, `-d`, `-s`, `--complement` |
| `grep` | `-E -F -G -P -i -v -w -x -c -l -L -n -h -H -o -q -s -r -R -m -A -B -C -e -f` |
| `rg` | recursive, `.gitignore`/`.ignore` support, `-i -S -v -w -x -F -n -l -c -o -A -B -C -m -g -t/-T` |
| `find` | `-name -type -size -empty -mtime -maxdepth -print -delete -exec … \;` |
| `sed` | `-n -e -f -E -i -s -z`, addresses, `s///`, `d p n y///` `b t :` etc. |
| `awk` | `-F -v -f`, full POSIX awk + gawk extras (`BEGIN/END`, arrays, `getline`, `printf`, redirections) |
| `diff` | Myers O(ND), `-u/-U -c/-C -q -r -N -i -w -b --label` |
| `patch` | unified/context/normal, `-pN -R -N --dry-run -o -b -F` |
| `date` | `+FORMAT` (strftime), `-u`, `-d STRING`, `-I`, `-R`, `--rfc-3339`, `-r FILE` |
| `echo` / `printf` / `cd` | (builtins) |

---

## Error Handling & Exit Codes

| Situation | Message (stderr) | Exit |
|-----------|------------------|------|
| unknown command | `bash: foo: command not found` | 127 |
| syntax error | `bash: syntax error near unexpected token 'x'` | 2 |
| bad option | `ls: invalid option -- 'z'` | 2 (ls/grep/diff) or 1 |
| missing file | `cat: x: No such file or directory` | 1 |
| redirection to missing dir | `bash: d/f: No such file or directory` | 1 |
| unsupported feature | `bash: <feature>: not supported by bash.js` | 2 |
| host callback throws | `<cmd>: <path>: <host message>` | 1 |
| abort signal | stops between commands | 130 |

Internal JS bugs are caught, reported as `bash.js: internal error: …`, and return exit 70 — `exec()` never rejects unless `strict: true`.

---

## Design Decisions

1. **Async everywhere** — host callbacks may be async (IndexedDB, remote FS), so the interpreter is `async`; `exec` returns a Promise.
2. **Buffered pipelines** — simpler and deterministic; no infinite producers, `head` cannot terminate upstream early (acceptable because inputs are finite).
3. **Text-only data** — content treated as UTF-8 strings; `wc -c`/`head -c`/`cut -b` operate on UTF-8 byte offsets via `TextEncoder`.
4. **Directory creation via `write(path, null, {type:'dir'})`** — keeps host contract to 4 functions.
5. **GNU behavior is the reference** (not BSD/macOS) for options and messages.
6. **`&` background jobs** run synchronously (documented limitation).
7. **Locale** is `C`/`POSIX` for sorting and character classes.
8. **No `eval` of JS / no `Function()`** — safe on untrusted command strings; only side effects are via supplied callbacks.

---

## Testing

The project includes a test suite in `test/` using Node's built-in `node:test` (zero dependencies).

```bash
# Run all tests
node --test test/
```

`BashJS.memfs()` provides an in-memory FS adapter shipped inside `bash.js` so tests and demos need no setup.

---

## Disclaimer

This library was developed using AI.

---

## License

MIT — see `LICENSE` file.
