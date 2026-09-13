/**
 * The Lumen runtime value model.
 *
 * Values are plain tagged objects rather than classes so they are cheap to
 * create and easy to pattern-match in TypeScript. `k` is the tag.
 *
 * Truthiness is deliberately narrow: only `nil` and `false` are falsy. Zero and
 * the empty string are true, which removes the whole family of bugs that come
 * from `if (0)` and `if ("")` behaving surprisingly.
 */

import type { Block, Param } from './ast.js';
import type { Span } from './diagnostics.js';

export type Value =
  | NilValue
  | BoolValue
  | NumValue
  | StrValue
  | ListValue
  | MapValue
  | StructValue
  | EnumValue
  | FnValue
  | NativeValue
  | ModuleValue
  | StructTypeValue
  | EnumTypeValue;

export interface NilValue {
  readonly k: 'nil';
}
export interface BoolValue {
  readonly k: 'bool';
  readonly v: boolean;
}
export interface NumValue {
  readonly k: 'num';
  readonly v: number;
}
export interface StrValue {
  readonly k: 'str';
  readonly v: string;
}

/** Lists are mutable in place; `items` is intentionally not readonly. */
export interface ListValue {
  readonly k: 'list';
  readonly items: Value[];
}

/** Maps have string keys. Insertion order is preserved. */
export interface MapValue {
  readonly k: 'map';
  readonly entries: Map<string, Value>;
}

export interface StructValue {
  readonly k: 'struct';
  readonly typeName: string;
  readonly fields: Map<string, Value>;
}

export interface EnumValue {
  readonly k: 'enum';
  readonly enumName: string;
  readonly variant: string;
  readonly values: readonly Value[];
}

/** The file a piece of code came from, kept so errors point at the right source. */
export interface SourceUnit {
  readonly file: string;
  readonly source: string;
}

/**
 * A closure over Lumen source. It carries its defining `unit` so that a runtime
 * error raised inside a function imported from another file is rendered against
 * that file, not against whoever happened to call it.
 */
export interface FnValue {
  readonly k: 'fn';
  readonly name: string;
  readonly params: readonly Param[];
  readonly body: Block;
  readonly closure: Env;
  readonly unit: SourceUnit;
}

export interface NativeParam {
  readonly name: string;
  /** When present, the parameter may be omitted and takes this value. */
  readonly defaultValue?: Value;
}

/** Context handed to every native function. */
export interface CallCtx {
  readonly host: Host;
  /** Where the call appears in source, for error reporting. */
  readonly span: Span;
  /** Invoke a Lumen value (closure or native) from inside a native. */
  call(fn: Value, args: readonly Value[]): Promise<Value>;
  /** Abort with a runtime error located at this call. */
  panic(message: string, notes?: readonly string[]): never;
}

/** A function implemented in the host language. */
export interface NativeValue {
  readonly k: 'native';
  readonly name: string;
  readonly params: readonly NativeParam[];
  /** One-line description, shown by `help()`. */
  readonly doc?: string;
  /** When true, surplus positional arguments are collected into a list. */
  readonly variadic?: boolean;
  call(args: readonly Value[], ctx: CallCtx): Value | Promise<Value>;
}

export interface ModuleValue {
  readonly k: 'module';
  readonly name: string;
  readonly exports: ReadonlyMap<string, Value>;
}

/** The value bound by `struct Task { .. }` — used to build and validate literals. */
export interface StructTypeValue {
  readonly k: 'structType';
  readonly name: string;
  readonly fieldNames: readonly string[];
}

/** The value bound by `enum Status { .. }` — `Status.Done` reads a variant off it. */
export interface EnumTypeValue {
  readonly k: 'enumType';
  readonly name: string;
  /** Variant name to payload arity. */
  readonly variants: ReadonlyMap<string, number>;
}

// ------------------------------------------------------------- constructors

export const NIL: NilValue = { k: 'nil' };
export const TRUE: BoolValue = { k: 'bool', v: true };
export const FALSE: BoolValue = { k: 'bool', v: false };

