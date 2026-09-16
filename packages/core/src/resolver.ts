/**
 * The resolver: static checks that run before a program does.
 *
 * Until now a typo was only reported when execution reached it, so a mistake on
 * a branch that happened not to run stayed hidden. Lumen is fully lexically
 * scoped and has no `eval`, no dynamic scope and no runtime name construction,
 * so every name a program uses can be resolved without running it.
 *
 * What is reported:
 *   RS001  a name that is not defined anywhere in scope
 *   RS002  a `match` over an enum that does not cover every variant
 *   RS003  a `match` arm that cannot be reached
 *   RS004  a name declared twice in the same scope
 *   RS005  assignment to a binding introduced with `let`
 *   RS006  `break` or `continue` outside a loop
 *   RS007  a struct field or enum variant declared twice
 *   RS008  `main()` written out in a module that already has it called
 *   RS009  an import of a name a known module does not export
 *   RS010  an import from a module that does not exist
 *   RS011  a binding that is never read — a **warning**, not an error
 *
 * The guiding rule is **no false positives**. A check that rejects a valid
 * program is worse than one that misses an invalid one, so anything the
 * resolver cannot be certain about it leaves to the interpreter. That is why
 * exhaustiveness is only checked when every arm names variants of one enum the
 * resolver can actually see, and why a guarded arm never counts as covering a
 * variant — the guard might be false.
 */

import type {
  Block,
  EnumDecl,
  Expr,
  ImportSpecifier,
  MatchArm,
  Module,
  Param,
  Pattern,
  Stmt,
} from './ast.js';
import { type Diagnostic, type Note, type Severity, type Span, LumenError } from './diagnostics.js';
import { checkTypes, type CheckOptions, type Ty } from './types.js';
import { suggest } from './values.js';

interface Binding {
  readonly mutable: boolean;
  readonly span: Span;
  /** What introduced it, for the "already declared" message. */
  readonly kind: string;
  /**
   * True for a declaration the module exports, which is never unused: its
   * whole point is to be read from another file this pass cannot see.
   */
  readonly exported?: boolean;
}

class Scope {
  private readonly names = new Map<string, Binding>();
  /**
   * Names something in this scope has actually read.
   *
   * By name rather than by binding, because one scope holds at most one
   * binding per name — `declare` overwrites, and that overwrite is what `RS004`
   * reports. Shadowing happens in a *different* Scope object, so this stays
   * exact where an identity-based version would have to cope with the
   * fabricated bindings `lookupDeferred` hands back.
   */
  readonly used = new Set<string>();
  /**
   * Everything this scope will declare, known before its statements are walked.
   *
   * A function body does not run where it is written, so a name declared later
   * in an enclosing scope is perfectly visible to it:
   *
   *     fn greet() { "Hello, ${name}" }   // `name` does not exist yet...
   *     let name = "world"
   *     print(greet())                    // ...but it does by the time this runs
   *
   * Reporting that as undefined would reject a valid program, so lookups from
   * inside a function body consult this as well. Lookups at statement level,
   * which do run where they are written, do not.
   */
  private readonly future = new Map<string, boolean>();

  constructor(readonly parent: Scope | undefined) {}

  declare(name: string, binding: Binding): void {
    this.names.set(name, binding);
  }

  /** Record that `name` is declared somewhere in this scope. */
  expect(name: string, mutable: boolean): void {
    this.future.set(name, mutable);
  }

  own(name: string): Binding | undefined {
    return this.names.get(name);
  }

  lookup(name: string): Binding | undefined {
    let scope: Scope | undefined = this;
    while (scope !== undefined) {
      const found = scope.names.get(name);
      if (found !== undefined) return found;
      scope = scope.parent;
    }
    return undefined;
  }

  /** As `lookup`, but also accepting names this scope has yet to declare. */
  lookupDeferred(name: string): Binding | undefined {
    let scope: Scope | undefined = this;
    while (scope !== undefined) {
      const found = scope.names.get(name);
      if (found !== undefined) return found;
      const later = scope.future.get(name);
      if (later !== undefined) {
        return { mutable: later, span: ZERO_SPAN, kind: later ? 'var' : 'let' };
      }
      scope = scope.parent;
    }
    return undefined;
  }

