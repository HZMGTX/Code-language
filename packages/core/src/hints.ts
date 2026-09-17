/**
 * What a mistake usually means when the fingers that typed it learned another
 * language first.
 *
 * Sixty of the things a person arriving from Python writes on their first day
 * were run through Lumen and what it said about each was read. Every one was
 * an error, and every error was *correct* — `print "hello"` really is a string
 * where a line break was expected — and almost none of them said the one thing
 * that person needed, which is Lumen's spelling of what they meant. `True` was
 * "not defined"; `xs.append(2)` listed forty-eight methods and `push` was one
 * of them; `f"hi {name}"` was "expected `)`, found a string".
 *
 * Nothing here changes what is an error. It changes what the error *says*, by
 * one note, in the places that already say "did you mean". The tables are
 * consulted before the edit-distance guess, because `True` is not a slip of
 * the fingers for anything in scope — it is a word from somewhere else, and
 * an exact match on a well-known one beats a near match on a local name.
 *
 * A test holds every note to naming only things that exist: every `std/…`
 * module, every name inside an `import { … }`, every method a `use` points at.
 * A note that names something that is not there is worse than no note.
 */

/** A name that is not defined here and is a well-known word elsewhere. */
export const FOREIGN_NAMES: ReadonlyMap<string, string> = new Map([
  ['True', 'Lumen spells it `true`'],
  ['TRUE', 'Lumen spells it `true`'],
  ['False', 'Lumen spells it `false`'],
  ['FALSE', 'Lumen spells it `false`'],
  ['null', '`nil` is the missing value'],
  ['NULL', '`nil` is the missing value'],
  ['undefined', '`nil` is the missing value'],
  ['Nil', '`nil` is the missing value'],
  ['int', '`num(text)` parses a number from text; a Num needs no other conversion'],
  ['float', '`num(text)` parses a number from text; a Num needs no other conversion'],
  ['parseInt', '`num(text)` parses a number from text; a Num needs no other conversion'],
  ['parseFloat', '`num(text)` parses a number from text; a Num needs no other conversion'],
  ['Number', '`num(text)` parses a number from text; a Num needs no other conversion'],
  ['String', '`str(x)` turns any value into text'],
  ['toString', '`str(x)` turns any value into text'],
  ['Boolean', '`bool(x)` — and only `nil` and `false` are false'],
  ['dict', '`{}` is an empty map, and `{ a: 1 }` a full one'],
  ['Object', '`{}` is an empty map, and `{ a: 1 }` a full one'],
  ['HashMap', '`{}` is an empty map, and `{ a: 1 }` a full one'],
  ['list', '`[]` is an empty list'],
  ['Array', '`[]` is an empty list'],
  ['ArrayList', '`[]` is an empty list'],
  ['set', 'a set is a list with no duplicates: `import { of, union } from "std/set"`'],
  ['frozenset', 'a set is a list with no duplicates: `import { of, union } from "std/set"`'],
  ['tuple', 'a fixed group of values is a list, `[a, b]`, and `let [a, b] = pair` takes it apart'],
  ['println', '`print(...)` writes a line'],
  ['console', '`print(...)` writes a line'],
  ['echo', '`print(...)` writes a line'],
  ['puts', '`print(...)` writes a line'],
  ['printf', '`print(...)` writes a line; `"${x}"` puts a value into text'],
  ['System', '`print(...)` writes a line'],
  ['self', 'Lumen has no objects: a method call `x.f()` is a plain call of `f` with `x` as its first argument'],
  ['this', 'Lumen has no objects: a method call `x.f()` is a plain call of `f` with `x` as its first argument'],
  ['pass', 'an empty block is written `{ }`'],
  ['open', 'a file is read whole: `import { read } from "std/fs"`'],
  ['exit', '`import { exit } from "std/core"` stops the program with a status'],
  ['quit', '`import { exit } from "std/core"` stops the program with a status'],
  ['Math', '`import { sqrt, floor } from "std/math"`'],
  ['math', '`import { sqrt, floor } from "std/math"`'],
  ['JSON', '`import { parse, stringify } from "std/json"`'],
  ['json', '`import { parse, stringify } from "std/json"`'],
  ['isinstance', '`type(x)` answers a type name: `type(x) == "Str"`'],
  ['typeof', '`type(x)` answers a type name: `type(x) == "Str"`'],
  ['length', '`len(x)`, or `x.len()`'],
  ['require', '`import { name } from "./file.lm"` brings in a local module'],
  ['raw_input', '`input(prompt)` reads a line'],
  ['xrange', '`range(n)` counts to n'],
]);