export const bool = (v: boolean): BoolValue => (v ? TRUE : FALSE);
export const num = (v: number): NumValue => ({ k: 'num', v });
export const str = (v: string): StrValue => ({ k: 'str', v });
export const list = (items: Value[]): ListValue => ({ k: 'list', items });
export const map = (entries: Map<string, Value>): MapValue => ({ k: 'map', entries });

export const enumValue = (
  enumName: string,
  variant: string,
  values: readonly Value[] = [],
): EnumValue => ({ k: 'enum', enumName, variant, values });

export const ok = (v: Value): EnumValue => enumValue('Result', 'Ok', [v]);
export const err = (v: Value): EnumValue => enumValue('Result', 'Err', [v]);
export const some = (v: Value): EnumValue => enumValue('Option', 'Some', [v]);
export const NONE: EnumValue = enumValue('Option', 'None', []);

/** True unless the value is `nil` or `false`. */
export function truthy(v: Value): boolean {
  if (v.k === 'nil') return false;
  if (v.k === 'bool') return v.v;
  return true;
}

/** The name Lumen uses for a value's type, as seen by `type(x)`. */
export function typeName(v: Value): string {
  switch (v.k) {
    case 'nil':
      return 'Nil';
    case 'bool':
      return 'Bool';
    case 'num':
      return 'Num';
    case 'str':
      return 'Str';
    case 'list':
      return 'List';
    case 'map':
      return 'Map';
    case 'struct':
      return v.typeName;
    case 'enum':
      return v.enumName;
    case 'fn':
    case 'native':
      return 'Fn';
    case 'module':
      return 'Module';
    case 'structType':
    case 'enumType':
      return 'Type';
  }
}

/** Structural equality. Functions and modules compare by identity. */
export function valuesEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'nil':
      return true;
    case 'bool':
      return a.v === (b as BoolValue).v;
    case 'num':
      return a.v === (b as NumValue).v;
    case 'str':
      return a.v === (b as StrValue).v;
    case 'list': {
      const other = b as ListValue;
      if (a.items.length !== other.items.length) return false;
      return a.items.every((item, i) => {
        const rhs = other.items[i];
        return rhs !== undefined && valuesEqual(item, rhs);
      });
    }
    case 'map': {
      const other = b as MapValue;
      if (a.entries.size !== other.entries.size) return false;
      for (const [key, value] of a.entries) {
        const rhs = other.entries.get(key);
        if (rhs === undefined || !valuesEqual(value, rhs)) return false;
      }
      return true;
    }
    case 'struct': {
      const other = b as StructValue;
      if (a.typeName !== other.typeName || a.fields.size !== other.fields.size) return false;
      for (const [key, value] of a.fields) {
        const rhs = other.fields.get(key);
        if (rhs === undefined || !valuesEqual(value, rhs)) return false;
      }
      return true;
    }
    case 'enum': {
      const other = b as EnumValue;
      if (a.enumName !== other.enumName || a.variant !== other.variant) return false;
      if (a.values.length !== other.values.length) return false;
      return a.values.every((value, i) => {
        const rhs = other.values[i];
        return rhs !== undefined && valuesEqual(value, rhs);
      });
    }
    default:
      return false;
  }
}