  /**
   * Record that `name` was read, in whichever scope owns it.
   *
   * `future` counts as owning it: a function body may legitimately read a name
   * the enclosing scope declares further down, and marking the scope that will
   * declare it is what keeps `fn greet() { name }` from reporting `name` as
   * never used.
   */
  markUsed(name: string): void {
    let scope: Scope | undefined = this;
    while (scope !== undefined) {
      if (scope.names.has(name) || scope.future.has(name)) {
        scope.used.add(name);
        return;
      }
      scope = scope.parent;
    }
  }

  /** Everything declared here, for the never-used check when the scope ends. */
  declarations(): readonly [string, Binding][] {
    return [...this.names];
  }

  visible(): string[] {
    const out: string[] = [];
    let scope: Scope | undefined = this;
    while (scope !== undefined) {
      out.push(...scope.names.keys());
      scope = scope.parent;
    }
    return out;
  }

  /**
   * As `visible`, but also naming declarations still ahead of us. A typo in a
   * function body should be able to suggest a name declared later in the file,
   * since that body can legitimately reach it.
   */
  visibleDeferred(): string[] {
    const out: string[] = [];
    let scope: Scope | undefined = this;
    while (scope !== undefined) {
      out.push(...scope.names.keys(), ...scope.future.keys());
      scope = scope.parent;
    }
    return out;
  }
}

/**
 * Everything the static passes are told about the world outside the module.
 *
 * It extends `CheckOptions` rather than repeating it, so the one call that runs
 * both passes takes one object: names and scoping need the export lists, types
 * need the signatures, and a caller that has an interpreter in hand has both.
 */
export interface ResolveOptions extends CheckOptions {
  /** Names available with no declaration — the prelude. */
  readonly globals: readonly string[];
  /**
   * What a module is known to export, and the type of each, keyed by module
   * path. Imports of a module not listed here are trusted rather than guessed
   * at.
   *
   * This is how the standard library reaches a resolver that cannot import it.
   * `packages/core` depends on nothing, so it cannot look up what `std/list`
   * exports; the caller, which has a fully built interpreter in hand, can.
   * Core learns a data format rather than a dependency.
   *
   * Names and types together in one map rather than two, because two
   * statements of one fact drift: a name in the list and missing from the
   * types is a name the checker silently stops checking.
   */
  readonly moduleExports?: ReadonlyMap<string, ReadonlyMap<string, Ty>>;
  /**
   * Module paths beginning with one of these are *completely* described by
   * `moduleExports`, so one that is missing from it does not exist.
   *
   * Without this the resolver cannot tell `"std/lst"` — a typo it should
   * report — from `"./helpers"`, a local file it has never read and must not
   * guess about. The caller names the namespaces it owns; everything else
   * stays trusted.
   */
  readonly closedPrefixes?: readonly string[];
  /**
   * Called for every name that resolves, with where it was declared.
   *
   * For tooling: "go to definition" is this and nothing else. A built-in has a
   * zero span, which is how a caller tells "declared in this file" from
   * "part of the language". Off unless asked.
   */
  readonly reference?: (reference: Reference) => void;
}

/** A name, where it is used, and where it was declared. */
export interface Reference {
  readonly name: string;
  readonly use: Span;
  /** Zero-width at the start of the file for a built-in or the prelude. */
  readonly declaration: Span;
  /** What introduced it: `let`, `var`, `function`, `parameter`, `import`, … */
  readonly kind: string;
}

class Resolver {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly enums = new Map<string, readonly string[]>();
  private readonly moduleExports: ReadonlyMap<string, ReadonlyMap<string, Ty>>;
  private readonly closedPrefixes: readonly string[];
  /** Where to send every name-to-declaration link, when anybody wants them. */
  private readonly reference: ResolveOptions['reference'];
  /** True while walking a declaration the module exports. */
  private exporting = false;
  private scope: Scope;
  /** Greater than zero while walking a function body, whose execution is deferred. */
  private deferred = 0;
  /**
   * How many loops enclose the statement being walked. Reset across a function
   * boundary: a `break` inside a lambda cannot leave the loop the lambda was
   * written in, because by the time it runs the loop may be long finished.
   */
  private loops = 0;

