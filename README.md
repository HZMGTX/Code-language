# Lumen

**One language for scripts, servers, websites, and AI.**

```lumen
import { serve, page } from "std/web"
import { chat } from "std/ai"

fn handle(req) {
  match chat(prompt: "Write a haiku about ${req.path}") {
    Ok(poem) => page(title: "Lumen", body: "<pre>${poem}</pre>"),
    Err(why) => page(title: "Oops", body: "<p>${why}</p>"),
  }
}

serve(handler: handle, port: 3000)
```

That is a complete, working program. No build step, no framework, no dependencies.

---

## Status

**v0.1.0.** The language runs. Everything documented here works today — there is
no aspirational syntax in this README. What is *not* done yet is listed honestly
in [ROADMAP.md](ROADMAP.md), and the most important item is that **type
annotations are parsed but not yet enforced**.

- 207 tests, 74 conformance fixtures, green on Node 20/22/24 across Linux, macOS and Windows
- **Zero runtime dependencies.** The only build-time dependencies are TypeScript
  and Node's type definitions.
- **Ships as a standalone executable.** Running a Lumen program needs no Node,
  no npm and no `node_modules` — see below.

## Running Lumen

**You do not need Node installed to run Lumen.** Lumen is written in
TypeScript — that has not changed and is not worth hiding — but what you run is
a standalone executable with the runtime already inside it.

There are three ways to get a `lumen` you can run.

**1. The standalone binary — recommended if you just want to run programs.** One
file, and no runtime of any kind required: no Node, no npm, no `node_modules`.

```bash
npm run binary                      # writes build/lumen
build/lumen run examples/hello.lm
```

