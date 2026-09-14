# Roadmap

What is not done yet, stated plainly.

The first section describes **how v0.1 behaves today** — real limits you will meet,
not plans. Everything under `v0.2` and below is **unimplemented**: a statement of
intent, and nothing in the shipped language depends on it.

## Known limitations in v0.1

These are the things most likely to surprise you. They are deliberate scope
decisions, not oversights.

| Limitation | Detail |
|---|---|
| **`match` exhaustiveness is checked, but only where it can be proved** | The resolver reports a missing variant (`RS002`) when every arm names variants of one enum it can see. A `match` over a value whose enum it cannot determine — a parameter with no annotation, say — still falls back to the run-time `RT020`. Closing that gap needs the type checker. |
| **Type checking is gradual** | Annotations are enforced where written (`TY001`-`TY008`), an unannotated `let` takes its value's type, an operator whose operands are both known is checked, and the standard library declares its own types — so `upper(1)`, `"abc".padStart("x")` and `[1].push()` are caught without running. But there is no inference for parameters or `var`, no type variables, and no flow analysis. An unannotated program that calls nothing produces no type diagnostic at all, by design — which is also the limit: `fn f(a) { a + "x" }` is reported only when it runs. |
| **Ranges are materialised** | `0..n` builds a list, capped at 10,000,000 elements. Large spans need a `while` loop. |
| **No methods on your own types** | `Str`, `List`, `Map`, `Num`, `Option` and `Result` have methods, and `str`, `inspect`, `type`, `clone` and `isNil` work on every value — but a `struct` you define gets none. `f(x)` and `x \|> f()` are how your own functions are called. Method syntax is a calling convention rather than an object model (spec §4.7), so there is nowhere to register one; traits would be the mechanism, and they are v0.2. |
| **Performance** | A tree-walking interpreter in which every evaluation is a promise. `npm run bench` measures it. Profiling the `while` benchmark puts roughly **37% of non-library ticks in promise machinery** alone (`RunMicrotasks`, `AsyncFunctionAwait*`, `FulfillPromise`, `EnqueueMicrotask`, `PerformPromiseThen`), which is what the v0.3 work below is aimed at. |
| **`await` is inert** | Accepted and evaluates to its operand. I/O is awaited implicitly. |
| **No package manager** | Imports are `std/*` modules or relative `.lm` paths. |
| **`lumen fmt` only fixes indentation** | It rewrites leading whitespace and nothing else: it never moves a line break, and never changes spacing inside a line. Reflowing a long line is the part most formatters do and this one does not, because a line break ends a statement in Lumen (spec §1.1) and moving one changes what the program means. Widening it needs the parser, not the lexer — the formatter would have to know that a break is inside an expression before it could move it. See §1.3 for what it does guarantee. |
| **Distribution artifacts are not published** | There is now both a single-file bundle (`npm run bundle` -> `build/lumen.cjs`, produced by `scripts/bundle.mjs`, a small purpose-built bundler that adds no dependency) and a native standalone binary (`npm run binary` -> `build/lumen`, compiled by bun at build time only). Neither is hosted anywhere, signed or notarised: you build them, or you use `npm link --workspace @lumen-lang/cli`. |
| **The native binary is around 100 MB** | It embeds a JavaScript runtime, which is exactly what lets it run with no Node, npm or `node_modules` installed. The portable bundle is a couple of hundred kilobytes but needs a Node 20 or newer already present. Five targets are supported — linux-x64, linux-arm64, macos-x64, macos-arm64, windows-x64 — and nothing beyond them. |

## v0.2 — Types

Annotations now mean something where they are written. The rest of the theme is
depth: knowing the types of things nobody annotated.

**Done:**

- ~~Signatures for the standard library, so `upper(1)` is caught.~~ All 200
  functions declare one, written in the language's own annotation syntax and
  parsed with the real parser. The checker is *told* them — `packages/core`
  still imports nothing — which is also what types an imported name and made
  `lumen check` able to see a mistyped import (`RS009`, `RS010`).
- ~~Type-checked method calls.~~ `x.f(a)` is `CallExpr{callee: MemberExpr}`, so
  giving the member its real type was enough: the three spellings of a call
  share one code path and cannot disagree.
- ~~Function-type compatibility.~~ `accepts` compares `fn` against `fn`
  properly — covariant in the result, contravariant in the parameters, and
  silent about arity, which a call reports where it happens.
- Argument counts (`TY007`, `TY008`), which were not on this list and fall out
  of knowing a function's parameters.

**Still ahead:**

- Inference for parameters and `var` bindings, so a function's types can be
  known without writing them
- Type variables, so `map(xs, f)` can say it returns a list of whatever `f`
  gives back rather than a `List` of nothing in particular — the one thing that
  stopped the standard library's own signatures being more precise
- Full `match` exhaustiveness, including values whose enum only the type checker
  can determine (the resolver already covers the cases it can prove)
- Generics and traits, and with traits, methods on your own types
- Unused-binding warnings (the resolver already reports duplicate declarations).
  `Severity` has had a `'warning'` arm since v0.1 and nothing has ever emitted
  one; this would be the first.

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
