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
 */

import type {
  BinaryOp,
  Block,
  Expr,
  Module,
  Param,
  Pattern,
  Stmt,
  TypeExpr,
} from './ast.js';
import { type Diagnostic, type Note, type Span } from './diagnostics.js';

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

interface ParamTy {
  readonly name: string;
  readonly ty: Ty;
  /** A parameter with a default may be omitted. */
  readonly optional: boolean;
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
    case 'fn':
      return true; // function shapes are not compared in this pass
    default:
      return true;
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
  private readonly enums = new Set<string>();
  private scope = new Scope(undefined);
  /** The declared return type of the function being checked, if any. */
  private returnTy: Ty = ANY;

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
            ]
          : ['`+` joins two Nums, two Strs or two Lists'],
      );
      return;
    }

    if (op === '-' || op === '*' || op === '/' || op === '%' || op === '**') {
      if (left.k === 'num' && right.k === 'num') return;
      this.report(
        'TY005',
        'cannot apply `' + op + '` to ' + shown,
        span,
        'mismatched operands',
        ['`' + op + '` wants two Nums'],
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
  ): void {
    const key = code + '@' + String(span.start.offset) + ':' + String(span.end.offset) + ' ' + message;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diagnostics.push({
      severity: 'error',
      code,
      message,
      span,
      label,
      ...(notes === undefined ? {} : { notes: notes.map((m): Note => ({ message: m })) }),
    });
  }

  /** Convert a written annotation into a type. Unknown names become Any. */
  private toTy(annotation: TypeExpr | undefined): Ty {
    if (annotation === undefined) return ANY;
    if (annotation.kind === 'TypeFn') {
      return {
        k: 'fn',
        params: annotation.params.map((p, i) => ({ name: 'p' + i, ty: this.toTy(p), optional: false })),
        ret: this.toTy(annotation.ret),
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
        return { k: 'list', of: this.toTy(first) };
      case 'Map':
        return { k: 'map', of: this.toTy(first) };
      default:
        if (this.structs.has(annotation.name)) return { k: 'struct', name: annotation.name };
        if (this.enums.has(annotation.name)) return { k: 'enum', name: annotation.name };
        // `Any`, a generic parameter, or a name this pass does not know.
        return ANY;
    }
  }

  private fnTy(params: readonly Param[], ret: TypeExpr | undefined): Ty {
    return {
      k: 'fn',
      params: params.map((p) => ({
        name: p.name,
        ty: this.toTy(p.type),
        optional: p.defaultValue !== undefined,
      })),
      ret: this.toTy(ret),
    };
  }

  // -------------------------------------------------------------- traversal

  check(module: Module): readonly Diagnostic[] {
    this.collectTypes(module.stmts);
    this.hoist(module.stmts);
    for (const stmt of module.stmts) this.stmt(stmt);
    return this.diagnostics;
  }

  /** Structs and enums first, so annotations naming them resolve. */
  private collectTypes(stmts: readonly Stmt[]): void {
    for (const stmt of stmts) {
      const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
      if (decl.kind === 'EnumDecl') this.enums.add(decl.name);
    }
    for (const stmt of stmts) {
      const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
      if (decl.kind !== 'StructDecl') continue;
      const fields = new Map<string, Ty>();
      for (const field of decl.fields) fields.set(field.name, this.toTy(field.type));
      this.structs.set(decl.name, { fields });
    }
  }

  private hoist(stmts: readonly Stmt[]): void {
    for (const stmt of stmts) {
      const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
      if (decl.kind === 'FnDecl') {
        this.scope.declare(decl.name, this.fnTy(decl.params, decl.ret));
      }
    }
  }

  private block(block: Block): void {
    const saved = this.scope;
    this.scope = new Scope(saved);
    this.hoist(block.stmts);
    for (const stmt of block.stmts) this.stmt(stmt);
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

      case 'ImportDecl':
        for (const spec of stmt.specifiers) this.scope.declare(spec.alias ?? spec.name, ANY);
        return;

      case 'ExportDecl':
        this.stmt(stmt.declaration);
        return;
    }
  }

  private fnBody(params: readonly Param[], ret: TypeExpr | undefined, body: Block): void {
    const savedScope = this.scope;
    const savedReturn = this.returnTy;
    this.scope = new Scope(savedScope);
    this.returnTy = this.toTy(ret);
    for (const param of params) this.scope.declare(param.name, this.toTy(param.type));
    this.block(body);
    this.checkImplicitReturn(body);
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
   * Declare every name a pattern binds, in the current scope.
   *
   * `ty` is what the whole pattern matches against. It is only passed through to
   * a plain binding — the pieces of a destructuring are `Any`, because working
   * out the type of the third element of a list or the payload of an enum
   * variant is inference, which this pass deliberately does not do. `Any` is
   * always safe: it is compatible in both directions, so it can produce no
   * diagnostic at all.
   */
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

  /** The type of an expression, or Any when it cannot be determined. */
  private typeOf(expr: Expr): Ty {
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
        this.typeOf(expr.left);
        this.typeOf(expr.right);
        return ANY;

      case 'IndexExpr': {
        const target = this.typeOf(expr.target);
        this.typeOf(expr.index);
        if (target.k === 'list') return target.of;
        if (target.k === 'map') return target.of;
        if (target.k === 'str') return STR;
        return ANY;
      }

      case 'MemberExpr': {
        const target = this.typeOf(expr.target);
        if (target.k === 'struct') {
          const info = this.structs.get(target.name);
          const field = info?.fields.get(expr.name);
          if (field !== undefined) return field;
        }
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
        this.typeOf(expr.subject);
        for (const arm of expr.arms) {
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
    const callee = this.typeOf(expr.callee);
    for (const arg of expr.args) this.typeOf(arg.value);
    if (callee.k !== 'fn') return ANY;

    // Positional arguments fill parameters in order; named ones by name. The
    // resolver and interpreter already report arity and naming problems, so
    // this pass only compares the types of arguments it can pair up.
    let next = 0;
    const fnName = expr.callee.kind === 'Ident' ? expr.callee.name : 'this function';
    for (const arg of expr.args) {
      const param =
        arg.name === undefined
          ? callee.params[next++]
          : callee.params.find((p) => p.name === arg.name);
      if (param === undefined) continue;
      const actual = this.typeOf(arg.value);
      if (!accepts(param.ty, actual)) {
        this.report(
          'TY001',
          '`' + fnName + '` expects ' + showTy(param.ty) + ' for `' + param.name +
            '` but was given ' + showTy(actual),
          arg.value.span,
          'expected ' + showTy(param.ty),
          ['the parameter is declared as `' + param.name + ': ' + showTy(param.ty) + '`'],
        );
      }
    }
    return callee.ret;
  }
}

/** Type-check a module. An empty result means nothing conflicted. */
export function checkTypes(module: Module): readonly Diagnostic[] {
  return new Checker().check(module);
}
