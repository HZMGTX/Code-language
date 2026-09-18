/** `std/json` — JSON encoding and decoding, mapped onto Lumen values. */

import { NIL, bool, list, map, num, str, suggest, type Value, typeName } from '@lumen-lang/core';
import { Err, Ok, arg, expectNum, expectStr, fn, moduleOf, withDocs, withSignatures } from './support.js';

/** Convert parsed JSON into Lumen values. */
function fromJson(input: unknown): Value {
  if (input === null || input === undefined) return NIL;
  if (typeof input === 'boolean') return bool(input);
  if (typeof input === 'number') return num(input);
  if (typeof input === 'string') return str(input);
  if (Array.isArray(input)) return list(input.map((item) => fromJson(item)));
  if (typeof input === 'object') {
    const entries = new Map<string, Value>();
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      entries.set(key, fromJson(value));
    }
    return map(entries);
  }
  return NIL;
}

/**
 * Convert Lumen values into JSON-ready data.
 *
 * Structs become objects. Enums become their variant name when they carry
 * nothing, and `{"variant": ..., "values": [...]}` when they do. Functions have
 * no JSON form.
 *
 * `Option` is the one exception, and it is worth the exception: `Some(v)`
 * becomes `v` and `None` becomes `null`. An optional field is the single most
 * common thing in a JSON document, JSON already has a way to spell it, and the
 * tagged form does not read as one —
 *
 *     {"nickname": {"variant": "Some", "values": ["addy"]}}
 *     {"nickname": "addy"}
 *
 * — so every consumer of an API built this way would have to unwrap it by hand.
 * `Option` maps onto a concept JSON has; `Result` does not, and keeps the tagged
 * form. There is no agreed JSON shape for "succeeded or failed" — some APIs use
 * a status code, some an `error` key, some a wrapper — and unlike `Option`, both
 * arms of a `Result` carry something the reader has to tell apart, so collapsing
 * it would lose what matters rather than what does not.
 *
 * The cost is that `Some(nil)` and `None` both become `null`. That is JSON's
 * limit rather than this function's: there is no second null to map the other
 * one to.
 */
/**
 * Thrown when a value contains itself.
 *
 * JSON has no way to write a cycle — there is no syntax for "the object we are
 * already inside" — so unlike `clone` and `==`, which were taught to cope, this
 * one has to refuse. It carries the path to where the cycle closes, because
 * "somewhere in this structure" is not an answer anybody can act on.
 */
class CyclicValue extends Error {
  constructor(readonly path: string) {
    super('cyclic value at ' + path);
  }
}

/**
 * Thrown when a number has no JSON form.
 *
 * `Infinity` and `NaN` are ordinary Lumen values — the spec says overflow to
 * `Infinity` is not an error — and JSON has no way to write either. Carrying
 * the path means the answer is "the total overflowed" rather than "something in
 * here did".
 */
class Unwritable extends Error {
  constructor(readonly path: string, readonly what: string) {
    super(what + ' at ' + path);
  }
}

