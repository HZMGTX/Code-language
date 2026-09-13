# Learn Lumen

This is the gentlest way in. It assumes you have never written a program, or
have done a little Python and want to know what is different here. You will not
need the specification, and you will not need to know what a compiler is.

Give it about an hour. Every snippet below is short and runs exactly as printed —
type them, change them, break them. That is the whole method.

## 1. Your first program

A Lumen program is a text file ending in `.lm`. Make one called `hello.lm` and
put a single line in it:

```lumen
print("Hello, world!")
```

Run it:

```bash
lumen run hello.lm
```

```
Hello, world!
```

`print` writes things out, with a newline at the end. Give it several values and
it separates them with spaces:

```lumen
print("2 + 2 is", 2 + 2)
print(10 / 4, 7 % 3)
```

```
2 + 2 is 4
2.5 1
```

`%` is the remainder after division. There is only one kind of number in Lumen —
no separate whole numbers and decimals — so `10 / 4` is simply `2.5`.

Two ways to leave a note for yourself, neither of which the computer reads:

```lumen
// this is a comment
/* and this one
   runs over several lines */
print("comments do nothing")
```

```
comments do nothing
```

If you have used Python, note that `#` is **not** a comment in Lumen.

There is also a scratchpad you can type into a line at a time, which is useful
while you read this:

```bash
lumen repl
```

```
Lumen 0.1.0 — type :help for help, :quit to leave
lumen> 1 + 1
2
lumen> "hi".upper()
"HI"
```

## 2. Values and names

A name is how you refer to a value later. `let` gives a name to something that
will not change:

```lumen
let name = "Ada"
let born = 1815
print(name, born)
```

```
Ada 1815
```

If something does need to change, say so with `var`:

```lumen
var count = 0
count += 1
count += 1
print(count)
```

```
2
```

`count += 1` is shorthand for `count = count + 1`.

**`let` is the default, and that is deliberate.** Most names in a real program
never need to change, and saying so means the language can tell you when you
have changed one by accident:

```lumen
let name = "Ada"
name = "Grace"
```

```
error[RS005]: cannot assign to `name`
 --> hello.lm:2:1
  |
2 | name = "Grace"
  | ^^^^ declared with `let`
  |
  = note: values bound with `let` never change; use `var` if it needs to
```

Start everything as `let`. Change it to `var` on the day Lumen complains.

One honest caveat: `let` fixes the *name*, not the contents. A list you named
with `let` can still have things added to it — you just cannot point that name at
a different list.

There are six kinds of built-in value, and `type` tells you which you have:

```lumen
print(type(nil), type(true), type(42))
print(type("words"), type([1, 2]), type({ a: 1 }))
```

```
Nil Bool Num
Str List Map
```

`nil` means "nothing here". The rest of this guide meets the others in turn.

### Naming several things at once

When something hands you back more than one value, you can name them all in one
line by writing the shape you expect:

```lumen
fn minMax(xs) { [min(xs), max(xs)] }

let [lowest, highest] = minMax([3, 1, 4, 1, 5])
print("${lowest} to ${highest}")
```

```
1 to 5
```

`..` collects whatever is left over:

```lumen
let [winner, ..others] = ["Ada", "Grace", "Alan"]
print(winner)
print(others)
```

```
Ada
["Grace", "Alan"]
```

The same shape works on the left of a plain `=`, which is how you swap two
things without a spare name to hold one of them:

```lumen
var a = 1
var b = 2
[a, b] = [b, a]
print([a, b])
```

```
[2, 1]
```

The right-hand side is worked out completely before anything is written, which
is why the swap comes out right.

## 3. Text

Text is written between double quotes — only double quotes, never single ones.
To put a value inside a piece of text, wrap it in `${...}`:

```lumen
let name = "Ada"
print("Hello, ${name}!")
print("${name} has ${len(name)} letters")
print("2 + 2 = ${2 + 2}")
```

