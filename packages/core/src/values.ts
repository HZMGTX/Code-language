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
  /**
   * True when the parameters have no names a program could use — an enum
   * variant's payload, which is positional. Diagnostics then say how many
   * values are wanted rather than listing `field0, field1`, which is an
   * implementation detail nobody wrote and cannot act on.
   */
  readonly positional?: boolean;
  /**
   * Its type, written in Lumen's own annotation syntax: `'(s: Str) -> Str'`.
   *
   * A string rather than a `Ty`, so declaring one costs a standard-library
   * author nothing but the sentence they would write in the documentation
   * anyway, and so it is spelled in exactly the syntax a user writes. The
   * checker parses it with the real parser — see `signatureTy`.
   *
   * Optional, and absent means `Any`: the 204 natives can be typed one at a
   * time, and an untyped one is exactly as unchecked as it was before any of
   * them were typed.
   */
  readonly signature?: string;
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

/**
 * Structural equality. Functions and modules compare by identity.
 *
 * `pairs` records which two containers are already being compared, so a cyclic
 * value can be compared at all: `inspect` prints `[1, [...]]` for a list that
 * contains itself, so the language has already decided such a value is a real
 * one, and answering it with a stack overflow would be the odd thing.
 *
 * Assuming a pair equal while it is still being checked is the standard reading
 * of equality on cyclic structures: two values are equal when nothing about them
 * distinguishes them, and a cycle that lines up distinguishes nothing. It also
 * terminates, which the alternative does not.
 *
 * The bookkeeping costs about 4% on a loop doing two hundred thousand
 * comparisons of small lists, measured interleaved against the version without
 * it. Deferring it until the recursion is deep enough for a cycle to be possible
 * was tried, on the reasoning that ordinary data cannot cycle: measured the same
 * way it saved nothing at all, so it was removed rather than kept for the story.
 * Scalars already skip it — only containers can recur — and `a === b` short-
 * circuits the identical case before anything else happens.
 */
export function valuesEqual(a: Value, b: Value, pairs = new Set<string>()): boolean {
  if (a === b) return true;
  if (a.k !== b.k) return false;

  // Only containers can recur, so only they need the bookkeeping.
  const recursive = a.k === 'list' || a.k === 'map' || a.k === 'struct' || a.k === 'enum';
  let pairKey = '';
  if (recursive) {
    pairKey = String(identityOf(a)) + ':' + String(identityOf(b));
    if (pairs.has(pairKey)) return true;
    pairs.add(pairKey);
  }
  try {
    return compareShape(a, b, pairs);
  } finally {
    if (recursive) pairs.delete(pairKey);
  }
}

/**
 * A stable number per container, for the pair bookkeeping above.
 *
 * A `WeakMap` rather than anything on the value itself, so a `Value` stays a
 * plain tagged object with no hidden fields, and nothing is kept alive by being
 * compared once.
 */
const identities = new WeakMap<object, number>();
let nextIdentity = 0;

function identityOf(value: object): number {
  const seen = identities.get(value);
  if (seen !== undefined) return seen;
  nextIdentity += 1;
  identities.set(value, nextIdentity);
  return nextIdentity;
}

