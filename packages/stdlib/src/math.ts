/** `std/math` — numeric helpers and constants. */

import { num, type Value } from '@lumen-lang/core';
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

    fn('pow', ['base', 'exponent'], (a, c) =>
      num(Math.pow(expectNum(arg(a, 0), c, 'pow base'), expectNum(arg(a, 1), c, 'pow exponent'))),
    ),

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

    /** Uniform in `[0, 1)`. Not cryptographically secure. */
    fn('random', [], () => num(Math.random())),
  );

  exports.set('PI', num(Math.PI));
  exports.set('E', num(Math.E));
  return exports;
}