export function toJson(value: Value, open = new Set<Value>(), at = '$'): unknown {
  if (open.has(value)) throw new CyclicValue(at);
  switch (value.k) {
    case 'nil':
      return null;
    case 'num':
      // JSON has no `Infinity` and no `NaN`, and `JSON.stringify` writes `null`
      // for both without a word. `null` is the worst possible substitute: it is
      // how JSON spells *absent*, so an overflowed total is not merely lost —
      // it comes back looking like a field nobody filled in, and every check
      // for a missing value now says yes. The language already treats an
      // overflow as worth saying out loud (`RT046`), and this module already
      // refuses a value with no JSON form; a number with no JSON form is the
      // same thing.
      if (!Number.isFinite(value.v)) throw new Unwritable(at, String(value.v));
      return value.v;
    case 'bool':
    case 'str':
      return value.v;
    case 'list':
      open.add(value);
      try {
        return value.items.map((item, i) => toJson(item, open, at + '[' + String(i) + ']'));
      } finally {
        open.delete(value);
      }
    case 'map':
    case 'struct': {
      const source = value.k === 'map' ? value.entries : value.fields;
      // `Object.create(null)`, not `{}`: assigning to `out.__proto__` on an
      // ordinary object sets the prototype instead of storing a key, so a map
      // with that key came back from `stringify` silently missing it.
      const out = Object.create(null) as Record<string, unknown>;
      open.add(value);
      try {
        for (const [key, item] of source) out[key] = toJson(item, open, at + '.' + key);
      } finally {
        open.delete(value);
      }
      return out;
    }
    case 'enum':
      // The variant names are checked too, not just the enum's: somebody's own
      // `enum Option { A, B }` should keep the tagged form, and somebody's own
      // `enum Option { Some(Num), None }` wants this one anyway.
      if (value.enumName === 'Option' && (value.variant === 'Some' || value.variant === 'None')) {
        if (value.variant === 'None') return null;
        open.add(value);
        try {
          return toJson(value.values[0] ?? NIL, open, at);
        } finally {
          open.delete(value);
        }
      }
      if (value.values.length === 0) return value.variant;
      open.add(value);
      try {
        return {
          variant: value.variant,
          values: value.values.map((v, i) => toJson(v, open, at + '.' + value.variant + '[' + String(i) + ']')),
        };
      } finally {
        open.delete(value);
      }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- locating

/**
 * Where the text stops being JSON, as an offset and a sentence.
 *
 * This runs **only** after `JSON.parse` has already refused the text, which is
 * what makes it safe: nothing it does can affect a document that parses, and
 * the worst a bug in it can do is produce a vaguer message. That is why it is a
 * second scan rather than a replacement — a hand-written parser good enough to
 * *accept* every valid document (surrogate pairs, `__proto__` keys, the exact
 * rounding of every number) is a much harder thing than one good enough to find
 * the first place an invalid one goes wrong, and the host already does the
 * first perfectly well.
 *
 * The position is worked out here rather than read out of the host's message
 * because V8 rewords those between releases: `JSON.parse("{")` is "Unexpected
 * end of JSON input" on one Node and "Expected property name or '}' in JSON at
 * position 1" on another. A Lumen program's output must not depend on which
 * Node happens to be running it — which is the reason the message used to be
 * four words, and is not a reason to say nothing.
 */
interface Wrong {
  readonly at: number;
  readonly message: string;
}

/** Deep enough that no real document reaches it, shallow enough not to. */
const MAX_DEPTH = 400;

function locate(text: string): Wrong | undefined {
  let i = 0;

  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
  const here = (message: string): Wrong => ({ at: i, message });

  const space = (): void => {
    // JSON's whitespace is exactly these four. A vertical tab or a form feed is
    // not whitespace here, which is a thing files do have in them.
    while (i < text.length) {
      const c = text[i] as string;
      if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') return;
      i += 1;
    }
  };

  function value(depth: number): Wrong | undefined {
    if (depth > MAX_DEPTH) return here('nested more than ' + String(MAX_DEPTH) + ' deep');
    space();
    if (i >= text.length) return here('the text ends where a value should be');
    const c = text[i] as string;
    if (c === '{') return object(depth);
    if (c === '[') return array(depth);
    if (c === '"') return string_();
    if (c === '-' || isDigit(c)) return number_();
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return undefined;
      }
    }
    // The commonest three by a distance, each worth naming.
    if (text.startsWith('True', i) || text.startsWith('False', i) || text.startsWith('None', i)) {
      return here('JSON writes these in lower case, and `None` is `null`');
    }
    if (c === "'") return here('JSON has no single-quoted strings');
    if (c === 'N' || c === 'I' || (c === '+' && isDigit(text[i + 1]))) {
      return here('JSON has no `NaN`, `Infinity` or leading `+`');
    }
    if (c === '.') return here('a number needs a digit before the decimal point');
    // A bare word is somebody's unquoted key, or a half-typed literal. Naming
    // the whole word beats naming its first letter, and the language already
    // suggests the nearest name everywhere else it can.
    if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 32))?.[0] ?? c;
      const near = suggest(word, ['true', 'false', 'null']);
      return here(
        '`' + word + '` is not a value JSON knows' +
          (near === undefined ? ' — a key or a word has to be in double quotes' : ' — did you mean `' + near + '`?'),
      );
    }
    return here('expected a value, found ' + show(c));
  }

  function object(depth: number): Wrong | undefined {
    const opened = i;
    i += 1;
    space();
    if (text[i] === '}') {
      i += 1;
      return undefined;
    }
    for (;;) {
      space();
      if (i >= text.length) return { at: opened, message: 'this `{` is never closed' };
      if (text[i] !== '"') {
        if (text[i] === '}') return here('a trailing comma: JSON has no comma before `}`');
        // An unquoted key is what JavaScript, YAML and every configuration
        // format allow, so it is the mistake people bring with them. Naming the
        // key beats naming its first letter.
        const bare = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i, i + 32))?.[0];
        if (bare !== undefined) return here('the key `' + bare + '` needs double quotes around it');
        return here('expected a key in double quotes, found ' + show(text[i]));
      }
      const key = string_();
      if (key !== undefined) return key;
      space();
      if (text[i] !== ':') {
        return i >= text.length
          ? { at: opened, message: 'this `{` is never closed' }
          : here('expected `:` after the key, found ' + show(text[i]));
      }
      i += 1;
      const held = value(depth + 1);
      if (held !== undefined) return held;
      space();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return undefined;
      }
      if (i >= text.length) return { at: opened, message: 'this `{` is never closed' };
      return here('expected `,` or `}`, found ' + show(text[i]));
    }
  }

  function array(depth: number): Wrong | undefined {
    const opened = i;
    i += 1;
    space();
    if (text[i] === ']') {
      i += 1;
      return undefined;
    }
    for (;;) {
      space();
      if (text[i] === ']') return here('a trailing comma: JSON has no comma before `]`');
      const held = value(depth + 1);
      if (held !== undefined) return held;
      space();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') {
        i += 1;
        return undefined;
      }
      if (i >= text.length) return { at: opened, message: 'this `[` is never closed' };
      return here('expected `,` or `]`, found ' + show(text[i]));
    }
  }

  function string_(): Wrong | undefined {
    const opened = i;
    i += 1;
    for (;;) {
      if (i >= text.length) return { at: opened, message: 'this `"` is never closed' };
      const c = text[i] as string;
      if (c === '"') {
        i += 1;
        return undefined;
      }
      if (c === '\\') {
        const slash = i;
        i += 1;
        if (i >= text.length) return { at: opened, message: 'this `"` is never closed' };
        const escape = text[i] as string;
        if (escape === 'u') {
          for (let k = 1; k <= 4; k += 1) {
            const digit = text[i + k];
            if (digit === undefined || !/[0-9a-fA-F]/.test(digit)) {
              return { at: slash, message: '`\\u` needs four hex digits after it' };
            }
          }
          i += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) {
          return { at: slash, message: show('\\' + escape) + ' is not an escape JSON knows' };
        }
        i += 1;
        continue;
      }
      if (c < ' ') {
        return here('a control character has to be escaped inside a string');
      }
      i += 1;
    }
  }

  function number_(): Wrong | undefined {
    const started = i;
    if (text[i] === '-') i += 1;
    if (text[i] === '0') {
      i += 1;
      if (isDigit(text[i])) return { at: started, message: 'a number may not start with `0`' };
    } else if (isDigit(text[i])) {
      while (isDigit(text[i])) i += 1;
    } else {
      return { at: started, message: 'this number has no digits' };
    }
    if (text[i] === '.') {
      i += 1;
      if (!isDigit(text[i])) return here('a decimal point needs a digit after it');
      while (isDigit(text[i])) i += 1;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i += 1;
      if (text[i] === '+' || text[i] === '-') i += 1;
      if (!isDigit(text[i])) return here('an exponent needs a digit after it');
      while (isDigit(text[i])) i += 1;
    }
    return undefined;
  }

  const problem = value(0);
  if (problem !== undefined) return problem;
  space();
  if (i < text.length) {
    return here('the document ended here, and then there was ' + show(text[i]));
  }
  return undefined;
}

