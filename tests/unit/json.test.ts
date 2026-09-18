/**
 * `std/json` — the error locator, checked against the parser it stands beside.
 *
 * `parse` uses the host's `JSON.parse` for the value and a second scan of its
 * own to say *where* an invalid document goes wrong. Two parsers describing one
 * grammar is a thing that drifts, and the drift would be invisible: the locator
 * only ever runs after a failure, so a locator that had quietly stopped
 * understanding JSON would still produce a plausible sentence about the wrong
 * place.
 *
 * So the property is checked directly, over a few hundred thousand generated
 * documents: **the locator finds a problem exactly when `JSON.parse` refuses
 * the text.** One direction catches a locator that has grown too strict — it
 * would be claiming a position in a document that parses — and the other
 * catches one that has grown too lax, which is how a message ends up pointing
 * past the real mistake.
 *
 * The generator is deterministic, so a failure is reproducible rather than
 * something that happens on somebody else's machine once.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { locateJsonErrorForTesting as locate } from '@lumen-lang/stdlib';

/**
 * The fragments documents are built from.
 *
 * Chosen to be *nearly* JSON: every piece is either a valid token or a
 * near-miss, so a random assembly of them lands on the boundary far more often
 * than random characters would. The interesting failures are one character out,
 * not one keyboard-mash out.
 */
const PIECES = [
  '{', '}', '[', ']', ',', ':',
  '"', '"a"', '"b"', '"\\n"', '"\\u00e9"', '"\\uZZ"', '"\\',
  '1', '0', '01', '-', '-1', '1.5', '1e3', '1e', '.5', '+1',
  'true', 'false', 'null', 'True', 'None', 'nul', 'NaN', 'Infinity',
  ' ', '\n', '\t', '\\', "'", 'e', '+', '.',
  // Built rather than written as source escapes, so no formatter can normalise
  // them away and no raw control byte ends up in this file: a control character
  // inside a string is invalid JSON, and is the kind of thing a real file has.
  String.fromCharCode(0),
  String.fromCharCode(7),
  '"' + String.fromCharCode(1) + '"',
];

/** A generator with no hidden state, so a failing case can be run again. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe('std/json error locator', () => {
  it('agrees with the host parser about what is JSON', () => {
    const random = generator(12345);
    const disagreements: string[] = [];
    let valid = 0;

    for (let n = 0; n < 200000; n += 1) {
      const parts: string[] = [];
      const length = 1 + Math.floor(random() * 8);
      for (let k = 0; k < length; k += 1) {
        parts.push(PIECES[Math.floor(random() * PIECES.length)] as string);
      }
      const text = parts.join('');

      let parses = true;
      try {
        JSON.parse(text);
      } catch {
        parses = false;
      }
      if (parses) valid += 1;

      const found = locate(text);
      if (parses !== (found === undefined) && disagreements.length < 5) {
        disagreements.push(
          JSON.stringify(text) + ': host ' + (parses ? 'accepted' : 'refused') +
            ', locator ' + (found === undefined ? 'found nothing' : 'said ' + found.message),
        );
      }
    }

    assert.deepEqual(disagreements, []);
    // If the generator stopped producing valid documents the first assertion
    // would pass for the wrong reason, so the test also checks it is still
    // exercising both answers.
    assert.ok(valid > 1000, 'only ' + String(valid) + ' of 200000 were valid JSON');
  });

  it('finds nothing wrong with a document that parses', () => {
    // The shapes a hand-written scanner gets wrong: escapes, surrogate pairs,
    // an exponent's sign, a negative zero, whitespace in every legal place, and
    // the one key that is special to JavaScript objects rather than to JSON.
    const valid = [
      '{}', '[]', 'null', 'true', 'false', '0', '-0', '1e3', '1E+3', '1.5e-3', '-1.5', '1e-3',
      '"\\u00e9"', '"\\ud83c\\udf89"', '"\\"\\\\\\/\\b\\f\\n\\r\\t"', '"é🎉"',
      '[1,[2,[3,[4]]]]', '{"a":{"b":{"c":1}}}', '  {"a" : [ 1 , 2 ] }  ',
      '{"__proto__":1}', '[{"a":[]},{"b":{}}]', '{"":""}', '[0,-0,1e0]',
      '\t\n\r {"a":\t1}\r\n ',
    ];
    for (const text of valid) {
      JSON.parse(text); // if this throws, the test's own list is wrong
      assert.equal(locate(text), undefined, 'reported a problem in valid JSON: ' + text);
    }
  });

  it('points at the opening bracket of something never closed', () => {
    // Not at the end of the text, which is where the host points. The `{` is
    // the thing you have to go and look at; the end of the file is where you
    // already are.
    assert.equal(locate('{"a": 1')?.at, 0);
    assert.equal(locate('[1, [2, 3]')?.at, 0);
    assert.equal(locate('"never closed')?.at, 0);

    // The other direction, and the reason "never closed" is not the answer to
    // everything: `[1, 2}` is not an unclosed bracket, it is a wrong character,
    // and the wrong character is what to point at.
    const mismatched = locate('{"a": [1, 2}');
    assert.equal(mismatched?.at, 11);
    assert.match(mismatched?.message ?? '', /expected `,` or `\]`/);
  });

  it('survives a document nested past any reasonable depth', () => {
    // A hand-written recursive scanner is a stack overflow waiting to happen,
    // and this one runs on input that has *already* been refused — which is
    // exactly the input somebody hostile controls.
    const deep = '['.repeat(50000);
    const found = locate(deep);
    assert.ok(found !== undefined, 'found nothing wrong with 50000 open brackets');
    assert.match(found.message, /nested more than/);
  });
});