  constructor(options: ResolveOptions) {
    this.moduleExports = options.moduleExports ?? new Map();
    this.closedPrefixes = options.closedPrefixes ?? [];
    this.reference = options.reference;
    const root = new Scope(undefined);
    for (const name of options.globals) {
      root.declare(name, { mutable: false, span: ZERO_SPAN, kind: 'built-in' });
    }
    this.scope = new Scope(root);
    // Result and Option are always matchable, whatever the prelude holds.
    this.enums.set('Result', ['Ok', 'Err']);
    this.enums.set('Option', ['Some', 'None']);
  }

  private report(
    code: string,
    message: string,
    span: Span,
    label?: string,
    notes?: readonly string[],
    severity: Severity = 'error',
  ): void {
    this.diagnostics.push({
      severity,
      code,
      message,
      span,
      ...(label === undefined ? {} : { label }),
      ...(notes === undefined ? {} : { notes: notes.map((m): Note => ({ message: m })) }),
    });
  }

  private pushScope(): void {
    this.scope = new Scope(this.scope);
  }

  private popScope(): void {
    this.checkUnused(this.scope);
    this.scope = this.scope.parent ?? this.scope;
  }

  /**
   * Bindings this scope declared and nothing ever read.
   *
   * The first thing in the language to produce a **warning** rather than an
   * error. A binding that is never read is either dead code or a typo
   * somewhere else, and neither stops the program running — so reporting it as
   * an error would mean rejecting programs that work, which this pass does not
   * do. A check that is merely advisory has to be worth reading, though, which
   * is why the rule below is as narrow as it is.
   *
   * Only `let`, `var` and `import`:
   *
   *   - **A parameter** is often unused on purpose — a handler that ignores its
   *     request, a callback that only wants the index — and there is no way to
   *     tell that from a mistake.
   *   - **A function, struct or enum** may be the point of the file, and a
   *     non-exported one is at worst dead code somebody is in the middle of
   *     writing. Reported, this would fire constantly while you work.
   *   - **A pattern binding** already has `_` for the parts nobody wants, and
   *     `match` arms name things for readability as much as for use.
   *
   * And never for `_`, which is the conventional throwaway, nor for anything
   * the module exports, whose whole purpose is to be read from a file this pass
   * cannot see.
   *
   * Writing to a `var` does not count as reading it. `var x = 0` followed only
   * by `x = 1` is a value nobody ever looks at, which is exactly the thing
   * worth saying.
   */
  private checkUnused(scope: Scope): void {
    for (const [name, binding] of scope.declarations()) {
      // `_` is the throwaway, and a leading `_` is how every other language
      // spells "I know, and I meant it". The fixtures in this repository had
      // already reached for `_a` and `_b` by instinct before the check existed,
      // which is as good evidence as there is that the convention is the right
      // one to honour.
      if (name.startsWith('_') || binding.exported === true) continue;
      if (binding.kind !== 'let' && binding.kind !== 'var' && binding.kind !== 'import') continue;
      if (scope.used.has(name)) continue;
      this.report(
        'RS011',
        '`' + name + '` is never used',
        binding.span,
        'never read',
        binding.kind === 'import'
          ? ['remove it from the import, or use it', 'a method needs no import: `xs.groupBy(f)` works without one']
          : ['remove it, or start its name with `_` if it is deliberately unused'],
        'warning',
      );
    }
  }

  /**
   * Record a binding.
   *
   * `span` is the **name's** span, not the whole declaration's. A diagnostic
   * about a name should underline the name: `RS004` used to draw a caret under
   * the whole of `let total = 2` to say that `total` was declared twice, which
   * points at everything except the part that is wrong. It is also what a
   * rename needs, since replacing the declaration's span would replace the
   * declaration.
   */
  private declare(name: string, span: Span, mutable: boolean, kind: string): void {
    // `_` is the conventional throwaway and may be repeated freely.
    if (name !== '_') {
      const existing = this.scope.own(name);
      // `built-in` is shadowable, and `unresolved` is not a declaration at all:
      // it is the recovery binding `use` invents for a name it has just
      // reported as undefined, so that the same typo is not reported at every
      // later use. Counting it as one made `let c = c` report *two* errors —
      // the true `RS001` and a false `RS004` claiming `c` was declared twice,
      // with a note citing the line of the **use** as "the earlier one". Across
      // lines that note names a line which declares nothing at all.
      //
      // The two kinds are already paired this way where assignment checks
      // mutability, a few hundred lines below; this is the same pairing for the
      // same reason.
      if (
        existing !== undefined &&
        existing.kind !== 'built-in' &&
        existing.kind !== 'unresolved'
      ) {
        this.report(
          'RS004',
          '`' + name + '` is already declared in this scope',
          span,
          'declared twice',
          ['the earlier one is on line ' + existing.span.start.line],
        );
      }
    }
    this.scope.declare(name, {
      mutable,
      span,
      kind,
      ...(this.exporting ? { exported: true } : {}),
    });
  }