```
Hello, Ada!
Ada has 3 letters
2 + 2 = 4
```

Anything at all can go inside `${...}` — a name, a sum, a whole calculation.
This is how you build text out of other values; `+` will not join a piece of
text to a number, and the error politely says so.

### Methods

Text knows how to do things to itself:

```lumen
print("hi".upper())
print("  spaces  ".trim())
print("a,b,c".split(","))
```

```
HI
spaces
["a", "b", "c"]
```

Here is the one idea worth pausing on. `"hi".upper()` is not a special
construction. Every function in Lumen's library takes its subject as the first
argument, so `x.f(a)` simply *means* `f(x, a)`. These three lines are the same
line:

```lumen
print("a,b,c".split(","))
print(split("a,b,c", ","))
print("a,b,c" |> split(","))
```

```
["a", "b", "c"]
["a", "b", "c"]
["a", "b", "c"]
```

The only difference is bookkeeping. The plain-call form needs the name to be in
scope: `split` is one of the names Lumen gives you everywhere, but `upper` lives
in a module, so `upper("hi")` would need an import while `"hi".upper()` never
does. That is a good reason to prefer the dot.

It does not go both ways for everything, mind. A method has to be one the type
actually has, and a few of the everywhere-names are not methods on every type —
`len("abc")` works, `"abc".len()` does not. When you are unsure, `help("abc")`
lists exactly what that value will answer to.

The dot also lets you write a sequence of steps left to right:

```lumen
print("  Hello World  ".trim().lower().split(" ").join("_"))
```

```
hello_world
```

Read that as four instructions in order: trim the spaces off, lower the case,
split on spaces, join with underscores.

A few more, to give you the shape of what is available:

```lumen
print("banana".replace("a", "o"))
print("banana".contains("nan"))
print("hello".chars())
print("abc".reverse())
print("ha".repeat(3))
print("7".padStart(3, "0"))
```

```
bonono
true
["h", "e", "l", "l", "o"]
cba
hahaha
007
```

You do not have to memorise the list. Section 12 shows how to ask.

Numbers turn into text with `str`, and with `fixed` when the decimals matter:

```lumen
print(str(4.5))
print(fixed(4.5, 2))
print(fixed(2 / 3, 3))
print("Total: " + fixed(19.5, 2).padStart(8))
```

```
4.5
4.50
0.667
Total:    19.50
```

`4.5` and `4.50` are the same *number* but not the same *figure*, and a column
of prices needs the second. Rounding cannot get you there — `round(n * 100) /
100` gives back a number, and a number has no trailing zero to show.

## 4. Lists

A list is several values in order, written in square brackets. Positions are
counted from `0`:

```lumen
let scores = [70, 92, 58, 88]
print(scores[0])
print(scores[3])
print(len(scores))
```

```
70
88
4
```

Asking for a position that does not exist is an error, not a shrug — a list has
a definite size, so being past the end is always a mistake:

```lumen
let scores = [70, 92, 58, 88]
print(scores[9])
```

```
error[RT022]: index 9 is out of bounds for a list of length 4
 --> marks.lm:2:7
  |
2 | print(scores[9])
  |       ^^^^^^^^^ out of range
  |
  = note: negative indices count from the end, so `-1` is the last element
```

Lists have methods too, and this is where the dotted form earns its keep:

```lumen
let scores = [70, 92, 58, 88]
print(scores.sorted())
print(scores.sum())
print(scores.reversed())
print(scores.contains(92))
```

```
[58, 70, 88, 92]
308
[88, 58, 92, 70]
true
```

Two methods take a small function of their own. `filter` keeps the items you say
yes to; `map` replaces every item with something worked out from it:

```lumen
let scores = [70, 92, 58, 88]
print(scores.filter(fn(s) { s >= 70 }))
print(scores.map(fn(s) { s + 5 }))
```

```
[70, 92, 88]
[75, 97, 63, 93]
```

