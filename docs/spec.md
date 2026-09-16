# The Lumen Language Specification

**Version 0.1.0**

This document defines Lumen. Where the implementation and this document
disagree, that is a bug in one of them — please say which. The conformance
suite in `tests/conformance/` is the executable half of this specification.

---

## 1. Source text

A Lumen source file is UTF-8 text with the extension `.lm`.

### 1.1 Line structure

Line breaks are significant: a statement ends at a line break. Semicolons are
therefore optional, and `;` is accepted as an explicit terminator.

A line break is **not** significant in three cases:

1. Inside `(`, `[`, or an argument list.
2. After a trailing operator (`1 +` continues on the next line).
3. Before a leading `|>`, `.`, or `?.` on the next line.

Rule 3 is what lets a pipeline be written down the page:

```lumen
let names = users
  |> filter(fn(u) { u.active })
  |> map(fn(u) { u.name })
```

Runs of blank lines collapse into a single terminator.

### 1.2 Comments

```lumen
// to the end of the line
/* block, which /* nests */ correctly */
```

### 1.3 Indentation

Indentation carries no meaning. Any amount of leading whitespace is accepted
anywhere, and two programs that differ only in indentation are the same program.

`lumen fmt` defines a canonical indentation, and defines it narrowly. It is
specified here because a formatter that can be argued with is a formatter that
gets turned off:

- Two spaces per level. A level is added by **a line that leaves a bracket
  open**, not by each bracket — `print(match c {` opens two and indents its body
  once.
- A line's closing brackets, where nothing precedes them on the line, return it
  to the indentation of the line that opened them.
- A line beginning `.`, `?.` or `|>` is indented one level past the line it
  continues, unless a bracket has already indented it.
- A line is left where it is when it starts at the column of the first element
  after an open `(`, `[` or `{` — that is alignment, and it is the author's
  decision. It moves with that line if the line itself moves.
- Trailing whitespace is removed, runs of blank lines collapse to one, and the
  file ends with exactly one newline.

Nothing else changes. Line breaks are never moved — §1.1 makes a line break part
of the program's meaning — and spacing within a line is never touched, so a set
of match arms lined up by hand

```text
  x if x % 15 == 0 => "FizzBuzz",
  x if x % 3 == 0  => "Fizz",
  _                => "${n}",
```

stays as written. A file that does not lex is returned unmodified.

### 1.4 Identifiers and keywords

An identifier starts with a letter or `_` and continues with letters, digits or
`_`. The reserved words are:

```
let var fn return if else while for in match struct enum
import export break continue true false nil and or not async await
```

`async` and `await` are reserved for future explicit concurrency; see §7.4.

**`from` and `as` are not reserved.** Each appears in exactly one position in
the grammar — after the `}` of an import list, and between an imported name and
its alias — so the parser looks for the word where it means something and
leaves it an ordinary identifier everywhere else:

```lumen
import { map as mapped } from "std/list"

let from = "/tmp/a"
fn move(from, to) { "${from} -> ${to}" }
```

Reserving `from` bought nothing: it cannot begin a statement or an expression,
so there is nothing for it to be ambiguous with, and `let from = ...` and
`replace(s, from, to)` are what people write.

A keyword is only a keyword where a statement or an expression could begin.
Where nothing but a name can appear — after `.` or `?.`, as a map key, as a
struct field in a declaration, a literal or a pattern, as an imported name or
its alias, or before the `:` of a named argument — a keyword is that name:

```lumen
let m = { if: 1, for: 2, true: 3 }
print(m.if)
struct Config { for: Num, while: Bool }
```

This matters because data does not know Lumen's keywords: `parse("{\"if\": 1}")`
produces a map with a key called `if`, and before this rule there was no way to
write that key or to reach it with a dot.

A **binding** name is the exception — `let`, `var`, `fn`, a parameter, a struct
or enum name. Those have to be readable as a bare expression later, where a
keyword really is ambiguous, so `fn f(in)` is still an error.

### 1.5 Literals

| Form | Examples |
|---|---|
| Number | `42` `3.14` `1_000_000` `0xFF` `0b1010` `0o17` `1e6` `2.5e-3` |
| String | `"text"` `"multi\nline"` `"interpolated ${expr}"` |
| Boolean | `true` `false` |
| Nil | `nil` |
| List | `[1, 2, 3]` |
| Map | `{ key: value, "quoted": 2, [computed]: 3 }` |

All numbers are IEEE-754 doubles. `_` may separate digits anywhere between them.

A `.` is only part of a number when a digit follows, so `0..10` is a range, not
a malformed float.

### 1.6 Strings

Strings are double-quoted and may span lines. Escapes are `\n` `\t` `\r` `\0`
`\\` `\"` `\$` `\u{...}`, and a backslash before a line break swallows that
break.

`${expr}` interpolates any expression. Brace nesting and nested string literals
are tracked, so `"${ pick("}") }"` is read correctly.

---

