# Lumen for Python programmers

You already know Python. This page is the shortest route from that to writing
useful Lumen — about ten minutes.

Read it in this order: the translation table to get moving, **What is the same**
so you can stop worrying about the rest, and then **What will bite you**. That
last section is the one worth not skipping; the first item in it fails silently.

Everything below runs. Try any of it with `lumen run file.lm`.

## The translation table

### Printing and strings

| Python | Lumen |
|---|---|
| `print("hi")` | `print("hi")` |
| `print(a, b)` | `print(a, b)` |
| `f"{name} is {age}"` | `"${name} is ${age}"` |
| `f"{1 + 2}"` | `"${1 + 2}"` |
| `len(s)` | `len(s)` |
| `s.upper()` / `s.lower()` | `s.upper()` / `s.lower()` |
| `s.strip()` | `s.trim()` |
| `s.split(",")` | `s.split(",")` |
| `s.split()` (on whitespace) | `s.split(" ")` — no whitespace-aware form |
| `",".join(xs)` | `xs.join(",")` |
| `s.replace("a", "b")` | `s.replace("a", "b")` |
| `s.startswith("a")` | `s.startsWith("a")` |
| `"x" in s` | `s.contains("x")` |
| `s[0]`, `s[-1]` | `s[0]`, `s[-1]` |
| `s[1:4]` | `s.slice(1, 4)` |
| `list(s)` | `s.chars()` |
| `s.splitlines()` | `s.lines()` |
| `s.rjust(8)` / `s.ljust(8)` | `s.padStart(8)` / `s.padEnd(8)` |
| `"ab" * 3` | `"ab".repeat(3)` |
| `int("42")` / `float("4.2")` | `num("42")` — returns `Ok`/`Err` |
| `str(42)` | `str(42)` |

`join` is the one that looks backwards: in Lumen the list is the subject, so it
is `xs.join(",")`, not `",".join(xs)`.

```lumen
let parts = ["  Hello World  ".trim().lower(), "again"]
print(parts.join(" / "))                 // hello world / again
print("a,b,c".split(",").reversed())     // ["c", "b", "a"]
print("x".padStart(3, "0"))              // 00x
```

### Lists

| Python | Lumen |
|---|---|
| `xs = [1, 2, 3]` | `let xs = [1, 2, 3]` |
| `len(xs)` | `len(xs)` or `xs.len()` |
| `xs[0]`, `xs[-1]` | `xs[0]`, `xs[-1]` |
| `xs[1:3]` | `xs.slice(1, 3)` |
| `xs[:2]` / `xs[2:]` | `xs.take(2)` / `xs.drop(2)` |
| `xs.append(4)` | `xs.push(4)` |
| `xs.pop()` | `xs.pop()` — gives `Some(v)` or `None` |
| `3 in xs` | `xs.contains(3)` |
| `xs.index(3)` | `xs.indexOf(3)` — gives `Some(i)` or `None`, never `-1` |
| `xs + ys` | `xs + ys` |
| `sorted(xs)` | `xs.sorted()` |
| `sorted(xs, key=len)` | `xs.sortBy(fn(x) { len(x) })` |
| `sorted(xs, reverse=True)` | `xs.sorted().reversed()` |
| `list(reversed(xs))` | `xs.reversed()` |
| `sum(xs)`, `min(xs)`, `max(xs)` | `sum(xs)`, `min(xs)`, `max(xs)` |
| `set(xs)` | `xs.unique()` — a list, not a set |
| `functools.reduce(f, xs, 0)` | `xs.reduce(f, 0)` |
| `all(bs)` / `any(bs)` | `bs.all(fn(b) { b })` / `bs.any(fn(b) { b })` |

Lumen's `all` and `any` always take a predicate; there is no one-argument form
over a list of booleans, which is why the last row looks noisier than Python's.

### List comprehensions

Lumen has none. You get the same results from `.filter()` and `.map()`:

| Python | Lumen |
|---|---|
| `[f(x) for x in xs]` | `xs.map(fn(x) { f(x) })` |
| `[x for x in xs if p(x)]` | `xs.filter(fn(x) { p(x) })` |
| `[f(x) for x in xs if p(x)]` | `xs.filter(fn(x) { p(x) }).map(fn(x) { f(x) })` |
| `sum(x*x for x in xs)` | `xs.map(fn(x) { x * x }).sum()` |