`fn(s) { s >= 70 }` is a function with no name: given an `s`, its value is
whether `s` is at least 70. Lumen hands each item to it in turn.

Chain them and a list transformation becomes one readable sentence:

```lumen
let scores = [70, 92, 58, 88]
print(
  scores
    .filter(fn(s) { s >= 70 })
    .map(fn(s) { "${s}%" })
    .join(", ")
)
```

```
70%, 92%, 88%
```

Most list methods leave the original alone and hand you a new list. The two
exceptions announce themselves by name — `push` and `pop` change the list in
place:

```lumen
let basket = ["apple"]
basket.push("pear")
print(basket)
print(basket.pop())
print(basket)
```

```
["apple", "pear"]
Some("pear")
["apple"]
```

(`Some("pear")` rather than `"pear"` because the list might have been empty.
Section 11 explains.)

### Try it yourself

1. Given `[4, 8, 15, 16, 23, 42]`, print only the numbers greater than 10, each
   doubled.
2. Count the vowels in `"Programming Is Fun"`. (`chars`, `lower`, `contains` and
   `count` between them will do it.)

Answers are at the end.

## 5. Maps

A list finds things by position. A **map** finds them by name:

```lumen
let person = { name: "Ada", born: 1815 }
print(person.name)
print(person["born"])
```

```
Ada
1815
```

Both spellings work. Use `person.name` when you are typing the key out, and
`person[key]` when the key is in a variable.

```lumen
let person = { name: "Ada", born: 1815 }
print(person.keys())
print(person.values())
print(person.has("name"))
print(person.missing)
```

```
["name", "born"]
["Ada", 1815]
true
nil
```

A key that is not there gives `nil`. Unlike a list index, this is not an error:
a map is open-ended, so "not present" is an ordinary answer.

When you want a different answer for "not present", say what it is with
`getOr`. This is what makes counting things one line instead of three:

```lumen
var counts = {}
for word in ["pear", "fig", "pear"] {
  counts[word] = counts.getOr(word, 0) + 1
}
print(counts)
```

```
{pear: 2, fig: 1}
```

Without it, every single increment would have to ask first whether the word had
ever been seen.

Maps do not change when you update them — you get a new map back:

```lumen
let person = { name: "Ada", born: 1815 }
let corrected = person.set("born", 1816)
print(corrected.born, person.born)
```

```
1816 1815
```

You can walk a map, taking the key and the value together:

```lumen
let ages = { Ada: 36, Grace: 85 }
for [name, age] in ages {
  print("${name} is ${age}")
}
```

```
Ada is 36
Grace is 85
```

One corner worth knowing before you hit it: if a map has a key called `keys`,
that key wins over the method. `{ keys: "mine" }.keys` is `"mine"`. This is the
safe direction to resolve the clash — adding methods to the language can never
change what your existing lookups return — but it does mean `.keys()` on that
particular map will fail, because you would be trying to call a piece of text.

## 6. Making decisions

```lumen
let temperature = 31

if temperature > 30 {
  print("hot")
} else if temperature > 15 {
  print("mild")
} else {
  print("cold")
}
```

```
hot
```

Conditions are built from `==`, `!=`, `<`, `<=`, `>`, `>=`, and joined with
`&&` (and), `||` (or), `!` (not). If you prefer words, `and`, `or` and `not`
mean exactly the same thing.

In Lumen, `if` is an **expression** — it has a value, so you can give that value
a name directly:

```lumen
let temperature = 31
let advice = if temperature > 30 { "stay inside" } else { "go for a walk" }
print(advice)
```

```
stay inside
```

There is no separate conditional operator to learn; the `if` you already know
does that job.

### The falsiness rule — read this one twice

**Only `nil` and `false` are false. Everything else is true.**

That includes `0`, the empty string, and the empty list, all of which are *true*
in Lumen:

```lumen
if 0 { print("0 is true") }
if "" { print("the empty string is true") }
if [] { print("the empty list is true") }
if nil { print("you will never see this") }
```

