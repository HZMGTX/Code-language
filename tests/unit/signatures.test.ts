/**
 * The standard library's declared types, against the functions they describe.
 *
 * A signature is a second statement of something the implementation already
 * says — the parameter list — and two statements of one fact drift. A signature
 * whose parameter names do not match is worse than none at all: a named
 * argument would stop being checked, silently, and nothing would notice.
 *
 * So every signature is checked against the native it belongs to, for the same
 * names in the same order and the same parameters being optional. Nothing here
 * asserts *which* types are declared — that is a judgement, and `types.test`
 * and the conformance fixtures are where it is exercised — only that a
 * signature describes the function it is attached to.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parse, signatureTy, type NativeValue, type ParamTy, type Value } from '@lumen-lang/core';
import { STD_MODULES, stdMethodSignatures, stdSignatures } from '@lumen-lang/stdlib';

/** Every native in the library, with the path it is reached by. */
function everyNative(): { where: string; value: NativeValue }[] {
  const found: { where: string; value: NativeValue }[] = [];
  for (const [moduleName, factory] of STD_MODULES) {
    for (const [name, value] of factory()) {
      if (value.k === 'native') found.push({ where: moduleName + '.' + name, value });
    }
  }
  return found;
}

describe('standard library signatures', () => {
  const natives = everyNative();

  it('finds natives to check', () => {
    assert.ok(natives.length > 150, 'expected the whole library, got ' + natives.length);
  });

  /**
   * Every parameter name is one a Lumen program could have written.
   *
   * The library is written in TypeScript, so nothing stops it naming a
   * parameter `from` — and `std/str.replace` did, which is a keyword. A
   * program can pass it by name (the parser is lenient about a keyword before
   * a `:` in a call) but could never declare the function it belongs to, so
   * the library had a parameter that could not have been written in the
   * language the library is for. This is the general form of that bug.
   */
  it('names its parameters in the language it is for', () => {
    for (const { where, value } of natives) {
      for (const param of value.params) {
        assert.doesNotThrow(
          () => parse('fn __check(' + param.name + ') {}', '<check>'),
          where + ' has a parameter named `' + param.name + '`, which is not an identifier',
        );
      }
    }
  });

  it('every signature parses', () => {
    // A signature that does not parse is a build failure rather than a function
    // that quietly stops being checked, which is the point of parsing them with
    // the real parser instead of a notation of their own.
    for (const { where, value } of natives) {
      if (value.signature === undefined) continue;
      assert.doesNotThrow(() => signatureTy(value.signature ?? ''), where + ': ' + value.signature);
    }
  });

  it('names the same parameters the implementation does', () => {
    for (const { where, value } of natives) {
      if (value.signature === undefined) continue;
      const ty = signatureTy(value.signature);
      assert.equal(ty.k, 'fn', where);
      const declared = (ty as { params: readonly ParamTy[] }).params;
      assert.deepEqual(
        declared.map((p) => p.name),
        value.params.map((p) => p.name),
        where + ' declares ' + value.signature + ' but takes (' +
          value.params.map((p) => p.name).join(', ') + ')',
      );
    }
  });

  it('agrees about which parameters may be left out', () => {
    for (const { where, value } of natives) {
      if (value.signature === undefined) continue;
      const declared = (signatureTy(value.signature) as { params: readonly ParamTy[] }).params;
      assert.deepEqual(
        declared.map((p) => p.optional),
        value.params.map((p) => p.defaultValue !== undefined),
        where + ' disagrees with its signature about which parameters are optional',
      );
    }
  });

  /**
   * Coverage, as a number that may only go up.
   *
   * Not a demand that everything be typed — `map(xs, f)` has nothing useful to
   * say without type variables, and forcing a signature onto it would be worse
   * than leaving it alone. This is here so the work cannot silently stall, and
   * so removing a signature is a decision somebody has to make on purpose.
   */
  it('types most of the library', () => {
    const typed = natives.filter((n) => n.value.signature !== undefined).length;
    assert.ok(
      typed >= 170,
      'only ' + typed + ' of ' + natives.length + ' natives carry a signature',
    );
  });

  it('exposes the maps the checker is given', () => {
    const globals = stdSignatures();
    const methods = stdMethodSignatures();
    assert.ok(globals.size > 0, 'no global signatures');
    assert.ok(methods.size > 0, 'no method signatures');

    // A method's receiver is already supplied, so its type has one parameter
    // fewer than the function it comes from. Getting this wrong would check
    // every argument of every method call against the wrong parameter.
    const upper = methods.get('Str.upper');
    assert.ok(upper !== undefined && upper.k === 'fn', 'Str.upper has no type');
    assert.equal(upper.params.length, 0);

    const split = methods.get('Str.split');
    assert.ok(split !== undefined && split.k === 'fn', 'Str.split has no type');
    assert.deepEqual(
      split.params.map((p) => p.name),
      ['separator'],
    );
  });

  it('keeps a method and the function it comes from in step', () => {
    // `"a,b".split(",")` and `split("a,b", ",")` are the same call (§4.7), so
    // the method's parameters must be the function's without the first.
    const globals = stdSignatures();
    const methods = stdMethodSignatures();
    for (const [key, method] of methods) {
      const [, name] = key.split('.');
      const whole = globals.get(name ?? '');
      if (whole === undefined || whole.k !== 'fn' || method.k !== 'fn') continue;
      assert.deepEqual(
        method.params.map((p) => p.name),
        whole.params.slice(1).map((p) => p.name),
        key + ' and the global `' + String(name) + '` disagree',
      );
    }
  });
});

/** Kept so the import of `Value` is used, and the file states what it walks. */
void (undefined as Value | undefined);
