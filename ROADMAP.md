# Roadmap

What is not done yet, stated plainly. Nothing in this file is implemented today.

## Known limitations in v0.1

These are the things most likely to surprise you. They are deliberate scope
decisions, not oversights.

| Limitation | Detail |
|---|---|
| **Type annotations are not enforced** | `fn add(a: Num, b: Num) -> Num` parses and is retained, but nothing checks it. Arity, struct fields and operand types are checked at run time. |
| **`match` exhaustiveness is checked, but only where it can be proved** | The resolver reports a missing variant (`RS002`) when every arm names variants of one enum it can see. A `match` over a value whose enum it cannot determine — a parameter with no annotation, say — still falls back to the run-time `RT020`. Closing that gap needs the type checker. |
| **Type checking is gradual and shallow** | Annotations are enforced where written (`TY001`-`TY004`), and an unannotated `let` takes its value's type. But there is no inference for parameters or `var`, the standard library carries no signatures, method calls are unchecked, and there is no flow analysis or generics. An unannotated program is never type-checked at all, by design. |
| **Ranges are materialised** | `0..n` builds a list, capped at 10,000,000 elements. Large spans need a `while` loop. |
| **No methods on built-in types** | `len(x)`, not `x.len()`. Pipelines cover most of the ergonomics. |
| **Performance** | A tree-walking interpreter in which every evaluation is a promise. `npm run bench` measures it. Profiling the `while` benchmark puts roughly **37% of non-library ticks in promise machinery** alone (`RunMicrotasks`, `AsyncFunctionAwait*`, `FulfillPromise`, `EnqueueMicrotask`, `PerformPromiseThen`), which is what the v0.3 work below is aimed at. |
| **`await` is inert** | Accepted and evaluates to its operand. I/O is awaited implicitly. |
| **No package manager** | Imports are `std/*` modules or relative `.lm` paths. |
| **`lumen fmt` only fixes indentation** | It rewrites leading whitespace and nothing else: it never moves a line break, and never changes spacing inside a line. Reflowing a long line is the part most formatters do and this one does not, because a line break ends a statement in Lumen (spec §1.1) and moving one changes what the program means. Widening it needs the parser, not the lexer — the formatter would have to know that a break is inside an expression before it could move it. See §1.3 for what it does guarantee. |
| **Distribution artifacts are not published** | There is now both a single-file bundle (`npm run bundle` -> `build/lumen.cjs`, produced by `scripts/bundle.mjs`, a small purpose-built bundler that adds no dependency) and a native standalone binary (`npm run binary` -> `build/lumen`, compiled by bun at build time only). Neither is hosted anywhere, signed or notarised: you build them, or you use `npm link --workspace @lumen-lang/cli`. |
| **The native binary is around 100 MB** | It embeds a JavaScript runtime, which is exactly what lets it run with no Node, npm or `node_modules` installed. The portable bundle is a couple of hundred kilobytes but needs a Node 20 or newer already present. Five targets are supported — linux-x64, linux-arm64, macos-x64, macos-arm64, windows-x64 — and nothing beyond them. |

## v0.2 — Types

Annotations now mean something where they are written. The rest of the theme is
depth: knowing the types of things nobody annotated.

- Inference for parameters and `var` bindings, so a function's types can be
  known without writing them
- Signatures for the standard library, so `upper(1)` is caught
- Type-checked method calls
- Function-type compatibility, rather than treating every `fn` as interchangeable
- Full `match` exhaustiveness, including values whose enum only the type checker
  can determine (the resolver already covers the cases it can prove)
- Generics and traits, and with traits, method syntax (`x.len()`)
- Unused-binding warnings (the resolver already reports duplicate declarations)

## v0.3 — Speed

Measured, not guessed. `npm run bench` is the baseline; profile before and after.

- **A bytecode compiler and VM to replace tree-walking.** This is the change
  that alters the category rather than the constant factor, and it should come
  before the item below rather than after it.

- **Returning `Value | Promise<Value>` rather than always a promise** — costed,
  and deliberately not done in full.

  A narrow piece of it *has* landed: leaf expressions — number, string and
  boolean literals, `nil`, and plain names — are evaluated synchronously by
  `evalLeaf`, with every caller falling back to the async path for anything
  else. None of those can suspend, so there is no correctness question, and
  they are the bulk of what a tight loop evaluates: `while i < 300000 { total
  += i * 2 - 1 }` has six of them per iteration, each previously allocating a
  promise that resolved immediately. Best-of-three on the suite went from
  2.86s to 2.39s, about 16%; comparing medians rather than bests puts it
  nearer 25%.

  The rest is still deliberately not done. The interpreter awaits I/O so user code needs
  no `async`, and that must not change; but almost nothing it evaluates is
  actually asynchronous, and awaiting a plain value still costs a microtask.
  The profile above attributes ~37% of the work to exactly that.

  The scope is larger than the 80 `await` sites suggest. Without `async`, every
  `for ... of` loop containing an await — in `ListLit`, `MapLit`, `evalArgs`,
  `execBlock`, `matchPattern` — becomes a hand-written step function, and every
  `try`/`catch` around the `return`/`break`/`continue`/`?` signals has to handle
  both a synchronous throw and a rejection. That is a rewrite of the evaluator
  in continuation-passing style, not a refactor of it.

  Which is the argument for ordering: a bytecode VM has no tree-walking
  evaluator, so this work would be thrown away by the item above it. Spending
  that risk on code the roadmap already plans to replace is the wrong trade.
  Worth doing only if the VM is not.
- Constant folding and inline caches for member access

Already done, and worth ~13-28%: scopes allocate their slot table on first
declaration instead of eagerly, since a loop body and the block inside it
created two throwaway Maps per iteration.

## v0.4 — Reach

- A JavaScript backend, so Lumen runs in the browser as well as on the server —
  the reason `packages/core` imports no host API
- A language server: completion, go-to-definition, inline diagnostics

## v0.5 — Depth

- Structured concurrency, giving `async`/`await` their real meaning
- A macro or compile-time evaluation mechanism, so new domains stay libraries
- `std/ai` agents with tool-calling as a first-class construct
- A dependency manager for local and private module sources

## Deliberately not planned

- Exceptions. Errors are values; two error mechanisms is one too many.
- Implicit type coercion. `1 == "1"` will stay `false`.
- Making `0` and `""` falsy.
