# Developing Lumen

## Requirements

Node 20 or newer. Nothing else — Lumen has no runtime dependencies, and the only
build-time ones are TypeScript and Node's type definitions.

One exception, and only if you are building the native binary: that step shells
out to [bun](https://bun.sh). Bun is a build-time tool, not a dependency — it is
not in `package.json`, and nobody running the binary it produces needs it.

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
| `npm run bundle` | Build `build/lumen.cjs`, the portable single-file bundle |
| `npm run binary` | Build `build/lumen`, the native standalone executable (needs bun) |
| `npm run binary:all` | Cross-compile the native binary for all five targets |
| `npm run dist` | Build both: bundle, then binary |
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
scripts/           test runner, example runner, doc generator, private check,
                   the bundler and the native-binary builder
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

## Distribution

Lumen ships in two tiers. Both are built from the same TypeScript sources and
both land in `build/`, which is git-ignored.

### Tier 1 — the native binary

`npm run binary` writes `build/lumen`: a true standalone executable. It embeds a
JavaScript runtime, so it runs with no Node, no npm and no `node_modules`
present anywhere on the machine.

`scripts/build-binary.mjs` compiles it with `bun build --compile`. Bun is needed
at **build time only** — it is not a Lumen dependency, it is not in
`package.json`, and a user running the binary never installs it. If bun is not
on your PATH the script says so plainly and points you at the portable bundle
instead.

`npm run binary:all` cross-compiles every supported target from one machine:

```
build/lumen-linux-x64
build/lumen-linux-arm64
build/lumen-macos-x64
build/lumen-macos-arm64
build/lumen-windows-x64.exe
```

Those five are the whole supported set; `node scripts/build-binary.mjs
--target=<name>` builds just one of them. Each build records a SHA-256 in
`build/SHA256SUMS.txt`, merging with what is already there rather than replacing
it, so building one target does not erase the entries from earlier builds.

`npm run bundle` writes no checksum of its own, so after `npm run dist` that
file covers the binary only. The release workflow records `lumen.cjs` into the
same file by hand before the binary build merges into it, which is what leaves
every published asset covered.

Expect roughly 100 MB per binary. That is the embedded runtime, not bloat in
Lumen, and it is what buys the "needs nothing installed" property — state it
wherever the binary is offered, rather than letting the download size surprise
someone.

### Tier 2 — the portable bundle

`npm run bundle` writes `build/lumen.cjs`: one self-contained CommonJS file of a
couple of hundred kilobytes, which runs the whole CLI on any Node 20 or newer
with no npm install, no `node_modules` and no source tree.

`scripts/bundle.mjs` is a small purpose-built bundler, which is the point: a
single-file distribution bought with a bundler dependency would have cost the
property in the section above. It recompiles the same sources to CommonJS
through `tsconfig.cjs.json` into `build/cjs/` — a standalone project with its
own `outDir` and `tsBuildInfoFile`, so it never disturbs `packages/*/dist` —
wraps each emitted module in a factory, and resolves them with a `require` shim
that falls through to the real `require` for the `node:` builtins.

### Verifying them

Each tier claims something specific, so test the claim rather than the happy
path. The binary claims it needs no runtime, so take the runtime away:

```bash
env -i PATH=/nonexistent build/lumen run examples/hello.lm
```

The bundle claims it needs no install and no source tree, so run it from
somewhere else entirely:

```bash
cp build/lumen.cjs /tmp && (cd /tmp && node lumen.cjs run /abs/path/to/app.lm)
```

Both must print exactly what `npm run lumen -- run` prints for the same program.

## Before you push

```bash
npm run typecheck
npm test
npm run examples
node scripts/check-private.mjs
node scripts/gen-stdlib-docs.mjs --check
```

CI runs all of these, and two things you cannot easily run locally: the
Lumen-language suite (`lumen test tests/lumen`) on every supported platform, and
a `distribution` job that re-proves both tiers of the section above — the bundle
from a directory containing nothing else, the binary with `node` unreachable.

## A note on licensing

Lumen is proprietary and closed source. Every `package.json` carries
`"private": true`, and `scripts/check-private.mjs` fails the build if that
changes. Do not remove it, and do not publish any build artifact to a public
registry. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
