# Changelog

All notable changes to Lumen are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lumen follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the
stability policy in [docs/spec.md](docs/spec.md) §10.

## [Unreleased]

### Language

- **`RS011`: a binding that is never read — the first warning.** Nothing in the
  language had ever produced one: every check either rejected a program or said
  nothing, and `Severity` had carried an unreachable `'warning'` arm since v0.1.

  A binding nothing reads is dead code or a typo somewhere else, and neither
  stops the program running — so rejecting it would mean rejecting programs
  that work. `checkModule` now draws that line directly: it raises on errors
  and *returns* warnings, so `lumen check` prints them and still exits zero. A
  build that fails over an unused binding is a build people learn to pass with
  `--no-verify`.

  The rule is narrow on purpose, because a check that is merely advisory has to
  be worth reading. Only `let`, `var` and `import`: a parameter is often unused
  deliberately, a function may be the point of the file, and a pattern binding
  already has `_`. Never for a name starting with `_`, and never for anything
  the module exports.

  Writing does not count as reading, but a compound assignment does — `total +=
  n` reads `total`. That distinction was a false positive when first written,
  found by running the check over this repository.

  It found 23 real ones there, all imports used only as methods. A method comes
  from its type's table and never from scope, so `xs.groupBy(f)` works with no
  import at all and those imports really were dead. They are gone.

- **`from` and `as` are no longer keywords.** Each appears in exactly one
  position in the grammar — after the `}` of an import list, and between a name
  and its alias inside one — so the parser looks for the word where it means
  something and leaves it an ordinary name everywhere else. `as` already worked
  that way; `from` did not.

  Reserving it bought nothing and cost a great deal. `let from = ...` is what
  anybody writes for a rename, `replace(s, from, to)` is how every other
  language spells that function, and `relative(from, to)` is the conventional
  signature — all three were syntax errors, and the standard library twice
  ended up with a parameter no Lumen program could have declared. It came up
  three times in one afternoon, which is enough.

  The rest of the keywords stay reserved: each can begin a statement or an
  expression, where a name could also begin, so they genuinely keep the grammar
  unambiguous.

### Added

- **The language server gained find-references, rename, document highlight and
  signature help.** All four work by **identity** rather than by name: the
  resolver says where each use was declared, so the set is exactly the uses
  that resolve to the same binding. Two different `x` in two different scopes
  are two different bindings, and a rename that changed both would be a rename
  that broke the program — which is precisely what a name-matching
  implementation does, silently.

  Signature help is the feature the typed standard library most obviously
  buys: `"7".padStart(` is a question that had no answer at all before, and now
  gets `padStart(width: Num, fill: Str = ...) -> Str` with the current
  parameter marked. It repairs the document first, like completion, because a
  call is asked about while it is being typed and therefore has no closing
  bracket yet.

  A rename to something that is not a name is declined rather than performed:
  an editor sends whatever the person typed, and silently producing a file that
  does not parse is worse than saying no.

- **A declaration's name has a span of its own.** `RS004` used to draw a caret
  under the whole of `let total = 2` to say that `total` was declared twice,
  which points at everything except the part that is wrong. It now underlines
  the name — and that span is what made rename possible, since replacing the
  declaration's span would have replaced the declaration.

- **The guides know what the language can do now.** `docs/tour.md` said
  "Twelve standard modules" and listed twelve, six modules after that stopped
  being true — a count in prose goes stale exactly as fast as one in digits and
  is harder to notice, so the same check that pins the README's numbers now
  pins the tour's module list. `docs/from-python.md` gained a table of the
  standard library by the Python module a reader would reach for: `re`, `csv`,
  `pathlib`, `subprocess`, `random.seed`, `sys.stdin.read()`, and the four
  differences worth knowing before hitting them.

- **Every standard module is checked for being exercised by something that
  runs.** `std/http` shipped with no fixture, no unit test and no example — the
  only one — so the client half of "you can build a website with this" had
  never once executed. That was found by reading, which is not a method. The
  check found `std/result` on its first run: its functions were well covered as
  methods, and the import path had never been run at all.

- **`std/crypto`** — hashing, HMAC, secure random, constant-time comparison.
  Four things, because a program that serves anything needs all four and gets
  at least one of them wrong by hand: an ETag, a content-addressed cache key, a
  webhook signature to verify, a session token to issue. Every digest in the
  fixture is a published test vector, so it checks the implementation against
  the standard rather than against itself.

  `token()` comes from the operating system, never from `std/math.random`, and
  is not affected by `seed` — that generator exists so a test can be repeated,
  which is the exact opposite of what a session id needs. `equals()` compares
  without leaking how much matched, because `==` on strings stops at the first
  differing character and that recovers a signature one character at a time.

  No encryption, no key exchange, no password hashing, and the reason is
  written down: each needs choices that change with the year, and a standard
  library making them silently is wrong in 2031 for everybody at once. `sha1`
  and `md5` are present and documented as broken, because real work needs them
  and omitting them only makes people write them worse.

- **Three bugs found by probing the new modules adversarially**, none of them
  visible from reading the code:

  - `isInside(".", "a")` was **false**. The check compared paths as text, and
    `"a"` does not start with `"./"` — so every program asking whether a
    relative path stays under the working directory was told no. It compares
    segment by segment now, which also handles the two cases it already got
    right (`/publicity` is not inside `/public`; `..` is resolved first).
  - `ext("..")` was `"."` and `stem("..")` was `"."`. `.` and `..` are
    directory references, not files whose name is empty and whose extension is
    a dot, so a path walking upwards lost half of itself to a function that was
    only supposed to look at it.
  - A CSV delimiter that already means something — a quote, a line break —
    was accepted and quietly did something else. `rows("a\"b", delimiter: "\"")`
    answered `["a", "b"]`, which looks like an answer and was an accident of
    which branch ran first. Refused now, with the reason.

