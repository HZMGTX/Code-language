# Roadmap

What is not done yet, stated plainly. Nothing in this file is implemented today.

## Known limitations in v0.1

These are the things most likely to surprise you. They are deliberate scope
decisions, not oversights.

| Limitation | Detail |
|---|---|
| **Type annotations are not enforced** | `fn add(a: Num, b: Num) -> Num` parses and is retained, but nothing checks it. Arity, struct fields and operand types are checked at run time. |
| **`match` exhaustiveness is a run-time check** | A value that matches no arm raises `RT020` when it happens, rather than being rejected before the program runs. Static exhaustiveness needs the type checker. |
| **No undefined-name checking before running** | `RT005` fires when the name is reached, not at load time. |
| **Ranges are materialised** | `0..n` builds a list, capped at 10,000,000 elements. Large spans need a `while` loop. |
| **No methods on built-in types** | `len(x)`, not `x.len()`. Pipelines cover most of the ergonomics. |
| **Performance** | A tree-walking interpreter in which every evaluation is a promise. Correctness and capability were the v0.1 priorities; speed is v0.3's. |
| **`await` is inert** | Accepted and evaluates to its operand. I/O is awaited implicitly. |
| **No package manager** | Imports are `std/*` modules or relative `.lm` paths. |
| **Distribution artifacts are not published** | There is now both a single-file bundle (`npm run bundle` -> `build/lumen.cjs`, produced by `scripts/bundle.mjs`, a small purpose-built bundler that adds no dependency) and a native standalone binary (`npm run binary` -> `build/lumen`, compiled by bun at build time only). Neither is hosted anywhere, signed or notarised: you build them, or you use `npm link --workspace @lumen-lang/cli`. |
| **The native binary is around 100 MB** | It embeds a JavaScript runtime, which is exactly what lets it run with no Node, npm or `node_modules` installed. The portable bundle is a couple of hundred kilobytes but needs a Node 20 or newer already present. Five targets are supported — linux-x64, linux-arm64, macos-x64, macos-arm64, windows-x64 — and nothing beyond them. |

## v0.2 — Types

The theme is making annotations mean something, without invalidating code
written against v0.1.

- Type inference and checking for annotated code; gradual, so unannotated code
  keeps working
- Static `match` exhaustiveness, using the checker's knowledge of enums
- Undefined-name and unreachable-arm checks before execution
- Generics and traits, and with traits, method syntax (`x.len()`)
- A resolver pass that reports duplicate declarations and shadowing warnings

## v0.3 — Speed

- A bytecode compiler and VM to replace tree-walking
- A synchronous fast path, so pure code stops paying the promise tax
- Constant folding and inline caches for member access

## v0.4 — Reach

- A JavaScript backend, so Lumen runs in the browser as well as on the server —
  the reason `packages/core` imports no host API
- A language server: completion, go-to-definition, inline diagnostics
- `lumen fmt`, a canonical formatter

## v0.5 — Depth

- Structured concurrency, giving `async`/`await` their real meaning
- A macro or compile-time evaluation mechanism, so new domains stay libraries
- `std/ai` agents with tool-calling as a first-class construct
- A dependency manager for local and private module sources

## Deliberately not planned

- Exceptions. Errors are values; two error mechanisms is one too many.
- Implicit type coercion. `1 == "1"` will stay `false`.
- Making `0` and `""` falsy.