function compareShape(a: Value, b: Value, pairs: Set<string>): boolean {
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
        return rhs !== undefined && valuesEqual(item, rhs, pairs);
      });
    }
    case 'map': {
      const other = b as MapValue;
      if (a.entries.size !== other.entries.size) return false;
      for (const [key, value] of a.entries) {
        const rhs = other.entries.get(key);
        if (rhs === undefined || !valuesEqual(value, rhs, pairs)) return false;
      }
      return true;
    }
    case 'struct': {
      const other = b as StructValue;
      if (a.typeName !== other.typeName || a.fields.size !== other.fields.size) return false;
      for (const [key, value] of a.fields) {
        const rhs = other.fields.get(key);
        if (rhs === undefined || !valuesEqual(value, rhs, pairs)) return false;
      }
      return true;
    }
    case 'enum': {
      const other = b as EnumValue;
      if (a.enumName !== other.enumName || a.variant !== other.variant) return false;
      if (a.values.length !== other.values.length) return false;
      return a.values.every((value, i) => {
        const rhs = other.values[i];
        return rhs !== undefined && valuesEqual(value, rhs, pairs);
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

/**
 * A string as Lumen source would write it.
 *
 * `JSON.stringify` covers `"`, `\` and the control characters, and misses the
 * one escape that is Lumen's own: `${` begins an interpolation, so
 * `inspect("${name}")` produced source that means something else entirely. The
 * lexer has had `\$` for exactly this since it was written; nothing was using
 * it.
 *
 * Only a `$` that is followed by `{` is escaped. A bare one needs nothing, and
 * escaping every `$` would make every price and every shell snippet harder to
 * read for no gain.
 */
function quote(s: string): string {
  let out = '"';
  // By code point, so a surrogate pair is one character and cannot be split.
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else {
      const code = ch.codePointAt(0) as number;
      // The C0 controls, and a lone surrogate — which a regex without the `u`
      // flag can hand back half of. Both have to be escaped: raw, one would be
      // a control character sitting in the middle of a quoted string and the
      // other is not valid text at all.
      const lone = code >= 0xd800 && code <= 0xdfff;
      out += code < 0x20 || lone ? '\\u{' + code.toString(16).toUpperCase() + '}' : ch;
    }
  }
  // Last, and on the assembled text: the escape depends on the *next*
  // character, which the loop above cannot see. Nothing it emits can create a
  // false `${` — an escape always puts a `\\` between the two.
  return out.replace(/\$(?=\{)/g, '\\$') + '"';
}

/** A `Map` key may be written bare exactly when it is a plain name. */
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A key as a map literal would write it: bare when it can be, quoted when not.
 *
 * Keys were concatenated raw, which made the rendering of an ordinary map
 * wrong in three ways at once — `{"a-b": 1}` came out as `{a-b: 1}`, which
 * reads back as a subtraction; a key with a quote in it was ambiguous; and a
 * key with a **newline** in it broke the output across lines and corrupted
 * whatever was printing it. None of that needs a strange program: a `Map` key
 * is an arbitrary string, and `std/csv.records`, `std/json.parse` and
 * `std/web.form` all build maps whose keys a stranger chose.
 *
 * List elements were already quoted (`[1, "a"]` rather than `[1, a]`) for
 * exactly this reason, so keys not being was an inconsistency inside one
 * function.
 */
function keyOf(key: string): string {
  return BARE_KEY.test(key) ? key : quote(key);
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
        .map(([key, value]) => keyOf(key) + ': ' + inspect(value, seen))
        .join(', ');
      seen.delete(v);
      return '{' + body + '}';
    }
    case 'struct': {
      if (seen.has(v)) return v.typeName + ' {...}';
      seen.add(v);
      // A struct's field names come from its declaration and so are always
      // plain names; going through `keyOf` anyway costs nothing and means
      // there is one answer to "how is a key written" rather than two.
      const body = [...v.fields]
        .map(([key, value]) => keyOf(key) + ': ' + inspect(value, seen))
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

/**
 * A lexical scope. Lookup walks the parent chain.
 *
 * The slot table is allocated on first declaration rather than in the
 * constructor. Most scopes never hold anything — a loop body creates one per
 * iteration, and a block inside it creates another — so allocating a Map
 * eagerly meant two throwaway Maps per iteration of every loop. Profiling the
 * `while` benchmark showed that cost as `MapConstructor` and
 * `FindOrderedHashMapEntry`; an empty scope now costs one object.
 */
export class Env {
  private slots: Map<string, Slot> | undefined;

  constructor(readonly parent?: Env) {}

  /** Declare in this scope. Redeclaring the same name shadows the old slot. */
  declare(name: string, value: Value, mutable: boolean): void {
    (this.slots ??= new Map<string, Slot>()).set(name, { value, mutable });
  }

  lookup(name: string): Slot | undefined {
    let scope: Env | undefined = this;
    while (scope !== undefined) {
      const slot = scope.slots?.get(name);
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
      if (scope.slots !== undefined) for (const key of scope.slots.keys()) names.push(key);
      scope = scope.parent;
    }
    return names;
  }

  ownNames(): string[] {
    return this.slots === undefined ? [] : [...this.slots.keys()];
  }

  hasOwn(name: string): boolean {
    return this.slots?.has(name) ?? false;
  }
}

/**
 * How many code points a string holds, without building a list of them.
 *
 * `[...s].length` was the obvious spelling and allocates an array as long as
 * the string, so counting one the host had just made without trouble ran out of
 * memory. Iterating a string yields its code points one at a time, so this is
 * the same answer in constant space. `std/str` has the same helper for the same
 * reason; `core` cannot import it, which is the rule this package is built on.
 */
export function codePointCount(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
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
   * The arguments the program was given, not counting its own name.
   *
   * The host decides what those are, because only the host knows: a CLI has to
   * work out how many words of its own command line it consumed, and a browser
   * or a build step has none at all. Reading them from `process.argv` at a fixed
   * offset looks like it works and does not — `lumen run x.lm a b` and
   * `lumen x.lm a b` put them in different places, so the same program saw
   * different arguments depending on how it was started.
   *
   * Optional: a host with no notion of arguments omits it, and `args()` is
   * empty rather than wrong.
   */
  args?(): readonly string[];
  /**
   * Read one line from the console, without its trailing newline, or undefined
   * at end of input. Optional: a host with no console (a browser, a build step)
   * simply omits it, and `input()` reports that rather than hanging.
   */
  readLine?(prompt: string): Promise<string | undefined>;
  /**
   * Everything left on the input, as one string.
   *
   * The other half of reading: `readLine` is for a conversation and this is for
   * a pipeline, and a program written for `cat file | prog` could not be
   * written at all with only the first — `while input()` works, but it is four
   * lines and an `Option` to say "read the input".
   *
   * Optional, like `readLine`, and for the same reason: a browser or a build
   * step has no input to read.
   */
  readAll?(): Promise<string>;
  /**
   * Stop the program with an exit status.
   *
   * `exit()` used to call `process.exit()` from inside the standard library,
   * which was the one place a Node API was reached for directly rather than
   * through the host — and so the one thing that would not work in a browser,
   * a worker or an embedding that wants to survive the program it is running.
   *
   * Optional, because not every host can stop. One that omits it makes `exit()`
   * fail the way `input()` does without a console — saying so plainly beats
   * pretending. A host that implements it is not expected to return.
   */
  exit?(code: number): never | void;
}

// ------------------------------------------------------------------ helpers

/**
 * Edit distance, counting a swap of two neighbours as one edit.
 *
 * Plain Levenshtein charges two for a transposition, because it has to
 * substitute both letters. But transposing is the commonest typo there is, and
 * charging it double forces the suggestion threshold up to two — which on a
 * four-letter word means half of it may differ, and `nope` starts "meaning"
 * `type`. Counting the swap as one (Damerau-Levenshtein, the restricted form)
 * separates the two cases properly: `cuont` is one edit from `count`, and `nope`
 * is still two from `type`.
 *
 * Used only to suggest a name the reader probably meant.
 */
export function editDistance(a: string, b: string): number {
  // Three rows rather than two: a transposition needs the row before the
  // previous one, which is what distinguishes this from Levenshtein.
  let twoBack: number[] = new Array<number>(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (twoBack[j - 2] ?? 0) + 1);
      }
      curr[j] = best;
    }
    twoBack = prev;
    prev = curr;
    curr = new Array<number>(b.length + 1).fill(0);
  }
  return prev[b.length] ?? 0;
}

/**
 * The closest candidate to `name`, if any is close enough to be worth showing.
 *
 * A confident wrong suggestion costs more than no suggestion: it sends the
 * reader after the wrong thing, and they trust it because the compiler said it.
 * So the allowance scales with the length of the name and never exceeds three —
 * roughly a third of it may differ, and no more:
 *
 *     up to 5 characters   one edit
 *     6 to 8               two
 *     9 or more            three
 *
 * Short names are where this matters. With a flat allowance of two, `nope`
 * "meant" `type` — two of its four letters, which is a different word rather
 * than a typo. One edit is enough for a short name precisely because
 * `editDistance` counts a transposition as one, so `cuont` still finds `count`
 * and `tets` still finds `test`. A one-edit match on a short name is kept:
 * `abc` really might be a slip for `abs`.
 */
export function suggest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  const limit = name.length <= 5 ? 1 : Math.min(3, Math.floor(name.length / 3));
  for (const candidate of candidates) {
    const score = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore && score <= limit) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
