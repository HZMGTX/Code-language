/** `std/math` — numeric helpers and constants. */

import {
  NIL,
  list,
  num,
  str,
  typeName,
  type CallCtx,
  type NativeValue,
  type Value,
} from '@lumen-lang/core';
import { None, Some, arg, expectInt, expectList, expectNum, fn, moduleOf, withSignatures } from './support.js';

/**
 * Reduce over either a single list or the arguments themselves, so that both
 * `min([3, 1, 2])` and `min(3, 1, 2)` work — Python accepts both, and guessing
 * wrong about which one a beginner meant is a bad first experience.
 *
 * This lives here, in the module the functions belong to, and the prelude takes
 * it from here. It used to live in the prelude with `std/math` keeping a
 * narrower pair of its own, which is the one thing the prelude's own header
 * says must not happen: "so there is one implementation, not two".
 */
function extremum(which: 'min' | 'max') {
  return (args: readonly Value[], ctx: CallCtx): Value => {
    const first = args[0] ?? NIL;
    const items = args.length === 1 && first.k === 'list' ? first.items : args;
    if (items.length === 0) {
      return ctx.panic(which + '() needs at least one value', [
        'it takes either a list, as ' + which + '([1, 2, 3]), or several numbers',
      ]);
    }
    let best: number | undefined;
    for (const item of items) {
      if (item.k !== 'num') {
        return ctx.panic(which + '() needs Nums, found ' + typeName(item));
      }
      if (best === undefined) best = item.v;
      else best = which === 'min' ? Math.min(best, item.v) : Math.max(best, item.v);
    }
    return num(best ?? 0);
  };
}

/** A native that takes any number of arguments, and so declares no signature. */
function variadicFn(
  name: string,
  doc: string,
  call: (args: readonly Value[], ctx: CallCtx) => Value,
): NativeValue {
  return { k: 'native', name, params: [], variadic: true, doc, call };
}

/**
 * Every function's type. `Num` throughout, which is the whole of this module.
 *
 * `randomInt` and `fixed` are the only ones that answer with something else,
 * and `fixed` is the reason `n.fixed(2)` reads as text: it is a rendering, not
 * a rounding.
 */
const SIGNATURES: Readonly<Record<string, string>> = {
  abs: '(n: Num) -> Num',
  floor: '(n: Num) -> Num',
  ceil: '(n: Num) -> Num',
  round: '(n: Num) -> Num',
  trunc: '(n: Num) -> Num',
  sign: '(n: Num) -> Num',
  sin: '(n: Num) -> Num',
  cos: '(n: Num) -> Num',
  tan: '(n: Num) -> Num',
  exp: '(n: Num) -> Num',
  asin: '(n: Num) -> Num',
  acos: '(n: Num) -> Num',
  atan: '(n: Num) -> Num',
  cbrt: '(n: Num) -> Num',
  sqrt: '(n: Num) -> Num',
  atan2: '(y: Num, x: Num) -> Num',
  hypot: '(a: Num, b: Num) -> Num',
  gcd: '(a: Num, b: Num) -> Num',
  lcm: '(a: Num, b: Num) -> Num',
  log: '(n: Num, base: Num = 2.718281828459045) -> Num',
  pow: '(base: Num, exponent: Num) -> Num',
  clamp: '(n: Num, low: Num, high: Num) -> Num',
  fixed: '(n: Num, places: Num = 2) -> Str',
  random: '() -> Num',
  randomInt: '(low: Num, high: Num) -> Num',
  seed: '(value: Num) -> Nil',
  shuffle: '(xs: List) -> List',
  choice: '(xs: List) -> Option',
};

/**
 * The generator behind `random`, so a program can make itself reproducible.
 *
 * `undefined` means `Math.random`, which is what you want by default: a
 * language whose randomness is the same on every run by default is a language
 * where somebody ships a shuffle that always deals the same hand. Calling
 * `seed` replaces it, and there is deliberately no way to ask what the current
 * seed is — that would only ever be used to "restore" it, and a program that
 * needs two independent streams needs two generators, not one it keeps
 * winding back.
 *
 * Module-level rather than per-instance, because `stdMath()` is called once by
 * the interpreter factory and the seed must outlive the call that set it.
 */
let generator: (() => number) | undefined;

