/**
 * A value that goes through a function and back must come back unchanged.
 *
 * The library is full of inverse pairs, and two of them were not inverses:
 *
 *   - `path.split` answers with a list and `path.join` took only loose strings,
 *     so `join(split(p))` — the obvious way to put a path back together — was a
 *     run-time error. Lumen has no spread at a call site, so there was no way
 *     around it either.
 *   - `time.parts` answers with a Map and `time.fromParts` took seven separate
 *     numbers, so the function whose *name* says it takes parts could not take
 *     them. The round-trip meant reading seven keys out by hand.
 *
 * Both were found by asking one question of the whole library at once rather
 * than of a function at a time, which is the only way this class shows up: each
 * half is perfectly reasonable alone.
 *
 * So the pairs are **derived from the library's own naming**, not listed. A
 * name beginning `from` or `parse` is a promise about another function's
 * output, and every such promise must be kept *and* have a case here — adding
 * `fromFoo` to the library fails this file until somebody round-trips it. A
 * guessed list is what let `sum([inf, -inf])` sit unnoticed in the NaN sweep.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { stdModuleExports } from '@lumen-lang/stdlib';

import { runSource } from '../support/harness.js';

/**
 * A `from`/`parse` name and the function whose output it claims to accept.
 *
 * `fromEntries` promises to take what `entries` gives; `parseIso` promises to
 * take what `iso` gives. The convention is the library's, and this is where it
 * stops being a convention and starts being checked.
 */
interface Pair {
  readonly module: string;
  /** The name that makes the promise — `fromParts`. */
  readonly inverse: string;
  /** The name it points at — `parts`. */
  readonly forward: string;
}

/** Every `from…`/`parse…` export, paired with the name it promises to accept. */
function derivePairs(): readonly Pair[] {
  const pairs: Pair[] = [];
  for (const [module, exports] of stdModuleExports()) {
    const names = new Set(exports.keys());
    for (const name of names) {
      const suffix = /^(?:from|parse)(.+)$/.exec(name)?.[1];
      if (suffix === undefined) continue;
      // `fromParts` -> `parts`, `parseIso` -> `iso`.
      const forward = suffix.charAt(0).toLowerCase() + suffix.slice(1);
      if (!names.has(forward)) continue;
      pairs.push({ module, inverse: name, forward });
    }
  }
  return pairs;
}

/**
 * One round-trip per pair: source that prints `ok` when the value survives.
 *
 * Written in Lumen rather than against the natives, because the point is the
 * call a program actually makes — `join(split(p))` failed on how it was
 * *called*, which is invisible from inside the implementation.
 */
const TRIPS: Readonly<Record<string, string>> = {
  'std/map fromEntries': `
    import { entries, fromEntries } from "std/map"
    let cases = [{ a: 1, b: 2 }, { "": 1 }, { "a\\nb": 1, "🎉": 2 }, {}]
    for m in cases {
      if fromEntries(entries(m)) != m { print("FAILED \${m}") }
    }
    print("ok")
  `,
  'std/time fromParts': `
    import { parts, fromParts } from "std/time"
    // The epoch, a recent instant, year one and the last millisecond of 9999.
    for t in [0, 1700000000000, -62135596800000, 253402300799999] {
      if fromParts(parts(t)) != t { print("FAILED \${t}") }
    }
    print("ok")
  `,
  'std/time parseIso': `
    import { iso, parseIso } from "std/time"
    for t in [0, 1700000000000, -62135596800000, 253402300799999] {
      match parseIso(iso(t)) {
        Ok(back) => { if back != t { print("FAILED \${t} -> \${iso(t)} -> \${back}") } }
        Err(why) => print("FAILED \${t}: \${why}")
      }
    }
    print("ok")
  `,
};

describe('a value survives a round trip through an inverse pair', () => {
  const pairs = derivePairs();

  it('finds the pairs the library names', () => {
    // The derivation itself is worth pinning: a rename that broke the
    // convention would otherwise make this whole file quietly test nothing.
    assert.ok(pairs.length >= 3, 'derived only ' + pairs.length + ' pairs: ' + JSON.stringify(pairs));
    const keys = pairs.map((p) => p.module + ' ' + p.inverse).sort();
    assert.deepEqual(keys, ['std/map fromEntries', 'std/time fromParts', 'std/time parseIso']);
  });

  it('has a case for every pair the library names', () => {
    // The half that keeps this from stalling: a new `fromFoo` has to be
    // round-tripped here before the suite goes green again.
    const missing = pairs
      .map((p) => p.module + ' ' + p.inverse)
      .filter((key) => !(key in TRIPS));
    assert.deepEqual(missing, [], 'no round-trip case for: ' + missing.join(', '));
  });

  for (const [name, source] of Object.entries(TRIPS)) {
    it(name + ' accepts what its counterpart gives', async () => {
      const result = await runSource(source.trim() + '\n');
      assert.equal(result.failed, false, result.output);
      assert.equal(result.output.trim(), 'ok', result.output);
    });
  }
});