  private use(name: string, span: Span): void {
    const found =
      this.deferred > 0 ? this.scope.lookupDeferred(name) : this.scope.lookup(name);
    if (found !== undefined) {
      this.scope.markUsed(name);
      // Where this name was declared, for whoever asked. The resolver has
      // always known it and always thrown it away the moment it had finished
      // checking, so an editor's "go to definition" had to work it out again —
      // a second implementation of the same question, free to disagree.
      this.reference?.({ use: span, declaration: found.span, name, kind: found.kind });
      return;
    }
    const hint = suggest(
      name,
      this.deferred > 0 ? this.scope.visibleDeferred() : this.scope.visible(),
    );
    this.report(
      'RS001',
      '`' + name + '` is not defined',
      span,
      'not found in this scope',
      hint === undefined ? undefined : ['did you mean `' + hint + '`?'],
    );
    // Declare it so the same typo is not reported at every later use.
    this.scope.declare(name, { mutable: true, span, kind: 'unresolved' });
  }

  // ------------------------------------------------------------------ module

  resolveModule(module: Module): readonly Diagnostic[] {
    this.expectAll(module.stmts);
    this.hoist(module.stmts);
    for (const stmt of module.stmts) this.stmt(stmt);
    this.checkMainCall(module);
    // The module's own scope is never popped, so its unused bindings are
    // checked here instead. The root scope above it holds the prelude, which is
    // not this module's business.
    this.checkUnused(this.scope);
    // In source order. Most are reported as the walk reaches them and so come
    // out sorted already, but a scope's unused bindings are only known when it
    // ends — so without this a warning about line 3 appears after an error
    // about line 30, and the list stops reading down the file.
    return [...this.diagnostics].sort((a, b) => a.span.start.offset - b.span.start.offset);
  }

  /**
   * `main()` written at the top level of a module that defines `main`.
   *
   * A program that declares `fn main` has it called once the file has been
   * read, so writing the call as well runs the whole program twice. Nothing
   * raises: the output simply appears twice, which is a confusing way to spend
   * an afternoon, and an easy habit to bring from Python — where the call at
   * the bottom is exactly how you do it.
   */
  private checkMainCall(module: Module): void {
    const declaresMain = module.stmts.some((stmt) => {
      const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
      return decl.kind === 'FnDecl' && decl.name === 'main';
    });
    if (!declaresMain) return;

    for (const stmt of module.stmts) {
      if (stmt.kind !== 'ExprStmt') continue;
      const call = stmt.expr;
      if (call.kind !== 'CallExpr') continue;
      if (call.callee.kind !== 'Ident' || call.callee.name !== 'main') continue;
      this.report(
        'RS008',
        '`main()` is called for you, so this runs the program twice',
        stmt.span,
        'already called',
        [
          'a module that defines `fn main` calls it once the file has been read',
          'delete this line; everything it does still happens',
        ],
      );
    }
  }

  /**
   * An `import` against what the caller says the module actually exports.
   *
   * Until this existed, `import { nope } from "std/list"` passed every static
   * check and failed at run time — the one class of typo `lumen check` could
   * not see, because the checker has no way to read a module it does not
   * import. It still cannot; the caller supplies the answer (`ResolveOptions`).
   *
   * Restraint, as everywhere in this file: a module the caller did not describe
   * is trusted completely. Only a path under a prefix the caller claims to own
   * can be wrong, and only a name missing from a listed module's exports.
   */
  private checkImport(
    from: string,
    specifiers: readonly ImportSpecifier[],
    span: Span,
  ): void {
    const exports = this.moduleExports.get(from);
    if (exports === undefined) {
      if (!this.closedPrefixes.some((prefix) => from.startsWith(prefix))) return;
      const hint = suggest(from, [...this.moduleExports.keys()]);
      this.report(
        'RS010',
        'there is no module "' + from + '"',
        span,
        'no such module',
        hint === undefined
          ? ['the modules available are: ' + [...this.moduleExports.keys()].sort().join(', ')]
          : ['did you mean "' + hint + '"?'],
      );
      return;
    }

    for (const spec of specifiers) {
      if (exports.has(spec.name)) continue;
      const hint = suggest(spec.name, [...exports.keys()]);
      this.report(
        'RS009',
        'module "' + from + '" has no export named `' + spec.name + '`',
        spec.span,
        'not exported',
        hint === undefined
          ? ['it exports: ' + [...exports.keys()].sort().join(', ')]
          : ['did you mean `' + hint + '`?'],
      );
    }
  }

