# Changelog

All notable changes to Lumen are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lumen follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the
stability policy in [docs/spec.md](docs/spec.md) §10.

## [Unreleased]

### Language

- **`**` raises to a power.** `2 ** 10` is `1024`. It binds tighter than `*` and
  is the only right-associative binary operator, so `2 ** 3 ** 2` is
  `2 ** (3 ** 2)` — 512, which is what the notation means in mathematics and in
  every language that has the operator.

  A unary operator directly before it is **refused**, not resolved: `-2 ** 2` is
  `PA018`. Python reads it as `-(2 ** 2)`, which is -4; binding the unary first,
  as Lumen's precedence table otherwise would, gives 4. Both readings have a
  language behind them, so a reader arriving from either one is entitled to
  assume theirs, and picking a side quietly means somebody's arithmetic is
  wrong with nothing to point at. JavaScript made the same call. A unary
  operator on the right is unambiguous and allowed: `2 ** -1` is `0.5`.

  `0` to a negative power is `1 / 0` by another spelling and reports `RT018`
  rather than `Infinity`. A negative number to a fractional power is `RT048`:
  `(0 - 8) ** (1 / 3)` is -2 in arithmetic and `NaN` in IEEE 754, and Lumen has
  only real numbers, so it says so instead of handing back a value that is not
  equal to itself. `cbrt` in `std/math` is the function that answers it.

- **`return`, `break` and `continue` are expressions.** They produce no value —
  they leave — so they can now appear wherever a value is expected, which is
  what lets a `match` arm bail out:

  ```lumen
  match line.toNum() {
    Ok(n)  => n,
    Err(_) => continue,
  }
  ```

  Previously this was `PA010: expected an expression, found 'return'`, and
  since `match` is the main way to branch in an expression-oriented language,
  that was a hole in the middle of it. The statement forms are unchanged and
  mean exactly the same thing.

### Performance

- **Leaf expressions no longer allocate a promise.** Number, string and boolean
  literals, `nil`, and plain names cannot suspend, so they are evaluated
  synchronously and every caller falls back to the async path for anything
  else. They are most of what a tight loop evaluates — `while i < 300000 {
  total += i * 2 - 1 }` has six per iteration, each previously allocating a
  promise that resolved immediately. Best-of-three on `npm run bench` went from
  2.86s to 2.39s (about 16%; nearer 25% comparing medians), with the profile's
  garbage-collection share falling accordingly. This is a narrow, contained
  piece of the `Value | Promise<Value>` change the roadmap costs out — the rest
  of which remains deliberately undone, because it is a continuation-passing
  rewrite that a bytecode VM would discard.

### Static checks

- **`main()` at the top level of a module that defines `main` is now `RS008`.**
  A module that declares `fn main` has it called once the file has been read, so
  writing the call as well ran the whole program twice. Nothing raised — the
  output simply appeared twice — and the call at the bottom is exactly how it is
  done in Python, which is where the habit comes from. Found by writing
  `examples/schedule.lm` and wondering why its output was duplicated.

### Fixed

- **`args()` no longer depends on how the program was started.** It was
  `process.argv.slice(3)`, a fixed offset that is one word further along for
  `lumen run app.lm a b` than for `lumen app.lm a b` — so the first spelling
  handed the program its own path as `args()[0]` and the second did not. The same
  script therefore saw different arguments depending on which way it was
  launched, silently.

  The offset was never knowable from the standard library: only the CLI knows how
  many words of the command line were its own. So `args` joins the `Host`
  interface alongside `getEnv` and `now`, the CLI supplies it after parsing, and
  a host with no notion of arguments — a browser, a build step — omits it and
  gets an empty list rather than a wrong one. Both spellings are now tested
  through the real command, since a test covering one of them would have gone on
  passing.

- **`serve` on a port already in use now says so.** It reported `internal error`
  followed by a Node stack trace through `node:net`, which answers a question
  about the machine with a trace into the runtime. It is by a wide margin the
  commonest way starting a server fails — the last one is still running — and now
  reads as a diagnostic pointing at the `serve` call, suggesting the next port.
  `EACCES` (a port below 1024) and `EADDRNOTAVAIL` (a host that is not this
  machine) get the same treatment.