- **Compound assignment went round the NaN guard.** `inf - inf` is `RT046`;
  `a -= inf` was a `NaN`, and `lumen check` said the file had no problems.
  Every binary operator goes through `checked`, and compound assignment had its
  own little arithmetic inside `storeInto` that did not — so `+=`, `-=`, `*=`
  and `/=` were the one path that could put a `NaN` into a Lumen value.

  `docs/spec.md` forbids it outright — *"any arithmetic that would produce one
  is `RT046`"* — and the reason is in the guard's own comment: a `NaN` is equal
  to nothing, including itself, so one that gets into a value poisons every
  comparison it later reaches. The whole point of `RT046` is that it cannot
  get in.

  All four now go through `checked`, and the message names the *base* operator:
  `the result of Infinity - Infinity is undefined`, because that is the
  arithmetic which has no answer and is what the reader has to see. `/= 0` is
  still `RT018`, and `Infinity` itself is still an ordinary value — it means
  "larger than we can say", it compares consistently, and it is equal to
  itself. A second fixture pins every ordinary use, including `+=` on a string
  and a list, and an index and a field as targets.

- **`std/list.pop` declared the wrong return type, so the idiomatic use was
  rejected.** The signature said `(xs: List) -> List`; the docstring says
  "Some(x), or None if empty" and the implementation returns exactly that. Only
  the signature disagreed — and a signature is not documentation that can be
  quietly wrong, it is what the checker believes:

  ```text
  error[TY001]: `unwrapOr` expects Option for `option` but was given List
  ```

  A false positive on correct code, which `docs/philosophy.md` names as the one
  thing gradual typing must never do. The converse was live too: code that
  really did treat the answer as a list was approved.

  Four tests already compared a signature with its implementation — the same
  parameter names, the same order, the same ones optional, the same defaults.
  None looked at the *return*, and there is nothing in TypeScript to compare it
  against: a native's callback is typed `Value` and nothing finer. So the new
  test **calls** each function and compares the answer's own `type()`, with
  arguments derived from the declared parameter types; a call that cannot be
  made is skipped rather than reported. 235 functions declare a return type and
  exactly one was wrong — then the test was checked against the bug it exists
  for by putting the signature back, and it names it exactly.

- **`std/option` and `std/result` reported the interpreter's internal tags.**
  `andThen([1], f)` said `note: this is list` — and there is no type called
  `list` in this language. Both use `typeName` now, which is what `type()`
  answers and what every other diagnostic in the library uses.

  Found by tripping over it while writing the test above: its first version
  rendered type names by hand and produced `num`, `str` and `list` rather than
  `Num`, `Str` and `List`, reporting all 72 functions as mismatched. The test
  uses `showTy` — the language's own rendering — for the same reason the library
  now uses `typeName`.

- **`min` and `max` were two functions, and importing the wrong one broke
  working code.** This compiled and ran:

  ```lumen
  let scores = [3, 1, 4, 1, 5]
  print(max(scores))
  ```

  and stopped compiling the moment somebody added
  `import { sqrt, min, max } from "std/math"`, with `TY008: max is missing a
  value for b`. True of `std/math`'s `max`, false of the `max` everybody means
  — and `std/math` is exactly where a reader goes looking for `min`.

  The prelude's pair is variadic and takes a list *or* the numbers themselves,
  because guessing wrong about which one a beginner meant is a bad first
  experience. `std/math` kept a narrower pair of its own, exactly two `Num`s,
  **with a signature saying so** — and the comment beside the prelude's version
  explains that a variadic deliberately carries none "so that the checker's
  argument-count rule can never be wrong about them". The narrow pair's
  signature is precisely what made the rule wrong.

  The prelude's header states the rule that was broken: *"so there is one
  implementation, not two."* The variadic pair lives in `std/math` now, where
  the functions belong, and the prelude takes them from there the way it already
  takes `split`, `join`, `abs` and `round` — one native, so the two cannot
  disagree. Which is the answer this project had already reached for `now`,
  shared between `std/core` and `std/time` for the same reason.

  The generated reference follows on its own: `min` and `max` read `min(...)`
  rather than a two-parameter signature, and typed coverage stays at 100%
  because variadics are excluded from both sides of that count — 244/244, was
  246/246.

- **The "no host error text" rule is now a test rather than a habit.**
  `docs/stdlib.md` has always said error text belongs to Lumen and not to the
  host, and every module kept it — which is exactly why nobody looked at the one
  `catch` in `std/process` that stringified whatever it caught. So the question
  is asked of the whole library at once: call every export with an argument of
  the wrong shape and with the awkward values, and fail if the answer contains a
  word only the host would use (`TypeError`, `ERR_…`, `errno`, `ENOENT`,
  `[object …]`, `node:internal`, and a dozen more).

  1701 calls, 390 ms, in-process. The result on the current library is zero,
  which is the answer worth having written down.

  Two things about building it are worth recording, because both were wrong
  first:

  - The first version used only wrong *types* — `nil`, `[]`, `0 - 1` — and when
    the `std/process` bug was put back to check the test, **it still passed**.
    `run("")` was the input that produced the `TypeError`, and no wrong type
    goes near it. An empty string, a zero and an empty collection are what a
    program computes by accident — a trimmed field, a `len()` of nothing, a
    list that filtered down to none — and that is where the unconsidered branch
    is. A check nobody verified against the bug it exists for is a check that
    reports "all clear" about nothing.
  - `null` and `NaN` were in the list of host words and had to come out. JSON
    spells nil `null`, so `stringify(nil)` is `null` and `std/web.json(nil)`
    carries a body of `null`; `Infinity` and `NaN` are how `inspect` renders
    those values. Both are Lumen's own spelling, and reporting them made the
    sweep call two correct answers defects — which is the failure mode a check
    like this has to avoid, because a check nobody believes is worse than none.

