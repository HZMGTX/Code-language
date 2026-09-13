# Why Lumen is built this way

This document exists because the brief for Lumen was "make it the best, forever
the best." That is worth answering honestly rather than with a slogan.

## On "forever the best"

No language is permanently the best. The ones that last do not win by being
cleverest at launch; they last because they are **hard to break** — by their own
maintainers, by time, and by the ecosystem around them. Being closed source
removes the usual mechanism by which languages accumulate durability (a large
outside community), so the durability has to be built into the artifact itself.

Six deliberate decisions do that work.

### 1. The language is defined by a document, not only by code

`docs/spec.md` states the grammar, the semantics, the precedence table and the
diagnostic codes. When the implementation and the specification disagree, that
is a bug in one of them, and it is answerable. A language that exists only as an
implementation cannot be reimplemented, ported, or reasoned about — it can only
be archaeology.

### 2. Behaviour is pinned by an executable conformance suite

`tests/conformance/` holds one `.lm` file and one exact expected-output file per
behaviour. Fifty of them today. They are byte-compared, run on three Node
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

### 6. Errors are treated as a feature, not an afterthought

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

**No methods on built-in types.** There is `len(x)`, not `x.len()`, and
pipelines carry the ergonomics.
*Cost:* less familiar. The reason is that method dispatch deserves to be
designed together with traits in v0.2, rather than bolted on now and
regretted.

**Type annotations parsed but not enforced.** Stated plainly wherever it could
mislead.
*Cost:* an annotation currently documents intent rather than guaranteeing it.
Shipping a full inference engine in a first pass is where language projects
die; freezing the syntax first is what makes the checker additive later.

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