Building it needs [bun](https://bun.sh) on the machine doing the build. Running
it needs nothing at all. The binary is around 100 MB, because it embeds a
JavaScript runtime — that is the honest price of depending on nothing.

`npm run binary:all` cross-compiles all five supported targets from a single
machine — `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64` and
`windows-x64` — into `build/lumen-<target>` (`.exe` for Windows).

**2. The portable bundle.** One self-contained CommonJS file. It needs some Node
20 or newer to be present, but no npm install, no `node_modules` and no source
tree.

```bash
npm run bundle                           # writes build/lumen.cjs
node build/lumen.cjs run examples/hello.lm
```

It is a couple of hundred kilobytes rather than a hundred megabytes, so it is the
better choice if you already have Node and would rather use it.

`npm run dist` builds both.

**3. From source**, if you are working on Lumen itself — that is the quick start
below.

## Quick start

Working on the language, rather than running programs with it:

```bash
npm install
npm run build

npm run lumen -- run examples/hello.lm
npm run lumen -- repl
```

To get a real `lumen` command on your PATH:

```bash
npm link --workspace @lumen-lang/cli
lumen run examples/tour.lm
```

## What it looks like

```lumen
// No imports. Methods, because every std function takes its subject first.
print("  Hello World  ".trim().lower().split(" ").join("_"))
print([1, 2, 3, 4].filter(fn(n) { n % 2 == 0 }).map(fn(n) { n * 10 }).sum())
print(sum(range(101)))
```

```lumen
struct Task { title: Str, done: Bool }

enum Status { Todo, Done }

fn statusOf(t: Task) -> Status {
  if t.done { Status.Done } else { Status.Todo }
}

fn main() {
  let tasks = [
    Task { title: "write the lexer",  done: true  },
    Task { title: "ship it",          done: false },
  ]

  for t in tasks {
    let mark = match statusOf(t) {
      Status.Done => "x",
      Status.Todo => " ",
    }
    print("[${mark}] ${t.title}")
  }
}
```

## The four ideas

**1. Errors are values, not explosions.** Lumen has no exceptions. Anything that
can fail returns a `Result`, and `?` either unwraps it or hands the error back to
your caller. The happy path stays flat and nothing fails silently.

```lumen
fn addBoth(a, b) {
  let x = parsePositive(a)?   // on Err, returns that Err from addBoth
  let y = parsePositive(b)?
  Ok(x + y)
}
```

**2. No async colouring.** `chat(...)`, `read(...)` and `get(...)` do real I/O
but look and compose exactly like pure functions. There is no `async fn` to
thread up your call stack, and no colour mismatch between a function that awaits
and one that does not.

**3. Errors you can read.** Every diagnostic points at the source, underlines the
problem, and suggests the fix.

```
error[RT005]: `cuont` is not defined
 --> app.lm:2:7
  |
2 | print(cuont)
  |       ^^^^^ not found in this scope
  |
  = note: did you mean `count`?
```

**4. Immutable by default.** `let` never changes; `var` says out loud that it
does.

## The command

```
lumen <file.lm>          run a program
lumen run <file.lm>      run a program
lumen serve <file.lm>    run a program that starts a web server
lumen repl               start an interactive session
lumen check [path]       check every .lm under path without running it
lumen test [path]        run every *_test.lm under path
lumen tokens <file.lm>   show the token stream
lumen ast <file.lm>      show the parsed syntax tree
```

`lumen check` is the one to reach for from an editor, a pre-commit hook or a CI
step: it parses, resolves and type-checks a whole tree in the time it takes to
read it, and runs nothing — which matters when the program in question writes
files or serves a port.

## Documentation

| Document | What it covers |
|---|---|
| [docs/learn.md](docs/learn.md) | Start here if you are new to programming |
| [docs/from-python.md](docs/from-python.md) | Start here if you know Python |
| [docs/tour.md](docs/tour.md) | Learn the language in about ten minutes |
| [docs/spec.md](docs/spec.md) | The specification — grammar, semantics, diagnostics |
| [docs/stdlib.md](docs/stdlib.md) | Every standard module and function |
| [docs/philosophy.md](docs/philosophy.md) | Why it is built this way, and what "built to last" means |
| [ROADMAP.md](ROADMAP.md) | What is not done yet, stated plainly |
| [DEVELOPING.md](DEVELOPING.md) | Building, testing, and adding to the language |

## Examples

Seventeen runnable programs, each executed by CI on every change. `lumen run
examples/<name>.lm` runs any of them.

| File | What it shows |
|---|---|
| `hello.lm` | The smallest complete program |
| `beginner.lm` | The first hour: variables, lists, loops, functions |
| `tour.lm` | Structs, enums, `match`, pipelines — the language in one file |
| `fizzbuzz.lm` | `match` with guards, read as a table of rules |
| `wordcount.lm` | `Str` and `Map` methods carrying a whole program |
| `stats.lm` | Mean, median, variance, and a bar chart drawn in text |
| `caesar.lm` | Strings as lists of characters; breaking the cipher by score |
| `matrix.lm` | Lists of lists: transpose, identity, multiplication |
| `bank.lm` | `Result` and `?` where failure is the interesting part |
| `calculator.lm` | A recursive-descent parser for arithmetic, written in Lumen |
| `adventure.lm` | `input()`, a world in a `Map`, and a game that plays itself |
| `inventory.lm` | JSON in, report out — parse, group, total, write, read back |
| `sudoku.lm` | Backtracking search, and a solution that checks itself |
| `website.lm` | A real site: routing, HTML, JSON, 404s (`lumen serve`) |
| `guestbook.lm` | A form, escaping, and one file that is both site and script |
| `ai_agent.lm` | An AI call that works with no key, via the mock provider |
| `triage.lm` | Structured output from a model — parsing, fallback, retries |

## Repository layout

```
packages/core      the language: lexer, parser, AST, values, interpreter
                   — imports no host APIs, so a browser target stays possible
packages/stdlib    std/* modules, the Node host, and the module resolver
packages/cli       the `lumen` command
examples/          runnable programs, each covered by CI
tests/unit         unit tests for the internals
tests/conformance  golden fixtures: one .lm file plus its exact expected output
docs/              the specification and guides
```

## Licence

**Proprietary. All rights reserved.** This is closed-source software; see
[LICENSE](LICENSE). Every package is marked `"private": true` and CI fails if
that ever changes, so it cannot be published by accident.
