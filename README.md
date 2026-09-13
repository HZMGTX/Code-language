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

- 133 tests, 50 conformance fixtures, green on Node 20/22/24 across Linux, macOS and Windows
- **Zero runtime dependencies.** The only build-time dependencies are TypeScript
  and Node's type definitions.

## Quick start

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
lumen test [path]        run every *_test.lm under path
lumen tokens <file.lm>   show the token stream
lumen ast <file.lm>      show the parsed syntax tree
```

## Documentation

| Document | What it covers |
|---|---|
| [docs/tour.md](docs/tour.md) | Learn the language in about ten minutes |
| [docs/spec.md](docs/spec.md) | The specification — grammar, semantics, diagnostics |
| [docs/stdlib.md](docs/stdlib.md) | Every standard module and function |
| [docs/philosophy.md](docs/philosophy.md) | Why it is built this way, and what "built to last" means |
| [ROADMAP.md](ROADMAP.md) | What is not done yet, stated plainly |
| [DEVELOPING.md](DEVELOPING.md) | Building, testing, and adding to the language |

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
