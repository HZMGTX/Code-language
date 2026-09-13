# Why Lumen is built this way

This document exists because the brief for Lumen was "make it the best, forever
the best." That is worth answering honestly rather than with a slogan.

## On "forever the best"

No language is permanently the best. The ones that last do not win by being
cleverest at launch; they last because they are **hard to break** — by their own
maintainers, by time, and by the ecosystem around them. Being closed source
removes the usual mechanism by which languages accumulate durability (a large
outside community), so the durability has to be built into the artifact itself.

Seven deliberate decisions do that work.

### 1. The language is defined by a document, not only by code

`docs/spec.md` states the grammar, the semantics, the precedence table and the
diagnostic codes. When the implementation and the specification disagree, that
is a bug in one of them, and it is answerable. A language that exists only as an
implementation cannot be reimplemented, ported, or reasoned about — it can only
be archaeology.

### 2. Behaviour is pinned by an executable conformance suite

`tests/conformance/` holds one `.lm` file and one exact expected-output file per
behaviour. 74 of them today. They are byte-compared, run on three Node
versions and three operating systems, and they are what makes the specification
enforceable rather than aspirational.

Practically: it means the language can be refactored aggressively — a bytecode
VM, a JavaScript backend, a type checker — without silently changing what
existing programs do.

### 3. Zero runtime dependencies

Lumen depends on nothing at run time. The only build-time dependencies are
TypeScript and Node's type definitions, and neither ships in the product.

This is the single largest longevity lever available. A language with a
dependency graph inherits every one of its dependencies' abandonments, breaking
changes and supply-chain incidents. Lumen has no such graph to rot. CI enforces
this by checking the manifests.

Shipping a standalone executable carries the same argument one step further.
Until now there was one dependency left that the manifests could not see,
because it sat underneath them: the user's Node installation, of a particular
version, in working order. `npm run binary` produces `build/lumen`, a single
file with a JavaScript runtime inside it, so running a Lumen program now depends
on nothing being installed at all. Lumen is still written in TypeScript — that
is a fact about how it is built, not about what anyone must install to use it.

*Cost:* the embedded runtime makes that binary around 100 MB, and the price is
paid on every download. For people who already have Node 20 or newer and would
rather use it, `npm run bundle` produces `build/lumen.cjs` — one portable file
of a couple of hundred kilobytes, no install, no `node_modules`. The bundler that
writes it was built for the purpose rather than taken off the shelf: a
single-file distribution bought with a bundler dependency would have undone the
section it sits under. Bun compiles the native binary, and only at build time;
nobody who runs one ever installs it.

### 4. New domains arrive as libraries, not as surgery on the core

`packages/core` contains the language and imports no host API whatsoever. All
I/O reaches it through one `Host` interface. Every capability — the web server,
the AI client, the filesystem — is a `std/*` module built on that interface.

So "Lumen should also do X" is answered by writing a module, not by touching the
parser. It is also why a browser or embedded target stays a wiring exercise
rather than a rewrite.

### 5. Explicit stability guarantees

Within `0.x`, minor releases may change the language and patch releases may not.
From `1.0`, source that runs on `1.x` keeps running on every later `1.y`.
Diagnostic codes are stable from now and are never reused for a different
meaning.

Annotation syntax was deliberately finished *before* type checking so that the
v0.2 checker can begin enforcing without invalidating a line of code written
today.

### 6. Being learnable is part of being durable

A language nobody can get started in does not last, however well designed. So the
prelude carries what a beginner reaches for in the first hour — `range`, `sum`,
`sorted`, `map`, `filter`, `min`, `max`, `input` — rather than making them find
the right module first, and `help()` answers "what can I do with this value?"
from inside the terminal.

*Cost:* a larger prelude is more names to collide with, and more surface that has
to keep working. The mitigation is that a user binding always shadows a prelude
one, so a program that defines its own `sum` is unaffected.

### 7. Errors are treated as a feature, not an afterthought

Every diagnostic carries a source span, a caret, a stable code and usually a
suggested fix. This is not decoration. The quality of its error messages
determines how much of a language a person can learn without leaving the
terminal, and how long they stay willing to use it.

## Design decisions, and what they cost

Honest engineering means naming the trade, not just the benefit.

**No exceptions; errors are values.** `Result`, `Option` and `?`. Nothing fails
invisibly and no function has a hidden second exit.
*Cost:* more typing than `throw`, and `?` only works inside a function that
returns a `Result` or `Option`.

**No async colouring.** The interpreter awaits I/O, so `chat(...)` composes like
a pure function and no `async` marker propagates up your call stack.
*Cost:* every expression evaluation is a promise, which is slow. A bytecode VM
is the planned answer. This is the trade I would most want to revisit.

**Immutable by default.** `let` is final; `var` announces mutability.
*Cost:* nothing significant, beyond having to mean it.

**Only `nil` and `false` are falsy.** `0`, `""` and `[]` are true.
*Cost:* differs from JavaScript and Python, so it surprises newcomers exactly
once.

**A missing map key yields `nil`, but a list index out of range is an error.**
Maps are open-ended; lists have a definite size, so an out-of-range index is
always a mistake.
*Cost:* the asymmetry has to be learned. `std/map.get` returns an `Option` when
you want absence handled explicitly.

**Methods on built-in types, from the calling convention rather than an object
model.** `x.f(a)` means `f(x, a)`. Because every standard-library function takes
its subject first, `x.f(a)`, `f(x, a)` and `x |> f(a)` are three spellings of one
thing, and every existing library function gained method syntax without a line of
new library code.
*Cost:* two ways to write the same call, which a style guide has to settle. On a
map, a key and a method can share a name — the key always wins, so adding methods
can never change what an existing lookup returns, but it does mean
`m.keys` and `m.keys()` can differ.

> This reverses an earlier decision, and it is worth recording why rather than
> quietly editing history. v0.1 argued that method dispatch should wait for
> traits in v0.2, on the grounds that bolting it on early would be regretted.
> That reasoning assumed methods required an object model to dispatch through.
> They did not: the subject-first convention already encoded everything dispatch
> needed. The earlier position was defensible and wrong, and the cost of holding
> it was that a beginner wrote three import lines before their first useful
> program.

**Gradual typing, with `Any` as the default rather than an escape hatch.**
Annotations are enforced where written; everything else is `Any`, which is
compatible with everything. An unannotated program is never type-checked.
*Cost:* the checker is silent exactly where a program most needs help — code
nobody annotated. It catches a wrong argument to an annotated function, not a
wrong argument to an unannotated one. The alternative, inferring everywhere,
would have changed what existing programs mean, which is a larger cost to pay
without asking.

## What would make this claim false

It is worth writing down what would actually undermine the above, so it can be
watched for:

- A runtime dependency creeping in.
- A build-time tool — TypeScript, bun — turning into something a *user* has to
  install.
- A behaviour change that the conformance suite does not notice.
- The specification drifting from the implementation with no one reconciling it.
- Diagnostics degrading into bare messages with no span or suggestion.
- The core reaching for a host API directly, rather than through `Host`.

Each of those is checkable, and the first is checked automatically.