## 2. Values and types

### 2.0 A value may contain itself

Lists, maps and structs are mutable, so `a.push(a)` builds a value that contains
itself. That is a real value, not an error, and every operation on one either
answers or says why it cannot:

| Operation | On a cyclic value |
|---|---|
| `print`, `inspect` | a back-reference: `[1, [...]]` |
| `==` | terminates; two cycles built the same way are equal |
| `clone` | a copy with its own cycle, sharing nothing with the original |
| `std/set` membership | works, and follows `==` |
| `stringify` | **refuses**, naming where the cycle closes |

`stringify` is the only refusal, and it has to be: JSON has no way to write "the
value we are already inside".

One narrow limit, stated rather than hidden. `==` calls two cyclic values equal
when nothing distinguishes them however far they are unrolled, so `a = [a]` equals
`b = [[b]]`; `std/set` keys them differently and can hold both. Agreeing there
needs a canonical form for infinite trees, which is not carried for a value nobody
builds on purpose.

| Type | Description |
|---|---|
| `Nil` | The single value `nil` |
| `Bool` | `true` or `false` |
| `Num` | A double-precision number |
| `Str` | An immutable UTF-8 string |
| `List` | An ordered, mutable sequence |
| `Map` | String-keyed, insertion-ordered |
| *struct* | A named record, its type name being the struct's name |
| *enum* | A tagged union value |
| `Fn` | A function, whether written in Lumen or native |
| `Module` | The result of an import |

`type(x)` returns this name as a `Str`.

A `Num` is an IEEE 754 double, with one restriction: **`NaN` is not a Lumen
value.** Any arithmetic that would produce one is `RT046`, and the standard
library reports the cases it can reach — `sqrt(-1)`, `log(0)`, `pow(-8, 0.5)` —
rather than returning one. A NaN would print as `NaN`, compare unequal to
another value printing as `NaN`, and be neither less than nor greater than
anything; that is not a value a program can reason about.

`Infinity` is a value, and is left as it is: it means "larger than can be
said", it is equal to itself, and it orders consistently against every finite
number. It has no literal, so it arises only from overflow.

A `Str` is a sequence of Unicode **code points**, not UTF-16 units. `len("😀")`
is 1, `"😀".chars()` has one element, and slicing never splits a character in
half.

### 2.1 Truthiness

**Only `nil` and `false` are falsy.** `0`, `""` and `[]` are all true. This is
deliberate: it removes the class of bugs where an empty or zero value silently
takes the wrong branch.

### 2.2 Equality

`==` is structural and deep for `List`, `Map`, struct and enum values, and
compares by identity for functions and modules. It never coerces: `1 == "1"` is
`false`.

---

## 3. Declarations

### 3.1 Bindings

```lumen
let total = 1          // immutable — reassignment is an error
var count = 0          // mutable
count += 1
```

An inner scope may shadow an outer name. Assigning to a `let` binding is
error `RT029` (`RS005` when the static checker gets there first).

The left side may be a list pattern, which is how a function returns more than
one thing:

```lumen
fn minMax(xs) { [min(xs), max(xs)] }

let [lo, hi] = minMax([3, 1, 4, 1, 5])
let [first, ..rest] = [1, 2, 3]
var [x, y] = [0, 0]              // `var` makes both mutable
```

It is the same pattern language `match` and `for` use, nested patterns and
`_` included. A `let` has no second arm to fall through to, so a pattern that
does not fit the value is `RT047` rather than a miss — use `match` when a value
may or may not have the shape you expect.

The same shape works on the left of an ordinary assignment, where each element
is a place in its own right — a variable, a field, an index, or a nested list:

```lumen
var p = 1
var q = 2
[p, q] = [q, p]                  // a swap, with no temporary
[point.x, row[1]] = [7, 8]
```

The right side is evaluated in full before anything is written, which is why
the swap works. Only plain `=` takes a list of places, and there is no
`..rest`: the lengths must match, or `RT047`.

### 3.2 Functions

```lumen
fn add(a: Num, b: Num = 2) -> Num { a + b }
fn shout(..parts) { parts.join(" ").upper() }   // every argument, as a List
let double = fn(n) { n * 2 }
```

- A function's value is the value of its last statement; `return` exits early.
- Parameters may have type annotations (§6) and default values.
- Declarations are **hoisted**, so order within a scope does not matter and
  mutual recursion needs no forward declaration.
- Arguments may be passed positionally or by name; all positional arguments must
  precede all named ones.
- A final parameter written `..name` collects every remaining positional
  argument into a `List`, empty if there are none. At most one, always last,
  never with a default value — `PA017` for either mistake.

If a module declares `fn main()`, it is called after the module's top-level
statements have run — automatically, so writing `main()` as well is `RS008`.

### 3.3 Structs

```lumen
struct Task { title: Str, done: Bool }

let t = Task { title: "ship", done: false }
t.done = true
```