/** One character as it should appear in a message. */
function show(c: string | undefined): string {
  if (c === undefined) return 'the end of the text';
  const named: Record<string, string> = {
    '\n': '`\\n`', '\r': '`\\r`', '\t': '`\\t`', '\0': '`\\0`',
  };
  return named[c] ?? (c < ' ' ? 'a control character' : '`' + c + '`');
}

/**
 * The locator alone, so a test can check it against the host's own parser.
 *
 * The property that matters is the one a fuzz test can state: `locate` finds a
 * problem exactly when `JSON.parse` refuses the text. A locator that is too
 * strict would report a position in a document that parses — which nobody would
 * ever see, because it only runs after a failure, and which would still mean it
 * had stopped describing JSON.
 */
export function locateJsonErrorForTesting(text: string): { at: number; message: string } | undefined {
  return locate(text);
}

/** A message naming where the text stops being JSON, in the module's own words. */
function invalidJson(text: string): string {
  if (text.trim() === '') return 'invalid JSON: there is nothing here to read';
  const wrong = locate(text);
  // The two disagreeing is possible in principle — they are different code —
  // and the honest answer to that is the old one rather than a guess.
  if (wrong === undefined) return 'invalid JSON';
  const before = text.slice(0, wrong.at);
  // The column is counted in **code points**, because that is what a character
  // is everywhere else here — `std/str.len` and `slice`, and the `at` a regex
  // match reports. Counting the host's UTF-16 units instead put the column one
  // past the mark for every emoji earlier on the line, which is the same
  // off-by-one three other functions had and is no better for being in a
  // message rather than in a return value.
  const line = before.split('\n').length;
  const column = [...before.slice(before.lastIndexOf('\n') + 1)].length + 1;
  return 'invalid JSON at line ' + String(line) + ', column ' + String(column) + ': ' + wrong.message;
}

