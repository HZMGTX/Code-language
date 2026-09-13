# Changelog

All notable changes to Lumen are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lumen follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the
stability policy in [docs/spec.md](docs/spec.md) §10.

## [Unreleased]

### Language

- **`return`, `break` and `continue` are expressions.** They produce no value —
  they leave — so they can now appear wherever a value is expected, which is
  what lets a `match` arm bail out:

  ```lumen
  match line.toNum() {
    Ok(n)  => n,
    Err(_) => continue,
  }
  ```

  Previously this was `PA010: expected an expression, found 'return'`, and
  since `match` is the main way to branch in an expression-oriented language,
  that was a hole in the middle of it. The statement forms are unchanged and
  mean exactly the same thing.

### Fixed

- **A function body may name declarations that come later.** `fn greet() {
  name }` followed by `let name = "world"` runs correctly and always has, but
  the resolver rejected it with `RS001` — the one failure a static check must
  not have. It also ruled out mutual recursion, since the second of two
  functions is never declared yet when the first names it. Lookups from inside
  a function body now see what the enclosing scope is going to declare;
  statement-level code, which really does run where it is written, is
  unchanged. A typo is still caught, and can now suggest a name from further
  down the file.
- **`break` and `continue` outside a loop said `internal error [object
  Object]`.** They are now `RS006`, reported before the program runs, with a
  note pointing at `return`. A function boundary counts: a `break` inside a
  lambda cannot leave the loop the lambda was written in.
- **Piped input dropped every line after the first.** A pipe delivers all its
  lines at once, well before a program asks for the second one, and the host
  read one and let the rest fall on the floor — so `printf 'a\nb\n' | lumen
  run script.lm` saw only `a`. Lines are queued as they arrive now. Reading at
  a terminal is unchanged.
- **`isServer()` always returned `true`,** whether the file was started with
  `lumen serve` or `lumen run`, which made it useless for the thing its name
  promises. `serve` and `run` are now genuinely different, and `isServer()`
  says which one you are in — so one file can serve its routes and also print
  them for inspection.

- **Runaway recursion hung instead of failing.** Every call is a promise rather
  than a stack frame, so `fn f() { f() }` allocated quietly until the process
  died — no stack to overflow, no diagnostic, no end. Calls are limited to
  10,000 deep and report `RT045`, which takes about a quarter of a second.
  Legal deep recursion is unaffected; nothing reasonable comes close.
- **A struct literal in a control-flow header produced nine errors.** `match
  Point { x: 1, y: 2 } { ... }` is ambiguous — in a header a `{` starts the
  body — and the parser used to silently take the identifier alone and then
  report on the wreckage. It now says so once, as `PA015`, with the fix
  (parentheses), and parses the struct literal anyway so nothing after it
  cascades. `if ready {}` is untouched: an empty brace pair in a header is far
  more likely a body than a struct.
- **Six ordinary identifiers were syntax errors.** `let valueOf = 1` failed
  with `expected an identifier, found function valueOf() { [native code] }`,
  and so did `toString`, `constructor`, `hasOwnProperty`, `__proto__` and
  `isPrototypeOf`. The keyword table was an object literal, so looking a name
  up in it answered with whatever JavaScript's `Object.prototype` carries. It
  is a `Map` now, which has no inherited keys. Three more leaks of the same
  kind went with it: `stringify` silently dropped a `__proto__` key, an
  `import` of one of those names crashed the interpreter instead of reporting
  an unknown module, and HTTP header maps were built on objects that could be
  written through. A language whose pitch is that the host is invisible cannot
  have the host's method names showing through its syntax.
- **Two values that both printed `NaN` compared unequal — sometimes.** `a == a`
  was true and `a == b` false for two identical computations, because equality
  short-circuits on object identity and `NaN === NaN` is false underneath. That
  leaked the host's object identity into a language where numbers have none.
  Rather than patch equality, `NaN` is no longer a Lumen value at all: any
  arithmetic that would produce one is `RT046`, and `pow(-8, 0.5)` reports that
  it has no real answer, as `sqrt(-1)` and `log(0)` already did. `Infinity` is
  untouched — it means something, is equal to itself, and orders consistently.