- **`inspect` did not print a value the way you would write it**, which is the
  contract stated in its own source. It escaped strings with
  `JSON.stringify` — escaping for a different language — and concatenated a
  `Map`'s keys raw:

  ```text
  inspect("${name}")      was  "${name}"       an interpolation, so a different value
  inspect("a\0b")         was  "a\u0000b"      Lumen writes \u{0}; this does not lex
  inspect({"a-b": 1})     was  {a-b: 1}        reads back as a subtraction
  inspect({"a\nb": 1})    was  {a              broke the line, and the output after it
  ```

  None of that needs a strange program. A `Map` key is an arbitrary string, and
  `std/csv.records`, `std/json.parse` and `std/web.form` all build maps whose
  keys somebody else chose — so printing a parsed CSV row with an awkward
  header column corrupted the log line it was in. A list element was *already*
  quoted (`[1, "a"]`, never `[1, a]`), so a key not being was one function
  answering the same question two ways.

  `quote` writes Lumen's escapes now, not JavaScript's: `\"`, `\\`, `\n`, `\t`,
  `\r`, `\u{…}` for the C0 controls and for a lone surrogate, and `\$` before a
  `{` — an escape the lexer has had since it was written and nothing was using.
  A bare `$` is left alone, because escaping every price and every shell
  snippet buys nothing. A key is bare only when it is a plain name.

  The test lexes the output instead of reading it, which is the part that would
  have caught this on day one: for every awkward string, `inspect` must produce
  exactly one token, that token must be a `string` and not a `template`, and it
  must carry back the value it started with. `template` is the whole `${` half —
  an unescaped marker does not produce a wrong string, it produces a different
  kind of token.

- **And a fifth, in the JSON locator added above.** The column it reports was
  counted in the host's UTF-16 units, so `["🎉",]` said column 7 where the `]`
  is the sixth character. Found by asking the same question of every function
  that hands back a position, which is what the previous four should have
  prompted immediately. Counting the *rest* of the library that way also turned
  up the one place the units genuinely differ on purpose, now written down in
  `ROADMAP.md`: a span's `col` is UTF-16 because that is what LSP means by a
  character, which is why the language server needs no conversion — and the
  terminal caret inherits it, so it is right for ASCII, right by coincidence
  for an emoji, and a cell out after a combining mark or a CJK character.
  Placing it properly means the East Asian Width table, which is a dependency
  this project will not take.

- **A regex match could not be found at the position it reported.** `std/regex`
  handed back the engine's UTF-16 offset while every position in Lumen is a code
  point, so `at` pointed one place past the match for every astral character
  before it — and the field exists for exactly one purpose:

  ```lumen
  let text = "🎉 order 42 shipped"       // the `4` is code point 8
  find(text, "\\d+")                     // said at = 9
  slice(text, 9)                         // "2 shipped" — inside the match
  slice(text, 9, 9 + len("42"))          // "2 " — not even the match itself
  ```

  A match whose own text cannot be recovered from its own reported position is
  not a position. `findAll` was worse: on `"🎉a🎉b"` the positions landed on the
  emoji and then past the end, so the last `slice` came back empty. Converted
  now, and the fixture pins the property rather than the examples —
  `slice(text, m.at, m.at + len(m.text)) == m.text` for every match.

  This is the fourth place the same mistake was found — `std/str.indexOf`,
  `padStart`, `padEnd`/`center`, and now this. The pattern is always the same: a
  function that delegates to the host and passes the host's units through a
  boundary where the units change.

- **A symlink walked straight out of a served directory.** `std/web.file`
  blocked every textual escape — `../`, `%2e%2e%2f`, an absolute path, a NUL
  byte, a backslash — and then served `public/keys.txt -> /etc/secrets` with a
  200, because the boundary was checked on the path as *written* and a symlink
  makes that a lie: a link inside the root pointing anywhere at all resolves to
  something that looks inside it. The module's own documentation says "`root` is
  a boundary, not a suggestion", which it was not.

  Nothing about the request has to be strange for a link to be there — an upload
  directory, a linked build artefact, a `node_modules` somebody symlinked. The
  boundary is checked twice now, once on the path as written and once on what
  the filesystem really has, with the root resolved too (`/var/www -> /srv/www`
  is an ordinary way to arrange a machine, and comparing a resolved target
  against an unresolved root would 404 every request on one). A link that stays
  inside still works, because `current -> releases/v3` is how deployments are
  done — which is the reason this checks rather than refusing symlinks outright.

- **And it served `.env`.** The other way a web root leaks is the files a
  checkout has in it anyway, and `file`'s default `root` is `"."` — the
  directory the program is running in. `.env`, `.git/config`, `.ssh/id_rsa`:
  the most-exploited misconfiguration on the web, available from a one-line
  handler. A path with a dot-leading segment is a 404 now. `.well-known` is the
  one exception and is not negotiable: it is where a certificate authority looks
  to prove the site is yours, so blocking it breaks HTTPS rather than protecting
  anything.

- **Half of `std/str` counted characters and half counted UTF-16 units.**
  `len`, `slice`, `chars` and `reverse` counted code points; `indexOf`,
  `padStart`, `padEnd` and `center` inherited JavaScript's counting, where an
  emoji is two. Two functions that disagree about what a position is are worse
  than either convention, because the whole point of them is being used
  together:

  ```lumen
  let line = "🎉name: value"
  let at = indexOf(line, ":")     // said 6; the colon is the sixth code point
  slice(line, 0, at)              // "🎉name:" — the half before it, with it
  slice(line, at + 1)             // " value" — a character late
  ```

  Both halves came back wrong, silently, for any text with an emoji in it —
  which is most text people type. And `padEnd(name, 28)` produced 27 characters
  by `len`'s count whenever `name` had one, so a table column was short by one
  for exactly the rows nobody tests with.

  All eight count code points now, and a fixture pins the property rather than
  the examples: `len(padStart(s, n, f)) == n` for every case, and
  `slice(s, 0, indexOf(s, sep))` is the half before the separator. Grapheme
  clusters are still not claimed — `reverse` of an `e` and a combining acute
  moves the accent, and there is no dependency-free way to do better — but the
  line is now drawn in the same place by everything in the module.

- **`parseIso` moved a date that does not exist instead of refusing it.**
  `parseIso("2024-02-30")` answered March 1st, and `parseIso("2023-02-29")`
  answered March 1st too — so a date read out of somebody's exported file
  shifted by a day and nothing said so. The host is the source of it and is
  incoherent about it: it rejects month 0, month 13, day 0, day 32, minute 60
  and second 60 on its own, and then accepts February 30th. If rolling over
  were the intent, month 13 would roll over into next January. It is an `Err`
  now, with the century rule applied — `1900-02-29` is refused, `2000-02-29` is
  not — and `24:00` is left alone, because ISO 8601 really does mean the end of
  that day by it. The module already overrode the host where it read an unzoned
  time as local; this is the same override for the same reason.

