/** Interpreter unit tests: semantics that the golden fixtures cannot assert directly. */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runSource } from '../support/harness.js';

/** Run a snippet and return its trimmed output. */
async function out(source: string): Promise<string> {
  const result = await runSource(source);
  assert.equal(result.failed, false, 'expected success but got:\n' + result.output);
  return result.output.trimEnd();
}

/** Run a snippet expected to fail, returning the diagnostic code. */
async function code(source: string): Promise<string> {
  const result = await runSource(source);
  assert.equal(result.failed, true, 'expected failure but got:\n' + result.output);
  const match = /error\[([A-Z]{2}\d{3})\]/.exec(result.output);
  return match?.[1] ?? '(none)';
}

describe('truthiness', () => {
  it('treats only nil and false as falsy', async () => {
    assert.equal(await out('print(if 0 { "t" } else { "f" })'), 't');
    assert.equal(await out('print(if "" { "t" } else { "f" })'), 't');
    assert.equal(await out('print(if [] { "t" } else { "f" })'), 't');
    assert.equal(await out('print(if nil { "t" } else { "f" })'), 'f');
    assert.equal(await out('print(if false { "t" } else { "f" })'), 'f');
  });
});

describe('scoping', () => {
  it('closes over a mutable variable by reference', async () => {
    const source = `
fn counter() {
  var n = 0
  fn() { n += 1
    n }
}
let c = counter()
print("\${c()}\${c()}\${c()}")`;
    assert.equal(await out(source), '123');
  });

  it('gives each closure its own captured state', async () => {
    const source = `
fn counter() { var n = 0
  fn() { n += 1
    n } }
let a = counter()
let b = counter()
a()
a()
print("\${a()} \${b()}")`;
    assert.equal(await out(source), '3 1');
  });

  it('shadows an outer binding without changing it', async () => {
    assert.equal(await out('let x = "out"\nfn f() { let x = "in"\n x }\nprint("${f()} ${x}")'), 'in out');
  });

  it('refuses to assign to a let binding, before the program runs', async () => {
    // RS005 is the resolver's static check. The interpreter still enforces the
    // same rule (RT029) as a backstop for any path that reaches it without
    // being resolved first, such as a host embedding the interpreter directly.
    assert.equal(await code('let a = 1\na = 2'), 'RS005');
  });

  it('allows assignment to a var binding', async () => {
    assert.equal(await out('var a = 1\na = 2\nprint(a)'), '2');
  });
});

describe('functions', () => {
  it('hoists declarations so order does not matter', async () => {
    assert.equal(await out('print(f())\nfn f() { "ok" }'), 'ok');
  });

  it('calls main automatically when one is declared', async () => {
    assert.equal(await out('fn main() { print("ran") }'), 'ran');
  });

  it('runs top-level statements before main', async () => {
    assert.equal(await out('print("top")\nfn main() { print("main") }'), 'top\nmain');
  });

  it('fills parameters from defaults and named arguments', async () => {
    const source = 'fn g(a, b = 2, c = 3) { "${a}${b}${c}" }\nprint(g(1))\nprint(g(1, 9))\nprint(g(1, c: 9))';
    assert.equal(await out(source), '123\n193\n129');
  });

  it('rejects a positional argument after a named one', async () => {
    assert.equal(await code('fn g(a, b) { a }\ng(a: 1, 2)'), 'RT037');
  });

  it('names the parameter when one is supplied twice', async () => {
    assert.equal(await code('fn g(a) { a }\ng(1, a: 2)'), 'RT044');
  });
});

describe('error propagation', () => {
  it('unwraps Ok and returns Err from the enclosing function', async () => {
    const source = `
fn inner(ok) { if ok { Ok(1) } else { Err("no") } }
fn outer(ok) { let v = inner(ok)?
  Ok(v + 1) }
print(outer(true))
print(outer(false))`;
    assert.equal(await out(source), 'Ok(2)\nErr("no")');
  });

  it('works the same way for Option', async () => {
    const source = `
fn inner(some) { if some { Some(1) } else { None } }
fn outer(some) { let v = inner(some)?
  Some(v + 1) }
print(outer(true))
print(outer(false))`;
    assert.equal(await out(source), 'Some(2)\nNone');
  });

  it('rejects ? on something that is neither Result nor Option', async () => {
    assert.equal(await code('fn f() { let a = 1?\n  Ok(a) }\nf()'), 'RT010');
  });
});

describe('pipelines', () => {
  it('passes the left value as the first argument', async () => {
    assert.equal(await out('fn sub(a, b) { a - b }\nprint(10 |> sub(3))'), '7');
  });

  it('calls a bare function reference', async () => {
    assert.equal(await out('fn dbl(n) { n * 2 }\nprint(4 |> dbl)'), '8');
  });
});

describe('collections', () => {
  it('mutates a list in place through an index', async () => {
    assert.equal(await out('var xs = [1, 2]\nxs[0] = 9\nprint(xs)'), '[9, 2]');
  });

  it('supports negative indices', async () => {
    assert.equal(await out('print([1, 2, 3][-1])'), '3');
  });

  it('errors on an out-of-range index rather than yielding nil', async () => {
    assert.equal(await code('print([1][4])'), 'RT022');
  });

  it('yields nil for a missing map key', async () => {
    assert.equal(await out('print({ a: 1 }["b"])'), 'nil');
  });

  it('compares collections structurally', async () => {
    assert.equal(await out('print([1, [2]] == [1, [2]])'), 'true');
  });

  it('renders a self-referencing list without looping forever', async () => {
    assert.equal(await out('var xs = [1]\nxs[0] = xs\nprint(xs)'), '[[...]]');
  });
});

describe('arithmetic guards', () => {
  it('rejects division by zero instead of yielding Infinity', async () => {
    assert.equal(await code('print(1 / 0)'), 'RT018');
  });

  it('rejects adding mismatched types', async () => {
    assert.equal(await code('print("a" + 1)'), 'RT016');
  });

  it('caps the size of a materialised range', async () => {
    assert.equal(await code('let r = 0..999999999'), 'RT008');
  });
});

describe('modules', () => {
  it('reports an unknown module', async () => {
    assert.equal(await code('import { x } from "std/nope"'), 'RT042');
  });

  it('reports a missing export with a suggestion', async () => {
    const result = await runSource('import { fliter } from "std/list"');
    assert.match(result.output, /did you mean `filter`/);
  });
});