```lumen
let xs = [1, 2, 3, 4, 5]
print(xs.filter(fn(n) { n % 2 == 1 }).map(fn(n) { n * n }))   // [1, 9, 25]
print(range(1, 4).map(fn(n) { n * n }).sum())                 // 14
```

Same chain, three spellings — `x.f(a)`, `f(x, a)` and `x |> f(a)` all mean the
same call, because every library function takes its subject first:

```lumen
let xs = [1, 2, 3, 4]
print(xs.filter(fn(n) { n % 2 == 0 }).sum())      // 6
print(sum(filter(xs, fn(n) { n % 2 == 0 })))      // 6
print(xs |> filter(fn(n) { n % 2 == 0 }) |> sum())// 6
```

For a long chain the `|>` form can go down the page: a line break before `|>`
does not end the statement.

### Dicts, which are Maps

| Python | Lumen |
|---|---|
| `d = {"a": 1}` | `let d = { a: 1 }` |
| `d["a"]` | `d["a"]` or `d.a` |
| `d["missing"]` → `KeyError` | `d["missing"]` → `nil` |
| `d.get("a")` | `d.get("a")` → `Some(1)` / `None` |
| `d.get("a", 0)` | `d.getOr("a", 0)` |
| `"a" in d` | `d.has("a")` |
| `d["b"] = 2` | `d["b"] = 2` |
| `del d["a"]` | `d.remove("a")` — returns a new map, `d` is unchanged |
| `d.keys()` / `.values()` / `.items()` | `d.keys()` / `d.values()` / `d.entries()` |
| `len(d)` | `len(d)` |
| `for k, v in d.items():` | `for [k, v] in d { }` |
| `{k: v for ...}` | build pairs, then `fromEntries` |

`getOr` is the form a counter wants — a key nobody has seen counts as zero, so
the first sighting is an increment like any other:

```lumen
var counts = {}
for w in ["a", "b", "a"] { counts[w] = counts.getOr(w, 0) + 1 }
print(counts)                    // {a: 2, b: 1}
```

`get` returns an `Option` for when absence is the interesting case; `getOr` is
for when it is not.

Dict comprehensions go through `fromEntries`:

```lumen
import { fromEntries } from "std/map"

let names = ["ada", "bob"]
print(names.map(fn(n) { [n, len(n)] }) |> fromEntries())   // {ada: 3, bob: 3}
```

One wrinkle with no Python equivalent: a map key and a map method can share a
name. The key always wins, so `{ keys: "mine" }.keys` is `"mine"` while
`{ a: 1 }.keys` is the method. Adding methods to the language could therefore
never change what an existing lookup returned — but `m.keys` and `m.keys()` are
not always the same thing.

### Control flow

| Python | Lumen |
|---|---|
| `if c: ... elif c2: ... else:` | `if c { } else if c2 { } else { }` |
| `x if c else y` | `if c { x } else { y }` — `if` is an expression |
| `for x in xs:` | `for x in xs { }` |
| `for i in range(5):` | `for i in range(5) { }` or `for i in 0..5 { }` |
| `for i, x in enumerate(xs):` | `for [i, x] in xs.enumerate() { }` |
| `for a, b in zip(xs, ys):` | `for [a, b] in zip(xs, ys) { }` |
| `while c:` | `while c { }` |
| `break` / `continue` | `break` / `continue` |
| `and` / `or` / `not` | `&&` / `\|\|` / `!` |
| `# comment` | `// comment` or `/* ... */` |
| `match`/`case` | `match v { pattern => value, }` |

```lumen
let n = 7
let label = if n < 0 { "negative" } else if n == 0 { "zero" } else { "positive" }
print(label)

for [i, name] in ["ada", "bob"].enumerate() { print("${i}: ${name}") }
for [name, age] in zip(["ada", "bob"], [36, 41]) { print("${name} is ${age}") }
```

`range` behaves as you expect: `range(5)`, `range(2, 6)`, `range(10, 0, -2)`.
Unlike Python's it returns an actual list, not a lazy object.

### Functions

