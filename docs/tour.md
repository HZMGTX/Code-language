# A Tour of Lumen

About ten minutes. Everything here runs — try it in `lumen repl`, or read
`examples/tour.lm` for the same material as one program.

## Hello

```lumen
print("Hello from Lumen!")
```

```bash
lumen run hello.lm
```

## Values

```lumen
let name = "Ada"        // immutable — this is the default
var count = 0           // mutable — say so out loud
count += 1
```

Reassigning a `let` is an error, and the error says so:

```
error[RT029]: cannot assign to `name`
  = note: values bound with `let` never change; use `var` if it needs to
```

Six built-in types: `Nil`, `Bool`, `Num`, `Str`, `List`, `Map`.

```lumen
let nothing = nil
let yes     = true
let n       = 42
let text    = "words"
let xs      = [1, 2, 3]
let m       = { host: "localhost", port: 8080 }
```

**Only `nil` and `false` are falsy.** `0`, `""` and `[]` are all true — which
means an empty value never quietly takes the wrong branch.

## Strings

```lumen
let who = "world"
print("hello ${who}")               // any expression fits inside ${}
print("1 + 2 = ${1 + 2}")
print("nested ${"like ${who}"}")
print("multi
line strings are fine")
```

## Functions

```lumen
fn add(a, b) { a + b }              // the last expression is the value
fn greet(name, greeting = "Hello") { "${greeting}, ${name}!" }

print(greet("Ada"))                 // Hello, Ada!
print(greet("Ada", "Yo"))           // Yo, Ada!
print(greet(greeting: "Hi", name: "Bob"))   // arguments by name
```

Declarations are hoisted, so order does not matter and mutual recursion just
works:

```lumen
fn main() { print(helper()) }       // main may come first
fn helper() { "defined below" }
```

Functions are values, and closures capture by reference:

```lumen
fn counter() {
  var n = 0
  fn() { n += 1
    n }
}

let next = counter()
print(next())   // 1
print(next())   // 2
```

## Control flow is expressions

```lumen
let label = if n < 0 { "negative" } else if n == 0 { "zero" } else { "positive" }

var i = 0
while i < 3 { i += 1 }

for x in [1, 2, 3] { print(x) }
for ch in "abc" { print(ch) }
for [key, value] in { a: 1 } { print("${key}=${value}") }
for i in 0..5 { print(i) }          // 0 to 4
```

## Pipelines

`|>` sends the value on the left into the call on the right, as its first
argument. Every standard-library function takes its subject first so this reads
left to right:

```lumen
import { filter, map, sum } from "std/list"

let total = [1, 2, 3, 4]
  |> filter(fn(n) { n % 2 == 0 })
  |> map(fn(n) { n * 10 })
  |> sum()

print(total)   // 60
```

A line break before `|>` is not a statement break, so pipelines can go down the
page.

## Structs

```lumen
struct Task {
  title: Str,
  done:  Bool,
}

let t = Task { title: "write the parser", done: true }
print(t.title)

var u = Task { title: "ship", done: false }
u.done = true
```

Every field must be supplied, in any order. Get one wrong and Lumen suggests the
right one.

## Enums

```lumen
enum Status { Todo, Done }
enum Shape { Circle(Num), Rect(Num, Num) }

let s = Status.Done
let r = Shape.Rect(3, 4)
```

## Match

```lumen
fn area(shape) {
  match shape {
    Shape.Circle(radius) => 3.14159 * radius * radius,
    Shape.Rect(w, h)     => w * h,
  }
}
```

Patterns match on shape, and destructure as they go:

```lumen
match value {
  0                => "zero",
  [first, ..rest]  => "list starting with ${first}",
  Task { title }   => "a task: ${title}",
  Some(inner)      => "some ${inner}",
  None             => "nothing",
  n if n > 100     => "large",          // a guard
  _                => "something else",
}
```

Two things worth knowing:

- A bare **capitalised** name is a variant (`None`, `Done`); anything else binds
  a variable. That is why types are `UpperCamel` and bindings `lowerCamel`.
- A guard is an ordinary expression, so a guard that raises raises the whole
  `match`. Put shape patterns above value guards.

## Errors are values

Lumen has no exceptions. Anything that can fail returns a `Result`:

```lumen
fn divide(a, b) {
  if b == 0 { Err("cannot divide by zero") } else { Ok(a / b) }
}

match divide(10, 0) {
  Ok(value) => print(value),
  Err(why)  => print("failed: ${why}"),
}
```

`?` unwraps an `Ok`, or hands the `Err` straight back to your caller — so the
happy path stays flat:

```lumen
fn addBoth(a, b) {
  let x = parsePositive(a)?   // on Err, addBoth returns that Err
  let y = parsePositive(b)?
  Ok(x + y)
}
```

`Option` works the same way, with `Some` and `None`, for "there might not be
one" rather than "this might fail".

## Modules

```lumen
import { map, filter as keep } from "std/list"
import { helper } from "./helper.lm"

export fn publicThing() { 1 }
```

Ten standard modules ship with the language: `core`, `str`, `list`, `map`,
`math`, `json`, `fs`, `http`, `web`, `ai`. See [stdlib.md](stdlib.md).

## A website

```lumen
import { serve, page, json, notFound, escape } from "std/web"

fn handle(req) {
  if req.path == "/" {
    page(title: "Home", body: "<h1>hello</h1>")
  } else if req.path == "/health" {
    json({ ok: true })
  } else {
    notFound("<p>no ${escape(req.path)}</p>")
  }
}

serve(handler: handle, port: 3000)
```

```bash
lumen serve site.lm
curl http://127.0.0.1:3000
```

## AI

```lumen
import { chat } from "std/ai"

match chat(prompt: "Explain recursion in one sentence.") {
  Ok(reply) => print(reply),
  Err(why)  => print("failed: ${why}"),
}
```

With no API key this uses a deterministic `mock` provider, so it runs anywhere.
Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for a real answer.

Notice there is no `await` anywhere above. Lumen awaits I/O for you, so a
function that calls the network composes exactly like one that does not.

## Where next

- [spec.md](spec.md) — the precise rules
- [stdlib.md](stdlib.md) — every function
- [../ROADMAP.md](../ROADMAP.md) — what is not built yet, stated plainly