A literal must supply every field exactly once; field order is free. An unknown
field is `RT013`, a missing one `RT015`.

### 3.4 Enums

```lumen
enum Status { Todo, Done }
enum Shape { Circle(Num), Rect(Num, Num) }

let a = Status.Done
let b = Shape.Rect(3, 4)
```

Variants are referenced through their enum (`Status.Done`). A variant with a
payload is a constructor function.

`Result` and `Option` are built in, and their constructors — `Ok`, `Err`,
`Some`, `None` — are global, so they need no qualifier.

### 3.5 Modules

```lumen
import { map, filter as keep } from "std/list"
import { helper } from "./helper.lm"

export fn publicThing() { 1 }
```

A path beginning `std/` names a standard module (§9); anything else is a path to
a `.lm` file relative to the importing file. Only `export`ed names are visible.
A module is evaluated once and cached. Import cycles are an error (`RT043`).

---

## 4. Expressions

### 4.1 Precedence

Loosest to tightest:

| Level | Operators | Associativity |
|---|---|---|
| 1 | `=` `+=` `-=` `*=` `/=` | right |
| 2 | `\|>` | left |
| 3 | `\|\|` `or` | left |
| 4 | `&&` `and` | left |
| 5 | `==` `!=` | left |
| 6 | `<` `<=` `>` `>=` | left |
| 7 | `..` | left |
| 8 | `+` `-` | left |
| 9 | `*` `/` `%` | left |
| 10 | `**` | **right** |
| 11 | unary `-` `!` `not` | right |
| 12 | call `()`, index `[]`, member `.` `?.`, postfix `?` | left |

`&&`/`and` and `||`/`or` are the same operator spelled two ways, and both
short-circuit.

`**` is the only right-associative binary operator, so `2 ** 3 ** 2` is
`2 ** (3 ** 2)` — 512, not 64. Grouping to the left is written `(2 ** 3) ** 2`,
which is also just `2 ** 6`.

A unary operator directly before `**` is **rejected**, not resolved:

```text
-2 ** 2        PA018: ambiguous `-` before `**`
-(2 ** 2)      -4
(0 - 2) ** 2   4
```

Both readings have a language behind them — Python reads `-2 ** 2` as `-(2 ** 2)`,
and binding the unary operator first, as the table above would, gives `4` — so a
reader arriving from either one is entitled to assume theirs. Picking a side
quietly means somebody's arithmetic is wrong with nothing to point at, so the
parentheses are required. A unary operator on the *right* is unambiguous and
allowed: `2 ** -1` is `0.5`.

### 4.2 Arithmetic

`+` adds two `Num`s, concatenates two `Str`s, or concatenates two `List`s.
Mixing types is `RT016` — to build a string from mixed values, use
interpolation.

`**` raises a `Num` to a `Num` power. `2 ** 10` is `1024`, `9 ** 0.5` is `3`,
and `2 ** -2` is `0.25`.

Division or remainder by zero is `RT018`, not `Infinity` or `NaN`. `0` to a
negative power is the same error by another spelling — `0 ** -1` is `1 / 0` —
and reports it as such. A negative number to a fractional power has no real
answer, and is `RT048` rather than a `NaN`: `(0 - 8) ** (1 / 3)` is -2 in
arithmetic but `NaN` in IEEE 754, and Lumen has only real numbers. An operation
whose result would be `NaN` for any other reason — `Infinity - Infinity`,
`Infinity * 0`, `Infinity / Infinity` — is `RT046`. Overflow to `Infinity` is not
an error.

### 4.3 Comparison

`<` `<=` `>` `>=` accept two `Num`s or two `Str`s. Anything else is `RT019`.

### 4.4 Pipeline

`x |> f(a)` calls `f(x, a)`; `x |> f` calls `f(x)`. Standard-library functions
take their subject first specifically so pipelines read left to right.

### 4.5 Range

`a..b` produces the list `[a, a+1, ..., b-1]`. Bounds must be whole numbers. The
range is **materialised as a list** in v0.1 and capped at 10,000,000 elements
(`RT008`); see [ROADMAP.md](../ROADMAP.md).

### 4.6 Indexing and members

- `list[i]` — `i` may be negative to count from the end. Out of range is `RT022`.
- `str[i]` — yields a one-character `Str`, by code point.
- `map[k]` — `k` must be a `Str`. **A missing key yields `nil`**; use
  `std/map.get` for an `Option` instead.
- `value.field` — struct fields, map keys, module exports, enum variants, and
  methods (§4.10).
- `value?.field` — yields `nil` if `value` is `nil` instead of erroring.

Member resolution is ordered, and the order is what makes methods additive:

| Receiver | Resolution order |
|---|---|
| struct | its fields, then methods registered for that struct's type |
| map | **its own keys first**, then methods, then `nil` |
| module | its exports; anything else is `RT025` |
| enum type | its variants; anything else is `RT026` |
| `Str`, `List` | methods; anything else is `RT027` |

