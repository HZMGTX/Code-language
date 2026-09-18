/**
 * Gradual type checking.
 *
 * Type annotations have been parsed and retained since v0.1 but never enforced,
 * so `fn add(a: Num, b: Num)` documented an intention rather than guaranteeing
 * one. This makes the annotations that are written mean something, without
 * requiring anyone to write them.
 *
 * The whole design rests on one type: `Any`. Anything the checker cannot
 * determine is `Any`, and `Any` is compatible with everything in both
 * directions. So an unannotated program has every expression typed `Any` and
 * cannot produce a single diagnostic — the checker is invisible until you opt
 * in by writing an annotation, and then it only speaks where both sides are
 * genuinely known.
 *
 * That is also why this is not inference. Inferring `let n = 1` as `Num` would
 * start rejecting `n = "text"` in code that never asked to be checked, which is
 * a different language than the one people have been writing. Inference is a
 * v0.2 decision to take deliberately, not a side effect of this pass.
 *
 *   TY001  argument does not match the parameter's declared type
 *   TY002  returned value does not match the declared return type
 *   TY003  initialiser does not match the declared type of a binding
 *   TY004  struct literal field does not match the field's declared type
 *   TY005  an operator's operands cannot be the types they are
 *   TY006  a value assigned to an annotated binding does not match it
 *   TY007  more arguments than the function takes
 *   TY008  a required argument the call does not supply
 *   TY009  a match arm the subject's type can never produce
 *   TY010  a statement whose only call answers with a value nothing takes
 *   TY011  an indexing that cannot work, when both sides are known
 *   TY012  a member the receiver's type does not have
 */

import type {
  Arg,
  BinaryOp,
  Block,
  Expr,
  Module,
  Param,
  Pattern,
  Stmt,
  TypeExpr,
} from './ast.js';
import { BUILT_IN_ENUMS } from './ast.js';
import { type Diagnostic, type Note, type Severity, type Span } from './diagnostics.js';
import { FOREIGN_METHODS, methodHintNote } from './hints.js';
import { parse } from './parser.js';
import { suggest } from './values.js';

// ------------------------------------------------------------------- types

export type Ty =
  | { readonly k: 'any' }
  | { readonly k: 'nil' }
  | { readonly k: 'bool' }
  | { readonly k: 'num' }
  | { readonly k: 'str' }
  | { readonly k: 'list'; readonly of: Ty }
  | { readonly k: 'map'; readonly of: Ty }
  | { readonly k: 'struct'; readonly name: string }
  | { readonly k: 'enum'; readonly name: string }
  | { readonly k: 'fn'; readonly params: readonly ParamTy[]; readonly ret: Ty };

export interface ParamTy {
  /**
   * Undefined when the parameter has no name to speak of.
   *
   * A `fn(Num) -> Num` annotation says nothing about what its parameter is
   * called, and inventing one — they used to be `p0`, `p1` — meant a call
   * writing `f(p0: 1)` matched it by accident, and a diagnostic about it named
   * a parameter nobody had written. Unnamed parameters pair positionally only.
   */
  readonly name: string | undefined;
  readonly ty: Ty;
  /** A parameter with a default may be omitted. */
  readonly optional: boolean;
  /**
   * `..parts` — collects every remaining positional argument.
   *
   * It keeps collecting, which is the point: `fn log(..parts: Str)` called as
   * `log(1, 2)` used to report only the `1`, because the walk moved past the
   * parameter after one argument and then paired `2` with nothing.
   */
  readonly rest: boolean;
}

const ANY: Ty = { k: 'any' };
const NIL: Ty = { k: 'nil' };
const BOOL: Ty = { k: 'bool' };
const NUM: Ty = { k: 'num' };
const STR: Ty = { k: 'str' };

/**
 * How an assignment target is named in a diagnostic.
 *
 * `v`, `p.x`, `xs[0]` — what the reader wrote, so the message points at
 * something they can find. Anything more elaborate is called "this", which is
 * still better than printing an approximation of their expression back at them.
 */
function describeTarget(expr: Expr): string {
  switch (expr.kind) {
    case 'Ident':
      return '`' + expr.name + '`';
    case 'MemberExpr':
      return expr.target.kind === 'Ident'
        ? '`' + expr.target.name + '.' + expr.name + '`'
        : '`' + expr.name + '`';
    case 'IndexExpr':
      return expr.target.kind === 'Ident' ? '`' + expr.target.name + '[…]`' : 'this element';
    default:
      return 'this target';
  }
}

/** `a Num`, `an Option` — a type named in prose rather than in a signature. */
export function aTy(ty: Ty): string {
  const shown = showTy(ty);
  return (/^[AEIOU]/u.test(shown) ? 'an ' : 'a ') + shown;
}

/** How a type is written in a diagnostic. */
export function showTy(ty: Ty): string {
  switch (ty.k) {
    case 'any':
      return 'Any';
    case 'nil':
      return 'Nil';
    case 'bool':
      return 'Bool';
    case 'num':
      return 'Num';
    case 'str':
      return 'Str';
    case 'list':
      return ty.of.k === 'any' ? 'List' : 'List<' + showTy(ty.of) + '>';
    case 'map':
      return ty.of.k === 'any' ? 'Map' : 'Map<' + showTy(ty.of) + '>';
    case 'struct':
    case 'enum':
      return ty.name;
    case 'fn':
      return 'fn(' + ty.params.map((p) => showTy(p.ty)).join(', ') + ') -> ' + showTy(ty.ret);
  }
}

/**
 * Whether a value of type `from` may be used where `to` is expected.
 *
 * `Any` is compatible with everything in both directions — that is what makes
 * the checking gradual rather than all-or-nothing.
 */
export function accepts(to: Ty, from: Ty): boolean {
  if (to.k === 'any' || from.k === 'any') return true;
  if (to.k !== from.k) return false;
  switch (to.k) {
    case 'list':
      return accepts(to.of, (from as { of: Ty }).of);
    case 'map':
      return accepts(to.of, (from as { of: Ty }).of);
    case 'struct':
    case 'enum':
      return to.name === (from as { name: string }).name;
    case 'fn': {
      const f = from as { params: readonly ParamTy[]; ret: Ty };
      // Covariant in the result: a function returning Num may be used where one
      // returning Num is wanted, and `Any` either way keeps quiet.
      if (!accepts(to.ret, f.ret)) return false;
      // Contravariant in the parameters, and only where both sides have one.
      // Arity is deliberately not compared: a call with the wrong number of
      // arguments is reported where the call is, with a span pointing at it,
      // and guessing here would reject `fn(a, b = 1)` passed as `fn(Num)`.
      for (const [i, want] of to.params.entries()) {
        const got = f.params[i];
        if (got === undefined) break;
        if (!accepts(got.ty, want.ty)) return false;
      }
      return true;
    }
    default:
      return true;
  }
}

/**
 * What the interpreter calls a value of this type, or undefined when unknown.
 *
 * The same strings `typeName` produces at run time, because they are the keys
 * method tables are registered under: the two passes must agree about what a
 * method is called or they check different programs.
 */
export function typeNameOf(ty: Ty): string | undefined {
  switch (ty.k) {
    case 'any':
      return undefined;
    case 'nil':
      return 'Nil';
    case 'bool':
      return 'Bool';
    case 'num':
      return 'Num';
    case 'str':
      return 'Str';
    case 'list':
      return 'List';
    case 'map':
      return 'Map';
    case 'fn':
      return 'Fn';
    case 'struct':
    case 'enum':
      return ty.name;
  }
}

// --------------------------------------------------------------- the checker

interface StructInfo {
  readonly fields: ReadonlyMap<string, Ty>;
}