/**
 * Parsing is never a silent failure, which is what `Result` says here: `parse`
 * answers `Ok(value)` or `Err(message)`. `stringify` can fail too — a cyclic
 * value has no JSON — but it panics rather than answering, so it is a `Str`.
 */
const SIGNATURES: Readonly<Record<string, string>> = {
  parse: '(text: Str) -> Result',
  stringify: '(value: Any, indent: Num = 0) -> Str',
};

export function stdJson(): Map<string, Value> {
  return withSignatures(
    withDocs(
    moduleOf(
    /** Returns `Ok(value)` or `Err(message)` — parsing is never a silent failure. */
    fn('parse', ['text'], (a, c) => {
      const text = expectStr(arg(a, 0), c, 'parse(text)');
      try {
        return Ok(fromJson(JSON.parse(text)));
      } catch {
        // Our own wording *and* our own position. The wording, because V8
        // rewrites its JSON errors between Node releases and a Lumen program's
        // output must not depend on which Node is running it. The position,
        // because "invalid JSON" about a file somebody else exported is not
        // something anybody can act on — and every other diagnostic in this
        // language says where.
        return Err(str(invalidJson(text)));
      }
    }),

    fn('stringify', ['value', { name: 'indent', defaultValue: num(0) }], (a, c) => {
      const indent = expectNum(arg(a, 1), c, 'stringify indent');
      let data: unknown;
      try {
        data = toJson(arg(a, 0));
      } catch (error) {
        if (error instanceof CyclicValue) {
          return c.panic('cannot convert a value that contains itself to JSON', [
            'the cycle closes at ' + error.path + ', where `$` is the value you passed',
            'JSON has no way to write "the value we are already inside"',
          ]);
        }
        if (error instanceof Unwritable) {
          return c.panic('cannot convert ' + error.what + ' to JSON', [
            'it is at ' + error.path + ', where `$` is the value you passed',
            'JSON has no way to write ' + error.what + ', and `null` would be a lie: ' +
              'it is how JSON spells a value that is not there',
            error.what === 'NaN'
              ? 'this usually means an earlier result was undefined'
              : 'this usually means an earlier result overflowed',
          ]);
        }
        throw error;
      }
      if (data === undefined) {
        return c.panic('cannot convert ' + typeName(arg(a, 0)) + ' to JSON');
      }
      return str(JSON.stringify(data, null, indent));
    }),
    ),
    {
      parse: 'JSON text as a value: `Ok(value)`, or `Err(message)` saying where it went wrong.',
      stringify: 'A value as JSON text, on one line unless an `indent` is given.',
    },
    ),
    SIGNATURES,
  );
}