- **Deeply nested source crashed with a message about the wrong thing.** A
  thousand nested parentheses exhausted the host stack, and what came out was
  `stack overflow — a function is probably recursing without a base case`,
  which names a cause that does not apply and nothing anyone could act on. The
  parser now refuses to build a tree more than 250 levels deep and reports
  `PA016` with a span. The same limit bounds every later walk of the tree, so
  none of them can meet something deeper than the parser was willing to build.
- **A long source line buried the caret it was pointing at.** A diagnostic on a
  minified or generated line printed the whole line, pushing the `^` off the
  screen. Lines past 120 characters are now shown as a window around the caret.
- **`std/fs` leaked Node's error text.** `ENOENT: no such file or directory,
  open '/x'` names an errno, a syscall and a quoting style that vary by
  platform and version — so the same Lumen program said different things on
  Windows. The messages are Lumen's now, mapped from the stable error code.
  `std/http` names the failing request instead of only "fetch failed".

### Added

- **`std/web.form(req)`** reads the fields a form submitted, whichever way the
  page sent them: the query string for `method="get"`, the urlencoded body for
  `method="post"`. A handler no longer has to know which, and percent- and
  plus-encoding are decoded on the way through. A request carrying anything
  else comes back empty, with `req.body` still there to parse.
- **Eight worked examples** — `fizzbuzz`, `wordcount`, `bank`, `calculator`,
  `stats`, `caesar`, `matrix` and `adventure`. Each is a program someone might
  actually write rather than a feature demonstration, and each is run by CI.
  The calculator is a recursive-descent parser for arithmetic written in
  Lumen; the adventure plays itself when there is nothing on stdin, so running
  it in CI exercises the whole game rather than its first room. `guestbook` is
  one file that is both a site and a script — `lumen serve` serves its routes,
  `lumen run` calls the same handler with requests written by hand and asserts
  that what a visitor typed reaches the page as text rather than as a tag.
  `inventory` parses JSON, groups and totals it, writes the summary back out
  and reads it in again.

## [0.1.0] — 2026-09-13

The first working version. Everything below runs today.

### Language

- Expression-oriented syntax with braces and optional semicolons
- `let` (immutable) and `var` (mutable) bindings
- Functions with type annotations, default values, named arguments, and hoisting
- Closures capturing by reference
- Structs and enums, including enum variants with payloads
- `match` with literal, binding, wildcard, list (with rest), struct and enum
  patterns, plus guards
- `Result` and `Option` built in, with postfix `?` propagation; no exceptions
- Pipeline operator `|>`
- String interpolation with full expression support and correct brace nesting
- Ranges, lists, string-keyed maps
- `if` as an expression; `while`, `for`, `break`, `continue`
- Modules: `import`/`export`, `std/*` modules and relative `.lm` files
- No async colouring — I/O is awaited implicitly

### Fixed

- `"abc".len()` raised while `[1, 2].len()` worked. `std/str` had no `len`, so
  strings were the one container without the method. They now agree.
- `any` and `all` required a predicate, so `any([true, false])` — the form a
  Python programmer reaches for first — was an error. The predicate is now
  optional and the elements are tested directly without one.
- `docs/tour.md` documented `for [k, v] in { a: 1 }`, which does not parse: in a
  loop header a `{` starts the body, so the map needs parentheses. The example
  is corrected and the rule is now explained where it bites.
- The prelude table in `docs/stdlib.md` still listed ten names when there were
  thirty-eight. It is generated from a live interpreter now, so it cannot go
  stale again, and the core built-ins carry documentation so `help()` is
  complete.

### Types

Annotations are enforced where they are written, before the program runs.

- `TY001` an argument that does not match the parameter's declared type
- `TY002` a returned value that does not match the declared return type
- `TY003` an initialiser that does not match a binding's declared type
- `TY004` a struct literal field that does not match the field's declared type

The checking is gradual: anything the checker cannot determine is `Any`, and
`Any` is compatible with everything, so a program that writes no annotations is
never type-checked and cannot produce a single diagnostic.

There is no inference, with one sound exception: an unannotated `let` takes the
type of its value. That is safe precisely because `let` is immutable — the
binding can never later hold something else, so the inferred type cannot become
wrong. A `var` stays `Any`.

Verified the same way as the resolver: every Lumen file in the repository was
checked before the pass was wired in. 66 files, none flagged.

### Static checks

Programs are now checked before they run, so a mistake is reported whether or
not execution happens to reach it.

- `RS001` a name that is not defined anywhere in scope, with a suggestion
- `RS002` a `match` over an enum that misses a variant. A guarded arm does not
  count as covering one, because the guard may be false
- `RS003` a `match` arm that can never be reached
- `RS004` a name declared twice in one scope
- `RS005` assignment to a binding introduced with `let`

The guiding rule is no false positives: anything the resolver cannot be certain
about it leaves to the interpreter, which still enforces every one of these at
run time as a backstop. Verified against every Lumen file in the repository —
56 valid programs, none flagged.

Diagnostic suggestions were also tightened. The "did you mean" threshold now
caps at an edit distance of 3, so a long name can no longer match something
unrelated; a confident wrong suggestion costs more than none.

### Ergonomics

- **Method-call syntax.** `x.f(a)` means `f(x, a)`. Because every standard-library
  function takes its subject first, `x.f(a)`, `f(x, a)` and `x |> f(a)` are three
  spellings of one thing, and every existing library function gained method syntax
  without a line of new library code. Methods are available on `Str`, `List` and
  `Map`. On a map, a real key always wins over a method of the same name, so no
  existing lookup changes meaning.
- **A prelude worth having.** `range`, `sum`, `sorted`, `reversed`, `min`, `max`,
  `abs`, `round`, `floor`, `ceil`, `map`, `filter`, `reduce`, `enumerate`, `zip`,
  `any`, `all`, `join`, `split` and `input` now need no import. Previously even
  `map` and `filter` did, which was a lot of ceremony before a beginner had done
  anything. A user binding of the same name still shadows the prelude one.
- **`help()`.** `help()` lists everything in scope, `help(value)` shows a value's
  type and the methods available on it, `help(fn)` shows a signature and
  description, and `help("std/list")` lists a module. Standard-library functions
  carry one-line documentation.
- **`input(prompt)`** reads a line from the console, as `Some(line)` or `None` at
  end of input, so interactive scripts are possible.
- `min` and `max` accept either a list or several numbers, because guessing which
  one a language chose is a bad first experience.

### Tooling

- `lumen` CLI: `run`, `serve`, `repl`, `test`, `tokens`, `ast`
- REPL with a persistent scope, multi-line input, and `:help`, `:type`, `:ast`,
  `:env`, `:modules`, `:clear`
- Diagnostics with source spans, carets, stable codes and suggested fixes

### Standard library

- `std/core`, `std/str`, `std/list`, `std/map`, `std/math`, `std/json`,
  `std/fs`, `std/http`, `std/web`, `std/ai`
- `std/web` serves real HTTP with routing, JSON, HTML escaping, and a page helper
- `std/ai` speaks to Anthropic and OpenAI, with a deterministic `mock` provider
  so examples and CI need no API key

### Distribution

- `npm run binary` builds `build/lumen`, a native standalone executable that
  runs Lumen programs with no Node, no npm and no `node_modules` present. It
  embeds a JavaScript runtime, so it is around 100 MB
- `npm run binary:all` cross-compiles five targets from one machine: linux-x64,
  linux-arm64, macos-x64, macos-arm64 and windows-x64. Bun compiles them, at
  build time only — it is never needed to run a binary
- `npm run bundle` builds `build/lumen.cjs`, one self-contained CommonJS file
  that runs the whole CLI on any Node 20 or newer with no install, no
  `node_modules` and no source tree
- `npm run dist` builds both tiers
- The bundler, `scripts/bundle.mjs`, is purpose-built, so single-file
  distribution still costs no dependency
- Binary builds record SHA-256 checksums in `build/SHA256SUMS.txt`

### Project

- Zero runtime dependencies
- 207 tests and 74 conformance fixtures, green on Node 20/22/24 across Linux,
  macOS and Windows
- Specification, tour, standard-library reference and design rationale
- Proprietary licence; every package marked private, enforced by CI

### Known limitations

Type annotations are parsed but not enforced, and `match` exhaustiveness is
checked at run time rather than before it. See [ROADMAP.md](ROADMAP.md).

[0.1.0]: https://github.com/HZMGTX/Code-language/releases/tag/v0.1.0