```
0 is true
the empty string is true
the empty list is true
```

If you are coming from Python or JavaScript this is the one rule most likely to
catch you out, because both of those treat `0` and `""` as false. Lumen does not,
on purpose: `if items` in those languages quietly means two different things at
once ("is there a list at all" and "does it have anything in it"), and the bug
only shows up on the day the list is empty.

So say which one you mean:

```lumen
let items = []
if items.isEmpty() { print("nothing here") }
if len(items) == 0 { print("still nothing here") }
```

```
nothing here
still nothing here
```

Where truthiness *is* useful is for `nil` — for "was this ever set at all":

```lumen
let settings = { colour: "blue" }
if settings.size { print("never") } else { print("no size set") }
```

```
no size set
```

## 7. Repeating

`for` walks through the items of something:

```lumen
for colour in ["red", "green", "blue"] {
  print(colour)
}
```

```
red
green
blue
```

To repeat a fixed number of times, walk a `range`:

```lumen
for i in range(3) {
  print("step ${i}")
}
```

```
step 0
step 1
step 2
```

`range(3)` is `[0, 1, 2]` — it starts at zero and stops *before* the number you
gave. `range(2, 6)` counts from 2 up to 5, and `range(10, 0, -2)` counts
downwards in twos. `0..3` is another way of writing `range(3)`.

If you want the position as well as the item, `enumerate` gives you both:

```lumen
for [i, colour] in ["red", "green"].enumerate() {
  print("${i}: ${colour}")
}
```

```
0: red
1: green
```

`while` repeats for as long as something stays true:

```lumen
var n = 3
while n > 0 {
  print(n)
  n -= 1
}
print("lift off")
```

```
3
2
1
lift off
```

`break` leaves a loop early; `continue` skips to the next turn:

```lumen
for n in range(10) {
  if n % 2 == 1 { continue }
  if n > 6 { break }
  print(n)
}
```

```
0
2
4
6
```

Text can be walked too, one character at a time:

```lumen
for ch in "hi" { print(ch) }
```

```
h
i
```

## 8. Functions

A function is a named piece of program you can run whenever you like. The last
expression in it is its value — there is no `return` to remember:

```lumen
fn double(n) {
  n * 2
}

print(double(21))
```

```
42
```

Arguments can have defaults, so the common case stays short:

```lumen
fn greet(name, greeting = "Hello") {
  "${greeting}, ${name}!"
}

print(greet("Ada"))
print(greet("Ada", "Good morning"))
```

```
Hello, Ada!
Good morning, Ada!
```

And you can pass them by name, in any order, which is worth doing the moment a
call stops being self-explanatory:

```lumen
fn greet(name, greeting = "Hello") {
  "${greeting}, ${name}!"
}

print(greet(greeting: "Hi", name: "Bob"))
```

```
Hi, Bob!
```

Functions do not have to be defined before they are used — Lumen reads the whole
file first — so you can put `main` at the top and the details underneath.

If you do not know how many arguments there will be, put `..` on the last
parameter and it collects them all into a list:

```lumen
fn shout(..parts) {
  parts.join(" ").upper() + "!"
}

print(shout("hello", "there"))
print(shout("hi"))
print(shout())
```

```
HELLO THERE!
HI!
!
```

There is always a list, even when it is empty — so there is no separate case to
write for "nothing was passed".

A function is also just a value. You can name one with `let`, pass it to
another function, or return one:

```lumen
let shout = fn(s) { s.upper() + "!" }
print(shout("hey"))
print(["a", "b"].map(shout))
```

```
HEY!
["A!", "B!"]
```

A function written inside another one can still see the names around it, and
keeps seeing them afterwards:

```lumen
fn counter() {
  var n = 0
  fn() {
    n += 1
    n
  }
}

let next = counter()
print(next())
print(next())
print(next())
```

```
1
2
3
```