/**
 * The pairs the naming rule cannot see, because the two halves share no stem.
 *
 * `split`/`join` and `stringify`/`parse` are inverses by meaning rather than by
 * name, so they are listed — but listed *here*, apart from the derived set, so
 * it stays obvious which half of this file is a convention being enforced and
 * which is a judgement somebody made.
 */
describe('the inverse pairs whose names do not say so', () => {
  it('path: join takes what split gives', async () => {
    const result = await runSource(
      `
      import { join, split, normalize } from "std/path"
      // The absolute cases are the ones that were wrong twice over: \`split\`
      // yields "/" as its first piece, and joining onto it doubled the
      // separator — and \`//abs/x\` is not \`/abs/x\`, it is the UNC share \`x\`
      // on the server \`abs\`.
      for p in ["a/b/c.txt", "/abs/x.tar.gz", "/a/b/c/d", "a/../b", ".", "/", "🎉/y.md", "a//b", "/one"] {
        let back = join(split(p))
        if back != normalize(p) { print("FAILED \${p} -> \${split(p)} -> \${back}") }
      }
      print("ok")
    `.trim() + '\n',
    );
    assert.equal(result.failed, false, result.output);
    assert.equal(result.output.trim(), 'ok', result.output);
  });

  it('path: resolve takes what relative gives', async () => {
    // `resolve(base, relative(base, target))` must be `normalize(target)`. It
    // was not for the commonest base of all: `normalize(".")` is `"."`, and
    // counting that single dot as a directory made `relative(".", "docs/x")`
    // climb out of a directory nobody had entered — `"../docs/x"` — which then
    // resolved to the same wrong place, so the pair agreed with each other and
    // with nothing else.
    const result = await runSource(
      `
      import { relative, resolve, normalize } from "std/path"
      let bases = [".", "./", "", "a", "a/b", "/a/b", "/", "a/b/c"]
      let targets = ["x", "docs/spec.md", "a/b/c/d", "/a/c/d", "/x", "a", "."]
      for base in bases {
        for target in targets {
          // Only where a relative path can connect the two at all: an absolute
          // base and a relative target have no such path, and relative answers
          // with the target itself, which resolve then reads against the base.
          // The pair is documented not to be an inverse there.
          if base.startsWith("/") != target.startsWith("/") { continue }
          let back = resolve(base, relative(base, target))
          if back != normalize(target) {
            print("FAILED \${base} -> \${target}: \${relative(base, target)} resolved to \${back}, not \${normalize(target)}")
          }
        }
      }
      print("ok")
    `.trim() + '\n',
    );
    assert.equal(result.failed, false, result.output);
    assert.equal(result.output.trim(), 'ok', result.output);
  });

  it('time: parseIso takes what iso gives, at every year the module accepts', async () => {
    // `iso` wrote `-0044`, which is not ISO 8601 — the standard reserves a
    // leading sign for the *expanded* form, six digits wide — and the module's
    // own `parseIso` refused it. A value could be printed and not read back.
    const result = await runSource(
      `
      import { fromParts, iso, parseIso, startOfDay, parts } from "std/time"
      let years = [0 - 44, 0 - 1, 0, 1, 50, 99, 100, 1970, 2024, 9999, 10000, 12345]
      for y in years {
        let t = fromParts(y, 3, 1, 13, 45, 0)
        match parseIso(iso(t)) {
          Ok(back) => { if back != t { print("FAILED \${y}: \${iso(t)} read back as \${iso(back)}") } }
          Err(why) => print("FAILED \${y}: \${iso(t)} -> \${why}")
        }
        // And the day's start is the same day, which the host's two-digit-year
        // rule broke for every year from 0 to 99 — by nineteen centuries.
        let midnight = startOfDay(t)
        if parts(midnight).year != y { print("FAILED startOfDay \${y}: \${iso(midnight)}") }
        if parts(midnight).day != 1 { print("FAILED startOfDay day \${y}: \${iso(midnight)}") }
      }
      print("ok")
    `.trim() + '\n',
    );
    assert.equal(result.failed, false, result.output);
    assert.equal(result.output.trim(), 'ok', result.output);
  });

  it('json: parse takes what stringify gives', async () => {
    const result = await runSource(
      `
      import { parse, stringify } from "std/json"
      let cases = [
        "", "plain", "with \\"quote\\"", "with\\nnewline", "🎉", "a\\\\b",
        0, 1, -1, 0.5, 1000000, 9007199254740991,
        true, false, nil,
        [1, "two", [3], { a: 1 }],
        { "": 1, "a\\nb": 2, "🎉": 3 },
      ]
      for v in cases {
        match parse(stringify(v)) {
          Ok(back) => { if back != v { print("FAILED \${v} -> \${stringify(v)} -> \${back}") } }
          Err(why) => print("FAILED \${v}: \${why}")
        }
      }
      print("ok")
    `.trim() + '\n',
    );
    assert.equal(result.failed, false, result.output);
    assert.equal(result.output.trim(), 'ok', result.output);
  });

  it('csv: rows takes what write gives', async () => {
    const result = await runSource(
      `
      import { rows, write } from "std/csv"
      let awkward = [
        "", " ", "plain", "with,comma", "with\\"quote", "with\\nnewline",
        "  padded  ", "\\"quoted\\"", "🎉", "; semi", "\\\\back",
      ]
      var grids = []
      for value in awkward {
        grids.push([value, "after"])
        // A row of one field as well. A row that is one empty field is the
        // shape that did not survive: written plainly it is a blank line, and
        // a blank line reads back as no row at all — so a two-row table came
        // back with one, through the module's own writer.
        grids.push([value])
      }
      for row in grids {
        match write([row]) {
          Ok(text) => {
            match rows(text) {
              Ok(back) => { if back != [row] { print("FAILED \${row}: \${text} -> \${back}") } }
              Err(why) => print("FAILED read \${row}: \${why}")
            }
          }
          Err(why) => print("FAILED write \${row}: \${why}")
        }
      }
      print("ok")
    `.trim() + '\n',
    );
    assert.equal(result.failed, false, result.output);
    assert.equal(result.output.trim(), 'ok', result.output);
  });

  it('csv: records takes what writeRecords gives', async () => {
    const result = await runSource(
      `
      import { records, writeRecords } from "std/csv"
      let sets = [
        [{ name: "Ada", note: "first" }, { name: "Bo", note: "second" }],
        [{ "odd,name": "x", "with\\"quote": "y" }],
        [{ name: "", note: "" }],
      ]
      for given in sets {
        match writeRecords(given) {
          Ok(text) => {
            match records(text) {
              Ok(back) => { if back != given { print("FAILED \${given} -> \${text} -> \${back}") } }
              Err(why) => print("FAILED read: \${why}")
            }
          }
          Err(why) => print("FAILED write: \${why}")
        }
      }
      print("ok")
    `.trim() + '\n',
    );
    assert.equal(result.failed, false, result.output);
    assert.equal(result.output.trim(), 'ok', result.output);
  });

  it('regex: an escaped literal is found, at position zero, as itself', async () => {
    const result = await runSource(
      `
      import { escape, find } from "std/regex"
      let literals = ["a.b", "a*b", "[x]", "(y)", "a|b", "^s$", "a\\\\b", "{1,2}", "a+b", "🎉", "a-b", "#c", "a?b"]
      for lit in literals {
        match find(lit, escape(lit)) {
          Ok(Some(m)) => {
            if m.text != lit or m.at != 0 { print("FAILED \${lit}: found \${m.text} at \${m.at}") }
          }
          Ok(None) => print("FAILED \${lit}: escape(\${escape(lit)}) does not match it"),
          Err(why) => print("FAILED \${lit}: \${why}")
        }
      }
      print("ok")
    `.trim() + '\n',
    );
    assert.equal(result.failed, false, result.output);
    assert.equal(result.output.trim(), 'ok', result.output);
  });

  it('str: a split text rejoins, and its characters rejoin', async () => {
    const result = await runSource(
      `
      import { split, chars } from "std/str"
      import { join } from "std/list"
      for text in ["", "a", "a,b", ",", "a,,b", ",a,", "🎉,x", "a\\nb"] {
        if join(split(text, ","), ",") != text { print("FAILED split \${text}") }
        if join(chars(text), "") != text { print("FAILED chars \${text}") }
      }
      print("ok")
    `.trim() + '\n',
    );
    assert.equal(result.failed, false, result.output);
    assert.equal(result.output.trim(), 'ok', result.output);
  });
});
