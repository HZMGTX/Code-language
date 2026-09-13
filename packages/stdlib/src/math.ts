/** `std/math` — numeric helpers and constants. */

import { num, str, type Value } from '@lumen-lang/core';
import { arg, expectNum, fn, moduleOf } from './support.js';

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

    fn('min', ['a', 'b'], (a, c) =>
      num(Math.min(expectNum(arg(a, 0), c, 'min a'), expectNum(arg(a, 1), c, 'min b'))),
    ),

    fn('max', ['a', 'b'], (a, c) =>
      num(Math.max(expectNum(arg(a, 0), c, 'max a'), expectNum(arg(a, 1), c, 'max b'))),
    ),

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
    fn('random', [], () => num(Math.random())),
  );

  exports.set('PI', num(Math.PI));
  exports.set('E', num(Math.E));
  return exports;
}