- **Four signatures declared a default the function does not have**, and the
  check that would have caught them did not exist. `std/time.time` said
  `seconds: Bool = false` and defaults to `true`, so the reference said
  `time(t)` gives `12:34` when it gives `12:34:56`. `std/math.log` said
  `base = 0` — a value the function itself rejects — and defaults to `e`.
  `std/math.fixed` said `places = 0` and defaults to `2`. `std/time.format`
  said `template = ""` and defaults to `"YYYY-MM-DD hh:mm:ss"`.

  The existing check compared names, order and *which* parameters were
  optional, and stopped there; the generated reference renders every default as
  `...`, so nothing anybody read would have shown the disagreement either. The
  test now parses each signature as the real declaration it is and compares the
  default expressions with the implementation's, which is what found all four —
  the first one by hand, and the other three in the three runs after it.

- **`std/json` says where the document goes wrong.** Every failure there is —
  an empty file, a trailing comma on line 300, an unquoted key, a string that
  never closes — answered with the same four words, "invalid JSON". That is
  unactionable about a file somebody else exported, and out of keeping with a
  language whose every other diagnostic carries a position, a caret and a "did
  you mean".

  ```text
  invalid JSON at line 3, column 29: a trailing comma: JSON has no comma before `]`
  invalid JSON at line 1, column 2: the key `name` needs double quotes around it
  invalid JSON at line 1, column 1: `tru` is not a value JSON knows — did you mean `true`?
  ```

  The original reason for saying nothing was sound and is kept: V8 rewords its
  JSON errors between Node releases, so `JSON.parse("{")` is "Unexpected end of
  JSON input" on one and "Expected property name or '}' in JSON at position 1"
  on another, and a Lumen program's output must not depend on which Node is
  installed. The wrong step was concluding that the *position* had to go too.
  It is worked out here instead, by a second scan of the text.

  That scan runs **only** after the host's parser has already refused the
  document, which is what makes a hand-written one safe: it cannot affect a
  document that parses, and the worst a bug in it can do is produce a vaguer
  message. Writing a parser good enough to *accept* every valid document —
  surrogate pairs, `__proto__` keys, the exact rounding of every number — is a
  much harder thing than writing one good enough to find where an invalid one
  first goes wrong, and the host already does the first perfectly well. A test
  pins the two together over 200,000 generated documents: the locator finds a
  problem exactly when `JSON.parse` refuses the text. An unclosed bracket is
  reported where it *opened*, not at the end of the file, because the `{` is
  the thing you have to go and look at.

- **`stringify` refused to write `null` for a number JSON cannot hold.**
  `Infinity` and `NaN` are ordinary Lumen values — the spec says overflow to
  `Infinity` is not `RT046` — and `JSON.stringify` writes `null` for both
  without a word. `null` is the worst possible substitute, because it is how
  JSON spells *absent*: an overflowed total did not merely lose its magnitude,
  it came back looking like a field nobody had filled in, and every check for a
  missing value then said yes. It is a panic naming the path now — `it is at
  $.total` — which is what this module already did for a function and for a
  cycle. A number with no JSON form is the same kind of thing.

- **Five more bugs, from turning the same adversarial probe on `std/process`
  and the language server.** The pattern that found the last three found these:
  use the thing the way a program would, then ask what it says when the answer
  is inconvenient.

  - **`lumen lsp` never exited.** LSP's `exit` notification asks a server to
    end its *process*; this one resolved a promise and kept running, because
    attaching a reader puts stdin into flowing mode and Node keeps a process
    with a live stdin pipe alive however the stream is left. So every editor
    session left an orphan behind — which is the one thing `exit` exists to
    prevent. It now exits with the status the protocol specifies: 0 after a
    `shutdown`, 1 for an `exit` that did not follow one, which is how an
    editor's log distinguishes a server that was asked to stop from one that
    had to be killed. The existing tests could not have caught it: they end by
    killing the child, so the process staying alive looked exactly like the
    process being shut down.

  - **The editor never showed a warning.** `checkModule` raises on errors and
    *returns* warnings, and the language server dropped the return value on the
    floor — so `RS011` was a warning on the command line and nothing at all in
    the editor, while the module's own header promised the two could never
    disagree. Two lines, and an editor that now draws what `lumen check` prints.

  - **A missing `cwd` blamed the program.** `run("pwd", cwd: "/gone")` answered
    ``cannot run `pwd`: no such program`` — a wrong answer of the worst kind,
    the sort that sends the reader to check their PATH, their spelling and
    their installation, none of which is the problem. Node reports a missing
    directory with exactly the `ENOENT` it reports for a missing program, right
    down to naming the *command* in `path`, so there is nothing in the error to
    branch on: the module looks at the directory before it spawns, in order to
    be able to say which one was missing.

  - **An empty command name leaked a Node `TypeError`.** ``run("")`` answered
    with "The argument 'file' cannot be empty", naming a parameter of a
    function the reader has never called, in a language they are not writing.
    Every other error in the module is a sentence; this one is now too.

  - **A negative timeout meant "wait forever".** Zero means no limit and is
    documented, but a negative number is what `deadline - now()` gives once the
    deadline has passed — so a program that had run out of time waited the
    longest of all. It is an `Err` naming the value.

  Two smaller things went with them: a rename the server declines because the
  new name is not a name now says so, rather than answering `null` — which is
  the valid answer for "no edits", so the person pressed Enter and watched
  nothing happen; and a comment claiming Lumen only ever produces errors, which
  stopped being true when `RS011` landed.

- **`std/csv`** — comma-separated values, as they actually arrive. Quoted
  fields containing the delimiter, a newline or a doubled quote; `\r\n` and
  `\n` mixed in one file; a delimiter that is not a comma. Reading and writing
  are inverses byte for byte, and a fixture asserts it.

  A ragged row is an `Err` naming the row rather than a guess: padding it makes
  every later column wrong by one, and dropping the extras throws data away. So
  is a duplicate column name, because one of the two would silently win and
  which one is not something a reader could predict. `rows` gives the raw grid
  for a caller who knows better.

  A **blank line** is the exception and is skipped: it is no data rather than
  misaligned data, and rejecting it was a rule that was right on paper and
  wrong on every file anybody actually has. Found by writing
  `examples/report.lm` against it.

  CSV has one type and it is text, so a `Num` written and read back is a `Str`.
  That is the format being honest rather than this module guessing which
  columns were numbers.

