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
  MatchArm,
  Module,
  Param,
  Pattern,
  Stmt,
} from './ast.js';
import { type Diagnostic, type Note, type Span, LumenError } from './diagnostics.js';
import { checkTypes } from './types.js';
import { suggest } from './values.js';

interface Binding {
  readonly mutable: boolean;
  readonly span: Span;
  /** What introduced it, for the "already declared" message. */
  readonly kind: string;
}

class Scope {
  private readonly names = new Map<string, Binding>();
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

export interface ResolveOptions {
  /** Names available with no declaration — the prelude. */
  readonly globals: readonly string[];
  /**
   * Names a module is known to export, keyed by module path. Imports of a
   * module not listed here are trusted rather than guessed at.
   */
  readonly moduleExports?: ReadonlyMap<string, readonly string[]>;
}

class Resolver {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly enums = new Map<string, readonly string[]>();
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
  ): void {
    this.diagnostics.push({
      severity: 'error',
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
    this.scope = this.scope.parent ?? this.scope;
  }

  private declare(name: string, span: Span, mutable: boolean, kind: string): void {
    // `_` is the conventional throwaway and may be repeated freely.
    if (name !== '_') {
      const existing = this.scope.own(name);
      if (existing !== undefined && existing.kind !== 'built-in') {
        this.report(
          'RS004',
          '`' + name + '` is already declared in this scope',
          span,
          'declared twice',
          ['the earlier one is on line ' + existing.span.start.line],
        );
      }
    }
    this.scope.declare(name, { mutable, span, kind });
  }

  private use(name: string, span: Span): void {
    const found =
      this.deferred > 0 ? this.scope.lookupDeferred(name) : this.scope.lookup(name);
    if (found !== undefined) return;
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
    return this.diagnostics;
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
          this.declare(decl.name, decl.span, false, 'function');
          break;
        case 'StructDecl':
          this.declare(decl.name, decl.span, false, 'struct');
          break;
        case 'EnumDecl':
          this.declare(decl.name, decl.span, false, 'enum');
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
        this.declare(stmt.name, stmt.span, stmt.mutable, stmt.mutable ? 'var' : 'let');
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
        for (const spec of stmt.specifiers) {
          this.declare(spec.alias ?? spec.name, spec.span, false, 'import');
        }
        return;

      case 'ExportDecl':
        this.stmt(stmt.declaration);
        return;
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
      this.declare(param.name, param.span, false, 'parameter');
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
        this.use(expr.name, expr.span);
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
        this.assign(expr.target, expr.value);
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

  private assign(target: Expr, value: Expr): void {
    this.expr(value);
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
 */
export function checkModule(module: Module, source: string, options: ResolveOptions): void {
  const scopeProblems = resolve(module, options);
  if (scopeProblems.length > 0) {
    throw new LumenError(scopeProblems, module.file, source);
  }
  const typeProblems = checkTypes(module);
  if (typeProblems.length > 0) {
    throw new LumenError(typeProblems, module.file, source);
  }
}