  /**
   * Note every binding this scope will introduce, so a function body written
   * above one of them can still see it.
   */
  private expectAll(stmts: readonly Stmt[]): void {
    for (const stmt of stmts) {
      const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
      if (decl.kind === 'LetDecl') this.scope.expect(decl.name, decl.mutable);
      else if (decl.kind === 'ImportDecl') {
        for (const spec of decl.specifiers) this.scope.expect(spec.alias ?? spec.name, false);
      }
    }
  }

  /** Pre-declare functions and types, matching the interpreter's hoisting. */
  private hoist(stmts: readonly Stmt[]): void {
    for (const stmt of stmts) {
      const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
      switch (decl.kind) {
        case 'FnDecl':
          this.declare(decl.name, decl.nameSpan, false, 'function');
          break;
        case 'StructDecl':
          this.declare(decl.name, decl.nameSpan, false, 'struct');
          break;
        case 'EnumDecl':
          this.declare(decl.name, decl.nameSpan, false, 'enum');
          this.enums.set(decl.name, (decl as EnumDecl).variants.map((v) => v.name));
          break;
        default:
          break;
      }
    }
  }

  private block(block: Block): void {
    this.pushScope();
    this.expectAll(block.stmts);
    this.hoist(block.stmts);
    for (const stmt of block.stmts) this.stmt(stmt);
    this.popScope();
  }

  private stmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'LetDecl':
        this.expr(stmt.value);
        this.declare(stmt.name, stmt.nameSpan, stmt.mutable, stmt.mutable ? 'var' : 'let');
        return;

      case 'DestructureDecl':
        this.expr(stmt.value);
        this.pattern(stmt.pattern, stmt.mutable);
        return;

      case 'FnDecl':
        this.fnBody(stmt.params, stmt.body);
        return;

      case 'StructDecl':
        // The name itself is hoisted; the shape is checked here.
        this.noDuplicates(
          'struct `' + stmt.name + '`',
          'field',
          stmt.fields.map((f) => ({ name: f.name, span: f.span })),
        );
        return;

      case 'EnumDecl':
        this.noDuplicates(
          'enum `' + stmt.name + '`',
          'variant',
          stmt.variants.map((v) => ({ name: v.name, span: v.span })),
        );
        return;

      case 'ReturnStmt':
        if (stmt.value !== undefined) this.expr(stmt.value);
        return;

      case 'WhileStmt':
        this.expr(stmt.condition);
        this.loops += 1;
        this.block(stmt.body);
        this.loops -= 1;
        return;

      case 'ForStmt':
        this.expr(stmt.iterable);
        this.pushScope();
        this.pattern(stmt.binding);
        this.loops += 1;
        this.block(stmt.body);
        this.loops -= 1;
        this.popScope();
        return;

      case 'BreakStmt':
        this.checkJump('break', stmt.span);
        return;

      case 'ContinueStmt':
        this.checkJump('continue', stmt.span);
        return;

      case 'ExprStmt':
        this.expr(stmt.expr);
        return;

      case 'ImportDecl':
        this.checkImport(stmt.from, stmt.specifiers, stmt.span);
        for (const spec of stmt.specifiers) {
          this.declare(spec.alias ?? spec.name, spec.span, false, 'import');
        }
        return;

