/**
 * Method-call syntax and the expanded prelude.
 *
 * The rule under test throughout: because every standard-library function takes
 * its subject first, `x.f(a)`, `f(x, a)` and `x |> f(a)` are three spellings of
 * one thing. These tests pin the parts of that claim which the golden fixtures
 * cannot express — argument binding, shadowing, and error wording.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runSource } from '../support/harness.js';

async function out(source: string, stdin: readonly string[] = []): Promise<string> {
  const result = await runSource(source, 'fixture.lm', stdin);
  assert.equal(result.failed, false, 'expected success but got:\n' + result.output);
  return result.output.trimEnd();
}

async function failure(source: string): Promise<string> {
  const result = await runSource(source);
  assert.equal(result.failed, true, 'expected failure but got:\n' + result.output);
  return result.output;
}

describe('method calls are ordinary calls', () => {
  it('agrees with the plain call and the pipeline', async () => {
    const source = `
import { upper } from "std/str"
print("hi".upper() == upper("hi"))
print(("hi" |> upper()) == upper("hi"))`;
    assert.equal(await out(source), 'true\ntrue');
  });

  it('passes further arguments after the receiver', async () => {
    assert.equal(await out('print("a-b-c".replace("-", "+"))'), 'a+b+c');
  });

  it('accepts named arguments for the remaining parameters', async () => {
    assert.equal(await out('print("a,b".split(separator: ","))'), '["a", "b"]');
  });

  it('honours defaults of the remaining parameters', async () => {
    // padStart(s, width, fill = " ") — fill is omitted here.
    assert.equal(await out('print("7".padStart(3))'), '  7');
  });

  it('drops the receiver from the reported signature', async () => {
    // The error should complain about `separator`, never about the subject `s`.
    const text = await failure('print("a,b".split())');
    assert.match(text, /missing a value for `separator`/);
    assert.doesNotMatch(text, /`s`/);
  });

  it('reports an unknown method', async () => {
    const text = await failure('print([1].nope())');
    assert.match(text, /List has no method `nope`/);
  });

  it('lists the alternatives when nothing is close enough to suggest', async () => {
    const text = await failure('print([1].xyzzy())');
    assert.match(text, /List has no method `xyzzy`/);
    assert.match(text, /available on List:/);
    assert.match(text, /filter/);
  });

  it('suggests a near miss', async () => {
    const text = await failure('print("a".uppr())');
    assert.match(text, /did you mean `upper`/);
  });

  it('chains, because each call returns an ordinary value', async () => {
    assert.equal(
      await out('print("  A B  ".trim().lower().split(" ").join("-"))'),
      'a-b',
    );
  });

  it('works on a value reached through a struct field', async () => {
    const source = `
struct Bag { items: List }
let b = Bag { items: [3, 1, 2] }
print(b.items.sorted())`;
    assert.equal(await out(source), '[1, 2, 3]');
  });

  it('works on a function result without a temporary', async () => {
    assert.equal(await out('fn make() { [2, 1] }\nprint(make().sorted())'), '[1, 2]');
  });
});

describe('maps keep their own keys', () => {
  it('prefers a real key over a method of the same name', async () => {
    assert.equal(await out('print({ keys: "mine" }.keys)'), 'mine');
  });

  it('still exposes the method when no such key exists', async () => {
    assert.equal(await out('print({ a: 1 }.keys())'), '["a"]');
  });

  it('still returns nil for a key that is neither', async () => {
    assert.equal(await out('print({ a: 1 }.somethingElse)'), 'nil');
  });

  it('lets a shadowed method still be reached through the module', async () => {
    const source = `
import { keys } from "std/map"
let m = { keys: "mine" }
print(m.keys)
print(keys(m))`;
    assert.equal(await out(source), 'mine\n["keys"]');
  });
});

describe('the prelude needs no import', () => {
  it('provides sequence helpers', async () => {
    assert.equal(await out('print([1,2,3].map(fn(n){n*2}).sum())'), '12');
    assert.equal(await out('print(sorted([3,1,2]))'), '[1, 2, 3]');
    assert.equal(await out('print(zip([1],["a"]))'), '[[1, "a"]]');
  });

  it('provides range in all three forms', async () => {
    assert.equal(await out('print(range(3))'), '[0, 1, 2]');
    assert.equal(await out('print(range(1, 4))'), '[1, 2, 3]');
    assert.equal(await out('print(range(4, 0, -2))'), '[4, 2]');
  });

  it('rejects a zero step rather than looping forever', async () => {
    assert.match(await failure('range(0, 5, 0)'), /step cannot be 0/);
  });

  it('caps an enormous range instead of exhausting memory', async () => {
    assert.match(await failure('range(999999999)'), /too large/);
  });

  it('accepts min and max in both Python spellings', async () => {
    assert.equal(await out('print(min([4,2,8]))'), '2');
    assert.equal(await out('print(min(4,2,8))'), '2');
    assert.equal(await out('print(max([4,2,8]))'), '8');
    assert.equal(await out('print(max(4,2,8))'), '8');
  });

  it('rejects min of nothing with an explanation', async () => {
    assert.match(await failure('min()'), /needs at least one value/);
  });

  it('does not shadow a user binding of the same name', async () => {
    assert.equal(await out('fn sum(xs) { "mine" }\nprint(sum([1,2]))'), 'mine');
  });
});

describe('input', () => {
  it('reads a line as Some', async () => {
    const source = `
match input("name? ") {
  Some(n) => print("hi \${n}"),
  None    => print("none"),
}`;
    assert.equal(await out(source, ['Ada']), 'name? hi Ada');
  });

  it('reports end of input as None', async () => {
    const source = `
match input("name? ") {
  Some(n) => print("hi \${n}"),
  None    => print("none"),
}`;
    assert.equal(await out(source, []), 'name? none');
  });
});

describe('help', () => {
  it('lists the prelude and the modules', async () => {
    const text = await out('help()');
    assert.match(text, /Available everywhere, with no import/);
    assert.match(text, /range/);
    assert.match(text, /std\/list/);
  });

  it('describes a value and the methods available on it', async () => {
    const text = await out('help("abc")');
    assert.match(text, /Str: "abc"/);
    assert.match(text, /methods you can call on it/);
    assert.match(text, /upper/);
  });

  it('describes a function with its signature and documentation', async () => {
    const text = await out('help(range)');
    assert.match(text, /range\(start, end = \.\.\., step = \.\.\.\)/);
    assert.match(text, /A list of numbers/);
  });

  it('describes a method with the receiver already dropped', async () => {
    const text = await out('help("a,b".split)');
    assert.match(text, /split\(separator\)/);
    assert.doesNotMatch(text, /split\(s,/);
  });

  it('lists a module by name', async () => {
    const text = await out('help("std/math")');
    assert.match(text, /std\/math/);
    assert.match(text, /sqrt/);
  });
});
