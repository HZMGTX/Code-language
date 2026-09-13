# Changelog

All notable changes to Lumen are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lumen follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the
stability policy in [docs/spec.md](docs/spec.md) §10.

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
- 181 tests and 59 conformance fixtures, green on Node 20/22/24 across Linux,
  macOS and Windows
- Specification, tour, standard-library reference and design rationale
- Proprietary licence; every package marked private, enforced by CI

### Known limitations

Type annotations are parsed but not enforced, and `match` exhaustiveness is
checked at run time rather than before it. See [ROADMAP.md](ROADMAP.md).

[0.1.0]: https://github.com/HZMGTX/Code-language/releases/tag/v0.1.0