- **`std/path`** — paths as text, with **one separator** everywhere. A path is
  written with `/` and read with either, so a Windows path pasted into a
  program works and a path this module produces looks the same on every
  machine; Node's own `path` changes behaviour with the platform, which is the
  same reason `std/time` has only UTC. Drive letters and UNC roots are
  understood and preserved, because losing one silently turns an absolute path
  into a relative one.

  Nothing here touches the filesystem, which is what lets a program work out
  where things will go before doing any of it. `isInside(parent, child)` is the
  check a program serving files needs, with both ways of getting it wrong
  already handled: `/publicity` is not inside `/public`, and `..` is resolved
  first.

- **`std/regex`** — regular expressions, with the pattern as a `Str`. There is
  no `/.../` literal, deliberately: it would be ambiguous with division in a
  language whose newlines are significant, and every escape would then have to
  be understood by the lexer as well as by the matcher.

  The dialect is ECMAScript and says so. Every function that takes a pattern
  returns a `Result`, because a pattern comes from somewhere and `(` is an
  ordinary thing for a person to type. There is no backtracking guard, and that
  is written down rather than left to be discovered.

- **Randomness you can repeat.** `seed(n)` replaces the generator with one
  written in the library, so the same seed gives the same sequence on every
  machine and every version of Node — which is what makes a randomised test
  repeatable when it fails, and there was no way to write one before.
  `shuffle` and `choice` come with it, and `shuffle` is Fisher-Yates: the
  spelling everybody reaches for first, `sortBy(fn(_) { random() })`, is not
  uniform, because a comparison sort asks about the same pair more than once
  and gets different answers.

  Not cryptographic, and it says so.

- **`inputAll()`** — everything on the input as one string. The pipeline half of
  `input()`: `cat access.log | lumen run report.lm` could not be written with
  `input` alone without a loop and an `Option` to say "read the input".

- **`std/fs` gained `stat`, `isDir`, `isFile`, `copy`, `rename`, `makeDir` and
  `walk`.** `stat` reports a modification time as a Lumen instant, so
  `stat(p).modified.iso()` needs no conversion — Node reports a `Date`, and
  mixing the two units is how a program compares a timestamp against a duration
  and gets a plausible wrong answer. `walk` does not follow symbolic links: a
  tree containing a link to its own parent is not unusual, and walking it
  forever is not a useful answer.

- **`std/regex` gained `multiline` and `dotAll`**, which are most of what a
  regular expression is for over plain string work. Without the first, `^`
  matches only the very start of the text, so a pattern written to find
  something at the beginning of each line finds it at most once — and there was
  no way to ask for anything else. `(?m)` is not the way: JavaScript has no
  inline modifier group, so a pattern written that way does not compile.

  Found by writing a program that needed it, which is the only way this kind of
  gap gets found.

- **`std/time` exports `now`**, which until now lived only in `std/core`. Every
  other function in that module takes an instant, and the obvious way to get one
  is the current time, so `iso(now())` needing a second import was a surprise
  every reader had exactly once. It is one native in both places, so the two
  cannot disagree.

- **`std/process`** — running another program, with **no shell**. A command is
  a name and a list of arguments, never one string for `/bin/sh` to take apart:
  with a shell, every call has to decide how to quote whatever it interpolates,
  and the one that forgets turns a file called `; rm -rf ~` into a disaster.
  With an argument list there is nothing to quote, because nothing is parsed.

  What that gives up is written down rather than left to be discovered — no
  `*`, no `|`, no `>`, no `&&` — with the line of Lumen that replaces each.

  A non-zero status is `Ok`, because "did this program work" is the question
  being asked and `grep` says "no match" that way; `Err` is for not having run
  at all. `timedOut` is its own field rather than a status to interpret.
  `which` looks along `PATH` itself, since shelling out to `which` would need
  the shell this module does not have.

- **`examples/report.lm`** — a messy CSV in, a CSV and an HTML page out, which
  is the shape of most real work. Every awkward part is there on purpose: a
  comma inside a quoted field, a doubled quote, a field with a newline, `\r\n`
  endings, a blank line, two rows whose numbers do not parse, and a product
  called `Tom & Jerry's <Ever>` that has to reach the HTML as a name rather
  than as markup. Money stays whole pence throughout, because a report that is
  a penny out is a report nobody trusts.

  It also teaches the lesson its own data forced: the multi-line field is
  correct and destroys a terminal table, so display collapses it to one line
  while the CSV written back out keeps the newline.

- **`examples/rename.lm`** — renaming a folder full of files, safely. It plans
  every move before making any, refuses to overwrite, refuses to leave the
  folder it was pointed at, and can be run twice with nothing happening the
  second time. The dangerous parts of that job are all in what it does not do.

## [0.2.0] — 2026-09-14

A release about **depth**: the standard library declares its types, so calling
it is checked; the interpreter evaluates far more without allocating a promise;
and there is a language server, so all of it reaches an editor.

A `0.x` minor may change the language (spec §10), and this one does: four new
static checks reject programs that previously passed `lumen check` and then
failed when they ran.

### Added

- **A language server.** `lumen lsp` speaks the Language Server Protocol on
  stdio: diagnostics as you type, hover with types and documentation,
  completion, go to definition, and formatting. `editors/vscode` is a client
  for it, installed with a symlink.

  Neither side has a dependency, including no `vscode-languageclient`. LSP is
  JSON-RPC over a stream and the framing is a few dozen lines; taking a library
  for it would have broken the promise the rest of the project is built on.

  Everything the editor knows, `lumen check` knows — the same parser, resolver
  and type checker, so an editor can never tell you something the command line
  disagrees with. Two hooks were added for it, both recording what was already
  being computed and thrown away: `CheckOptions.record` hands over the type of
  every expression, and `ResolveOptions.reference` hands over where every name
  was declared. Working either out again in the server would have been a second
  implementation of the same question, free to answer differently.

  Completion after a `.` offers the methods on the receiver's type, which is
  worth having only because the library declares its types. It also *repairs*
  the document first: completion is always asked for on source that does not
  parse — `s.` is not an expression yet — so a server that only understands
  complete documents has no receiver type at exactly the moment it needs one.