      case 'ExportDecl': {
        // What a module exports is never unused: its whole purpose is to be
        // read from a file this pass cannot see.
        const wasExporting = this.exporting;
        this.exporting = true;
        this.stmt(stmt.declaration);
        this.exporting = wasExporting;
        return;
      }
    }
  }

  private fnBody(params: readonly Param[], body: Block): void {
    this.pushScope();
    for (const param of params) {
      // A default value is evaluated at call time, like the body.
      if (param.defaultValue !== undefined) {
        this.deferred += 1;
        this.expr(param.defaultValue);
        this.deferred -= 1;
      }
      this.declare(param.name, param.nameSpan, false, 'parameter');
    }
    // The body gets its own scope so a local may shadow a parameter, and runs
    // when called rather than where it is written.
    this.deferred += 1;
    const enclosingLoops = this.loops;
    this.loops = 0;
    this.block(body);
    this.loops = enclosingLoops;
    this.deferred -= 1;
    this.popScope();
  }

  /**
   * A struct field or an enum variant written twice.
   *
   * Neither is a scope binding, so `RS004` does not see them, and both were
   * accepted in silence — the later one simply won. Declaring the same field
   * twice is never intentional, and the second one silently deciding the
   * type is the worst of the available outcomes.
   */
  private noDuplicates(
    owner: string,
    what: 'field' | 'variant',
    entries: readonly { name: string; span: Span }[],
  ): void {
    const seen = new Map<string, Span>();
    for (const entry of entries) {
      const earlier = seen.get(entry.name);
      if (earlier !== undefined) {
        this.report(
          'RS007',
          owner + ' declares ' + what + ' `' + entry.name + '` twice',
          entry.span,
          'declared twice',
          ['the earlier one is on line ' + String(earlier.start.line)],
        );
        continue;
      }
      seen.set(entry.name, entry.span);
    }
  }

  /** `break` and `continue` only mean something inside a loop. */
  private checkJump(word: 'break' | 'continue', span: Span): void {
    if (this.loops > 0) return;
    this.report(
      'RS006',
      '`' + word + '` is not inside a loop',
      span,
      'nothing to ' + (word === 'break' ? 'break out of' : 'continue'),
      ['`' + word + '` only works inside a `while` or `for`; to leave a function, use `return`'],
    );
  }

  // -------------------------------------------------------------- expressions

  private expr(expr: Expr): void {
    switch (expr.kind) {
      case 'NumberLit':
      case 'StringLit':
      case 'BoolLit':
      case 'NilLit':
        return;

      case 'TemplateLit':
        for (const part of expr.parts) if (part.kind === 'expr') this.expr(part.expr);
        return;

      case 'Ident':
        this.use(expr.name, expr.span);
        return;

      case 'Unary':
        this.expr(expr.operand);
        return;

      case 'Binary':
      case 'Logical':
        this.expr(expr.left);
        this.expr(expr.right);
        return;

      case 'PipelineExpr':
        this.expr(expr.left);
        this.expr(expr.right);
        return;

      case 'RangeExpr':
        this.expr(expr.start);
        this.expr(expr.end);
        return;

      case 'ListLit':
        for (const item of expr.items) this.expr(item);
        return;

      case 'MapLit':
        for (const entry of expr.entries) {
          // A bare-name key is a string, not a variable reference.
          if (entry.key.kind !== 'StringLit') this.expr(entry.key);
          this.expr(entry.value);
        }
        return;

      case 'StructLit':
        // The name, not the whole literal: underlining `Point { x: 1, y: 2 }`
        // for an undefined `Point` points at everything except the part that is
        // wrong, and the fields are usually the longer half.
        this.use(expr.name, expr.nameSpan);
        for (const field of expr.fields) this.expr(field.value);
        return;

      case 'CallExpr':
        this.expr(expr.callee);
        for (const arg of expr.args) this.expr(arg.value);
        return;

      case 'IndexExpr':
        this.expr(expr.target);
        this.expr(expr.index);
        return;

      case 'MemberExpr':
        // Only the target is a name; `.field` is not resolved here.
        this.expr(expr.target);
        return;

      case 'AssignExpr':
        this.assign(expr.op, expr.target, expr.value);
        return;

      case 'LambdaExpr':
        this.fnBody(expr.params, expr.body);
        return;

      case 'BlockExpr':
        this.block(expr.block);
        return;

      case 'IfExpr':
        this.expr(expr.condition);
        this.block(expr.then);
        if (expr.otherwise !== undefined) {
          if (expr.otherwise.kind === 'Block') this.block(expr.otherwise);
          else this.expr(expr.otherwise);
        }
        return;

      case 'MatchExpr':
        this.match(expr.subject, expr.arms, expr.span);
        return;

      case 'TryExpr':
      case 'AwaitExpr':
        this.expr(expr.operand);
        return;

      case 'JumpExpr':
        if (expr.jump !== 'return') this.checkJump(expr.jump, expr.span);
        if (expr.value !== undefined) this.expr(expr.value);
        return;
    }
  }

  private assign(op: string, target: Expr, value: Expr): void {
    this.expr(value);
    // `t += i` is `t = t + i`: it reads the target as well as writing it, so a
    // binding only ever touched that way is not unused. A plain `=` does not
    // read, which is what makes `var x = 0` followed only by `x = 1` a value
    // nobody looks at — and worth saying so.
    if (op !== '=' && target.kind === 'Ident') this.scope.markUsed(target.name);
    this.assignTo(target);
  }

  /** Check one place being written to; a list of places is checked one by one. */
  private assignTo(target: Expr): void {
    // `[a, b] = [b, a]`. Each element is a place in its own right, so the same
    // rules apply to it — including that a `let` binding may not be one.
    if (target.kind === 'ListLit') {
      for (const item of target.items) this.assignTo(item);
      return;
    }
    if (target.kind === 'Ident') {
      const binding =
        this.deferred > 0 ? this.scope.lookupDeferred(target.name) : this.scope.lookup(target.name);
      if (binding === undefined) {
        this.use(target.name, target.span);
        return;
      }
      if (!binding.mutable && binding.kind !== 'unresolved' && binding.kind !== 'built-in') {
        this.report(
          'RS005',
          'cannot assign to `' + target.name + '`',
          target.span,
          // Read it as a sentence: "declared with `let`", "bound by a pattern",
          // "a parameter". A kind spliced in raw reads as `pattern binding`
          // inside backticks, which looks like syntax nobody wrote.
          describeBinding(binding.kind),
          [adviceFor(binding.kind)],
        );
      }
      return;
    }
    this.expr(target);
  }

  // ------------------------------------------------------------------- match

  private match(subject: Expr, arms: readonly MatchArm[], span: Span): void {
    this.expr(subject);

    let catchAllAt: number | undefined;
    arms.forEach((arm, index) => {
      this.pushScope();
      this.pattern(arm.pattern);
      if (arm.guard !== undefined) this.expr(arm.guard);
      this.expr(arm.body);
      this.popScope();

      // An unguarded wildcard or plain binding matches everything after it.
      const isCatchAll =
        arm.guard === undefined &&
        (arm.pattern.kind === 'PWildcard' || arm.pattern.kind === 'PBinding');
      if (isCatchAll && catchAllAt === undefined && index < arms.length - 1) {
        catchAllAt = index;
      }
    });

    if (catchAllAt !== undefined) {
      const dead = arms[catchAllAt + 1];
      if (dead !== undefined) {
        this.report(
          'RS003',
          'this match arm can never be reached',
          dead.span,
          'unreachable',
          ['an earlier arm on line ' + (arms[catchAllAt]?.span.start.line ?? 0) + ' matches everything'],
        );
      }
      return; // A catch-all makes the match exhaustive by construction.
    }

    this.checkExhaustive(arms, span);
  }

  /**
   * Report a match that misses an enum variant.
   *
   * Only fires when every arm names a variant of exactly one enum the resolver
   * can see. Anything less certain is left alone, because a false "not
   * exhaustive" on a valid program is worse than missing one.
   */
  private checkExhaustive(arms: readonly MatchArm[], span: Span): void {
    const named = new Set<string>();
    const covered = new Set<string>();

    for (const arm of arms) {
      if (arm.pattern.kind !== 'PEnum') return; // mixed patterns: cannot judge
      const { enumName, variant } = arm.pattern;
      if (enumName !== undefined) {
        named.add(enumName);
      } else {
        // A bare variant: find which visible enum owns it, if exactly one does.
        const owners = [...this.enums].filter(([, variants]) => variants.includes(variant));
        if (owners.length !== 1) return;
        const owner = owners[0];
        if (owner === undefined) return;
        named.add(owner[0]);
      }
      // A guarded arm may not fire, so it covers nothing.
      if (arm.guard === undefined) covered.add(variant);
    }

    if (named.size !== 1) return;
    const enumName = [...named][0];
    if (enumName === undefined) return;
    const variants = this.enums.get(enumName);
    if (variants === undefined) return;

    const missing = variants.filter((v) => !covered.has(v));
    if (missing.length === 0) return;

    this.report(
      'RS002',
      'this `match` does not cover ' +
        (missing.length === 1 ? 'the variant ' : 'the variants ') +
        missing.map((v) => '`' + enumName + '.' + v + '`').join(', '),
      span,
      'not exhaustive',
      [
        'add ' + (missing.length === 1 ? 'an arm' : 'arms') + ' for ' + missing.join(', ') +
          ', or a `_ => ...` catch-all',
        arms.some((a) => a.guard !== undefined)
          ? 'an arm with a guard does not count as covering a variant, because the guard may be false'
          : 'every variant of an enum must be handled',
      ],
    );
  }

  // ---------------------------------------------------------------- patterns

  /**
   * Declare everything a pattern binds.
   *
   * `mutable` is for `var [a, b] = pair`; match arms and loop bindings are
   * immutable, which is why it defaults that way.
   */
  private pattern(pattern: Pattern, mutable = false): void {
    const kind = mutable ? 'var' : 'pattern binding';
    switch (pattern.kind) {
      case 'PWildcard':
        return;
      case 'PBinding':
        this.declare(pattern.name, pattern.span, mutable, kind);
        return;
      case 'PLiteral':
        return; // always a literal; nothing to resolve
      case 'PEnum':
        for (const sub of pattern.args) this.pattern(sub, mutable);
        return;
      case 'PStruct':
        for (const field of pattern.fields) this.pattern(field.pattern, mutable);
        return;
      case 'PList':
        for (const item of pattern.items) this.pattern(item, mutable);
        if (pattern.rest !== undefined) {
          this.declare(pattern.rest, pattern.span, mutable, kind);
        }
        return;
    }
  }
}