Because a map's own keys win, `{ keys: "mine" }.keys` is `"mine"`. Adding a
method can therefore never change what an existing lookup returns.

### 4.7 Method calls

`x.f(a)` calls `f(x, a)`. Every standard-library function takes its subject
first, so for a function whose subject's type has a method table these three are
one expression:

```text
x.f(a)        f(x, a)        x |> f(a)
```

Which types have one is set out below, and it is six of them rather than all.
`f(x, a)` and `x |> f(a)` always work — they are the same call written two
ways — while `x.f(a)` needs `f` to be on the table for whatever `x` is.
`"abc".sha256()` is therefore `RT027`, and `sha256("abc")` is how it is spelled.

A method is an ordinary function with its first parameter already supplied. That
first parameter disappears from the signature, so arity checking, defaults and
named arguments all apply to the parameters that remain:

```lumen
"a,b".split(",")                // split(s, separator)
"a,b".split(separator: ",")     // named arguments still work
"7".padStart(3)                 // padStart(s, width, fill = " ")
"a,b".split()                   // error: missing a value for `separator`
```

Methods come from two places.

**Per type**: `Str`, `List`, `Map`, `Num`, `Option` and `Result` each have a
table, supplied by `std/str`, `std/list`, `std/map`, `std/math`, `std/option` and
`std/result`.

**On every value**: `str`, `inspect`, `type`, `clone` and `isNil` — the five
whose subject is any value at all. `inspect` writes a value the way source
would: its output is a Lumen expression that reads back as the same value, so a
string carries `\"`, `\\`, `\n`, `\t`, `\r`, `\$` before a `{`, and `\u{…}` for
anything else unprintable, and a `Map` key is written bare only when it is a
plain name and quoted otherwise. `str` is the plain rendering and does none of
that — `"a\nb".str()` is two lines, `"a\nb".inspect()` is one. `42.str()`, `p.str()` on a struct and
`v.type()` therefore work, and a chain like `n.str().padStart(3)` has somewhere
to put the conversion, which `"${n}"` does not. A per-type method of the same
name always wins, so these can never change what an existing call means.

This is **not** a general fallback to whatever function is in scope, and the
difference is a deliberate one about error messages. Under a general fallback
`[1, 2].upper()` would call `upper` with a `List` and fail somewhere inside
`std/str`; as it is, it is `RT027: List has no method `upper`` with the ones it
does have listed. A worse error is not worth the convenience.

`help(value)` lists the methods available on any value.

This is a calling convention, not an object model: there is no inheritance, no
`self`, and no dynamic dispatch. A method that does not exist is `RT027`, with a
suggestion when one is close.

### 4.8 Conditionals

`if` is an expression:

```lumen
let label = if n < 0 { "negative" } else if n == 0 { "zero" } else { "positive" }
```

With no `else`, a false condition yields `nil`.

### 4.9 Match

```lumen
match value {
  0                => "zero",
  [first, ..rest]  => "list starting ${first}",
  Task { title }   => "task ${title}",
  Shape.Rect(w, h) => "rect ${w}x${h}",
  Some(inner)      => "some ${inner}",
  n if n > 100     => "large",
  _                => "something else",
}
```

Arms are tried in order; the first whose pattern matches **and** whose guard is
truthy wins. If none matches, that is `RT020`.

Patterns:

| Pattern | Matches |
|---|---|
| `_` | anything, binding nothing |
| `name` | anything, binding it |
| `1` `"a"` `true` `nil` | that literal, by `==` |
| `[a, b]` | a list of exactly that length |
| `[a, ..rest]` | a list of at least that length; `rest` takes the remainder |
| `Name { field }` | a struct of that type; shorthand binds the field |
| `Name { field: pattern }` | a struct field matched against a nested pattern |
| `Enum.Variant(a, b)` | that variant, binding its payload |
| `Variant(a)` | that variant of any enum |

> **Naming rule.** A bare capitalised name in a pattern is a nullary variant
> (`None`, `Done`); anything else binds a variable. This is why Lumen types and
> variants are `UpperCamel` and bindings are `lowerCamel`.

> **Guards are ordinary expressions.** A guard that raises raises the whole
> `match`. Write guards that are total for the values that can reach them — in
> practice, put shape patterns above value guards.

### 4.10 Error propagation

Postfix `?` applies to a `Result` or an `Option`:

- `Ok(v)` / `Some(v)` → evaluates to `v`
- `Err(e)` / `None` → **returns that value from the enclosing function**

Anything else is `RT010`. Used at the top level of a program with nothing to
return to, it is `RT001`.

---

## 5. Statements

```text
while condition { ... }
for pattern in iterable { ... }
break
continue
return value
```

`for` iterates a `List`, a `Str` (by character), a `Map` (as `[key, value]`
pairs), or a range. Anything else is `RT004`. The binding is a full pattern, so
`for [k, v] in someMap { ... }` destructures.