- **A `lumen` launcher in a checkout**, for macOS, Linux and Windows.
  `lumen run app.lm` appeared throughout the documentation and existed nowhere
  in the repository, so `./lumen run app.lm` — the first thing anyone tries
  after cloning — failed with "not recognized".

- **The version is checked for being the same in all seven places it is
  written**, which nothing compared before: `lumen --version` could have said
  one thing while the packages said another.

### Language

- **`x |> f(a)` is type-checked.** §4.7 says `x.f(a)`, `f(x, a)` and `x |> f(a)`
  are one expression; the checker used to agree about two of them. The pipeline
  arm typed both halves, discarded the result and answered `Any`, so the one
  spelling the language calls interchangeable with the others was the one
  nothing checked. Both spellings go through the same code now, which is the
  only way they can be guaranteed to stay in step, and a pipeline's value has
  the function's return type rather than `Any`.

- **A rest parameter's declared type applies to every argument it collects.**
  `fn log(..parts: Str)` called as `log(1, 2, 3)` reported the `1` and said
  nothing about the rest: the parameter walk stepped past the rest parameter
  after one match and paired everything after it with nothing. A rest parameter
  is also correctly optional now — `log()` is a legal call of it.

- **A `fn(...)` annotation's parameters have no names**, rather than the
  invented `p0`, `p1` they used to carry. A call writing `f(p0: 1)` could match
  one by accident, and a diagnostic about one named a parameter nobody had
  written. They pair positionally, and a diagnostic says "argument 1".

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

- **The synchronous fast path recurses, and the benchmarks are 15-26% faster.**
  `evalLeaf` evaluated an expression without allocating a promise, but only
  literals and plain names — so in `xs[i] * 2 - 1` the leaves were fast and
  every node joining them still allocated one. It now handles `Binary`,
  `Unary`, `Logical`, `IndexExpr`, `MemberExpr`, `ListLit` and `MapLit` as
  well, each only when every part of it also resolves synchronously, returning
  `undefined` to fall back the moment one does not.

  Calls stay asynchronous, deliberately and permanently: any call may do I/O,
  which is the whole point of Lumen having no async colouring.

  Measured by interleaving two bundles, best of five — `loop.lm` −26%,
  `structs.lm` −17%, `fib.lm` −15%, `strings.lm` −6%, `collections.lm`
  unchanged, about −18% over the suite. `collections.lm` is unchanged because it
  spends its time in library calls, which stay on the async path. Promise
  machinery is now about 22% of non-library ticks on the `while` benchmark,
  down from the 37% the roadmap has been quoting.

  The measurement is the interesting part. The first run of it said
  `collections.lm` had **regressed 31%**, which was entirely an artifact of
  comparing the built CLI (thirty-odd ES modules) against a bundle (one
  CommonJS file). `scripts/bench.mjs` now takes `--this` as well as `--against`
  so that like is compared with like, and interleaves the two builds — A then B,
  then B then A — so that whatever the machine is doing lands on both.

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

- **The standard library declares its own types, so calling it is checked.**
  `upper(1)`, `"abc".padStart("x")`, `[1, 2].take("two")` and `{a: 1}.get(1)`
  all passed every static check and failed when they ran. They are `TY001` now.

  This is the largest thing the checker has gained, because a program that
  writes no annotations of its own still calls the library on nearly every
  line: the type checker had no channel to it at all, so every standard call
  was `Any` in and `Any` out.

  It still has no channel — `packages/core` imports nothing, which is the rule
  the whole project rests on. It is *told*: whoever builds an interpreter hands
  the static passes the type of every prelude name, every module export and
  every method, as data. The signatures live beside the implementations they
  describe, in the language's own annotation syntax, and are parsed with the
  real parser:

  ```text
  upper      (s: Str) -> Str
  padStart   (s: Str, width: Num, fill: Str = " ") -> Str
  split      (s: Str, separator: Str) -> List<Str>
  ```

  All 200 functions carry one. `tests/unit/signatures.test.ts` checks every one
  against the function it describes — same parameter names, same order, same
  ones optional — because a signature that has drifted is worse than none: a
  named argument would silently stop being checked.

  Three restraints keep it sound, all the no-false-positives rule. A function
  with no signature stays `Any`. Nothing is narrowed past what the
  implementation accepts — `contains(xs, value)` takes a list of anything, and
  `slice`'s `end` defaults to nil and means "to the end". And a variadic
  declares nothing at all: `min` and `max` take a list *or* the numbers
  themselves, which no fixed parameter list describes.

- **Method calls are checked.** `x.f(a)` is a call whose callee is a member
  expression, so giving the member its real type was the whole change — the
  three spellings of a call (§4.7) share one code path and cannot disagree
  about what they accept.

- **`TY007` and `TY008`: the wrong number of arguments.** Once a function's
  parameters are known, so is how many arguments a call may have. `[1].push()`
  and `"abc".upper(1)` are static errors now; so is `add(1)` for a two-parameter
  `add`.

  Reported only for a function that was actually *declared*. A `fn(Num, Num) ->
  Num` annotation records no defaults, so a value of that type may well be
  `fn(a, b = 1)` and a one-argument call is fine. And they stay quiet the moment
  an argument is named, because the interpreter then has a better answer than a
  count: `greet(nmae: "Ada")` is a typo in `nmae`, not a missing `name`.

- **`accepts` compares one `fn` type against another**, having returned `true`
  for every pair of them since it was written. Covariant in the result,
  contravariant in the parameters, and deliberately silent about arity, which a
  call reports where it happens and with a span pointing at it.

