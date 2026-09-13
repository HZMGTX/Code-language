# Developing Lumen

## Requirements

Node 20 or newer. Nothing else — Lumen has no runtime dependencies, and the only
build-time ones are TypeScript and Node's type definitions.

## Setup

```bash
npm install
npm run build
```

## The commands

| Command | What it does |
|---|---|
| `npm run build` | Compile every package (`tsc --build`) |
| `npm test` | Build, then run unit and conformance tests |
| `npm run test:update` | Rewrite the conformance golden files |
| `npm run typecheck` | Force a clean rebuild, so nothing hides in incremental output |
| `npm run examples` | Run every example through the real CLI, server included |
| `npm run lumen -- <args>` | Run the CLI without installing it |
| `npm run clean` | Delete all build output |

To get a real `lumen` on your PATH:

```bash
npm link --workspace @lumen-lang/cli
```

## Layout

```
packages/core      the language — lexer, parser, AST, values, interpreter
packages/stdlib    std/* modules, the Node host, the module resolver
packages/cli       the `lumen` command
tests/unit         unit tests (node:test)
tests/conformance  golden fixtures
scripts/           test runner, example runner, doc generator, private check
```

### The one architectural rule

**`packages/core` must never import a Node API.** Everything it needs from the
outside world arrives through the `Host` interface in `values.ts`, supplied by
`packages/stdlib`.

This is what keeps a browser target (and the planned JavaScript backend) a wiring
exercise rather than a rewrite. If you find yourself reaching for `node:fs` in
`core`, add a `Host` method instead.

## Testing

Two layers, and both matter.

**Unit tests** (`tests/unit/*.test.ts`) cover internals that are awkward to
observe from Lumen source: token streams, operator precedence, recovery bounds,
argument binding.

**Conformance fixtures** (`tests/conformance/<category>/<name>.lm`) are the
executable half of the specification. Each `.lm` file is run and its complete
output — stdout plus any rendered diagnostic — is byte-compared against the
matching `.expected` file.

To add one:

```bash
# 1. write the fixture
cat > tests/conformance/expressions/my-feature.lm <<'EOF'
print(1 + 1)
EOF

# 2. generate its golden file
npm run test:update

# 3. READ the generated .expected file and check it is what you meant
cat tests/conformance/expressions/my-feature.expected

# 4. commit both files
```

Step 3 is not optional. `test:update` records whatever the implementation
currently does, bugs included. A golden file you have not read is not a test.

### Determinism

Fixtures run against a fixed world: the clock returns `0`, the environment is a
fixed table, `LUMEN_AI_PROVIDER` is `mock`, and the parser is given a bare
filename so no absolute path reaches a golden file.

If a fixture's output could differ between Node versions or operating systems,
that is a bug in the implementation, not something to work around in the
harness — CI runs the goldens on Node 20, 22 and 24 across Linux, macOS and
Windows precisely to catch it. (This is how `std/json`'s parse error came to use
Lumen's own wording rather than V8's.)

## Adding a standard-library module

1. Write `packages/stdlib/src/mymodule.ts`, exporting
   `export function stdMyModule(): Map<string, Value>`.
2. Build natives with the `fn` helper from `./support.js`, which gives them named
   parameters and therefore named-argument support.
3. Register it in `STD_MODULES` in `packages/stdlib/src/index.ts`.
4. Add a conformance fixture under `tests/conformance/stdlib/`.
5. Run `node scripts/gen-stdlib-docs.mjs` to refresh the reference table in
   `docs/stdlib.md`.

Conventions to follow, because the whole library follows them: the subject comes
first, nothing mutates unless its name says so, fallible operations return
`Result`, and absence returns `Option`.

## Adding syntax

Roughly in this order:

1. `token.ts` — a token kind, if the syntax needs one
2. `lexer.ts` — how it is recognised
3. `ast.ts` — the node
4. `parser.ts` — how it is parsed, and at what precedence
5. `interp.ts` — what it does
6. `tests/conformance/` — a fixture proving it
7. `docs/spec.md` — the rule, written down

Step 7 is part of the change, not follow-up work. The specification is what makes
the language reimplementable; letting it drift is how a language becomes
archaeology.

## Diagnostics

Every error carries a stable code, a span, a caret and — wherever a fix is
guessable — a note. Use `suggest()` from `values.ts` for "did you mean" hints.

Never reuse a diagnostic code for a different meaning; codes are part of the
language's contract. Take the next free number in the `LX`/`PA`/`RT` series and
add it to the table in `docs/spec.md`.

## Before you push

```bash
npm run typecheck
npm test
npm run examples
node scripts/check-private.mjs
node scripts/gen-stdlib-docs.mjs --check
```

CI runs exactly these.

## A note on licensing

Lumen is proprietary and closed source. Every `package.json` carries
`"private": true`, and `scripts/check-private.mjs` fails the build if that
changes. Do not remove it, and do not publish any build artifact to a public
registry. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