class Scope {
  private readonly names = new Map<string, Ty>();
  constructor(readonly parent: Scope | undefined) {}
  declare(name: string, ty: Ty): void {
    this.names.set(name, ty);
  }
  lookup(name: string): Ty | undefined {
    let scope: Scope | undefined = this;
    while (scope !== undefined) {
      const found = scope.names.get(name);
      if (found !== undefined) return found;
      scope = scope.parent;
    }
    return undefined;
  }
}

class Checker {
  private readonly diagnostics: Diagnostic[] = [];
  /** Keys of diagnostics already recorded, so one problem is reported once. */
  private readonly reported = new Set<string>();
  private readonly structs = new Map<string, StructInfo>();
  /** Each enum's variants, so a bare `Ok(v)` can be traced back to `Result`. */
  private readonly enums = new Map<string, readonly string[]>();
  /** `"Str.upper"` to the type of `x.upper`, with the receiver already removed. */
  private readonly methods: ReadonlyMap<string, Ty>;
  private readonly methodNames: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  private readonly neverReturning: ReadonlySet<Ty>;
  /** What each described module exports, so an imported name has a type. */
  private readonly moduleExports: ReadonlyMap<string, ReadonlyMap<string, Ty>>;
  /** Where to send every type derived, when anybody wants them. */
  private readonly record: CheckOptions['record'];
  /** Library functions called for an effect rather than for a value. */
  private readonly effectful: ReadonlySet<Ty | string>;
  /**
   * Every type the library described, by identity.
   *
   * The test for "is this callee the library's?" — a name resolving to some
   * *other* `Ty` is a binding the program declared, and what a program's own
   * function does is not something this pass can know. Identity rather than
   * name, because a program may perfectly well declare its own `sort`.
   */
  private readonly libraryTypes = new Set<Ty>();
  private scope: Scope;
  /** The declared return type of the function being checked, if any. */
  private returnTy: Ty = ANY;

  constructor(options: CheckOptions = {}) {
    this.methods = options.methods ?? new Map();
    // Usable only when it says what every value has; see `CheckOptions`.
    this.methodNames = options.methodNames?.has(UNIVERSAL) ? options.methodNames : undefined;
    this.neverReturning = options.neverReturns ?? new Set();
    this.moduleExports = options.moduleExports ?? new Map();
    this.record = options.record;
    this.effectful = options.effectful ?? new Set();
    for (const ty of (options.signatures ?? new Map()).values()) this.libraryTypes.add(ty);
    for (const ty of this.methods.values()) this.libraryTypes.add(ty);
    for (const exports of this.moduleExports.values()) {
      for (const ty of exports.values()) this.libraryTypes.add(ty);
    }
    // The prelude, seeded into the scope everything else nests inside. Without
    // this every standard-library call was `Any` in and `Any` out, so
    // `upper(1)` passed every static check and failed when it ran.
    const root = new Scope(undefined);
    for (const [name, ty] of options.signatures ?? []) root.declare(name, ty);
    this.scope = new Scope(root);
    // `Result` and `Option` are always matchable and always annotatable,
    // whatever the module declares — the same table the resolver seeds from.
    for (const [name, variants] of BUILT_IN_ENUMS) this.enums.set(name, variants);
  }

  /**
   * What a target ends up holding after an assignment.
   *
   * For `=` that is the value. For a compound assignment it is the result of the
   * operator, which for two Nums is a Num however the value is written — so
   * `total += 1` on a `Num` is fine and does not want reporting as "Num given
   * Num".
   */
  private assignedTy(op: string, target: Ty, value: Ty): Ty {
    if (op === '=') return value;
    if (target.k === 'num' && value.k === 'num') return NUM;
    if (op === '+=' && target.k === 'str' && value.k === 'str') return STR;
    if (op === '+=' && target.k === 'list' && value.k === 'list') return target;
    // Anything else is either already reported by `checkOperands` or unknowable.
    return ANY;
  }

  /**
   * An operator whose operands cannot be what they are.
   *
   * Only when **both** types are known: if either is `Any` this says nothing, so
   * an unannotated program still produces no diagnostics. That restraint is what
   * makes the check sound rather than merely useful — `Num - Str` has no reading
   * under which it works, so reporting it can never be a false positive, while
   * guessing about an `Any` could be.
   *
   * The same three rules the interpreter enforces, moved earlier: `+` joins two
   * Nums, two Strs or two Lists; the other arithmetic wants two Nums; ordering
   * wants two Nums or two Strs. `==` and `!=` accept anything, deliberately —
   * comparing values of different types is false, not an error.
   */
  private checkOperands(op: BinaryOp, left: Ty, right: Ty, span: Span): void {
    if (left.k === 'any' || right.k === 'any') return;
    if (op === '==' || op === '!=') return;

    const shown = showTy(left) + ' and ' + showTy(right);

    if (op === '+') {
      const joinable =
        (left.k === 'num' && right.k === 'num') ||
        (left.k === 'str' && right.k === 'str') ||
        (left.k === 'list' && right.k === 'list');
      if (joinable) return;
      this.report(
        'TY005',
        'cannot add ' + shown,
        span,
        'mismatched operands',
        left.k === 'str' || right.k === 'str'
          ? [
              '`+` joins two Nums, two Strs or two Lists',
              'to build a string from mixed values use interpolation: "${a}${b}"',
              'or turn the other value into text first: `str(n)`',
            ]
          : ['`+` joins two Nums, two Strs or two Lists'],
      );
      return;
    }

    if (op === '-' || op === '*' || op === '/' || op === '%' || op === '**') {
      if (left.k === 'num' && right.k === 'num') return;
      const repeats = op === '*' && ((left.k === 'str' && right.k === 'num') || (left.k === 'num' && right.k === 'str'));
      this.report(
        'TY005',
        'cannot apply `' + op + '` to ' + shown,
        span,
        'mismatched operands',
        repeats ? ['`' + op + '` wants two Nums', '`"ab".repeat(3)` repeats a string'] : ['`' + op + '` wants two Nums'],
      );
      return;
    }

    // `<`, `<=`, `>`, `>=`.
    if ((left.k === 'num' && right.k === 'num') || (left.k === 'str' && right.k === 'str')) return;
    this.report(
      'TY005',
      'cannot compare ' + shown,
      span,
      'not comparable',
      ['`<`, `<=`, `>` and `>=` work on two Nums or two Strs'],
    );
  }

  /**
   * Record a diagnostic, unless the very same one is already there.
   *
   * Some expressions are legitimately visited twice: a function's last
   * statement is checked once as a statement and once as the function's value,
   * because the implicit-return check needs its type. Without this, a body of
   * `{ a + "x" }` reported the mismatched operands twice — the same message at
   * the same place, which reads as two problems and is one.
   *
   * Deduping here rather than restructuring the walk, because the walk is right:
   * any later pass that revisits an expression gets the same protection without
   * having to know about this one.
   */
  private report(
    code: string,
    message: string,
    span: Span,
    label: string,
    notes?: readonly string[],
    severity: Severity = 'error',
  ): void {
    const key = code + '@' + String(span.start.offset) + ':' + String(span.end.offset) + ' ' + message;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diagnostics.push({
      severity,
      code,
      message,
      span,
      label,
      ...(notes === undefined ? {} : { notes: notes.map((m): Note => ({ message: m })) }),
    });
  }

  /** Convert a written annotation into a type. Unknown names become Any. */
  private toTy(annotation: TypeExpr | undefined): Ty {
    return tyOf(annotation, (name) =>
      this.structs.has(name) ? 'struct' : this.enums.has(name) ? 'enum' : undefined,
    );
  }

  private fnTy(params: readonly Param[], ret: TypeExpr | undefined): Ty {
    return {
      k: 'fn',
      params: params.map((p) => ({
        name: p.name,
        ty: this.toTy(p.type),
        // A rest parameter can always be left out entirely: `log()` is a legal
        // call of `fn log(..parts)`.
        optional: p.defaultValue !== undefined || p.rest,
        rest: p.rest,
      })),
      ret: this.toTy(ret),
    };
  }