- **`RS009` and `RS010`: an import that names something that is not there.**
  `import { nope } from "std/list"` and `import { map } from "std/lst"` used to
  pass every static check and fail at run time, which made a mistyped import the
  one typo `lumen check` could not see.

  The checker still cannot *read* a module — `packages/core` depends on nothing,
  which is the rule the whole project rests on — so it is told instead, through
  `ResolveOptions.moduleExports`. That option had been declared and documented
  since the resolver was written, and read nowhere.

  A caller also names the namespaces it knows the whole of, so `std/lst` is a
  typo while `./helper` is a file nobody has read and stays trusted. That is the
  same no-false-positives rule as every other check here, and `RT002` and
  `RT042` still answer for a local module at run time.

- **`TY005`: an operator whose operands cannot be what they are.** `fn f(a: Num)
  { a + "x" }` passed every check and failed when it ran. The checker had both
  types in hand and threw them away, because the `Binary` case only asked whether
  they were *both* Num or *both* Str and answered `Any` otherwise.

  It fires only when **both** types are known: `1 - "x"` is reported, `a - "x"`
  for an unannotated `a` is not. That restraint is what makes the check sound
  rather than merely useful — `Num - Str` has no reading under which it works, so
  reporting it can never be wrong, while guessing about an `Any` could be. The
  rules are the ones the interpreter already enforced, moved earlier. `==` and
  `!=` still accept anything, deliberately: comparing values of different types is
  `false`, not an error.

- **`TY006`: an assignment that does not match the target's declared type.** An
  annotation is a promise about every value a binding will hold, and it was being
  kept only for the first. `var v: Num = 1` followed by `v = "text"` passed, which
  made the annotation decorative after line one — and a `var` is precisely where
  a second value turns up. Struct fields too: `p.x = "text"` where `P.x` is `Num`.

  A compound assignment is an operator as well as an assignment, so `total += "x"`
  on a `Num` is now caught by `TY005` — which needed doing here rather than in the
  `Binary` case, because the AST holds `+=` as one node and not as an addition
  followed by a store. An unannotated `var` stays `Any`, so reassigning it to
  another type is still silent and still legal: a `var` really can hold anything.

- **The type checker was not declaring loop or pattern bindings.** Found
  immediately by TY005, which reported `x * 2` inside `for x in [1, 2]` as
  multiplying a `Str` — because an outer `let x = "outer"` was still what `x`
  meant. Both `for` and `match` opened a scope and put nothing in it. They now
  declare what they bind: a loop variable takes the list's element type where it
  is known, and pattern bindings are `Any`, which is always safe.

- **One problem is now reported once.** A function's last statement is checked
  twice on purpose — once as a statement, once as the function's value — so
  `fn f(a: Num) -> Num { a + "x" }` reported the same message at the same place
  twice. Deduplicating in `report` rather than restructuring the walk, so any
  later pass that revisits an expression is covered without knowing about this
  one.

- **`main()` at the top level of a module that defines `main` is now `RS008`.**
  A module that declares `fn main` has it called once the file has been read, so
  writing the call as well ran the whole program twice. Nothing raised — the
  output simply appeared twice — and the call at the bottom is exactly how it is
  done in Python, which is where the habit comes from. Found by writing
  `examples/schedule.lm` and wondering why its output was duplicated.

### Fixed

- **`std/str.replace` had a parameter no Lumen program could declare.** It was
  called `from`, which is a keyword: you can pass it by name, because the parser
  is lenient about a keyword before a `:` in a call, but `fn replace(s, from,
  to)` is a syntax error. So the standard library had a function that could not
  have been written in the language the standard library is for. It is
  `replace(s, old, new)` now, which is also what Python calls it. Every
  parameter in the library is now checked for being an identifier.

- **`help()` says what a parameter is, not only what it is called.**
  `help(range)` was `range(start, end = ..., step = ...)`; it is
  `range(start: Num, end = ..., step: Num = ...) -> List<Num>`. A bound method
  drops as many leading parameters from its signature as the value itself has
  dropped, so `help("a,b".split)` is `split(separator: Str) -> List<Str>`. The
  generated reference in `docs/stdlib.md` is regenerated from the same source.

- **`parseExpression` threw an internal exception.** It was the one entry point
  that did not catch the parser's own unwinding signal, so a bad expression
  escaped as a `ParseAbort` instead of the `LumenError` its signature promises,
  and a caller had no way to render it. It also had no test and a docstring
  claiming the REPL used it, which is how that went unnoticed for so long.

- **`exit()` went around the host.** It called `process.exit()` from inside the
  standard library — the one place a Node API was reached for directly rather
  than through `Host`, and so the one thing that could not work in a browser or
  a worker, or in an embedding that would rather not have the program it runs
  take the whole process down. It is `Host.exit` now, optional like `readLine`:
  a host without one gets a plain "not available here" rather than a surprise.

- **A conformance fixture could not import a file beside it.** Fixtures are
  parsed under their bare name so goldens read `thing.lm:3:1` on every machine,
  which also meant a relative import resolved against the working directory.
  `createNodeResolver` now takes the directory to resolve from and reports
  imported files relative to it, so a diagnostic raised *inside* an imported
  module is both correctly located and machine-independent.

- **`pointSpan` is gone**, exported and unused since the day it was written.

- **`:ast` in the REPL printed raw JSON where `lumen ast` printed a tree.** Two
  renderings of one structure, and the worse one in the place you reach for it
  most: twenty-eight lines for `1 + 2 ** 3` where the tree is seven. It now uses
  the same renderer, so the two cannot disagree.

- **`lumen ast` printed `(node)` where an argument, a match arm or a parameter
  should be.** Seven AST types are structure rather than syntax — there is no
  `Arg` in the grammar, only a call with things in it — so they carry no `kind`,
  and the dumper had nothing to label them with. In the one command whose whole
  job is showing how Lumen read a file, that spent a line saying nothing.

  A wrapper with a single child is now rendered straight through, so a positional
  argument appears as its own expression, and every element of a list carries a
  `-`. Without the marker two match arms printed as `pattern: body: pattern:
  body:` and the reader had no way to see where the first ended. Marking only the
  multi-part elements was tried and read worse — an argument list then had some
  bulleted and some not, which looks like a distinction and is not.

  Neither `ast` nor `tokens` had a single test, which is how this survived:
  nothing in the language breaks when a debugging tool goes vague. Both have them
  now, including one that simply asserts the output never says `(node)`.