| Python | Lumen |
|---|---|
| `def f(a, b):` | `fn f(a, b) { }` |
| `def f(a, b=1):` | `fn f(a, b = 1) { }` |
| `return x` | `return x`, or just end with the expression |
| `f(b=2, a=1)` | `f(b: 2, a: 1)` |
| `lambda n: n * 2` | `fn(n) { n * 2 }` |
| `def f(*args, **kwargs)` | not available |
| `a, b = 1, 2` | not available — one `let` each |

```lumen
fn greet(name, greeting = "Hello") { "${greeting}, ${name}!" }

print(greet("Ada"))                        // Hello, Ada!
print(greet(greeting: "Hi", name: "Bob"))  // Hi, Bob!
print([1, 2, 3].map(fn(n) { n * 2 }))      // [2, 4, 6]
```

The last expression in a body is its value, so `return` is usually only for
leaving early. Declarations are hoisted, so a function may be used above where
it is written — no more arranging a file bottom-up.

### Classes and structs

Lumen has no classes. A `struct` holds the data; ordinary functions act on it.

```python
class Task:
    def __init__(self, title, done=False):
        self.title = title
        self.done = done

    def label(self):
        return ("[x] " if self.done else "[ ] ") + self.title

t = Task("write docs")
print(t.label())
```

```lumen
struct Task { title: Str, done: Bool }

fn label(t) { (if t.done { "[x] " } else { "[ ] " }) + t.title }

let t = Task { title: "write docs", done: false }
print(label(t))         // [ ] write docs
print(t |> label())     // [ ] write docs   — the same call, left to right
```

Every field must be supplied — there are no defaults on a struct, and no
`__init__` to supply them, so a constructor function is the usual answer.

Note that `t.label()` does **not** work. Method syntax is a feature of the
standard library's built-in types (`Str`, `List`, `Map`), not something your own
functions join. For your own code the choice is `label(t)` or `t |> label()`.

### Errors

| Python | Lumen |
|---|---|
| `raise ValueError("bad")` | `Err("bad")` — returned, not thrown |
| `try: ... except E as e:` | `match` on the `Result` |
| bare `raise` to propagate | `?` |
| `assert c, "msg"` | `assert(c, "msg")` |
| unrecoverable crash | `panic("msg")` |

```python
def parse_positive(s):
    n = int(s)                      # raises on bad input
    if n <= 0:
        raise ValueError(f"{n} is not positive")
    return n

try:
    print(parse_positive("2") + parse_positive("-1"))
except ValueError as e:
    print(f"failed: {e}")
```

```lumen
fn parsePositive(s) {
  match num(s) {
    Ok(n)  => if n > 0 { Ok(n) } else { Err("${n} is not positive") },
    Err(e) => Err(e),
  }
}

fn addBoth(a, b) {
  let x = parsePositive(a)?      // on Err, addBoth returns that Err
  let y = parsePositive(b)?
  Ok(x + y)
}

match addBoth("2", "-1") {
  Ok(v)  => print(v),
  Err(w) => print("failed: ${w}"),
}
```

`?` is the closest thing to letting an error propagate: it unwraps an `Ok` or
hands the `Err` straight back to your caller, so the happy path stays flat. It
needs a caller to hand that `Err` to, so it only works inside a function; at the
top level of a program it stops and tells you to `match` on the value instead.

### None, nil and Option

| Python | Lumen |
|---|---|
| `None` | `nil` |
| `x is None` | `x == nil` |
| `Optional[int]` as a return | `Option` — `Some(v)` or `None` |

The two are different tools. `nil` is the absence of a value; `Option` is a
function saying out loud that there might not be one. Library functions that can
come up empty — `first`, `last`, `at`, `find`, `map.get`, `input` — return an
`Option`, which is a `None` you have to open rather than a `None` you can forget
to check:

```lumen
match [1, 2, 3].first() {
  Some(v) => print("first is ${v}"),
  None    => print("empty"),
}
print([].first())       // None
```

### Imports

| Python | Lumen |
|---|---|
| `from math import sqrt` | `import { sqrt } from "std/math"` |
| `from math import sqrt as s` | `import { sqrt as s } from "std/math"` |
| `import math` then `math.sqrt` | not available — name what you want |
| `from .helper import f` | `import { f } from "./helper.lm"` |
| a name is public by default | `export fn f() { }` |