  // -------------------------------------------------------------- traversal

  check(module: Module): readonly Diagnostic[] {
    this.collectTypes(module.stmts);
    this.hoist(module.stmts);
    for (const [i, stmt] of module.stmts.entries()) {
      this.stmt(stmt);
      // A module has no value, but its last statement is what the REPL echoes,
      // so it is left alone for the same reason a block's is.
      if (i < module.stmts.length - 1) this.checkDiscarded(stmt);
    }
    return this.diagnostics;
  }

  /**
   * Structs and enums first, so annotations naming them resolve.
   *
   * In three passes rather than two, because a field's type may name a struct
   * declared further down the file. `toTy` asks `this.structs.has(name)` to
   * decide whether an annotation names a struct, so filling the fields in the
   * same pass that registers the names made the answer depend on the order the
   * two structs were written in:
   *
   *     struct Wrapper { inner: Payload }      `w.inner` was Any, and every
   *     struct Payload  { value: Str }         check on it silently stopped
   *
   * Swapping those two lines changed what the checker could see about a program
   * that means the same thing either way. So every name is registered first,
   * with the field map it will be given, and the types go into that same map
   * afterwards — by which point every struct in the file is known.
   */
  private collectTypes(stmts: readonly Stmt[]): void {
    for (const stmt of stmts) {
      const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
      if (decl.kind === 'EnumDecl') this.enums.set(decl.name, decl.variants.map((v) => v.name));
    }
    const pending: { decl: Extract<Stmt, { kind: 'StructDecl' }>; fields: Map<string, Ty> }[] = [];
    for (const stmt of stmts) {
      const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
      if (decl.kind !== 'StructDecl') continue;
      const fields = new Map<string, Ty>();
      this.structs.set(decl.name, { fields });
      pending.push({ decl, fields });
    }
    for (const { decl, fields } of pending) {
      for (const field of decl.fields) fields.set(field.name, this.toTy(field.type));
    }
  }

  /**
   * The struct and enum declarations a block introduces, in force for that
   * block only.
   *
   * A declaration inside a function is scoped like any other name — §7.2 — and
   * this pass used to collect only the module's top level, so an inner `struct
   * Point` was invisible and a `Point { … }` beside it was checked against the
   * *outer* one. That is the worst kind of wrong answer this pass can give: a
   * valid program rejected, and rejected with a message listing fields from a
   * declaration somewhere else in the file.
   *
   * Returns what to put back, because a shadowed outer declaration has to
   * survive the block that shadowed it.
   */
  private scopedTypes(stmts: readonly Stmt[]): () => void {
    const undo: (() => void)[] = [];
    for (const stmt of stmts) {
      const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
      if (decl.kind === 'StructDecl') {
        const had = this.structs.get(decl.name);
        const fields = new Map<string, Ty>();
        for (const field of decl.fields) fields.set(field.name, this.toTy(field.type));
        this.structs.set(decl.name, { fields });
        undo.push(() => {
          if (had === undefined) this.structs.delete(decl.name);
          else this.structs.set(decl.name, had);
        });
      } else if (decl.kind === 'EnumDecl') {
        const had = this.enums.get(decl.name);
        this.enums.set(decl.name, decl.variants.map((v) => v.name));
        undo.push(() => {
          if (had === undefined) this.enums.delete(decl.name);
          else this.enums.set(decl.name, had);
        });
      }
    }
    return () => {
      for (const put of undo) put();
    };
  }

  private hoist(stmts: readonly Stmt[]): void {
    for (const stmt of stmts) {
      const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
      if (decl.kind === 'FnDecl') {
        this.scope.declare(decl.name, this.fnTy(decl.params, decl.ret));
      }
    }
  }

  /**
   * A block, and optionally something that has to see the block's own bindings.
   *
   * `inside` runs before the scope is thrown away, and exists because
   * `checkImplicitReturn` did not. It re-types the last statement, and ran
   * *after* this method had restored the enclosing scope — so every name in
   * that statement resolved outside the function body. An ordinary program:
   *
   *     fn total(xs: List) -> Num {
   *       var sum = 0
   *       for x in xs { sum += x }
   *       sum
   *     }
   *
   * was rejected with "this function returns Num but is giving back
   * fn(List) -> Num", because the `sum` on the last line found the prelude's
   * `sum` instead of the local. Any function whose last statement names a local
   * that shadows a prelude name was rejected the same way, and `sum`, `len`,
   * `count`, `first`, `last`, `keys`, `min` and `max` are all ordinary names
   * for a local.
   */
  private block(block: Block, inside?: () => void): void {
    const saved = this.scope;
    this.scope = new Scope(saved);
    const restoreTypes = this.scopedTypes(block.stmts);
    this.hoist(block.stmts);
    for (const [i, stmt] of block.stmts.entries()) {
      this.stmt(stmt);
      // The last statement is the block's own value, so nothing about it is
      // discarded — `fn f() { xs.sort() }` answers with the sorted list.
      if (i < block.stmts.length - 1) this.checkDiscarded(stmt);
    }
    inside?.();
    restoreTypes();
    this.scope = saved;
  }

  private stmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'DestructureDecl':
        // Checking the value is worth doing for its own sake. What the pattern
        // pulls out of it is `Any`, as everything a pattern binds is — the
        // same treatment loop bindings get.
        this.typeOf(stmt.value);
        return;

      case 'LetDecl': {
        const declared = this.toTy(stmt.type);
        const actual = this.typeOf(stmt.value);
        if (!accepts(declared, actual)) {
          this.report(
            'TY003',
            '`' + stmt.name + '` is declared as ' + showTy(declared) + ' but is given ' + showTy(actual),
            stmt.value.span,
            'expected ' + showTy(declared),
          );
        }
        // An annotated binding takes its annotation. An unannotated `let` takes
        // the type of its value — which is sound precisely because `let` is
        // immutable: the binding can never later hold something else, so the
        // inferred type cannot become wrong. A `var` stays Any, because
        // inferring there would start rejecting reassignments in code that
        // never asked to be checked.
        if (stmt.type !== undefined) this.scope.declare(stmt.name, declared);
        else this.scope.declare(stmt.name, stmt.mutable ? ANY : actual);
        return;
      }

      case 'FnDecl': {
        this.fnBody(stmt.params, stmt.ret, stmt.body);
        return;
      }

      case 'StructDecl':
      case 'EnumDecl':
      case 'BreakStmt':
      case 'ContinueStmt':
        return;

      case 'ReturnStmt': {
        if (stmt.value === undefined) return;
        const actual = this.typeOf(stmt.value);
        if (!accepts(this.returnTy, actual)) {
          this.report(
            'TY002',
            'this function returns ' + showTy(this.returnTy) + ' but is giving back ' + showTy(actual),
            stmt.value.span,
            'expected ' + showTy(this.returnTy),
          );
        }
        return;
      }

      case 'WhileStmt':
        this.typeOf(stmt.condition);
        this.block(stmt.body);
        return;

      case 'ForStmt': {
        const over = this.typeOf(stmt.iterable);
        const saved = this.scope;
        this.scope = new Scope(saved);
        // The loop binding has to be declared, not merely scoped. Without it, a
        // loop variable that shadows an outer name kept the outer name's type:
        // `let x = "outer"` followed by `for x in [1, 2] { x * 2 }` looked like
        // multiplying a Str.
        this.declarePattern(stmt.binding, over.k === 'list' ? over.of : ANY);
        this.block(stmt.body);
        this.scope = saved;
        return;
      }

      case 'ExprStmt':
        this.typeOf(stmt.expr);
        return;

      case 'ImportDecl': {
        // An imported name is typed when the caller has described the module,
        // and `Any` otherwise — a local `./helper.lm` is a file this pass has
        // never read, and guessing about it is the one thing it must not do.
        const exports = this.moduleExports.get(stmt.from);
        for (const spec of stmt.specifiers) {
          this.scope.declare(spec.alias ?? spec.name, exports?.get(spec.name) ?? ANY);
        }
        return;
      }