/**
 * A word that begins a statement in another language and is only a name here.
 *
 * `def f(x):` parses as the name `def` followed by `f`, which is two values on
 * one line — a true description of the wrong thing.
 */
export const FOREIGN_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ['def', 'functions are declared with `fn`: `fn name(args) { … }`'],
  ['function', 'functions are declared with `fn`: `fn name(args) { … }`'],
  ['func', 'functions are declared with `fn`: `fn name(args) { … }`'],
  ['fun', 'functions are declared with `fn`: `fn name(args) { … }`'],
  ['class', 'Lumen has structs instead of classes: `struct Name { field: Type }`'],
  ['lambda', 'an anonymous function is `fn(x) { x + 1 }`'],
  ['switch', '`match` chooses between cases: `match x { 1 => "one", _ => "other" }`'],
  ['case', '`match` chooses between cases: `match x { 1 => "one", _ => "other" }`'],
  ['try', 'Lumen has no exceptions: a failure is a `Result` value, and `?` passes it up'],
  ['catch', 'Lumen has no exceptions: a failure is a `Result` value, and `?` passes it up'],
  ['except', 'Lumen has no exceptions: a failure is a `Result` value, and `?` passes it up'],
  ['finally', 'Lumen has no exceptions: a failure is a `Result` value, and `?` passes it up'],
  ['raise', 'Lumen has no exceptions: answer with `Err(...)`, or `panic(...)` to stop the program'],
  ['throw', 'Lumen has no exceptions: answer with `Err(...)`, or `panic(...)` to stop the program'],
  ['from', 'an import names what it takes first: `import { upper } from "std/str"`'],
  ['global', 'a `var` from an outer scope can be assigned to as it is; nothing needs declaring'],
  ['nonlocal', 'a `var` from an outer scope can be assigned to as it is; nothing needs declaring'],
  ['with', 'there is no `with`: `read(path)` from `std/fs` gives the whole file, and nothing needs closing'],
  ['const', '`let` declares a name that will not change, and `var` one that will'],
  ['val', '`let` declares a name that will not change, and `var` one that will'],
  ['del', 'a binding cannot be deleted; a Map entry can, with `remove(m, key)`'],
  ['new', '`new` is not needed: `Point { x: 1, y: 2 }` builds a struct'],
  ['public', 'there are no visibility words: `export` marks what a module shares, and the rest is private'],
  ['private', 'there are no visibility words: `export` marks what a module shares, and the rest is private'],
  ['static', 'there are no visibility words: `export` marks what a module shares, and the rest is private'],
  ['yield', 'there are no generators: build the list, or `map` and `filter` one'],
]);

/** How a member hint is given: a method that exists, or a sentence. */
export type MethodHint = { readonly use: string } | { readonly note: string };

/**
 * A method another language has on this type, keyed `"List.append"`.
 *
 * Only for the types whose missing member is an error. A `Map` member is a
 * key, and a missing one reads as `nil` by design, so `m.items()` fails later
 * and elsewhere — as a call on `nil` — where nothing knows it began as a Map.
 */