/**
 * mulberry32: 32 bits of state, a period of 2^32, and about ten operations.
 *
 * Not cryptographic, and nothing here claims otherwise — `seed` exists so a
 * test can be repeated and a demo can be the same twice, which wants
 * determinism and speed rather than unpredictability. Anyone choosing a nonce
 * with this deserves to be told plainly, so `docs/stdlib.md` says so too.
 *
 * Chosen over the obvious `(a * 1103515245 + 12345) % 2^31` because a linear
 * congruential generator's low bits cycle with a period of two or four, which
 * makes `randomInt(0, 1)` alternate — a bug that looks like randomness until
 * somebody plots it.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number in [0, 1), from the seeded generator or from the host. */
function nextRandom(): number {
  return generator === undefined ? Math.random() : generator();
}

export function stdMath(): Map<string, Value> {
  const unary = (name: string, op: (n: number) => number) =>
    fn(name, ['n'], (a, c) => num(op(expectNum(arg(a, 0), c, name + '(n)'))));

  const exports = moduleOf(
    unary('abs', Math.abs),
    unary('floor', Math.floor),
    unary('ceil', Math.ceil),
    unary('round', Math.round),
    unary('trunc', Math.trunc),
    unary('sign', Math.sign),
    unary('sin', Math.sin),
    unary('cos', Math.cos),
    unary('tan', Math.tan),
    unary('exp', Math.exp),
    unary('asin', Math.asin),
    unary('acos', Math.acos),
    unary('atan', Math.atan),
    // Defined for every real number, unlike `sqrt`: every number has one real
    // cube root, including the negative ones.
    unary('cbrt', Math.cbrt),

    /** The angle to the point (x, y), in radians, with the quadrant right. */
    fn('atan2', ['y', 'x'], (a, c) =>
      num(Math.atan2(expectNum(arg(a, 0), c, 'atan2(y)'), expectNum(arg(a, 1), c, 'atan2(x)'))),
    ),

    /** `sqrt(a*a + b*b)`, without the overflow that spelling can hit. */
    fn('hypot', ['a', 'b'], (a, c) =>
      num(Math.hypot(expectNum(arg(a, 0), c, 'hypot(a)'), expectNum(arg(a, 1), c, 'hypot(b)'))),
    ),

    /** The greatest common divisor of two whole numbers. Always positive. */
    fn('gcd', ['a', 'b'], (a, c) => {
      let x = Math.abs(expectInt(arg(a, 0), c, 'gcd(a)'));
      let y = Math.abs(expectInt(arg(a, 1), c, 'gcd(b)'));
      while (y !== 0) [x, y] = [y, x % y];
      return num(x);
    }),

    /** The least common multiple. `lcm(n, 0)` is 0, which is the convention. */
    fn('lcm', ['a', 'b'], (a, c) => {
      const x = Math.abs(expectInt(arg(a, 0), c, 'lcm(a)'));
      const y = Math.abs(expectInt(arg(a, 1), c, 'lcm(b)'));
      if (x === 0 || y === 0) return num(0);
      let g = x;
      let h = y;
      while (h !== 0) [g, h] = [h, g % h];
      return num((x / g) * y);
    }),

    fn('sqrt', ['n'], (a, c) => {
      const n = expectNum(arg(a, 0), c, 'sqrt(n)');
      if (n < 0) c.panic('sqrt of a negative number (' + n + ')');
      return num(Math.sqrt(n));
    }),

    fn('log', ['n', { name: 'base', defaultValue: num(Math.E) }], (a, c) => {
      const n = expectNum(arg(a, 0), c, 'log(n)');
      const base = expectNum(arg(a, 1), c, 'log base');
      if (n <= 0) c.panic('log needs a positive number, got ' + n);
      if (base <= 0 || base === 1) c.panic('log base must be positive and not 1, got ' + base);
      return num(Math.log(n) / Math.log(base));
    }),

    fn('pow', ['base', 'exponent'], (a, c) => {
      const base = expectNum(arg(a, 0), c, 'pow base');
      const exponent = expectNum(arg(a, 1), c, 'pow exponent');
      // A negative base with a fractional exponent has no real answer. IEEE
      // 754 says NaN; Lumen says so out loud, as `sqrt` and `log` already do.
      if (base < 0 && !Number.isInteger(exponent)) {
        return c.panic(
          'pow(' + base + ', ' + exponent + ') has no real answer',
          ['a negative base needs a whole-number exponent'],
        );
      }
      return num(Math.pow(base, exponent));
    }),

    // `min` and `max` are the prelude's, which the prelude takes from here —
    // one native, not two. They were two, with different contracts: this
    // module's took exactly two Nums and the prelude's takes a list *or* the
    // numbers themselves, so `max([3, 1, 4])` worked until somebody wrote
    // `import { sqrt, min, max } from "std/math"` and the narrower one took
    // over. A working program stopped compiling because of an import, and
    // `std/math` is exactly where a reader goes looking for `min`.
    //
    // A variadic carries no signature — see `withSignatures`, which refuses to
    // give one to one — precisely so the checker's argument-count rule can
    // never be wrong about them. The narrow pair had one, which is what made
    // the rule wrong.
    variadicFn('min', 'The smallest of a list, or of the numbers given.', extremum('min')),
    variadicFn('max', 'The largest of a list, or of the numbers given.', extremum('max')),

    fn('clamp', ['n', 'low', 'high'], (a, c) => {
      const n = expectNum(arg(a, 0), c, 'clamp n');
      const low = expectNum(arg(a, 1), c, 'clamp low');
      const high = expectNum(arg(a, 2), c, 'clamp high');
      if (low > high) c.panic('clamp low (' + low + ') is above high (' + high + ')');
      return num(Math.min(high, Math.max(low, n)));
    }),

    /**
     * A number as text with exactly `places` decimals — `£${fixed(4.5, 2)}`
     * gives `£4.50`.
     *
     * `round(n * 100) / 100` rounds the value but cannot make `3.5` print as
     * `3.50`, because the trailing zero is not part of the number. Money,
     * percentages and any column of figures need it, so this is the one piece
     * of number formatting worth having before a full format-specifier
     * syntax exists.
     */
    fn('fixed', ['n', { name: 'places', defaultValue: num(2) }], (a, c) => {
      const n = expectNum(arg(a, 0), c, 'fixed(n)');
      const places = expectNum(arg(a, 1), c, 'fixed places');
      if (!Number.isInteger(places) || places < 0 || places > 20) {
        return c.panic(
          'fixed needs a whole number of places from 0 to 20, got ' + places,
          ['that is the range a double can actually distinguish'],
        );
      }
      if (!Number.isFinite(n)) return str(String(n));
      return str(n.toFixed(places));
    }),

    /** Uniform in `[0, 1)`. Not cryptographically secure. */
    fn('random', [], () => num(nextRandom())),

    /**
     * Make every later `random` reproducible, from this seed.
     *
     * Without it there was no way to write a test over randomised input that
     * could be repeated when it failed, which is most of what randomised tests
     * are for. Seeding with the same number gives the same sequence on every
     * machine and every version of Node, because the generator is written here
     * rather than borrowed from the host.
     *
     * Not cryptographic. It is for repeatability, not for secrets.
     */
    fn('seed', ['value'], (a, c) => {
      generator = mulberry32(expectInt(arg(a, 0), c, 'seed(value)'));
      return NIL;
    }),

    /**
     * A whole number from `low` to `high`, both included.
     *
     * `floor(random() * n)` is the spelling everyone writes and half of them
     * get wrong at one end, so it is worth having written once.
     */
    fn('randomInt', ['low', 'high'], (a, c) => {
      const low = expectInt(arg(a, 0), c, 'randomInt(low)');
      const high = expectInt(arg(a, 1), c, 'randomInt(high)');
      if (low > high) return c.panic('randomInt low (' + low + ') is above high (' + high + ')');
      return num(low + Math.floor(nextRandom() * (high - low + 1)));
    }),

    /**
     * A shuffled copy. The original is untouched, as everywhere else here.
     *
     * Fisher-Yates, which is the one that is uniform. The spelling everybody
     * reaches for first — `sortBy(fn(_) { random() })` — is not: a comparison
     * sort asks about the same pair more than once and gets different answers,
     * so the result is biased in a way that is invisible without counting.
     */
    fn('shuffle', ['xs'], (a, c) => {
      const items = [...expectList(arg(a, 0), c, 'shuffle(xs)').items];
      for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(nextRandom() * (i + 1));
        const held = items[i] as Value;
        items[i] = items[j] as Value;
        items[j] = held;
      }
      return list(items);
    }),

    /** One element, or `None` for an empty list — there is nothing to pick. */
    fn('choice', ['xs'], (a, c) => {
      const items = expectList(arg(a, 0), c, 'choice(xs)').items;
      if (items.length === 0) return None;
      return Some(items[Math.floor(nextRandom() * items.length)] as Value);
    }),
  );

  exports.set('PI', num(Math.PI));
  exports.set('E', num(Math.E));
  exports.set('TAU', num(Math.PI * 2));
  // Not a literal anyone can write: `1e400` is a lexer error, and this is the
  // only way to name the value that comparisons against "no limit" want.
  exports.set('INFINITY', num(Infinity));
  return withSignatures(exports, SIGNATURES);
}