      case 'ExportDecl':
        this.stmt(stmt.declaration);
        return;
    }
  }

  /**
   * `TY010`: a statement that is a call whose value nobody takes, to a function
   * that has no other effect. The line does nothing.
   *
   *     var xs = [3, 1, 2]
   *     xs.sort()            ← sorts nothing; `sort` answers with a new list
   *     print(xs)            → [3, 1, 2]
   *
   * `xs.sort()` is the first thing anyone arriving from Python or JavaScript
   * writes, and eleven statements like it ran silently: `sort`, `reverse`,
   * `unique`, `take`, `insert`, `upper`, `trim`, `set`… every one of them
   * answers with a new value and leaves its subject alone.
   *
   * `docs/stdlib.md` has always stated the rule — *"nothing mutates unless its
   * name says so"* — and this is where it stops being something to remember.
   * The two functions it names, `push` and `pop`, really do mutate, so they are
   * listed as effectful and say nothing here; their twenty neighbours do not,
   * and now say so. The rule and the diagnostic cannot drift apart, because the
   * library states the exception list in one place.
   *
   * Reported as a **warning**: the program runs, and a line that does nothing
   * is a mistake in what the author meant rather than in what the machine can
   * do. Same line `RS011` draws.
   *
   * Only a call whose callee is the library's own — by object identity against
   * the signature it was seeded with, so a user function shadowing `sort` is a
   * function this pass knows nothing about and stays silent.
   */
  private checkDiscarded(stmt: Stmt): void {
    if (stmt.kind !== 'ExprStmt') return;
    // §4.7: `f(x)`, `x.f()` and `x |> f()` are three spellings of one
    // expression, so all three have to answer alike here. Being silent about
    // one of them is the drift this project keeps finding.
    const call = stmt.expr.kind === 'PipelineExpr' ? stmt.expr.right : stmt.expr;
    if (call.kind !== 'CallExpr') return;

    const known = this.libraryCallee(call.callee);
    if (known === undefined) return;
    if (this.effectful.has(known.ty) || this.effectful.has(known.key)) return;
    // No value to discard means it was called for what it does.
    if (known.ty.k !== 'fn' || known.ty.ret.k === 'nil' || known.ty.ret.k === 'any') return;

    this.report(
      'TY010',
      '`' + known.name + '` answers with a ' + showTy(known.ty.ret) + ' that nothing takes',
      stmt.span,
      'this statement does nothing',
      [
        '`' + known.name + '` leaves its subject alone and answers with a new value',
        'take the answer or assign it back to the subject; on its own it is thrown away',
      ],
      'warning',
    );
  }

  /**
   * The library function a callee names, or undefined for anything else.
   *
   * Identity against the seeded signature is the whole guard: a name resolving
   * to some *other* `Ty` is a binding the program declared, and what a
   * program's own function does is not something this pass can know.
   */
  private libraryCallee(
    callee: Expr,
  ): { readonly key: string; readonly name: string; readonly ty: Ty } | undefined {
    if (callee.kind === 'Ident') {
      const ty = this.scope.lookup(callee.name);
      if (ty === undefined || !this.libraryTypes.has(ty)) return undefined;
      return { key: callee.name, name: callee.name, ty };
    }
    if (callee.kind !== 'MemberExpr') return undefined;
    // `x.f()` is `f(x)`, so a binding named `f` wins over the method table. If
    // that binding is the program's own, this pass knows nothing about it.
    const local = this.scope.lookup(callee.name);
    if (local !== undefined && !this.libraryTypes.has(local)) return undefined;
    const receiver = typeNameOf(this.typeOf(callee.target));
    if (receiver === undefined) return undefined;
    const ty =
      this.methods.get(receiver + '.' + callee.name) ?? this.methods.get('*.' + callee.name);
    if (ty === undefined) return undefined;
    return { key: callee.name, name: callee.name, ty };
  }

  /**
   * `TY011`: an indexing that cannot work, when both sides are known.
   *
   * `RT021` and `RT023` have always said this at run time, with both types in
   * hand — so the only thing missing was asking the same question a pass
   * earlier, where the answer is free and arrives before the program ships.
   *
   * It became worth having the moment `indexOf` started answering `Option`:
   * `xs[xs.indexOf(v)]` is the shape of every program written against the old
   * `-1`, and turning a silent wrong answer into a run-time one was only most
   * of the fix. Now it does not run.
   *
   * The restraint is `TY005`'s, and for the same reason: both sides must be
   * known. A `Map` indexed by something `Any` is a program that may well be
   * right, and saying otherwise is the one mistake this pass must not make.
   */
  private checkIndex(target: Ty, index: Ty, expr: Expr & { readonly index: Expr }): void {
    if (target.k === 'any' || index.k === 'any') return;

    if (target.k === 'list' || target.k === 'str') {
      if (index.k === 'num') return;
      this.report(
        'TY011',
        aTy(target) + ' is indexed by a Num, not ' + aTy(index),
        expr.index.span,
        'expected Num',
        index.k === 'enum' && index.name === 'Option'
          ? ['an Option holds the number rather than being one', 'take it out first: `match … { Some(i) => xs[i], None => … }`']
          : [],
      );
      return;
    }

    if (target.k === 'map') {
      if (index.k === 'str') return;
      this.report(
        'TY011',
        'a Map is indexed by a Str, not ' + aTy(index),
        expr.index.span,
        'expected Str',
        ['every Map key is a Str; `${' + '…}` turns a value into one'],
      );
      return;
    }

    // Nothing else can be indexed at all, which `RT023` says at run time — and
    // "nothing else" was three kinds short. A struct, an enum value and a
    // function are as certainly not indexable as a `Num` is, and each was
    // silent here and `RT023` at run time, which is the gap this check exists
    // to close. Listed positively, so a kind added to `Ty` has to be thought
    // about rather than silently falling through.
    this.report(
      'TY011',
      aTy(target) + ' cannot be indexed',
      expr.span,
      'not indexable',
      ['`[…]` reads from a List, a Str or a Map'],
    );
  }

  /**
   * `TY012`: a member the receiver's type does not have.
   *
   * `RT024` and `RT027` have always said this at run time, and `RS001` has
   * said the same of a bare name since the resolver existed — so a typo in
   * `xs.pussh(2)` was the one kind of typo a program had to run to find, and
   * the branch it sat on had to run. Now that the checker knows what `xs` is,
   * the question is asked a pass earlier, with the same answer.
   *
   * Existence is asked of `methodNames` and never of `methods`: a method with
   * no signature is absent from `methods` and works at run time. Without the
   * tables this says nothing.
   *
   * What is mirrored is `readMember`, branch for branch, so the two can never
   * disagree about what a value has. A struct's own field wins, then its
   * type's table, then the methods every value has; every other type has only
   * the tables. A `Map` is left alone, because a missing key reads as `nil` by
   * design, and so is `x?.name` on a `nil`, which reads nothing at all.
   */
  private checkMember(target: Ty, expr: Extract<Expr, { kind: 'MemberExpr' }>): void {
    const tables = this.methodNames;
    if (tables === undefined) return;
    if (target.k === 'any' || target.k === 'map') return;
    if (expr.optional && target.k === 'nil') return;
    const typeName = typeNameOf(target);
    if (typeName === undefined) return;

    const available = [...new Set([...(tables.get(typeName) ?? []), ...(tables.get(UNIVERSAL) ?? [])])];
    if (available.includes(expr.name)) return;

    if (target.k === 'struct') {
      const info = this.structs.get(target.name);
      // A struct this file did not declare has fields this pass cannot see.
      if (info === undefined) return;
      const fields = [...info.fields.keys()];
      const hint = suggest(expr.name, [...fields, ...available]);
      this.report(
        'TY012',
        '`' + target.name + '` has no field `' + expr.name + '`',
        expr.span,
        'unknown field',
        hint !== undefined
          ? ['did you mean `' + hint + '`?']
          : fields.length > 0
            ? ['its fields are: ' + fields.join(', ')]
            : ['it has no fields'],
      );
      return;
    }

    // The same three answers `RT027` gives, in the same order: what another
    // language calls it, the nearest name, or everything there is.
    const foreign = FOREIGN_METHODS.get(typeName + '.' + expr.name);
    const hint = suggest(expr.name, available);
    this.report(
      'TY012',
      typeName + ' has no method `' + expr.name + '`',
      expr.span,
      'not available here',
      foreign !== undefined
        ? [methodHintNote(expr.name, foreign)]
        : hint !== undefined
          ? ['did you mean `' + hint + '`?']
          : ['available on ' + typeName + ': ' + available.sort().join(', ')],
    );
  }

  private fnBody(params: readonly Param[], ret: TypeExpr | undefined, body: Block): void {
    const savedScope = this.scope;
    const savedReturn = this.returnTy;
    this.scope = new Scope(savedScope);
    this.returnTy = this.toTy(ret);
    // A rest parameter's annotation describes each argument it collects; the
    // binding itself is always the list of them. Declared as `Str`, `..parts`
    // was `Str` inside the body — so `parts.join(" ")` looked like a method
    // `Str` does not have, which `TY012` was the first check to say out loud.
    for (const param of params) {
      const each = this.toTy(param.type);
      this.scope.declare(param.name, param.rest ? { k: 'list', of: each } : each);
    }
    // Inside the body's scope, not after it: see `block`.
    this.block(body, () => this.checkImplicitReturn(body));
    this.scope = savedScope;
    this.returnTy = savedReturn;
  }

  /**
   * A function's value is the value of its last statement, and `return` is the
   * exception rather than the rule — so checking only `return` statements left
   * the declared return type unenforced on almost every function anyone
   * writes. `fn f() -> Num { "text" }` was accepted.
   *
   * Only a final `ExprStmt` is checked. A body ending in a loop or a
   * declaration yields nil, and complaining about that would be complaining
   * about a function whose value nobody uses, which is not a type error.
   */
  private checkImplicitReturn(body: Block): void {
    if (this.returnTy.k === 'any') return;
    const last = body.stmts[body.stmts.length - 1];
    if (last === undefined || last.kind !== 'ExprStmt') return;

    const actual = this.typeOf(last.expr);
    // A body that ends by stopping the program has no value to give back, so
    // there is nothing to compare against the annotation. Typed after the line
    // above so the expression is still checked for its own sake.
    if (this.neverReturns(last.expr)) return;
    if (!accepts(this.returnTy, actual)) {
      this.report(
        'TY002',
        'this function returns ' + showTy(this.returnTy) + ' but is giving back ' + showTy(actual),
        last.expr.span,
        'expected ' + showTy(this.returnTy),
        ["a function's value is the value of its last statement"],
      );
    }
  }

  /**
   * Whether an expression stops the program rather than producing a value.
   *
   * The same shapes `RS012` calls "certainly leaves", for the same reason and
   * with the same restraint: the call has to be to a *library* function that
   * never returns, recognised by the identity of its type rather than by its
   * name, so a program's own `panic` is its own business.
   */
  private neverReturns(expr: Expr): boolean {
    switch (expr.kind) {
      case 'CallExpr': {
        if (expr.callee.kind !== 'Ident') return false;
        const ty = this.scope.lookup(expr.callee.name);
        return ty !== undefined && this.neverReturning.has(ty);
      }
      case 'IfExpr':
        // Both ways out, or it is not certain — an `if` with no `else` falls
        // through by definition.
        if (expr.otherwise === undefined) return false;
        return (
          this.blockNeverReturns(expr.then) &&
          (expr.otherwise.kind === 'IfExpr'
            ? this.neverReturns(expr.otherwise)
            : this.blockNeverReturns(expr.otherwise))
        );
      case 'MatchExpr':
        return expr.arms.length > 0 && expr.arms.every((arm) => this.neverReturns(arm.body));
      case 'BlockExpr':
        return this.blockNeverReturns(expr.block);
      default:
        return false;
    }
  }

  private blockNeverReturns(block: Block): boolean {
    const last = block.stmts[block.stmts.length - 1];
    return last !== undefined && last.kind === 'ExprStmt' && this.neverReturns(last.expr);
  }

  /**
   * Declare every name a pattern binds, in the current scope.
   *
   * `ty` is what the whole pattern matches against. It is only passed through to
   * a plain binding — the pieces of a destructuring are `Any`, because working
   * out the type of the third element of a list or the payload of an enum
   * variant is inference, which this pass deliberately does not do. `Any` is
   * always safe: it is compatible in both directions, so it can produce no
   * diagnostic at all.
   */
  /**
   * `TY009`: an arm whose pattern the subject's type can never produce.
   *
   * The mistake this catches is one nobody makes twice and everybody makes
   * once: misremembering whether a function answers with a `Result`.
   *
   *     match stringify(v) { Ok(text) => ..., Err(why) => ... }
   *
   * `stringify` answers with a `Str`. Every arm is dead, so the match cannot
   * succeed — and it passed every static check, then failed at run time as
   * `RT020` with the caret on the *subject*, which is the one part that was
   * right. `RS003` has always reported an arm that can never be reached; this
   * is the same defect for the reason only this pass can see.
   *
   * Three restraints, all the no-false-positives rule:
   *
   * - An `Any` subject says nothing, and a pattern whose own type cannot be
   *   worked out says nothing.
   * - A variant this pass cannot trace to an enum says nothing, so an enum
   *   arriving through an unannotated import stays quiet.
   * - `nil` is never impossible. It is the one value that legitimately turns up
   *   where a type says otherwise, and a `match x { nil => ... }` guarding
   *   against exactly that is defensive, not wrong.
   */
  private checkArmFits(subject: Ty, pattern: Pattern): void {
    if (subject.k === 'any') return;
    const shown = showTy(subject);
    switch (pattern.kind) {
      case 'PWildcard':
      case 'PBinding':
        return;

      case 'PLiteral': {
        const literal = this.typeOf(pattern.value);
        if (literal.k === 'nil' || accepts(subject, literal)) return;
        this.report(
          'TY009',
          'a ' + showTy(literal) + ' can never equal a ' + shown,
          pattern.span,
          'this arm can never be taken',
          ['the subject of the match is a ' + shown],
        );
        return;
      }

      case 'PEnum': {
        const owner = pattern.enumName ?? this.enumOfVariant(pattern.variant);
        if (owner === undefined) return;
        if (subject.k === 'enum' && subject.name === owner) return;
        this.report(
          'TY009',
          '`' + pattern.variant + '` can never match a ' + shown,
          pattern.span,
          'this arm can never be taken',
          [
            '`' + pattern.variant + '` is a variant of ' + owner,
            'the subject of the match is a ' + shown,
          ],
        );
        return;
      }

      case 'PStruct': {
        if (subject.k === 'struct' && subject.name === pattern.name) return;
        if (!this.structs.has(pattern.name)) return;
        this.report(
          'TY009',
          '`' + pattern.name + '` can never match a ' + shown,
          pattern.span,
          'this arm can never be taken',
          ['the subject of the match is a ' + shown],
        );
        return;
      }

      case 'PList':
        if (subject.k === 'list') return;
        this.report(
          'TY009',
          'a list pattern can never match a ' + shown,
          pattern.span,
          'this arm can never be taken',
          subject.k === 'str'
            ? [
                'the subject of the match is a ' + shown,
                'a Str is not a list of its characters — `chars(s)` is',
              ]
            : ['the subject of the match is a ' + shown],
        );
        return;
    }
  }

  /** The enum a bare variant name belongs to, when exactly one claims it. */
  private enumOfVariant(variant: string): string | undefined {
    const owners = [...this.enums]
      .filter(([, variants]) => variants.includes(variant))
      .map(([name]) => name);
    // Two enums with a variant of the same name make a bare pattern ambiguous,
    // and guessing which was meant is how a check starts rejecting good code.
    return owners.length === 1 ? owners[0] : undefined;
  }

  private declarePattern(pattern: Pattern, ty: Ty): void {
    switch (pattern.kind) {
      case 'PBinding':
        this.scope.declare(pattern.name, ty);
        return;
      case 'PEnum':
        for (const arg of pattern.args) this.declarePattern(arg, ANY);
        return;
      case 'PStruct':
        for (const field of pattern.fields) this.declarePattern(field.pattern, ANY);
        return;
      case 'PList':
        for (const item of pattern.items) this.declarePattern(item, ANY);
        if (pattern.rest !== undefined) this.scope.declare(pattern.rest, { k: 'list', of: ANY });
        return;
      case 'PWildcard':
      case 'PLiteral':
        return;
    }
  }

  // ------------------------------------------------------------- expressions

  /**
   * The type of an expression, or Any when it cannot be determined.
   *
   * A thin wrapper so that every type this pass derives can be handed to
   * whoever asked for it. The checker used to throw all of them away the
   * moment it had finished with them, which meant an editor asking "what is
   * this" had to work it out again from scratch — and would then be a second
   * implementation of the same question, free to answer differently.
   *
   * Nothing is recorded unless a caller asked, so `lumen check` pays one
   * undefined comparison per expression and no allocation.
   */
  private typeOf(expr: Expr): Ty {
    const ty = this.typeOfExpr(expr);
    this.record?.(expr, ty);
    return ty;
  }

  private typeOfExpr(expr: Expr): Ty {
    switch (expr.kind) {
      case 'NumberLit':
        return NUM;
      case 'StringLit':
      case 'TemplateLit':
        if (expr.kind === 'TemplateLit') {
          for (const part of expr.parts) if (part.kind === 'expr') this.typeOf(part.expr);
        }
        return STR;
      case 'BoolLit':
        return BOOL;
      case 'NilLit':
        return NIL;

      case 'Ident':
        return this.scope.lookup(expr.name) ?? ANY;

      case 'Unary':
        this.typeOf(expr.operand);
        return expr.op === '-' ? NUM : BOOL;

      case 'Logical':
        this.typeOf(expr.left);
        this.typeOf(expr.right);
        return ANY;

      case 'Binary': {
        const left = this.typeOf(expr.left);
        const right = this.typeOf(expr.right);
        this.checkOperands(expr.op, left, right, expr.span);
        if (expr.op === '==' || expr.op === '!=') return BOOL;
        if (expr.op === '<' || expr.op === '<=' || expr.op === '>' || expr.op === '>=') return BOOL;
        // `+` is also string and list concatenation, so it only yields Num when
        // both sides are known to be numbers.
        if (left.k === 'num' && right.k === 'num') return NUM;
        if (expr.op === '+' && left.k === 'str' && right.k === 'str') return STR;
        if (expr.op === '+' && left.k === 'list' && right.k === 'list') {
          return accepts(left.of, right.of) ? left : { k: 'list', of: ANY };
        }
        return ANY;
      }

      case 'RangeExpr':
        this.typeOf(expr.start);
        this.typeOf(expr.end);
        return { k: 'list', of: NUM };

      case 'ListLit': {
        const items = expr.items.map((item) => this.typeOf(item));
        const first = items[0];
        if (first === undefined) return { k: 'list', of: ANY };
        const uniform = items.every((t) => accepts(first, t) && accepts(t, first));
        return { k: 'list', of: uniform ? first : ANY };
      }

      case 'MapLit': {
        for (const entry of expr.entries) this.typeOf(entry.value);
        return { k: 'map', of: ANY };
      }

      case 'StructLit':
        return this.structLit(expr);

      case 'CallExpr':
        return this.call(expr);

      case 'PipelineExpr':
        return this.pipeline(expr);

      case 'IndexExpr': {
        const target = this.typeOf(expr.target);
        const index = this.typeOf(expr.index);
        this.checkIndex(target, index, expr);
        if (target.k === 'list') return target.of;
        if (target.k === 'map') return target.of;
        if (target.k === 'str') return STR;
        return ANY;
      }

      case 'MemberExpr': {
        const target = this.typeOf(expr.target);
        // A struct's own field wins, exactly as it does at run time.
        if (target.k === 'struct') {
          const info = this.structs.get(target.name);
          const field = info?.fields.get(expr.name);
          if (field !== undefined) return field;
        }
        const method = this.methodTy(target, expr.name);
        if (method !== undefined) return method;
        this.checkMember(target, expr);
        return ANY;
      }

      case 'AssignExpr': {
        const target = this.typeOf(expr.target);
        const value = this.typeOf(expr.value);

        // `v += x` is `v = v + x`, so the operands have to agree as well as the
        // result. Checking the operator here rather than leaving it to `Binary`
        // is the only chance: the AST holds a compound assignment as one node,
        // not as an addition and an assignment.
        if (expr.op !== '=') {
          const op: BinaryOp = expr.op === '+=' ? '+' : expr.op === '-=' ? '-' : expr.op === '*=' ? '*' : '/';
          this.checkOperands(op, target, value, expr.span);
        }

        // An annotation is a promise about every value the binding will hold,
        // not only its first. `var v: Num = 1` followed by `v = "text"` used to
        // pass, which made the annotation decorative after line one — and a
        // `var` is exactly where a second value arrives.
        if (!accepts(target, this.assignedTy(expr.op, target, value))) {
          this.report(
            'TY006',
            describeTarget(expr.target) + ' is ' + showTy(target) + ' but is being given ' + showTy(value),
            expr.value.span,
            'expected ' + showTy(target),
            expr.op === '='
              ? undefined
              : ['`' + expr.op + '` means `' + describeTarget(expr.target) + ' = ' + describeTarget(expr.target) + ' ' + expr.op.slice(0, 1) + ' …`'],
          );
        }
        return value;
      }

      case 'LambdaExpr':
        this.fnBody(expr.params, expr.ret, expr.body);
        return this.fnTy(expr.params, expr.ret);

      case 'BlockExpr':
        this.block(expr.block);
        return ANY;

      case 'IfExpr':
        this.typeOf(expr.condition);
        this.block(expr.then);
        if (expr.otherwise !== undefined) {
          if (expr.otherwise.kind === 'Block') this.block(expr.otherwise);
          else this.typeOf(expr.otherwise);
        }
        return ANY;

      case 'MatchExpr': {
        const subject = this.typeOf(expr.subject);
        for (const arm of expr.arms) {
          this.checkArmFits(subject, arm.pattern);
          const saved = this.scope;
          this.scope = new Scope(saved);
          // Every name the pattern binds, as Any: what a pattern narrows a value
          // to is not something this pass works out. Declaring them is still
          // necessary, because a pattern name that shadows an outer one would
          // otherwise be checked as the outer one's type.
          this.declarePattern(arm.pattern, ANY);
          if (arm.guard !== undefined) this.typeOf(arm.guard);
          this.typeOf(arm.body);
          this.scope = saved;
        }
        return ANY;
      }

      case 'TryExpr':
      case 'AwaitExpr':
        this.typeOf(expr.operand);
        return ANY;

      case 'JumpExpr':
        // A jump never yields a value, so it is compatible with any type an
        // arm beside it produces. Checking the returned expression is still
        // worth doing for its own sake.
        if (expr.value !== undefined) this.typeOf(expr.value);
        return ANY;
    }
  }

  /**
   * The type of `x.name`, or undefined when there is nothing to say.
   *
   * `x.f(a)` is `CallExpr{callee: MemberExpr}`, so a method call needs no case
   * of its own: giving the member its real type is enough for `checkCall` to do
   * the rest, and the three spellings of a call stay one code path.
   *
   * A receiver whose type is unknown answers nothing, as always. So does a
   * method nobody supplied a signature for.
   */
  private methodTy(receiver: Ty, name: string): Ty | undefined {
    const typeName = typeNameOf(receiver);
    if (typeName === undefined) return undefined;
    // The type's own table first, then the handful that belong to every value
    // (`str`, `inspect`, `type`, `clone`, `isNil`) — the same order the
    // interpreter looks them up in, so a type-specific method still wins.
    return this.methods.get(typeName + '.' + name) ?? this.methods.get(UNIVERSAL + '.' + name);
  }

  private structLit(expr: Extract<Expr, { kind: 'StructLit' }>): Ty {
    const info = this.structs.get(expr.name);
    for (const field of expr.fields) {
      const actual = this.typeOf(field.value);
      const declared = info?.fields.get(field.name);
      if (declared === undefined) continue;
      if (!accepts(declared, actual)) {
        this.report(
          'TY004',
          '`' + expr.name + '.' + field.name + '` is ' + showTy(declared) + ' but is given ' + showTy(actual),
          field.value.span,
          'expected ' + showTy(declared),
        );
      }
    }
    return info === undefined ? ANY : { k: 'struct', name: expr.name };
  }

  private call(expr: Extract<Expr, { kind: 'CallExpr' }>): Ty {
    return this.checkCall(
      this.typeOf(expr.callee),
      calleeName(expr.callee),
      this.argTys(expr.args),
      expr.span,
    );
  }

  /**
   * `x |> f(a)`, which §4.7 says is the same expression as `f(x, a)`.
   *
   * It used to type both halves and answer `Any`, so the one spelling of a call
   * the language calls interchangeable with the other two was the one nothing
   * checked. Everything below is shared with `call`, which is the only way the
   * three spellings can be guaranteed to agree.
   */
  private pipeline(expr: Extract<Expr, { kind: 'PipelineExpr' }>): Ty {
    const piped: ArgTy = {
      name: undefined,
      ty: this.typeOf(expr.left),
      span: expr.left.span,
    };
    if (expr.right.kind === 'CallExpr') {
      const callee = this.typeOf(expr.right.callee);
      return this.checkCall(
        callee,
        calleeName(expr.right.callee),
        [piped, ...this.argTys(expr.right.args)],
        expr.span,
      );
    }
    return this.checkCall(this.typeOf(expr.right), calleeName(expr.right), [piped], expr.span);
  }

  /**
   * Too many arguments, or a required one missing.
   *
   * The interpreter already reports both (`RT040` and `RT036`) and reported
   * them alone until the standard library had types: nothing could know that
   * `"abc".upper(1)` was wrong without knowing that `upper` takes no argument
   * beyond its receiver. Now that it does, this is the cheapest thing a
   * signature buys, and the commonest mistake it catches.
   *
   * Two restraints, both about saying the useful thing rather than the first
   * thing:
   *
   * **Only for a function whose parameters have names**, which means one that
   * was actually declared — a `fn` written in Lumen, or a native that declared
   * its signature. A `fn(Num, Num) -> Num` *annotation* says nothing about
   * defaults, so a value of that type may well be `fn(a, b = 1)` and a call
   * with one argument is perfectly good. Reporting it would be exactly the
   * false positive this pass exists not to produce.
   *
   * **Only when every argument is positional.** The moment one is named there
   * is a family of shapes the interpreter already describes better than a count
   * can — `RT039` names a misspelt parameter, `RT037` a positional argument
   * after a named one, `RT044` one supplied twice — and `greet(nmae: "Ada")` is
   * a typo in `nmae`, not a missing `name`. Reporting the consequence instead
   * of the cause is the same mistake as reporting a type error for an undefined
   * variable, which is why scope errors come before type errors in the first
   * place.
   */
  private checkArity(
    callee: Extract<Ty, { k: 'fn' }>,
    fnName: string,
    args: readonly ArgTy[],
    span: Span,
  ): void {
    if (callee.params.some((p) => p.name === undefined)) return;
    if (args.some((a) => a.name !== undefined)) return;

    const positional = args;
    const takesAnyNumber = callee.params.some((p) => p.rest);

    if (!takesAnyNumber && positional.length > callee.params.length) {
      const extra = positional[callee.params.length];
      if (extra !== undefined) {
        this.report(
          'TY007',
          '`' + fnName + '` takes ' + String(callee.params.length) +
            (callee.params.length === 1 ? ' argument' : ' arguments'),
          extra.span,
          'too many arguments',
          callee.params.length === 0
            ? ['it takes no arguments']
            : ['it takes: ' + callee.params.map((p) => p.name ?? '_').join(', ')],
        );
      }
    }

    for (const [i, param] of callee.params.entries()) {
      if (param.optional || param.name === undefined) continue;
      if (i < positional.length) continue;
      this.report(
        'TY008',
        '`' + fnName + '` is missing a value for `' + param.name + '`',
        args[args.length - 1]?.span ?? span,
        'required argument not supplied',
        ['it takes: ' + callee.params.map((p) => (p.rest ? '..' : '') + (p.name ?? '_')).join(', ')],
      );
    }
  }

  /** Every argument typed once, in source order, whatever the call's spelling. */
  private argTys(args: readonly Arg[]): readonly ArgTy[] {
    return args.map((arg) => ({
      name: arg.name,
      ty: this.typeOf(arg.value),
      span: arg.value.span,
    }));
  }

  /**
   * Arguments against parameters, for every spelling of a call.
   *
   * Positional arguments fill parameters in order; named ones by name. The
   * resolver and interpreter already report arity and naming problems, so this
   * pass only compares the types of arguments it can pair up.
   */
  private checkCall(callee: Ty, fnName: string, args: readonly ArgTy[], span: Span): Ty {
    if (callee.k !== 'fn') return ANY;

    this.checkArity(callee, fnName, args, span);

    let next = 0;
    for (const arg of args) {
      let param: ParamTy | undefined;
      if (arg.name === undefined) {
        param = callee.params[next];
        // A rest parameter collects everything after it, so the walk stays on
        // it rather than stepping past and leaving the remainder unpaired.
        if (param?.rest !== true) next += 1;
      } else {
        param = callee.params.find((p) => p.name !== undefined && p.name === arg.name);
      }
      if (param === undefined) continue;
      if (accepts(param.ty, arg.ty)) continue;

      const described =
        param.name === undefined
          ? 'argument ' + String(args.indexOf(arg) + 1)
          : '`' + param.name + '`';
      this.report(
        'TY001',
        '`' + fnName + '` expects ' + showTy(param.ty) + ' for ' + described +
          ' but was given ' + showTy(arg.ty),
        arg.span,
        'expected ' + showTy(param.ty),
        param.name === undefined
          ? ['the parameter is declared as `' + showTy(param.ty) + '`']
          : ['the parameter is declared as `' + param.name + ': ' + showTy(param.ty) + '`'],
      );
    }
    return callee.ret;
  }
}