Each call to `counter()` makes a fresh `n`, and the little function handed back
keeps hold of it.

### Try it yourself

3. Write `initials(fullName)` so that `initials("ada byron lovelace")` prints
   `ABL`.
4. Write `shipping(weight)` that costs 3 up to 1kg, 6 up to 5kg, and 10 above
   that. (You can do this with `if`; section 10 shows a tidier way.)

## 9. Your own types

When several values belong together, give the shape a name. A **struct** is a
fixed set of named fields:

```lumen
struct Book {
  title: Str,
  pages: Num,
}

let b = Book { title: "Dune", pages: 412 }
print(b.title)
print("${b.title} has ${b.pages} pages")
```

```
Dune
Dune has 412 pages
```

Every field must be given a value, though the order is up to you. Get a name
wrong and Lumen guesses what you meant:

```lumen
struct Book { title: Str, pages: Num }
let b = Book { titel: "Dune", pages: 412 }
```

```
error[RT013]: `Book` has no field `titel`
 --> books.lm:2:16
  |
2 | let b = Book { titel: "Dune", pages: 412 }
  |                ^^^^^^^^^^^^^ unknown field
  |
  = note: did you mean `title`?
```

The `Str` and `Num` above say what you intend each field to hold. Today they are
documentation — Lumen does not yet check them — and the roadmap says so plainly
rather than implying otherwise.

An **enum** is the other half: a value that is exactly one of a fixed set of
possibilities.

```lumen
enum Status { Todo, Doing, Done }

let s = Status.Doing
print(s)
```

```
Status.Doing
```

This is better than using text for the same job, because `Status.Doing` cannot
be misspelled without Lumen noticing, while `"doign"` can.

Variants can carry values of their own:

```lumen
enum Shape {
  Circle(Num),
  Rect(Num, Num),
}

print(Shape.Rect(3, 4))
```

```
Shape.Rect(3, 4)
```

A `Shape` is *either* a circle with a radius *or* a rectangle with a width and a
height, and there is no way to be halfway between the two. Getting the value back
out is what the next section is for.

## 10. match

`match` compares a value against a list of shapes, in order, and takes the first
one that fits. It is the heart of the language, and worth the ten minutes.

At its simplest it is a tidier `if`:

```lumen
fn describe(n) {
  match n {
    0 => "zero",
    1 => "one",
    n if n < 0 => "negative",
    _ => "many",
  }
}

print(describe(0))
print(describe(1))
print(describe(-5))
print(describe(99))
```

```
zero
one
negative
many
```

Three things are going on there:

- `0` and `1` match those exact values.
- `n if n < 0` matches anything, calls it `n`, and then only accepts it if the
  condition after `if` holds. That trailing condition is called a **guard**.
- `_` matches anything at all. Put it last; it is the "otherwise" arm.

The real power is that patterns match *shape*, and pull the pieces out while
they do it. This is how you open an enum:

```lumen
enum Shape { Circle(Num), Rect(Num, Num) }

fn area(shape) {
  match shape {
    Shape.Circle(r) => 3.14159 * r * r,
    Shape.Rect(w, h) => w * h,
  }
}

print(area(Shape.Circle(1)))
print(area(Shape.Rect(3, 4)))
```

```
3.14159
12
```

Lists work the same way, and `..rest` stands for "everything remaining":

```lumen
fn summarise(xs) {
  match xs {
    [] => "empty",
    [only] => "just ${only}",
    [first, ..rest] => "${first}, then ${len(rest)} more",
  }
}

print(summarise([]))
print(summarise([7]))
print(summarise([1, 2, 3]))
```

```
empty
just 7
1, then 2 more
```

One rule decides whether a bare name in a pattern is a *value to match* or a
*name to bind*: a **capitalised** name is a variant (`None`, `Done`), and
anything else binds. That is the reason types are written `LikeThis` and
ordinary names `likeThis`.

### Try it yourself