`return`, `break` and `continue` are also expressions, and mean the same thing
there as they do on a line of their own. They produce no value — they leave —
so they compose with anything:

```lumen
fn parseAll(lines) {
  var out = []
  for line in lines {
    let n = match line.toNum() {
      Ok(n)  => n,
      Err(_) => continue,          // skip this line
    }
    out.push(n)
  }
  Ok(out)
}
```

A `return` in expression position takes its value at the lowest precedence, so
`return a + b` returns the sum; a comma, a closing bracket or the end of the
line ends it. `break` and `continue` never take one.

`break` and `continue` outside a loop are `RS006`. A function boundary counts:
a `break` inside a lambda cannot leave the loop the lambda was written in,
because by the time it runs that loop may already have finished.

`return` outside any function is **not** an error, unlike those two: it ends the
module, which is a useful way to stop early and is what a reader expects it to
mean. Its value has nowhere to go in a file and is discarded; at the REPL, where
a module is one line, it is the answer and is printed. There is no `RS` code for
it because there is nothing wrong with it.

---

## 6. Type annotations

Annotations are accepted everywhere a binding is introduced:

```lumen
let n: Num = 1
fn add(a: Num, b: Num) -> Num { a + b }
struct Task { title: Str, done: Bool }
```

Annotations are **checked where they are written**, before the program runs:

| Code | Reported when |
|---|---|
| `TY001` | An argument does not match the parameter's declared type |
| `TY002` | A returned value does not match the declared return type |
| `TY003` | An initialiser does not match a binding's declared type |
| `TY004` | A struct literal field does not match the field's declared type |
| `TY005` | An operator's operands cannot be what they are |
| `TY006` | An assignment does not match the target's declared type |
| `TY007` | A call passes more arguments than the function takes |
| `TY008` | A call leaves out an argument the function requires |
| `TY009` | A `match` arm names a pattern the subject's type can never produce |
| `TY010` | A statement's only call answers with a value nothing takes — a **warning** |
| `TY011` | An index cannot be one, or the thing indexed cannot be |

`TY005` speaks only when **both** operand types are known. `1 - "x"` is reported;
`a - "x"` for an unannotated `a` is not, because `a` is `Any`. That restraint is
what keeps the check sound rather than merely useful: `Num - Str` has no reading
under which it works, so reporting it can never be wrong, while guessing about an
`Any` could be. The rules are the ones §4.2 and §4.3 already state, moved earlier:
`+` joins two `Num`s, two `Str`s or two `List`s; the other arithmetic wants two
`Num`s; ordering wants two `Num`s or two `Str`s. `==` and `!=` accept anything,
deliberately — comparing values of different types is `false`, not an error.

`TY006` applies the same promise to assignments, not only to declarations. An
annotation says what a binding holds for its whole life, and a `var` is where the
second value arrives:

```text
var v: Num = 1
v = "text"          TY006: `v` is Num but is being given Str

struct P { x: Num }
var p: P = P { x: 1 }
p.x = "text"        TY006: `p.x` is Num but is being given Str
```

A compound assignment is an operator *as well as* a store, so `total += "x"` on a
`Num` is reported by `TY005` for the operands. An unannotated `var` is `Any`, so
reassigning it to another type stays silent and stays legal — a `var` really can
hold anything, and nothing about it promised otherwise.

The checking is **gradual**, and one rule makes it so: anything the checker
cannot determine has type `Any`, and `Any` is compatible with everything in
both directions. A program that writes no annotations therefore has every
expression typed `Any` and cannot produce a single type diagnostic. The checker
is invisible until you opt in.

There is deliberately **no inference**, with one sound exception. Inferring
`let n = 1` as `Num` in general would start rejecting `n = "text"` in code that
never asked to be checked. The exception is an unannotated `let`: because `let`
is immutable, the binding can never later hold a different type, so taking the
type from its value cannot become wrong. A `var` stays `Any`.

### The standard library's types

The checker cannot read the standard library — the language core depends on
nothing, which is what makes a browser or an embedded host a wiring exercise
rather than a rewrite. So it is *told*: an implementation hands the static
passes the type of every name the prelude puts in scope, every module export,
and every method, and the checker treats them exactly as it treats an
annotation somebody wrote.

That is what makes `upper(1)`, `"abc".padStart("x")` and `[1, 2].take("two")`
static errors rather than run-time ones, and it is where most of what this pass
catches now comes from — a program that writes no annotations of its own still
calls the library on nearly every line.

A signature is written in the language's own annotation syntax, so there is
nothing new to learn and nothing that can drift into a private notation:

```text
upper      (s: Str) -> Str
padStart   (s: Str, width: Num, fill: Str = " ") -> Str
split      (s: Str, separator: Str) -> List<Str>
```

Three restraints keep this sound, all of them the no-false-positives rule:

- **A function with no declared signature is `Any`.** The library can be typed
  a piece at a time, and an untyped function is exactly as unchecked as it was
  before any of it was typed.