/** One argument as `checkCall` sees it: what it is called, what it is, where it is. */
interface ArgTy {
  readonly name: string | undefined;
  readonly ty: Ty;
  readonly span: Span;
}

/** What to call the thing being called, in a diagnostic. */
function calleeName(callee: Expr): string {
  if (callee.kind === 'Ident') return callee.name;
  if (callee.kind === 'MemberExpr') return callee.name;
  return 'this function';
}

/**
 * A written annotation as a type.
 *
 * A free function rather than a method, so a signature can be converted with no
 * module around it — the standard library's are, at the point the caller builds
 * the maps in `CheckOptions`.
 *
 * `named` says what a name that is not built in refers to; a name it does not
 * recognise becomes `Any`, which is what makes an unknown annotation harmless
 * rather than an error.
 */
function tyOf(
  annotation: TypeExpr | undefined,
  named: (name: string) => 'struct' | 'enum' | undefined,
): Ty {
  if (annotation === undefined) return ANY;
  if (annotation.kind === 'TypeFn') {
    return {
      k: 'fn',
      params: annotation.params.map((p) => ({
        name: undefined,
        ty: tyOf(p, named),
        optional: false,
        rest: false,
      })),
      ret: tyOf(annotation.ret, named),
    };
  }
  const first = annotation.args[0];
  switch (annotation.name) {
    case 'Num':
      return NUM;
    case 'Str':
      return STR;
    case 'Bool':
      return BOOL;
    case 'Nil':
      return NIL;
    case 'List':
      return { k: 'list', of: tyOf(first, named) };
    case 'Map':
      return { k: 'map', of: tyOf(first, named) };
    default: {
      const kind = named(annotation.name);
      if (kind === 'struct') return { k: 'struct', name: annotation.name };
      if (kind === 'enum') return { k: 'enum', name: annotation.name };
      // `Any`, a generic parameter, or a name this pass does not know.
      return ANY;
    }
  }
}