5. Rewrite `shipping` from exercise 4 using `match` and guards.

## 11. When things go wrong

Lumen has no exceptions. Nothing is thrown past you, and no function has a
hidden second way of ending. Instead, anything that might fail hands you back a
value that says whether it worked.

```lumen
print(num("42"))
print(num("banana"))
```

```
Ok(42)
Err("`banana` is not a number")
```

`num` turns text into a number. It returns a **Result** — either `Ok(value)` or
`Err(reason)` — and you open it with `match`:

```lumen
match num("banana") {
  Ok(n) => print("got ${n}"),
  Err(why) => print("no: ${why}"),
}
```

```
no: `banana` is not a number
```

The point is that you cannot use the number without first saying what should
happen if there is not one. The failure is right there in the value, not in a
paragraph of documentation you did not read.

Its sibling is **Option**, for "there might not be one" rather than "this might
have failed" — `Some(value)` or `None`:

```lumen
let names = ["Ada", "Grace"]
print(names.first())
print([].first())
print(names.find(fn(n) { n.startsWith("Z") }))
```

```
Some("Ada")
None
None
```

That is why `first` does not simply give you the item: on an empty list there is
nothing to give, and `None` says so out loud instead of handing back a `nil` you
forget to check.

### `?`, so the happy path stays flat

Writing a `match` around every step gets heavy fast. The `?` suffix does the
common thing: if the value is `Ok` or `Some`, it unwraps it and carries on; if
it is `Err` or `None`, it stops the surrounding function and hands that failure
straight back to *your* caller.

```lumen
fn half(text) {
  let n = num(text)?
  Ok(n / 2)
}

print(half("10"))
print(half("ten"))
```

```
Ok(5)
Err("`ten` is not a number")
```

Two lines of work, with the failure handled, and no nesting. `?` needs a
function to return from: used at the top level of a program there is nowhere for
the failure to go, so Lumen stops with `RT001` rather than quietly dropping it.
That is the point of it — the obligation to deal with the problem moves up one
level rather than disappearing.

There is one gap worth knowing about. Lumen does not yet check that the function
you used `?` in returns a `Result` or an `Option` on its other paths, so that
part is down to you. Write one that does: a function handing back a bare number
when it works and an `Err` when it does not is awkward for whoever calls it.

Some things are genuinely mistakes rather than expected failures, and those do
stop the program with a message that points at the line — dividing by zero,
indexing past the end of a list, adding a number to a piece of text. Those are
bugs to fix, not situations to handle.

## 12. Finding your way

You will forget method names. That is fine — ask.

`help(x)` on a value lists what you can do with it:

```lumen
help("abc")
```

```
Str: "abc"

methods you can call on it:
  capitalize, center, chars, clone, contains, count, endsWith, indexOf, inspect, isEmpty, isNil, len, lines, lower, padEnd, padStart, removePrefix, removeSuffix, repeat, replace, reverse, slice, split, splitOnce, startsWith, str, title, toNum, trim, trimEnd, trimStart, type, upper, words
```

`help` on a function explains that function:

```lumen
help(range)
```

```
range(start, end = ..., step = ...)
  A list of numbers: range(5), range(2, 6), or range(10, 0, -2).
```

`help()` with nothing lists everything available without an import, plus the
modules you can reach for; and `help("std/list")` lists what one module holds.
All of this works inside `lumen repl`, which makes the repl a decent place to
look things up while you write.

### Read the errors

Lumen's errors are meant to be read, not skimmed past. They point at the exact
spot and usually tell you the fix:

```lumen
print("hello".uper())
```

```
error[RT027]: Str has no method `uper`
 --> hello.lm:1:7
  |
1 | print("hello".uper())
  |       ^^^^^^^^^^^^ not available here
  |
  = note: did you mean `upper`?
```

```lumen
print("you are " + 30 + " years old")
```