- **A value that contains itself no longer crashes four operations.** `print` has
  always shown `a.push(a)` as `[1, [...]]`, so the language had already decided
  such a value is real — but `==`, `clone`, `stringify` and set membership each
  overflowed the stack on one, reported as "a function is probably recursing
  without a base case" when no function of the reader's was involved. Lists, maps
  and structs are mutable, so building one takes a single line, deliberately or by
  accident.

  Each now does the right thing for what it is. `==` records the pairs it is
  comparing and calls a lined-up cycle equal, which is both the standard reading
  and the one that terminates. `clone` registers each copy before filling it in,
  so a cyclic value clones to a copy with its own cycle — and a value shared twice
  inside another stays one value in the copy rather than becoming two, because
  copying a value should not change its shape. `std/set` emits a back-reference to
  where the cycle closes, so two cycles built the same way key the same way.

  `stringify` is the one that has to refuse — JSON has no syntax for "the value we
  are already inside" — so it says so and names the path where the cycle closes
  (`$[2]`) rather than failing somewhere inside the host's own serialiser.

  One limit is stated rather than hidden: `==` calls `a = [a]` equal to
  `b = [[b]]`, since nothing distinguishes them however far they unroll, while
  `std/set` keys them differently and can hold both. Agreeing there needs a
  canonical form for infinite trees.

  `clone` being a **deep** copy is now documented, too. It always was; the
  reference listed the signature and said nothing, which is the one thing anybody
  needs to know about a clone.

- **`TY005` and `TY006` shipped without reaching the specification.** The §6 table
  lists the type checks exhaustively — it had `TY001` through `TY004` — and two
  more were added to the implementation without being added to it. The patch that
  was meant to do so silently matched nothing, and nothing noticed, so for several
  commits the document that defines the language did not mention two of the checks
  it performs.

  Both are now in the table with the prose that was meant to accompany them, and
  `check-counts.mjs` compares every `RS` and `TY` code the implementation can emit
  against the spec, so it cannot happen again. Only those two families: §8 says
  "selected codes" of `LX`, `PA` and `RT` and means it — there are eighty, and
  tabulating every one would make a worse document — but the static checks are the
  set a reader needs complete, because they are what `lumen check` can say about a
  program that has not run.

- **The README was telling three lies, and now cannot.** It claimed "207 tests, 74
  conformance fixtures" when there were 799 and 116; it said type annotations were
  "parsed but not yet enforced", which stopped being true when TY001 landed; and it
  said the suite was "green on Node 20/22/24 across Linux, macOS and Windows" on a
  repository where GitHub Actions has never managed to start a run. The first was
  staleness, the second a leftover, the third a claim that was never checkable.

  All three are corrected, and `scripts/check-counts.mjs` — a new sixteenth CI
  check — now compares every count against the repository, verifies that each
  `examples/*.lm` has a row in the README's table and that each `std/*` module is
  mentioned in the reference. `--fix` rewrites the counts. Written for the same
  reason as `check-doc-output.mjs`: documentation that is checked rather than
  merely written.

- **ROADMAP.md contradicted itself.** One row said "type annotations are not
  enforced" and the next said they are enforced where written — the first had been
  left behind by the type checker landing. Another said "no methods on built-in
  types: `len(x)`, not `x.len()`", which the method work made false a long time
  ago; the real limit is that a `struct` you define gets no methods, since method
  syntax is a calling convention rather than an object model and there is nowhere
  to register one. The file's opening line also read "nothing in this file is
  implemented today" over a table describing how v0.1 behaves *now*, which is the
  opposite of nothing.

- **`did you mean …?` no longer offers a different word as a typo.** The
  threshold allowed two edits on any name, so `nope` "meant" `type` — two of its
  four letters — and `import { nope }` "meant" `pop`. It now scales with length:
  one edit up to five characters, two up to eight, three beyond, so roughly a
  third of a name may differ and no more.

  Tightening it alone would have lost the real typos, because plain Levenshtein
  charges two for a transposition and transposing is the commonest slip there is.
  So `editDistance` now counts a swap of neighbours as one edit
  (Damerau-Levenshtein, restricted). `cuont` still finds `count` and `tets` still
  finds `test`, while `nope` finds nothing and gets the list of what does exist
  instead — which is the more useful answer for a name that was never a typo.

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

### Added, continued

- **`std/http` has executable coverage**, for the first time: it was the only
  standard module with no fixture, no unit test and no example, so the client
  half of "you can build a website with this" had never once run. A Lumen server
  using `std/web` and a Lumen client using `std/http`, over a real socket, with
  nothing stubbed.

- **A pass's header comment is checked against what it emits.** Both had
  drifted — `resolver.ts` listed RS001–RS007 while emitting RS008, `types.ts`
  listed TY001–TY004 while emitting TY005 and TY006 — and the check added for
  exactly this could not see it, because a code can be in the specification and
  still missing from the file that raises it.

- **Five methods on every value: `str`, `inspect`, `type`, `clone`, `isNil`.**
  Their subject is genuinely any value, so there was no type to attach them to
  and no reason to leave them off one. `42.str()` was `RT027`, and
  `n.str().padStart(3)` — a chain that has somewhere to put the conversion, which
  `"${n}"` does not — could not be written at all. `p.str()` on a struct had no
  spelling.

  Not a general fallback to whatever is in scope, and the difference is about
  error messages. Under a general fallback `[1, 2].upper()` would call `upper`
  with a `List` and fail somewhere inside `std/str`; as it is, it stays
  `RT027: List has no method \`upper\`` with the ones it does have listed. A
  per-type method of the same name still wins, so nothing existing changed
  meaning.

- **`examples/logs.lm`**, reading a log file and reporting on it — the job
  everybody has. It does the three parts people skip: it counts and shows the
  lines that do not parse (real logs contain half-written lines and wrapped stack
  traces), it prints the hours with **nothing** in them (the most interesting hour
  in an outage is exactly the row a `groupBy` drops), and it orders everything by
  something the data decides so two runs over one file agree.

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