/**
 * What the checker is told about the world outside the module.
 *
 * The checker cannot read the standard library — `packages/core` imports
 * nothing — so the caller, which has a fully built interpreter in hand, hands
 * over the types as data. Both maps are optional: without them every call is
 * `Any` in and `Any` out, which is exactly how this pass behaved before they
 * existed.
 */
export interface CheckOptions {
  /** Type of a name that is in scope with no declaration — the prelude. */
  readonly signatures?: ReadonlyMap<string, Ty>;
  /**
   * Type of `x.name(...)`, keyed `"Str.upper"`, with the receiver parameter
   * already removed — the shape a call actually has to match.
   *
   * The type half of the key is what `typeName` reports at run time, because
   * that is what method tables are registered under. A method that belongs to
   * every value is keyed `"*.str"`.
   */
  readonly methods?: ReadonlyMap<string, Ty>;
  /**
   * Every method each type has, keyed by the same type name as `methods`, with
   * the ones every value has under `UNIVERSAL`.
   *
   * `methods` cannot answer "does this method exist": a method nobody has
   * written a signature for is absent from it and works at run time. So
   * existence is asked of this map instead, which is the interpreter's own
   * tables by another route. Without it, or without a `UNIVERSAL` entry,
   * `TY012` says nothing — an incomplete table would call working code a typo.
   */
  readonly methodNames?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The types of library functions that never give a value back, by identity.
   *
   * `panic` and `exit` stop the program. Both are declared `-> Nil`, because
   * `Nil` is the nearest thing the type language has to say about a call that
   * has no answer — and taking that literally made a guard clause a type error:
   *
   *     fn mustBePositive(n: Num) -> Num {
   *       if n > 0 { return n }
   *       panic("expected a positive number, got ${n}")   ← TY002, wrongly
   *     }
   *
   * The resolver has always known better: `RS012` counts a call to `panic` as a
   * statement that certainly leaves, so the two static passes disagreed about
   * the same call. By type identity rather than by name, exactly as `RS012`
   * recognises it by binding — a program that declares its own `panic` is
   * calling its own, and this must not speak about it.
   */
  readonly neverReturns?: ReadonlySet<Ty>;
  /**
   * What each module exports and the type of each, keyed by module path.
   *
   * The same map the resolver uses for `RS009`, so an import cannot be checked
   * for existence by one pass and for type by another that disagrees about
   * what the module holds.
   */
  readonly moduleExports?: ReadonlyMap<string, ReadonlyMap<string, Ty>>;
  /**
   * Called with the type of every expression, as it is derived.
   *
   * For tooling: hover wants exactly this, and so does completion after a `.`.
   * Working it out a second time elsewhere would be a second implementation of
   * the same question, free to disagree with this one. Off unless asked, so
   * `lumen check` pays nothing for it.
   */
  readonly record?: (expr: Expr, ty: Ty) => void;
  /**
   * Names and method keys of library functions called for their *effect*.
   *
   * Everything else with a declared signature answers with a value and does
   * nothing else, so `xs.sort()` on a line of its own is a statement that does
   * nothing — see `TY010`. The caller supplies the set for the same reason it
   * supplies the signatures: this package knows no library.
   *
   * A function whose declared return type is `Nil` never needs listing. It has
   * no value to discard, so it is obviously called for what it does.
   *
   * The types rather than the names, because the library has two `remove`s and
   * two `write`s: `std/fs.remove` deletes a file and `std/map.remove` answers
   * with a smaller map, and a set of names could not tell them apart. Method
   * keys are named, though — `Str.read` and `Map.remove` reach the same two
   * through a different channel, and there a name that means both stays silent
   * for both, which errs the safe way.
   */
  readonly effectful?: ReadonlySet<Ty | string>;
}