export const FOREIGN_METHODS: ReadonlyMap<string, MethodHint> = new Map<string, MethodHint>([
  ['List.append', { use: 'push' }],
  ['List.extend', { use: 'concat' }],
  ['List.length', { use: 'len' }],
  ['List.size', { use: 'len' }],
  ['List.includes', { use: 'contains' }],
  ['List.has', { use: 'contains' }],
  ['List.index', { use: 'indexOf' }],
  ['List.copy', { use: 'clone' }],
  ['List.toString', { use: 'str' }],
  ['List.some', { use: 'any' }],
  ['List.every', { use: 'all' }],
  ['List.max', { use: 'maximum' }],
  ['List.min', { use: 'minimum' }],
  ['List.forEach', { note: 'loop instead: `for x in xs { … }`, or `xs.map(f)` for a new list' }],
  ['List.remove', { note: '`xs.filter(fn(x) { x != v })` drops a value, and `removeAt(i)` a position' }],
  ['List.shift', { note: '`xs.first()` is the head and `xs.drop(1)` the rest; lists are values, not queues' }],
  ['List.unshift', { note: '`[x] + xs` puts a value at the front' }],
  ['List.clear', { note: 'a list is a value; `[]` is a new empty one' }],
  ['Str.length', { use: 'len' }],
  ['Str.size', { use: 'len' }],
  ['Str.strip', { use: 'trim' }],
  ['Str.lstrip', { use: 'trimStart' }],
  ['Str.rstrip', { use: 'trimEnd' }],
  ['Str.trimLeft', { use: 'trimStart' }],
  ['Str.trimRight', { use: 'trimEnd' }],
  ['Str.find', { use: 'indexOf' }],
  ['Str.index', { use: 'indexOf' }],
  ['Str.toUpperCase', { use: 'upper' }],
  ['Str.toLowerCase', { use: 'lower' }],
  ['Str.substring', { use: 'slice' }],
  ['Str.substr', { use: 'slice' }],
  ['Str.includes', { use: 'contains' }],
  ['Str.splitlines', { use: 'lines' }],
  ['Str.charAt', { note: 'index it: `s[i]`' }],
  ['Str.at', { note: 'index it: `s[i]`' }],
  ['Str.format', { note: 'interpolate instead: `"${a} and ${b}"`' }],
  ['Str.join', { note: 'the list is the subject: `xs.join(", ")`' }],
  ['Str.concat', { note: '`a + b` joins two strings' }],
  ['Str.isdigit', { note: '`s.toNum()` answers `Ok` exactly when the text is a number' }],
  ['Str.isnumeric', { note: '`s.toNum()` answers `Ok` exactly when the text is a number' }],
  ['Num.toString', { use: 'str' }],
  ['Option.unwrap', { note: 'an Option is taken apart with `match`, or `unwrapOr(fallback)`, or `?` to pass `None` up' }],
  ['Option.get', { note: 'an Option is taken apart with `match`, or `unwrapOr(fallback)`, or `?` to pass `None` up' }],
  ['Option.value', { note: 'an Option is taken apart with `match`, or `unwrapOr(fallback)`, or `?` to pass `None` up' }],
  ['Result.unwrap', { note: 'a Result is taken apart with `match`, or `unwrapOr(fallback)`, or `?` to pass the `Err` up' }],
  ['Result.expect', { note: 'a Result is taken apart with `match`, or `unwrapOr(fallback)`, or `?` to pass the `Err` up' }],
  ['Result.get', { note: 'a Result is taken apart with `match`, or `unwrapOr(fallback)`, or `?` to pass the `Err` up' }],
  ['Result.value', { note: 'a Result is taken apart with `match`, or `unwrapOr(fallback)`, or `?` to pass the `Err` up' }],
]);

/** The note for a member hint, given what Lumen calls the thing. */
export function methodHintNote(name: string, hint: MethodHint): string {
  return 'use' in hint ? 'did you mean `' + hint.use + '`? `' + name + '` is what another language calls it' : hint.note;
}

/** String prefixes other languages have: `f"…"`, `r"…"`, `b"…"`. */
export const STRING_PREFIXES: ReadonlySet<string> = new Set(['f', 'F', 'r', 'R', 'b', 'B', 'fr', 'rf', 'u']);