- **Nothing is narrowed past what the implementation accepts.** `contains(xs,
  value)` works on a list of anything, so `value` is `Any`; `slice`'s `end`
  defaults to nil and means "to the end", so it is `Any` rather than `Num`.
- **A variadic declares nothing.** `min` and `max` take a list *or* the numbers
  themselves, which no fixed parameter list describes, so they declare none and
  every spelling of them stays silent.

`TY007` and `TY008` follow from the same knowledge — once a function's
parameters are known, so is how many arguments a call may have. Both are
reported only for a function that was actually *declared*: a `fn(Num, Num) ->
Num` annotation records no defaults, so a value of that type may well be
`fn(a, b = 1)`, and a one-argument call is perfectly good. They also stay quiet
the moment an argument is named, because the interpreter then has a better
answer than a count: `greet(nmae: "Ada")` is a typo in `nmae`, not a missing
`name`.

`TY009` is `RS003` for the reason only this pass can see. `RS003` reports an arm
unreachable because an earlier one already covers it; `TY009` reports one
unreachable because the subject's type cannot produce it at all —
`match stringify(v) { Ok(t) => ..., Err(e) => ... }`, where `stringify` answers
with a `Str`. Every arm is dead, so the match cannot succeed, and it used to
fail at run time as `RT020` with the caret on the subject, which is the one part
that was right.

Four restraints, the same no-false-positives rule as everywhere else:

- An `Any` subject says nothing, so an unannotated program is silent.
- A variant this pass cannot trace to exactly one enum says nothing, which
  covers both an unknown name and two enums declaring a variant alike.
- A payload's pattern is not checked, only the shape it sits in: `Ok(Some(x))`
  against a `Result` is fine whatever the payload's type turns out to be.
- **`nil` is never impossible.** It is the one value that legitimately turns up
  where a type says otherwise, so `match n { nil => ..., _ => ... }` guarding
  against exactly that is defensive rather than wrong.

`TY010` is a warning rather than an error, the line `RS011` draws: the program
runs, and a statement that does nothing is a mistake in what the author meant
rather than in what the machine can do.

```text
var xs: List<Num> = [3, 1, 2]
xs.sort()      ← warning[TY010]: this statement does nothing
print(xs)      → [3, 1, 2]
```

`xs.sort()` is the first thing anyone arriving from Python or JavaScript writes,
and it sorts nothing: `sort` answers with a new list and leaves its subject
alone, as almost everything in the library does. `docs/stdlib.md` states that
rule — *"nothing mutates unless its name says so"* — and this is what enforces
it. The two functions named there as the exceptions, `push` and `pop`, do mutate
and so are silent; their twenty neighbours are not and so are not. The library
states that exception list in one place, so the rule and the diagnostic cannot
drift apart.

The restraints again keep it to what is known:

- Only a call to a function the **library** described, by identity rather than
  by name, so a program declaring its own `sort` is left alone.
- Only when the answer's type is known and is not `Nil` — a function with
  nothing to give back was obviously called for what it does.
- Never the last statement of a block, which is the block's own value.
- All three spellings alike, because §4.7 says they are one expression: `f(x)`,
  `x.f()` and `x |> f()` warn or stay silent together.

`TY011` asks `RT021` and `RT023`'s question a pass earlier. Both have always had
the two types in hand at run time, so nothing was missing but the timing. A
`List` and a `Str` are indexed by a `Num`, a `Map` by a `Str`, and nothing else
is indexed at all — and again only when **both** sides are known, since a
container indexed by something `Any` is a program that may well be right.

What is **not** checked in this pass: parameters and `var` bindings without
annotations, anything requiring flow analysis, and generics — `map(xs, f)`
returns a list of whatever `f` gives back, and there is no way to say so, so its
element type is left off. Those need the full checker; see
[ROADMAP.md](../ROADMAP.md).

Arity, field names and operand types are also checked at run time, so a host
embedding the interpreter without running these passes is not left unguarded.

---

## 7. Execution model

### 7.1 Program start

Top-level statements run in order; then `main`, if declared, is called.

Because that call is automatic, writing `main()` yourself would run the program
twice. It is `RS008` rather than a second run — see §7.5.

### 7.2 Scope

Lexical, with closures capturing by reference — a closure over a `var` sees
later changes to it.

### 7.3 Evaluation order

Strictly left to right, except that `&&`, `||` and `match` guards
short-circuit.

### 7.4 Concurrency

Lumen has **no async colouring**. I/O-performing functions are awaited by the
interpreter, so `chat(...)` and `read(...)` compose exactly like pure functions
and no `async` marker propagates through your call stack.

`await expr` is accepted and evaluates to its operand. `async` is reserved.
Explicit structured concurrency is a v0.2 topic.

---

## 7.5 Static checks

Before a program runs, it is checked. Lumen is fully lexically scoped and has
no `eval`, no dynamic scope and no runtime name construction, so every name a
program uses can be resolved without running it.