/**
 * A signature written in Lumen's own annotation syntax, as a type.
 *
 *     signatureTy('(s: Str, separator: Str) -> List<Str>')
 *
 * Parsed with the real parser, on a real function declaration, so what the
 * standard library says about itself is spelled in exactly the syntax a user
 * writes and cannot drift into a private notation. A signature that does not
 * parse raises, which is what makes a typo in one a build failure rather than a
 * function that quietly stops being checked.
 *
 * Only the built-in type names mean anything here — there are no user structs
 * at the point a standard-library signature is read — so `Task` or a generic
 * `T` becomes `Any`, and the call is left unchecked rather than wrongly
 * rejected. `Option` and `Result` are known, being part of the language.
 */
export function signatureTy(signature: string): Ty {
  const module = parse('fn __signature' + signature + ' {}', '<signature>');
  const decl = module.stmts[0];
  if (decl === undefined || decl.kind !== 'FnDecl') {
    throw new Error('not a signature: ' + signature);
  }
  const known = (name: string): 'enum' | undefined =>
    name === 'Option' || name === 'Result' ? 'enum' : undefined;
  return {
    k: 'fn',
    params: decl.params.map((param) => ({
      name: param.name,
      ty: tyOf(param.type, known),
      optional: param.defaultValue !== undefined || param.rest,
      rest: param.rest,
    })),
    ret: tyOf(decl.ret, known),
  };
}