- **`stringify` renders `Option` as JSON's own optional.** `Some(v)` was
  `{"variant": "Some", "values": [v]}` and `None` was the string `"None"`, so
  every consumer of an API built with Lumen had to unwrap a field that JSON
  already knows how to spell. Now `Some(v)` is `v` and `None` is `null`.

  `Result` deliberately keeps the tagged form: JSON has no agreed shape for
  "succeeded or failed", and unlike `Option` both of its arms carry something the
  reader has to tell apart, so collapsing it would lose what matters. The enum's
  variant names are checked as well as its name, so somebody's own
  `enum Option { A, B }` is untouched.

- **A struct field or enum variant written twice was accepted in silence.**
  `struct Book { title: Str, pages: Num, title: Num }` ran, with the second
  `title` quietly deciding the type. Neither a field nor a variant is a scope
  binding, so `RS004` never saw them. They are `RS007` now, pointing at the
  second one and naming the line of the first.
- **Enum diagnostics named parameters that do not exist.** `Shape.Rect(1)` said
  "missing a value for `field1`" and "it takes: field0, field1" — implementation
  detail, since a variant's payload is positional and `Shape.Rect(3, 4)` has no
  `field0` in it. Those messages now count values instead, and passing one by
  name says so directly rather than suggesting a name that was never real.
  Ordinary functions are unchanged, suggestions included.
- **`lumen test` and `lumen check` printed `../../../tmp/…`** for a target
  outside the working directory, which is both longer than the absolute path and
  harder to read. They now print whichever is shorter.
- **A declared return type was unenforced on almost every function.** `TY002`
  only ever looked at `return` statements — but a Lumen function's value is the
  value of its last statement, and `return` is the exception rather than the
  rule, so `fn f() -> Num { "text" }` was accepted without comment. It is
  checked now. Silence is kept where silence is right: an unannotated helper is
  `Any` and stays uncomplained-about, and a body ending in a loop or a
  declaration yields `nil` and is left alone, since that is a function whose
  value nobody uses rather than a type error. Verified against every Lumen
  program in the repository — 24 files, none newly flagged.

- **A function body may name declarations that come later.** `fn greet() {
  name }` followed by `let name = "world"` runs correctly and always has, but
  the resolver rejected it with `RS001` — the one failure a static check must
  not have. It also ruled out mutual recursion, since the second of two
  functions is never declared yet when the first names it. Lookups from inside
  a function body now see what the enclosing scope is going to declare;
  statement-level code, which really does run where it is written, is
  unchanged. A typo is still caught, and can now suggest a name from further
  down the file.
- **`break` and `continue` outside a loop said `internal error [object
  Object]`.** They are now `RS006`, reported before the program runs, with a
  note pointing at `return`. A function boundary counts: a `break` inside a
  lambda cannot leave the loop the lambda was written in.
- **Piped input dropped every line after the first.** A pipe delivers all its
  lines at once, well before a program asks for the second one, and the host
  read one and let the rest fall on the floor — so `printf 'a\nb\n' | lumen
  run script.lm` saw only `a`. Lines are queued as they arrive now. Reading at
  a terminal is unchanged.
- **`isServer()` always returned `true`,** whether the file was started with
  `lumen serve` or `lumen run`, which made it useless for the thing its name
  promises. `serve` and `run` are now genuinely different, and `isServer()`
  says which one you are in — so one file can serve its routes and also print
  them for inspection.

- **Runaway recursion hung instead of failing.** Every call is a promise rather
  than a stack frame, so `fn f() { f() }` allocated quietly until the process
  died — no stack to overflow, no diagnostic, no end. Calls are limited to
  10,000 deep and report `RT045`, which takes about a quarter of a second.
  Legal deep recursion is unaffected; nothing reasonable comes close.
- **A struct literal in a control-flow header produced nine errors.** `match
  Point { x: 1, y: 2 } { ... }` is ambiguous — in a header a `{` starts the
  body — and the parser used to silently take the identifier alone and then
  report on the wreckage. It now says so once, as `PA015`, with the fix
  (parentheses), and parses the struct literal anyway so nothing after it
  cascades. `if ready {}` is untouched: an empty brace pair in a header is far
  more likely a body than a struct.
