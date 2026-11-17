'use strict';
// Shell-language behaviour that golden cases cannot express: state kept
// across exec() calls, safety limits, and the session API.
const test = require('node:test');
const assert = require('node:assert/strict');
const BashJS = require('../bash.js');

function session(options) {
  const fs = BashJS.memfs({ '/w': { type: 'dir', entries: [] } });
  return BashJS.create(Object.assign({ read: fs.read, write: fs.write, delete: fs.delete, move: fs.move, cwd: '/w' }, options || {}));
}

test('functions, arrays and options persist across exec() calls', async () => {
  const sh = session();
  await sh.exec('greet() { echo "hi $1 $(echo from-subst)"; }; arr=(a b c); set -o pipefail');
  assert.equal((await sh.exec('greet you; echo ${#arr[@]}')).stdout, 'hi you from-subst\n3\n');
  assert.equal((await sh.exec('x=$(greet sub); echo "[$x]"')).stdout, '[hi sub from-subst]\n');
  assert.equal((await sh.exec('false | true')).exitCode, 1);
});

test('subshells, pipeline stages and command substitutions see functions but do not leak state', async () => {
  const sh = session();
  const r = await sh.exec('f() { echo f; }; out=$(f); (g() { :; }; arr=(1)); type -t g; echo "$out ${#arr[@]}"');
  assert.equal(r.stdout, 'f 0\n');
  assert.equal(r.exitCode, 0);
});

test('positional parameters come from the args option and setPositional()', async () => {
  const sh = session({ args: ['one', 'two words'] });
  assert.equal((await sh.exec('echo $# "$2"')).stdout, '2 two words\n');
  sh.setPositional(['x']);
  assert.equal((await sh.exec('echo "$@"; shift; echo $#')).stdout, 'x\n0\n');
  // `shift` in the previous call changed the session's parameters.
  assert.deepEqual(sh.getPositional(), []);
});

test('runaway loops and recursion stop with an error instead of hanging', async () => {
  const sh = session({ maxLoopIterations: 1000 });
  const loop = await sh.exec('while true; do :; done; echo unreachable');
  assert.match(loop.stderr, /loop iteration limit \(1000\) exceeded/);
  assert.equal(loop.stdout, '');
  const deep = await session({ maxCallDepth: 50 }).exec('f() { f; }; f; echo after');
  assert.match(deep.stderr, /maximum function nesting level exceeded \(50\)/);
  assert.equal(deep.stdout, 'after\n');
});

test('quoted multi-element expansions produce one field each', async () => {
  const sh = session();
  const r = await sh.exec('a=(x "y z"); declare -A m=([k1]=1 [k2]=2); set -- p q r; printf "<%s>" "${a[@]}" "${!m[@]}" "${@:2}" "${a[@]/y/Y}"; echo');
  assert.equal(r.stdout, '<x><y z><k1><k2><q><r><x><Y z>\n');
});

test('exit inside a function ends the script; return only leaves the function', async () => {
  const sh = session();
  assert.equal((await sh.exec('f() { return 3; echo no; }; f; echo "rc=$?"')).stdout, 'rc=3\n');
  const r = await sh.exec('f() { exit 4; }; f; echo no');
  assert.equal(r.stdout, '');
  assert.equal(r.exitCode, 4);
});