/** What to suggest instead, which depends on where the binding came from. */
function adviceFor(kind: string): string {
  switch (kind) {
    case 'parameter':
    case 'pattern binding':
    case 'import':
      // `var` cannot be written at any of these, so the advice that works for
      // `let` would send the reader to a keyword they cannot use here.
      return 'copy it into a `var` of its own if it needs to change';
    default:
      return 'values bound with `let` never change; use `var` if it needs to';
  }
}

/** How to name a binding's origin in a diagnostic label. */
function describeBinding(kind: string): string {
  switch (kind) {
    case 'pattern binding':
      return 'bound by a pattern, so it never changes';
    case 'parameter':
      return 'a parameter, which the caller supplies';
    case 'import':
      return 'imported from another module';
    default:
      return 'declared with `' + kind + '`';
  }
}

const ZERO_SPAN: Span = {
  start: { offset: 0, line: 1, col: 1 },
  end: { offset: 0, line: 1, col: 1 },
};

/**
 * Check a module. Returns the diagnostics found; an empty array means the
 * module passed every static check.
 */
export function resolve(module: Module, options: ResolveOptions): readonly Diagnostic[] {
  return new Resolver(options).resolveModule(module);
}

/**
 * Every static check, in one call: names and scoping first, then types.
 *
 * Scope errors come first deliberately. A program with an undefined name will
 * also produce confusing type errors about it, and reporting the cause rather
 * than its consequences is the more useful half.
 *
 * Returns the **warnings**, and raises on errors. That asymmetry is what a
 * warning is: something worth saying that must not stop a program which works.
 */
export function checkModule(
  module: Module,
  source: string,
  options: ResolveOptions,
): readonly Diagnostic[] {
  const scopeProblems = resolve(module, options);
  const errors = scopeProblems.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    // Only the errors. A warning alongside them is noise: fix what stops the
    // program, then look at what merely bothers it.
    throw new LumenError(errors, module.file, source);
  }
  const typeProblems = checkTypes(module, options);
  if (typeProblems.length > 0) {
    throw new LumenError(typeProblems, module.file, source);
  }
  // Warnings are returned rather than raised, which is the whole difference
  // between the two: a warning must never stop a program that works. A caller
  // that ignores them behaves exactly as it did before they existed.
  return scopeProblems.filter((d) => d.severity !== 'error');
}