/**
 * A `fn` type written the way a signature is: `(s: Str, fill: Str = ...) -> Str`.
 *
 * The inverse of `signatureTy`, near enough — a default *value* is not kept in
 * a type, so an optional parameter comes back as `= ...`, which is how `help()`
 * has always rendered one. Used to describe a function to a person: a bound
 * method's receiver is gone from its parameters, so this is what shows
 * `split(separator: Str)` rather than the `split(s: Str, separator: Str)` the
 * free function has.
 */
export function showSignature(ty: Ty): string {
  if (ty.k !== 'fn') return showTy(ty);
  const params = ty.params.map((p) => {
    const name = (p.rest ? '..' : '') + (p.name ?? '_');
    const typed = p.ty.k === 'any' ? name : name + ': ' + showTy(p.ty);
    return p.optional && !p.rest ? typed + ' = ...' : typed;
  });
  return '(' + params.join(', ') + ')' + (ty.ret.k === 'any' ? '' : ' -> ' + showTy(ty.ret));
}

/**
 * The same signature as a method's: the receiver is the first parameter of the
 * function and is already supplied by the time `x.f(a)` is written, so it comes
 * off — exactly as `bindReceiver` takes it off the value at run time.
 */
export function methodTy(signature: Ty): Ty {
  if (signature.k !== 'fn') return signature;
  return { k: 'fn', params: signature.params.slice(1), ret: signature.ret };
}

/** The type half of a method key that applies to every value. */
export const UNIVERSAL = '*';

/** Type-check a module. An empty result means nothing conflicted. */
export function checkTypes(module: Module, options?: CheckOptions): readonly Diagnostic[] {
  return new Checker(options).check(module);
}