| Code | Reported when |
|---|---|
| `RS001` | A name is not defined anywhere in scope |
| `RS002` | A `match` over an enum does not cover every variant |
| `RS003` | A `match` arm can never be reached |
| `RS004` | A name is declared twice in the same scope |
| `RS005` | A binding introduced with `let` is assigned to |
| `RS006` | `break` or `continue` appears outside a loop |
| `RS007` | A struct field or enum variant is declared twice |
| `RS008` | `main()` called at the top level of a module that defines `main` |
| `RS009` | An `import` names something a known module does not export |
| `RS010` | An `import` names a module that does not exist |
| `RS011` | A binding is never read — a **warning**, not an error |
| `RS012` | A statement can never run — a **warning**, not an error |

The value is that a mistake is reported whether or not execution reaches it: a
typo on a branch that never runs is still a typo.

`RS012` is that idea turned around: a statement the program can never reach at
all. It is almost always a misplaced `return` or a leftover from an edit, and
neither is visible from reading the line itself — the mistake is a line above.
The test for "always leaves" is deliberately the shapes that are certain —
`return`, `break`, `continue`, a call to the prelude's `panic`, an `if` whose
branches all leave, a `match` where every arm leaves and one catches everything
— and no cleverness beyond them. A `while true` with no `break` never ends
either, and working that out is the beginning of a flow analysis this pass is
not. It reports once per block, at the first statement that cannot run, because
a dead tail of ten lines is one mistake.

Two rules bound what is checked, both in the direction of never rejecting a
valid program:

- **Exhaustiveness is only checked when it can be proved.** Every arm must name
  variants of one enum the resolver can see. A `match` whose arms mix patterns,
  or whose enum cannot be determined, is left to `RT020` at run time.
- **A declared return type is checked against the function's value**, which is
  the value of its last statement — `return` as well, but `return` is the
  exception rather than the rule. A body whose last statement is a loop or a
  declaration yields `nil` and is left alone: that is a function whose value
  nobody uses, not a type error, and rejecting it would need an analysis of
  whether every path returns something, which is not what this pass does.
- **A guarded arm covers nothing.** `Light.Amber if hurry => ...` does not make
  a `match` exhaustive, because the guard may be false.
- **A function body may name declarations that come later.** A body does not
  run where it is written, so `fn greet() { name }` followed by `let name =
  "world"` is accepted, and mutual recursion needs no forward declaration.
  Statement-level code, which does run where it is written, is unchanged: using
  a name before its `let` is still `RS001`.

- **`main()` written at the top level is `RS008`.** A module that defines `fn
  main` has it called once the file has been read (§7.1), so writing the call as
  well runs the whole program twice. Nothing raises — the output simply appears
  twice — and putting the call at the bottom is exactly how it is done in
  Python, so this is a mistake worth catching rather than leaving to be noticed.

- **An import is checked only against a module whose exports are known.** The
  resolver is *told* what a module exports; it cannot read one. A standard
  module is always known, so `import { nope } from "std/list"` is `RS009` and
  `import { map } from "std/lst"` is `RS010`. A local file is not — reporting
  `./helper` unread would be a guess — so an import from one is trusted, and
  `RT002` and `RT042` answer at run time instead. An implementation decides
  which namespaces it knows the whole of; `std/` is always one of them.

### Warnings

`RS011` is the first diagnostic that does **not** reject a program. A binding
nothing ever reads is either dead code or a typo somewhere else, and neither
stops the program running — so reporting it as an error would mean rejecting
programs that work, which these passes do not do. `lumen check` prints it and
still exits zero.

The rule is deliberately narrow, because a check that is merely advisory has to
be worth reading. Only `let`, `var` and `import` are reported:

- **A parameter** is often unused on purpose — a handler that ignores its
  request, a callback that only wants the index — and there is no way to tell
  that from a mistake.
- **A function, struct or enum** may be the point of the file, and an
  unexported one is at worst dead code somebody is in the middle of writing.
  Reported, it would fire constantly while you work.
- **A pattern binding** already has `_` for the parts nobody wants.

Never for a name starting with `_`, which is how to say it is deliberate, and
never for anything the module exports, whose whole purpose is to be read from a
file this pass cannot see.

Writing does not count as reading, but a compound assignment does: `var x = 0`
followed only by `x = 1` is a value nobody looks at, while `total += n` reads
`total` and so is a use.

An import used only as a method is reported, and that is not a mistake in the
check: a method comes from its type's table, never from scope, so
`xs.groupBy(f)` works with no import at all and the import really is dead.

`_` may be re-declared freely; it is the conventional throwaway name. Shadowing
an outer binding in an inner scope is not an error, and never will be.

The interpreter still enforces all of these at run time as well, so a host that
embeds the interpreter directly without resolving first is not left unguarded.

## 8. Diagnostics

Every diagnostic carries a stable code, a source span, a caret, and usually a
note suggesting the fix. Codes are grouped by phase:

| Prefix | Phase |
|---|---|
| `LX` | Lexical |
| `PA` | Parsing |
| `RS` | Static checks: names and scoping |
| `TY` | Static checks: types |
| `RT` | Run time |

Codes are part of the language's contract: a code is never reused for a
different meaning. Selected codes:

| Code | Meaning |
|---|---|
| `LX001` | Unexpected character |
| `LX002` | Unterminated string |
| `LX003` | Unterminated interpolation |
| `LX004` | Unknown escape sequence |
| `LX006` | Unterminated block comment |
| `PA001` | Expected a specific token |
| `PA003` | Two statements run together on one line |
| `PA008` | Invalid assignment target |
| `PA009` | Map literal in a control-flow header |
| `PA015` | Struct literal in a control-flow header |
| `PA016` | Source nested more than 250 levels deep |
| `PA017` | A `..` parameter that is not last, or that has a default |
| `PA014` | Unmatched `}` |
| `PA018` | A unary operator directly before `**`, where the grouping is ambiguous |
| `RT005` | Name is not defined |
| `RT010` | `?` applied to a non-Result/Option |
| `RT016` | Cannot add these types |
| `RT018` | Division by zero |
| `RT020` | No match arm matched |
| `RT022` | Index out of bounds |
| `RT029` | Assignment to a `let` binding |
| `RT036` | Missing a required argument |
| `RT039` | No parameter of that name |
| `RT040` | Too many arguments |
| `RT044` | One parameter supplied both positionally and by name |
| `RT027` | No such method on this type |
| `RT045` | Call depth exceeded — recursion with no reachable base case |
| `RT046` | An arithmetic result that would be `NaN` |
| `RT048` | A negative number raised to a fractional power |
| `RT047` | A destructuring `let` or assignment whose shape does not fit the value |

The parser reports multiple errors per run, suppressing duplicates and bounding
cascades at 25. It also refuses source nested more than 250 levels deep
(`PA016`), which is far past anything written by hand. The limit counts the
**depth of the tree**, not the parser's own recursion, and those are not the
same thing: `1 + 1 + 1 + …` is parsed by a loop, so three thousand terms once
parsed at depth 1 and then took the type checker's stack out with a bare
`RangeError`. Seven shapes did that — a chained operator, a chained `**`, a
repeated unary, `x = x = …`, `a[0][0]…`, a nested pattern, a nested type
annotation — and a nested `${…}` did it by starting a fresh budget for every
interpolation. All of them are `PA016` now, and a test generates twenty deep
shapes rather than listing the ones that were found. That limit is what keeps
every later walk of the tree bounded too — the resolver, the type checker,
printing, equality — none of which can meet a tree deeper than the parser was
willing to build.

A diagnostic whose source line runs past 120 characters is shown as a window
around the caret rather than in full, so a minified or generated line does not
bury the thing it is pointing at.

Calls are limited to 10,000 deep (`RT045`). The interpreter evaluates through
promises rather than the host stack, so runaway recursion would otherwise
allocate silently instead of failing; the limit turns it back into a
diagnostic. Nothing reasonable reaches it — a balanced tree of ten thousand
nodes is fourteen levels deep.

---

## 9. Standard library

See [stdlib.md](stdlib.md) for the full reference. The modules are
`std/core`, `std/str`, `std/list`, `std/map`, `std/set`, `std/math`, `std/time`,
`std/json`, `std/option`, `std/result`, `std/fs`, `std/http`, `std/web` and
`std/ai`.

#### The prelude

These are in scope in every file with no import. A user binding of the same name
always shadows the prelude one, so defining your own `sum` is safe.

| Group | Names |
|---|---|
| Output and inspection | `print` `help` `type` `len` |
| Conversion | `str` `num` `bool` |
| Sequences | `map` `filter` `reduce` `sum` `sorted` `reversed` `enumerate` `zip` `any` `all` `range` `join` `split` |
| Numbers | `abs` `round` `floor` `ceil` `fixed` `min` `max` |
| Errors | `Ok` `Err` `Some` `None` `Result` `Option` `assert` `panic` |
| Console | `input` `inputAll` |

`range(n)`, `range(start, end)` and `range(start, end, step)` all work, and a
negative step counts down. `min` and `max` accept either a list or several
numbers.

`input(prompt)` returns `Some(line)`, or `None` at end of input, and is for a
conversation. `inputAll()` returns everything on the input as one string, and is
for a pipeline: `cat access.log | lumen run report.lm`. An empty input is `""`
rather than an error — nothing on the input is a normal amount of input. On a
host with no console, both say so rather than hanging.

Lumen has a single `Num` type, so there is no `int` or `float` conversion —
`num(text)` parses, returning a `Result`.

---

## 10. Stability

Within `0.x`, a **minor** release may change the language; a **patch** release
may not. From `1.0`, source that runs on `1.x` keeps running on every later
`1.y`. Diagnostic codes are stable from now.