/** Format a number the way Lumen prints it: integers without a trailing `.0`. */
function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Number.POSITIVE_INFINITY) return 'Infinity';
  if (n === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

function quote(s: string): string {
  return JSON.stringify(s);
}

/**
 * Rendering for `print`: strings appear raw, everything else structurally.
 * Nested strings inside a collection are still quoted, so `[1, "a"]` is
 * unambiguous.
 */
export function display(v: Value): string {
  return v.k === 'str' ? v.v : inspect(v);
}

/** Enums whose constructors are global, and so print without a qualifier. */
const PRELUDE_ENUMS: ReadonlySet<string> = new Set(['Result', 'Option']);

/** Rendering for the REPL and for values nested inside collections. */
export function inspect(v: Value, seen = new Set<unknown>()): string {
  switch (v.k) {
    case 'nil':
      return 'nil';
    case 'bool':
      return v.v ? 'true' : 'false';
    case 'num':
      return formatNumber(v.v);
    case 'str':
      return quote(v.v);
    case 'list': {
      if (seen.has(v)) return '[...]';
      seen.add(v);
      const body = v.items.map((item) => inspect(item, seen)).join(', ');
      seen.delete(v);
      return '[' + body + ']';
    }
    case 'map': {
      if (seen.has(v)) return '{...}';
      seen.add(v);
      const body = [...v.entries]
        .map(([key, value]) => key + ': ' + inspect(value, seen))
        .join(', ');
      seen.delete(v);
      return '{' + body + '}';
    }
    case 'struct': {
      if (seen.has(v)) return v.typeName + ' {...}';
      seen.add(v);
      const body = [...v.fields]
        .map(([key, value]) => key + ': ' + inspect(value, seen))
        .join(', ');
      seen.delete(v);
      return v.typeName + ' {' + body + '}';
    }
    case 'enum': {
      // Print a value the way you would write it. `Ok`, `Err`, `Some` and
      // `None` are in the prelude so they need no qualifier; every other
      // variant is written `Enum.Variant`, so that is how it renders.
      const prefix = PRELUDE_ENUMS.has(v.enumName) ? '' : v.enumName + '.';
      if (v.values.length === 0) return prefix + v.variant;
      const body = v.values.map((value) => inspect(value, seen)).join(', ');
      return prefix + v.variant + '(' + body + ')';
    }
    case 'fn':
      return '<fn ' + (v.name === '' ? 'anonymous' : v.name) + '>';
    case 'native':
      return '<native ' + v.name + '>';
    case 'module':
      return '<module ' + v.name + '>';
    case 'structType':
      return '<struct ' + v.name + '>';
    case 'enumType':
      return '<enum ' + v.name + '>';
  }
}

// ------------------------------------------------------------- environments

export interface Slot {
  value: Value;
  readonly mutable: boolean;
}

/** A lexical scope. Lookup walks the parent chain. */
export class Env {
  private readonly slots = new Map<string, Slot>();

  constructor(readonly parent?: Env) {}

  /** Declare in this scope. Redeclaring the same name shadows the old slot. */
  declare(name: string, value: Value, mutable: boolean): void {
    this.slots.set(name, { value, mutable });
  }

  lookup(name: string): Slot | undefined {
    let scope: Env | undefined = this;
    while (scope !== undefined) {
      const slot = scope.slots.get(name);
      if (slot !== undefined) return slot;
      scope = scope.parent;
    }
    return undefined;
  }

  /** Names visible from here, nearest scope first — used for "did you mean". */
  visibleNames(): string[] {
    const names: string[] = [];
    let scope: Env | undefined = this;
    while (scope !== undefined) {
      for (const key of scope.slots.keys()) names.push(key);
      scope = scope.parent;
    }
    return names;
  }

  ownNames(): string[] {
    return [...this.slots.keys()];
  }

  hasOwn(name: string): boolean {
    return this.slots.has(name);
  }
}

/**
 * Everything the interpreter needs from the outside world. `core` never imports
 * a host API directly; the CLI supplies this, which is what keeps the language
 * portable to a browser later.
 */
export interface Host {
  writeOut(text: string): void;
  writeErr(text: string): void;
  /** Environment variables, for things like AI provider keys. */
  getEnv(name: string): string | undefined;
  now(): number;
  /**
   * Read one line from the console, without its trailing newline, or undefined
   * at end of input. Optional: a host with no console (a browser, a build step)
   * simply omits it, and `input()` reports that rather than hanging.
   */
  readLine?(prompt: string): Promise<string | undefined>;
}

// ------------------------------------------------------------------ helpers

/**
 * Levenshtein distance, capped for speed. Used only to suggest a name the user
 * probably meant.
 */
export function editDistance(a: string, b: string): number {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr: number[] = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/** The closest candidate to `name`, if any is close enough to be worth showing. */
export function suggest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  const limit = Math.max(2, Math.floor(name.length / 2));
  for (const candidate of candidates) {
    const score = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore && score <= limit) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