```
error[TY005]: cannot add Str and Num
 --> hello.lm:1:7
  |
1 | print("you are " + 30 + " years old")
  |       ^^^^^^^^^^^^^^^ mismatched operands
  |
  = note: `+` joins two Nums, two Strs or two Lists
  = note: to build a string from mixed values use interpolation: "${a}${b}"
```

The `RT016` is a stable code you can search for. When you are stuck, the note at
the bottom is usually the answer.

## 13. Putting it together

A small mark book. It uses a struct, `match` with guards, list methods, an
`Option` for the awkward case, and a `for` loop to print it — most of this guide
in a few dozen lines.

```lumen
struct Student {
  name: Str,
  marks: List,
}

fn average(marks) {
  if marks.isEmpty() {
    None
  } else {
    Some(marks.sum() / len(marks))
  }
}

fn grade(mark) {
  match mark {
    m if m >= 70 => "distinction",
    m if m >= 50 => "pass",
    _ => "fail",
  }
}

let students = [
  Student { name: "Ada",   marks: [88, 92, 75] },
  Student { name: "Grace", marks: [64, 71] },
  Student { name: "Alan",  marks: [] },
]

for s in students {
  let label = s.name.padEnd(7)
  match average(s.marks) {
    Some(avg) => print("${label}${round(avg)}  ${grade(avg)}"),
    None      => print("${label}no marks yet"),
  }
}
```

```
Ada    85  distinction
Grace  68  pass
Alan   no marks yet
```

Notice that `Alan` did not need a special case bolted on at the end. `average`
returns an `Option` because it honestly might not have an answer, and the
`match` that unpacks it has nowhere to hide the empty case.

If you want to take input from whoever is running the program, `input` gives you
`Some(line)`, or `None` when there is nothing more to read:

<!-- no-run: waits for a line to be typed, so `Ada` below is the reader's, not the program's -->
```lumen
match input("What is your name? ") {
  Some(name) => print("Hello, ${name.trim()}!"),
  None => print("Nobody there."),
}
```

```
What is your name? Ada
Hello, Ada!
```

## 14. Where to go next

- [tour.md](tour.md) — the same ground at speed, plus web servers and AI calls
- [from-python.md](from-python.md) — a translation table, if Python is your
  reference point
- [stdlib.md](stdlib.md) — every module and every function, with signatures
- [spec.md](spec.md) — the precise rules, when you want to know exactly what
  something does
- [philosophy.md](philosophy.md) — why the language makes the choices it does
- [../ROADMAP.md](../ROADMAP.md) — what is not built yet, stated plainly

The best next step is to write something small and useless: a tip calculator, a
program that counts the words in a sentence, a to-do list that prints itself.
Nothing here becomes yours until you have typed it wrong a few times.

## Answers to the exercises

**1.** Numbers over 10, doubled.

```lumen
let xs = [4, 8, 15, 16, 23, 42]
print(xs.filter(fn(n) { n > 10 }).map(fn(n) { n * 2 }))
```

```
[30, 32, 46, 84]
```

**2.** Counting vowels.

```lumen
fn countVowels(text) {
  text.lower().chars().count(fn(c) { "aeiou".contains(c) })
}

print(countVowels("Programming Is Fun"))
```

```
5
```

**3.** Initials.

```lumen
fn initials(fullName) {
  fullName.split(" ").map(fn(part) { part.slice(0, 1).upper() }).join("")
}

print(initials("ada byron lovelace"))
```

```
ABL
```

**4.** Shipping with `if`.

```lumen
fn shipping(weight) {
  if weight <= 1 { 3 } else if weight <= 5 { 6 } else { 10 }
}

print(shipping(0.5), shipping(3), shipping(20))
```

```
3 6 10
```

**5.** The same thing with `match`.

```lumen
fn shipping(weight) {
  match weight {
    w if w <= 1 => 3,
    w if w <= 5 => 6,
    _ => 10,
  }
}

print(shipping(0.5), shipping(3), shipping(20))
```

```
3 6 10
```