Much of what Python needs an import for is already in scope. `print`, `len`,
`range`, `sum`, `sorted`, `min`, `max`, `map`, `filter`, `enumerate`, `zip`,
`abs`, `round`, `input` and friends need no import at all, and neither does any
method on a `Str`, `List` or `Map`. Quite a few real programs need no `import`
line.

## What is the same

Relax about most of it. These carry over unchanged:

- **Reading and writing feel the same.** `print`, `len`, `range`, `sum`,
  `sorted`, `min`, `max`, `abs`, `round`, `enumerate`, `zip`, `input`, `type` —
  same names, same jobs, and all in scope with no import. Two small deviations:
  `type(x)` hands back a `Str` (`"List"`) rather than a type object, and `round`
  rounds halves upwards instead of to even, so `round(2.5)` is `3` here and `2`
  in Python. Upwards, not away from zero: `round(-2.5)` is `-2` in both.
- **Dynamic typing.** Values carry their types; you do not declare them.
  (Annotations parse, but nothing checks them yet — the roadmap is honest about
  this.)
- **Indexing and negative indices.** `xs[0]` and `xs[-1]` mean what they mean in
  Python, on both lists and strings.
- **Literals.** `[1, 2, 3]` is a list, `{ a: 1 }` is a dict-alike, `true`/`false`
  need only a lowercase spelling adjustment.
- **Functions are values.** Pass them, return them, close over variables.
  Closures capture by reference, exactly as in Python.
- **String interpolation.** `"${x}"` takes any expression, like an f-string.
- **Default and keyword arguments.** Same idea, `:` instead of `=` at the call
  site.
- **Structural equality.** `[1, 2] == [1, 2]` and `{ a: 1 } == { a: 1 }` are
  true, as in Python.
- **Floating point is floating point.** `0.1 + 0.2` is `0.30000000000000004`
  here too. No surprises, no improvements.
- **`match`.** If you have used Python 3.10's `match`, Lumen's is the same shape,
  with literal, binding, wildcard, list, struct and enum patterns plus guards.

## What will bite you

Seven real differences. The first one is the only one that goes wrong quietly,
so it comes first.

### 1. Only `nil` and `false` are falsy

`0`, `""`, `[]` and `{}` are all **true** in Lumen.

```lumen
let xs = []
if xs { print("this branch runs") }      // it does
if xs.isEmpty() { print("say what you mean") }
if len(xs) == 0 { print("or this") }
```

Every Python habit built on `if not items:`, `if not name:` or `while queue:`
inverts here, and nothing warns you — the code runs, it just takes the other
branch. Go through anything you port and replace truthiness tests on containers
with `isEmpty()` or `len(x) == 0`, and on numbers with `n == 0`.

What it buys: `if count:` and `if name:` stop meaning two different things
depending on whether the value happens to be empty. The bug class where a legit
`0` or `""` is read as "nothing here" does not exist. That is a real gain, but
you pay for it once, at the point where your fingers still type Python.

### 2. No exceptions

Nothing is thrown. Failure is a `Result` you get handed, and `?` is how you pass
it upwards. There is no `try` and no `except`.

What it costs: more words than `try:`. A three-line script that wants to die on
bad input has to say so. There is no equivalent of wrapping a large, messy call
tree in one `try` at the top and catching whatever comes out.

What it buys: no function has a hidden second exit. A signature tells you
whether a call can fail, and you cannot forget the failure path because the
value will not unwrap without it.