- **Six ordinary identifiers were syntax errors.** `let valueOf = 1` failed
  with `expected an identifier, found function valueOf() { [native code] }`,
  and so did `toString`, `constructor`, `hasOwnProperty`, `__proto__` and
  `isPrototypeOf`. The keyword table was an object literal, so looking a name
  up in it answered with whatever JavaScript's `Object.prototype` carries. It
  is a `Map` now, which has no inherited keys. Three more leaks of the same
  kind went with it: `stringify` silently dropped a `__proto__` key, an
  `import` of one of those names crashed the interpreter instead of reporting
  an unknown module, and HTTP header maps were built on objects that could be
  written through. A language whose pitch is that the host is invisible cannot
  have the host's method names showing through its syntax.
- **Two values that both printed `NaN` compared unequal — sometimes.** `a == a`
  was true and `a == b` false for two identical computations, because equality
  short-circuits on object identity and `NaN === NaN` is false underneath. That
  leaked the host's object identity into a language where numbers have none.
  Rather than patch equality, `NaN` is no longer a Lumen value at all: any
  arithmetic that would produce one is `RT046`, and `pow(-8, 0.5)` reports that
  it has no real answer, as `sqrt(-1)` and `log(0)` already did. `Infinity` is
  untouched — it means something, is equal to itself, and orders consistently.
- **Deeply nested source crashed with a message about the wrong thing.** A
  thousand nested parentheses exhausted the host stack, and what came out was
  `stack overflow — a function is probably recursing without a base case`,
  which names a cause that does not apply and nothing anyone could act on. The
  parser now refuses to build a tree more than 250 levels deep and reports
  `PA016` with a span. The same limit bounds every later walk of the tree, so
  none of them can meet something deeper than the parser was willing to build.
- **A long source line buried the caret it was pointing at.** A diagnostic on a
  minified or generated line printed the whole line, pushing the `^` off the
  screen. Lines past 120 characters are now shown as a window around the caret.
- **`RS005` gave advice that could not be followed.** Assigning to a parameter
  said "use `var` if it needs to", but a parameter cannot be declared `var`.
  The label and the note now depend on where the binding came from: a parameter
  reads as "a parameter, which the caller supplies", with advice to copy it
  into a `var` of its own. It also no longer splices a binding kind into
  backticks, which rendered as ``declared with `pattern binding` `` — syntax
  nobody ever wrote.
- **The REPL could not be escaped from a half-written line.** Typing `1 +` put
  it into continuation mode, and every line after that — `:quit` included — was
  swallowed as more of the same expression. A blank line abandons it now.
- **A mistyped command was reported as a missing file.** `lumen tets` said
  `cannot read \`tets\``, sending the reader hunting for a file they never meant
  to create. It says `unknown command \`tets\` — did you mean \`test\`?`. An
  unknown option after a command (`lumen run --weird app.lm`) was read as the
  filename; it is now reported as an option.
- **`std/fs` leaked Node's error text.** `ENOENT: no such file or directory,
  open '/x'` names an errno, a syscall and a quoting style that vary by
  platform and version — so the same Lumen program said different things on
  Windows. The messages are Lumen's now, mapped from the stable error code.
  `std/http` names the failing request instead of only "fetch failed".

### Added

- **`std/time`.** `now()` gave milliseconds and there was no way to turn one into
  a date, which left every log line, filename and guestbook entry stuck with a
  raw number.

  An instant is a `Num` of milliseconds — no date type — so `later - earlier` is
  the elapsed time, `<` compares two instants, and `sorted()` sorts a list of
  them with this module uninvolved. `iso`, `date`, `time`, `parts`, `fromParts`,
  `parseIso`, `plus`, `startOfDay`, `weekdayName`, `monthName`, `weekdayNames`,
  `monthNames`, `format`, `describe`, `offsetMinutes`.

  **Everything is UTC**, deliberately. Local time means time-zone names, which
  means the IANA database — a few hundred kilobytes that changes several times a
  year — and a program following the machine's zone would print different things
  on different computers, so a golden file or a date-stamped filename would
  depend on where it ran. `offsetMinutes(instant)` is the one door to local time:
  what this machine believes its offset is *at that instant*, so daylight saving
  is accounted for, and adding it leaves the assumption visible at the point it
  is made.

  `format` replaces `YYYY MM DD hh mm ss SSS` and leaves everything else exactly
  as written, in one left-to-right pass so a substituted value cannot be re-read
  as a placeholder. No escaping rules, at the price of not being able to write a
  literal `MM`.

  `fromParts` works around a host trap worth naming: `Date.UTC` still applies a
  rule written for two-digit years in the nineties, reading years 0–99 as
  1900 + the year, so `fromParts(50)` would have answered 1950. It computes four
  hundred years later and subtracts them back, which is exact because the
  Gregorian calendar repeats every 400 years to the day — and unlike patching the
  year afterwards, it survives a month or day that rolls over into the next year.

- **`router` and `route` in `std/web`.** A site no longer needs a chain of
  `if req.path == ...`:

  ```lumen
  let app = router([
    route("GET", "/", fn(req) { html("<h1>home</h1>") }),
    route("GET", "/post/:slug", fn(req) { postPage(req.params.slug) }),
    route("GET", "/static/*path", fn(req) { file(req.params.path, root: "public") }),
  ])
  serve(handler: app, port: 3000)
  ```

  `:name` matches one segment and `*name` the rest of the path; both arrive in
  `req.params`, percent-decoded, so every handler keeps the same one-argument
  shape. A route may name several methods separated by spaces. Patterns are
  compiled once when the router is built, not per request.

  Two things it gets right that the chain in `examples/website.lm` did not. A
  request whose path matches but whose method does not now gets **405 with an
  `allow` header**, not 404 — a client debugging against a 404 cannot tell a
  wrong URL from a wrong verb. And **a trailing slash is not a different
  route**, because links and browsers add and remove it freely.

  `examples/website.lm` is rewritten to use it, which removed a
  `slice(req.path, 6)` whose 6 had to be recounted by hand every time the
  `/post/` prefix was edited.

- **`std/set`, set operations over lists.** `of`, `has`, `add`, `remove`,
  `union`, `intersection`, `difference`, `symmetricDifference`, `isSubset`,
  `isSuperset`, `isDisjoint`, `equals`, `size`, `isSet`, `duplicates`.

  There is no new `Set` value: a set here is an ordinary `List` with no
  duplicates, so `map`, `filter`, `sorted`, `len` and `for … in` all still work
  on one, `print` shows it the way you would write it, and `type()` answers
  `List` rather than a polite fiction. Every function keeps the order of its
  first argument, because a program that prints a set has to print it in some
  order and "the order you built it in" is the only one that is stable across
  runs.

  The bulk operations index one side and walk the other, so they are linear
  rather than quadratic — which is the reason the module exists, since the same
  thing written with `filter` and `contains` is quadratic and quietly so. The
  single-element operations still have to build that index to answer one
  question, and the module says so rather than implying an `O(1)` it does not
  have.

  Membership follows `==` exactly, including the case that makes it hard:
  `inspect` prints a map's entries in insertion order, so `{x: 1, y: 2}` and
  `{y: 2, x: 1}` have different text despite being `==`, and using it as the key
  would have put both in the same set. The key sorts them. That property — two
  values share a key exactly when `==` calls them equal — is not observable from
  Lumen, so it is tested directly over every ordered pair of a list of values
  chosen to break it.

- **More of `std/list`:** `groupBy`, `partition`, `chunk`, `windows`, `flatMap`,
  `scan`, `intersperse`, `insert`, `removeAt`, `concat`, `minimum`, `maximum`,
  `minBy`, `maxBy`. `groupBy` and `partition` are the two that were most missed:
  both are awkward to write with `reduce` and both are one line to use.

- **More of `std/map`:** `update`, `mapValues`, `filter`, `invert`, `pick`,
  `omit`. `update` takes a fallback for a missing key, so a word counter is
  `counts.update(word, fn(n) { n + 1 }, 0)` rather than a `get`, a `match` and a
  `set`.

- **More of `std/str`:** `trimStart`, `trimEnd`, `capitalize`, `title`, `count`,
  `splitOnce`, `words`, `center`, `removePrefix`, `removeSuffix`. `splitOnce` is
  the one `split` cannot do: `"key=a=b"` splits into three pieces and loses where
  the key ended, where `splitOnce` gives `["key", "a=b"]`.

- **More of `std/math`:** `asin`, `acos`, `atan`, `atan2`, `cbrt`, `hypot`,
  `gcd`, `lcm`, `randomInt`, and the constants `TAU` and `INFINITY`. `INFINITY`
  is not a value any literal can name — `1e400` is a lexer error — so a
  comparison against "no limit" had no way to be written.

- **`examples/schedule.lm`**, a topological sort written with set operations:
  build order as waves of tasks that can run at once, with the two failures that
  matter — a cycle, naming the tasks caught in it, and a dependency on a task
  that does not exist.

- **`lumen fmt`, a formatter that only touches indentation.** `lumen fmt [path]`
  rewrites leading whitespace in place; `lumen fmt --check [path]` writes
  nothing, names the files that need it, and exits non-zero, which is what CI
  and a pre-commit hook want.

  The scope is the interesting decision. It does not move line breaks — a line
  break ends a statement in Lumen, so moving one changes what the program means
  — and it does not touch spacing inside a line, so a table lined up by hand
  stays lined up. Two rules do the work: a level is added by **a line** that
  leaves a bracket open rather than by each bracket, so `print(match c {`
  indents its body once and not twice; and each open bracket remembers the
  indentation of the line that opened it, so a `}` closing mid-line returns to
  the right place, which a depth counter cannot do. Column alignment is
  recognised rather than overruled — a row starting at the column of the first
  element above it is kept there, and shifts with that line if the line moves.

  It is specified in [docs/spec.md](docs/spec.md) §1.3 rather than left to the
  implementation, and three properties are asserted for every one of the 125
  `.lm` files in the repository, and for ten randomly mangled variants of each:
  only whitespace changes, the token stream comes out identical, and running it
  twice is running it once. The second is the one that matters, because
  whitespace inside a multi-line string is part of its value — which is why a
  line beginning inside a string, an interpolation or a block comment is emitted
  byte for byte, and why a file that does not lex is returned unmodified.

  Every file in the repository was already formatted when the tool was finished,
  which is the result worth reporting: the rules were derived from what the code
  already did rather than imposed on it. Flattening all 125 files to the left
  margin and reformatting restores 114 of them byte for byte; the other 11 use
  column alignment, which flattening destroys for good.

- **Variadic functions.** `fn shout(..parts)` collects every remaining
  positional argument into a `List`, empty if there are none — the same `..`
  a list pattern already used, in the one place a function shape needed it.
  Native functions could always do this, which is why `print` takes any number
  of arguments; nothing anyone wrote could. At most one, always last, never
  with a default: `PA017` for either mistake. `help()` shows the `..`, and
  shows default values too, which it had been quietly omitting.
- **`npm run docs` runs every documented example and checks what it prints.**
  `tests/unit/docs.test.ts` already checked that each ```lumen block parses,
  which catches a block that is not Lumen and nothing else. What actually
  happens is that the language moves underneath prose nobody re-runs. On its
  first run this found three: the tutorial teaching `RT029` for a mistake the
  static checker had started catching as `RS005`, a list of string methods
  missing `len` added long afterwards, and a column of figures padded by hand
  and padded wrong. All three are fixed. A block that cannot run on its own is
  skipped with `<!-- no-run: reason -->`, and the reason is required, so
  skipping is a decision somebody made rather than something that quietly
  happened. `docs/tour.md` and `docs/from-python.md` use a second convention,
  the result in a trailing comment, and 27 of those are checked as well —
  everything before an em dash is the claim. Where a block's prints do not
  produce one output line each the mapping is a guess, so those are counted as
  unchecked rather than guessed at, and the summary says how many, which keeps
  the number it reports honest about what was actually verified.
- **`docs/learn.md` caught up with the language.** Destructuring, swapping,
  `..` parameters, `getOr` and `fixed` are all things a beginner now reaches
  for and none of them were in the guide that teaches beginners.
- **`std/web.file(path, root)`.** A site could not serve a stylesheet, an image
  or a font — which makes "you can build a website with this" a stretch. The
  content type comes from the extension, a directory resolves to its
  `index.html`, percent-encoding is decoded so `/my%20file.txt` finds the file
  it names, and binary content comes back byte for byte (the server now writes
  a non-text body as latin1, since a Lumen `Str` is code points and writing one
  as utf8 doubles every byte above 127).

  `root` is enforced as a boundary rather than documented as one. Writing this
  by hand is where people put a path-traversal hole, so the path is decoded
  first, resolved, and then compared against the resolved root — a 404 for
  anything outside, the same answer a missing file gets, because saying which
  of the two happened is itself information. Six spellings of the attack are in
  the test suite, each asserted not to return the file they are reaching for.
- **`LUMEN_AI_MOCK_REPLY`**, and `examples/triage.lm` to go with it. The AI
  slice could show a call being made but not a program surviving the answer,
  which is the part that is actually hard: a reply is text, so asking for JSON
  still gets you prose, an apology, or JSON in a code fence, and the call can
  fail outright. The example classifies support tickets — asking for JSON,
  unwrapping a fence, checking every field, falling back to its own keyword
  rule when the reply is not usable, and retrying with backoff when the call
  fails. Under the mock provider the fallback is what you watch working, which
  is the honest thing for an example to show; the new variable scripts the
  mock's reply so the other paths are reachable with no key. Six tests drive
  all of them. The mock still never reads the prompt to decide what to say.
- **`std/option` and `std/result`,** and their methods. `match` is the honest
  way to handle absence or failure and will always be there, but a great many
  uses are one of three shapes — turn the value into another value, supply a
  default, ask which one you have — and writing each as a two-armed `match`
  buries the interesting line in ceremony. `find(notes, id).map(title)
  .unwrapOr("(none)")` is now available alongside it. Found by writing a test
  that naturally wanted `.map` on an Option and discovering the type had no
  methods at all, which for a language whose errors are values was a hole in
  the middle of it.
- **A keyword can be a name where nothing else could be.** `{ if: 1 }`, `m.for`,
  `struct Config { while: Bool }` — a keyword is only a keyword where a
  statement or an expression could begin, and after a `.`, before the `:` of a
  map entry, or as a struct field there is nothing else it could be. This
  matters because data does not know Lumen's keywords: `parse('{"if": 1}')`
  produces a map with a key called `if`, and there was previously no way to
  write that key or to reach it with a dot. Even `true` was affected. A binding
  name stays the exception — it must be readable as a bare expression later, so
  `fn f(in)` is still an error.
- **`examples/notes/` — a program in three files,** which no single-file example
  could show: a store that returns values and prints nothing, a renderer that
  knows nothing about storage, and a main that decides the order. The split
  earns itself in `store_test.lm`, which tests the whole data layer with
  ordinary comparisons and no captured output. CI runs it.
- **`lumen check [path]`.** Parse, resolve and type-check a whole tree without
  running any of it. It is what an editor, a pre-commit hook or a CI step wants:
  running a program to find out whether it has a typo is a poor trade when the
  program writes files or serves a port. Three CI steps now use it, over
  `examples/`, `tests/lumen/` and `bench/` — deliberately not over
  `tests/conformance/`, where many fixtures are wrong on purpose.
- **Destructuring bindings.** `let [lo, hi] = minMax(xs)` — the same pattern
  language `match` and `for` already used, now on the left of a `let` or `var`,
  nested patterns and `..rest` included. It is how a function returns more than
  one thing without a wrapper struct. A pattern that does not fit is `RT047`,
  because a `let` has no second arm to fall through to. Found by writing
  `let [i, values] = mostConstrained(grid)` in an example and discovering the
  language could not say it.
- **Destructuring assignment.** `[p, q] = [q, p]` — a swap in one line, with no
  temporary, because the right side is evaluated in full before anything is
  written. Each element is a place in its own right, so fields, indices and
  nested lists all work, and a `let` binding among them is refused as it would
  be anywhere else. `docs/from-python.md` listed "no tuple assignment and no
  swapping" under what Python does better; that line is gone.
- **`fixed(n, places)`**, in the prelude: a number as text with exactly that
  many decimals. `round(n * 100) / 100` rounds the value but cannot make `4.5`
  print as `4.50`, because the trailing zero is not part of the number — so a
  column of money or percentages had no way to line up. Every example that
  printed a figure was working around this; four of them are now a line
  shorter. Width stays a separate job: `fixed(x, 2).padStart(8)`.
- **`Num` methods.** `2.pow(10)`, `(2.7).round()`, `(9).sqrt()`,
  `(4.5).fixed(2)` — the `std/math` functions whose first argument is the
  number itself. Listed explicitly rather than taken wholesale, because
  `random()` takes no number and `PI` is not a function.
- **`getOr(m, key, fallback)`** on maps. `m[key]` gives `nil` for a missing
  key, which a counter then has to test for on every increment;
  `counts[word] = counts.getOr(word, 0) + 1` is the line people actually want.
  `get` still returns an `Option`, for when absence is the interesting case.
- **`enumerate(xs, start: 1)`.** Numbering a printed list from one is at least
  as common as indexing from zero, and writing `i + 1` at every use is worse.
- **`std/web.form(req)`** reads the fields a form submitted, whichever way the
  page sent them: the query string for `method="get"`, the urlencoded body for
  `method="post"`. A handler no longer has to know which, and percent- and
  plus-encoding are decoded on the way through. A request carrying anything
  else comes back empty, with `req.body` still there to parse.
- **Eight worked examples** — `fizzbuzz`, `wordcount`, `bank`, `calculator`,
  `stats`, `caesar`, `matrix` and `adventure`. Each is a program someone might
  actually write rather than a feature demonstration, and each is run by CI.
  The calculator is a recursive-descent parser for arithmetic written in
  Lumen; the adventure plays itself when there is nothing on stdin, so running
  it in CI exercises the whole game rather than its first room. `guestbook` is
  one file that is both a site and a script — `lumen serve` serves its routes,
  `lumen run` calls the same handler with requests written by hand and asserts
  that what a visitor typed reaches the page as text rather than as a tag.
  `inventory` parses JSON, groups and totals it, writes the summary back out
  and reads it in again.

## [0.1.0] — 2026-09-13

The first working version. Everything below runs today.

### Language

- Expression-oriented syntax with braces and optional semicolons
- `let` (immutable) and `var` (mutable) bindings
- Functions with type annotations, default values, named arguments, and hoisting
- Closures capturing by reference
- Structs and enums, including enum variants with payloads
- `match` with literal, binding, wildcard, list (with rest), struct and enum
  patterns, plus guards
- `Result` and `Option` built in, with postfix `?` propagation; no exceptions
- Pipeline operator `|>`
- String interpolation with full expression support and correct brace nesting
- Ranges, lists, string-keyed maps
- `if` as an expression; `while`, `for`, `break`, `continue`
- Modules: `import`/`export`, `std/*` modules and relative `.lm` files
- No async colouring — I/O is awaited implicitly

### Fixed

- `"abc".len()` raised while `[1, 2].len()` worked. `std/str` had no `len`, so
  strings were the one container without the method. They now agree.
- `any` and `all` required a predicate, so `any([true, false])` — the form a
  Python programmer reaches for first — was an error. The predicate is now
  optional and the elements are tested directly without one.
- `docs/tour.md` documented `for [k, v] in { a: 1 }`, which does not parse: in a
  loop header a `{` starts the body, so the map needs parentheses. The example
  is corrected and the rule is now explained where it bites.
- The prelude table in `docs/stdlib.md` still listed ten names when there were
  thirty-eight. It is generated from a live interpreter now, so it cannot go
  stale again, and the core built-ins carry documentation so `help()` is
  complete.

### Types

Annotations are enforced where they are written, before the program runs.

- `TY001` an argument that does not match the parameter's declared type
- `TY002` a returned value that does not match the declared return type
- `TY003` an initialiser that does not match a binding's declared type
- `TY004` a struct literal field that does not match the field's declared type

The checking is gradual: anything the checker cannot determine is `Any`, and
`Any` is compatible with everything, so a program that writes no annotations is
never type-checked and cannot produce a single diagnostic.

There is no inference, with one sound exception: an unannotated `let` takes the
type of its value. That is safe precisely because `let` is immutable — the
binding can never later hold something else, so the inferred type cannot become
wrong. A `var` stays `Any`.

Verified the same way as the resolver: every Lumen file in the repository was
checked before the pass was wired in. 66 files, none flagged.

### Static checks

Programs are now checked before they run, so a mistake is reported whether or
not execution happens to reach it.

- `RS001` a name that is not defined anywhere in scope, with a suggestion
- `RS002` a `match` over an enum that misses a variant. A guarded arm does not
  count as covering one, because the guard may be false
- `RS003` a `match` arm that can never be reached
- `RS004` a name declared twice in one scope
- `RS005` assignment to a binding introduced with `let`

The guiding rule is no false positives: anything the resolver cannot be certain
about it leaves to the interpreter, which still enforces every one of these at
run time as a backstop. Verified against every Lumen file in the repository —
56 valid programs, none flagged.

Diagnostic suggestions were also tightened. The "did you mean" threshold now
caps at an edit distance of 3, so a long name can no longer match something
unrelated; a confident wrong suggestion costs more than none.

### Ergonomics

- **Method-call syntax.** `x.f(a)` means `f(x, a)`. Because every standard-library
  function takes its subject first, `x.f(a)`, `f(x, a)` and `x |> f(a)` are three
  spellings of one thing, and every existing library function gained method syntax
  without a line of new library code. Methods are available on `Str`, `List` and
  `Map`. On a map, a real key always wins over a method of the same name, so no
  existing lookup changes meaning.
- **A prelude worth having.** `range`, `sum`, `sorted`, `reversed`, `min`, `max`,
  `abs`, `round`, `floor`, `ceil`, `map`, `filter`, `reduce`, `enumerate`, `zip`,
  `any`, `all`, `join`, `split` and `input` now need no import. Previously even
  `map` and `filter` did, which was a lot of ceremony before a beginner had done
  anything. A user binding of the same name still shadows the prelude one.
- **`help()`.** `help()` lists everything in scope, `help(value)` shows a value's
  type and the methods available on it, `help(fn)` shows a signature and
  description, and `help("std/list")` lists a module. Standard-library functions
  carry one-line documentation.
- **`input(prompt)`** reads a line from the console, as `Some(line)` or `None` at
  end of input, so interactive scripts are possible.
- `min` and `max` accept either a list or several numbers, because guessing which
  one a language chose is a bad first experience.

### Tooling

- `lumen` CLI: `run`, `serve`, `repl`, `test`, `tokens`, `ast`
- REPL with a persistent scope, multi-line input, and `:help`, `:type`, `:ast`,
  `:env`, `:modules`, `:clear`
- Diagnostics with source spans, carets, stable codes and suggested fixes

### Standard library

- `std/core`, `std/str`, `std/list`, `std/map`, `std/math`, `std/json`,
  `std/fs`, `std/http`, `std/web`, `std/ai`
- `std/web` serves real HTTP with routing, JSON, HTML escaping, and a page helper
- `std/ai` speaks to Anthropic and OpenAI, with a deterministic `mock` provider
  so examples and CI need no API key

### Distribution

- `npm run binary` builds `build/lumen`, a native standalone executable that
  runs Lumen programs with no Node, no npm and no `node_modules` present. It
  embeds a JavaScript runtime, so it is around 100 MB
- `npm run binary:all` cross-compiles five targets from one machine: linux-x64,
  linux-arm64, macos-x64, macos-arm64 and windows-x64. Bun compiles them, at
  build time only — it is never needed to run a binary
- `npm run bundle` builds `build/lumen.cjs`, one self-contained CommonJS file
  that runs the whole CLI on any Node 20 or newer with no install, no
  `node_modules` and no source tree
- `npm run dist` builds both tiers
- The bundler, `scripts/bundle.mjs`, is purpose-built, so single-file
  distribution still costs no dependency
- Binary builds record SHA-256 checksums in `build/SHA256SUMS.txt`

### Project

- Zero runtime dependencies
- 207 tests and 74 conformance fixtures, green on Node 20/22/24 across Linux,
  macOS and Windows
- Specification, tour, standard-library reference and design rationale
- Proprietary licence; every package marked private, enforced by CI

### Known limitations

Type annotations are parsed but not enforced, and `match` exhaustiveness is
checked at run time rather than before it. See [ROADMAP.md](ROADMAP.md).

[0.1.0]: https://github.com/HZMGTX/Code-language/releases/tag/v0.1.0