(`panic` does stop the program, and a failed `assert` stops it the same way —
as a runtime error, not as anything you could catch. They are for "this cannot
happen", not for ordinary failure.)

### 3. Immutable by default

`let` is the default; `var` is opt-in, and reassigning a `let` is an error.

```lumen
var count = 0
count += 1
print(count)      // 1
```

One subtlety worth having straight: `let` fixes the *binding*, not the contents.
`let xs = [1, 2]` still allows `xs.push(3)`, and `let d = { a: 1 }` still allows
`d.b = 2` — what you cannot do is point `xs` at a different list. It is
JavaScript's `const`, not a deep freeze.

### 4. Braces, not indentation

Blocks are `{ }`. Semicolons are optional and line breaks end statements, so it
looks close to Python once you stop noticing the braces.

What it costs: two characters per block, and the ongoing possibility of code
whose indentation lies about its structure — which Python simply does not have.

What it buys: pasting code into a chat window, an email or a REPL does not
change what it means.

### 5. One number type

There is one `Num`. No `int`, no `float`, so no `int()` or `float()` — parsing is
`num("42")`, which returns a `Result`.

What it costs, honestly: `Num` is a 64-bit float, so whole numbers are exact only
to about 9 quadrillion. Python's integers are arbitrary precision and Lumen's are
not — `9007199254740993` prints as `9007199254740992` here and correctly in
Python. If you are doing big-integer arithmetic, cryptography or exact counting
above 2^53, Python is the better tool and this is not a close call.

What it buys: for the ordinary 99%, one number type means no `1` versus `1.0`
distinction to track and no accidental integer-vs-float branch.

There is also no `**`. Use `pow` from `std/math`:

```lumen
import { pow, sqrt } from "std/math"
print(pow(2, 10))    // 1024
print(sqrt(16))      // 4
```

### 6. Comments are `//`

`#` is not a comment. This one announces itself with a parse error, so it costs
you seconds rather than an afternoon. Block comments are `/* ... */`.

Strings are double-quoted only — there is no `'single'` form.

### 7. No classes

Covered above: `struct` for the data, functions for the behaviour, and method
syntax that comes from the calling convention rather than an object model.

What it costs: no inheritance, no `__init__`, no `__repr__`, no properties, no
mixins — and, most noticeably day to day, no methods on your own types. Your
functions are called `f(x)` or `x |> f()`, never `x.f()`. Code that models a
domain as a class hierarchy has to be rethought, not translated.

What it buys: data is data. There is no question about where behaviour lives or
what a subclass overrode, and `struct` + `enum` + `match` covers a large share of
what class hierarchies are usually used for.

### 8. `main()` calls itself

Python needs the call at the bottom:

```python
def main():
    print("hi")

if __name__ == "__main__":
    main()
```

Lumen does not. A file that defines `fn main` runs its top-level statements and
then calls `main` for you:

```lumen
fn main() {
  print("hi")
}
```

Writing the call as well would run everything twice, so it is refused:

```text
main()

RS008: `main()` is called for you, so this runs the program twice
```

Nothing about the double run would have raised — you would simply have seen the
output twice and wondered — which is why it is worth a diagnostic rather than a
footnote. There is no `__name__` and no import-versus-run distinction: a module
you import runs its own top-level statements once, and only the file you named
on the command line has its `main` called.

## The standard library, by the Python module you would reach for

Lumen's modules take their subject first, so every function in them is also a
method. `import` is by name, always — there is no `import module` form and no
`module.function` access.

| Python | Lumen |
|---|---|
| `re` | `std/regex` — `test`, `find`, `findAll`, `replace`, `split`, `escape` |
| `csv` | `std/csv` — `rows`, `records`, `write`, `writeRecords` |
| `pathlib` / `os.path` | `std/path` — `join`, `dir`, `base`, `stem`, `ext`, `relative`, `isInside` |
| `subprocess` | `std/process` — `run`, `which`. No shell, ever |
| `json` | `std/json` — `parse` and `stringify`, both returning a `Result` |
| `datetime` | `std/time` — UTC only, instants as milliseconds |
| `random` | `std/math` — `random`, `randomInt`, `shuffle`, `choice`, `seed` |
| `math` | `std/math` |
| `pathlib.Path.read_text` | `std/fs` — `read`, `write`, `walk`, `stat`, `copy` |
| `urllib` / `requests` | `std/http` — `get`, `post`, `request` |
| `http.server` / Flask | `std/web` — a router, HTML, JSON, static files |
| `sys.stdin.read()` | `inputAll()` — in the prelude, no import |
| `input()` | `input()` — returns `Some(line)` or `None` |
| `sys.exit(n)` | `exit(n)` from `std/core` |
| `hashlib` / `hmac` / `secrets` | `std/crypto` — `sha256`, `hmacSha256`, `token`, `equals` |
| `collections.Counter` | `xs.groupBy(f)` and `mapValues(len)` |
| `set` | `std/set` — sets are lists with no repeats; there is no set type |
| `itertools` | `std/list` — `windows`, `chunk`, `zip`, `scan`, `flatMap` |

Four differences worth knowing before you hit them:

- **`re` patterns are strings, and the flags are named.** `re.M` is
  `multiline: true`, `re.I` is `ignoreCase: true`, `re.S` is `dotAll: true`.
  There is no `(?m)` — JavaScript has no inline modifier group, so a pattern
  written that way does not compile. The dialect is otherwise the one you know.
- **`subprocess` has no `shell=True` equivalent.** `run("ls", ["-l"])` and
  nothing else: no `*`, no `|`, no `>`, no `&&`. Each of those is a line of
  Lumen instead, and in exchange there is never a quoting question.
- **`csv` refuses ragged rows.** A row with more or fewer fields than the
  header is an `Err` naming the row, rather than a guess that silently shifts
  every later column.
- **`random.seed` exists and does what you expect.** The generator is written in
  the library, so a seeded sequence is the same on every machine.

## Where Python is simply more convenient

A comparison that only flatters its own side is not worth reading. These are
places where you will miss Python, with no consolation offered:

- **Format specifiers.** There is no `f"{x:>8.2f}"` in one piece. The parts are
  there — `fixed(x, 2)` for the decimals, `padStart(8)` for the width — but
  they have to be written separately: `fixed(x, 2).padStart(8)`.
- **`**kwargs`.** Not available. (`*args` is `fn f(..args)`.)
- **Slice syntax.** `xs[1:3]` and `xs[::-1]` are `xs.slice(1, 3)` and
  `xs.reversed()` — fine, but longer.
- **Sets and tuples.** Neither type exists. `unique()` returns a list, and a pair
  is a two-element list.
- **Comprehensions.** For nested or dict comprehensions especially,
  `.filter().map()` plus `fromEntries` is more machinery than Python needs.
- **Arbitrary-precision integers.** See above.
- **The ecosystem.** PyPI holds hundreds of thousands of packages. Lumen has
  nineteen standard modules and no package manager at all. For anything outside
  what ships in the box, Python is not in competition with Lumen; it has already
  won.

## Translate this Python

A word counter, in both languages. Same output.

```python
def top_words(text, limit=3):
    words = text.lower().replace(",", " ").split()
    counts = {}
    for w in words:
        if len(w) > 3:
            counts[w] = counts.get(w, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    return ranked[:limit]

text = "The rain in Spain falls mainly on the plain, the rain in Spain"
for word, count in top_words(text):
    print(f"{word:>8}  {count}")
```

```lumen
fn topWords(text, limit = 3) {
  let words = text.lower().replace(",", " ").split(" ")
  var counts = {}
  for w in words {
    if len(w) > 3 {
      if counts[w] == nil { counts[w] = 0 }
      counts[w] = counts[w] + 1
    }
  }
  counts.entries().sortBy(fn(kv) { -kv[1] }).take(limit)
}

let text = "The rain in Spain falls mainly on the plain, the rain in Spain"
for [word, count] in topWords(text) {
  print("${word.padStart(8)}  ${count}")
}
```

```
    rain  2
   spain  2
   falls  1
```

Everything that changed here is something you have already met above: `def`
became `fn` with braces; the default argument is `limit = 3`; `split()` with no
argument became `split(" ")`; `counts.get(w, 0)` became an explicit `nil` check;
`sorted(..., key=...)` became `.sortBy(...)`; the slice `[:limit]` became
`.take(limit)`; the f-string's `:>8` became `.padStart(8)`; and the `return`
vanished because the last expression in a body is already the value.

Nothing here was a rewrite. That is the usual experience: the shape of a Python
script survives, and the edits are local.

## Where next

- [tour.md](tour.md) — the language in ten minutes, without the Python framing
- [stdlib.md](stdlib.md) — every function that ships
- [philosophy.md](philosophy.md) — why the differences above are what they are
- [../ROADMAP.md](../ROADMAP.md) — what is not built yet, stated plainly

And from inside the terminal, `help()` lists everything, `help("abc")` shows what
you can call on a string, and `help(range)` shows a signature. That is often
faster than coming back here.
