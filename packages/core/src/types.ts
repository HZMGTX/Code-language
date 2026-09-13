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
  Block,
  Expr,
  Module,
  Param,
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
  private readonly structs = new Map<string, StructInfo>();
  private readonly enums = new Set<string>();
  private scope = new Scope(undefined);
  /** The declared return type of the function being checked, if any. */
  private returnTy: Ty = ANY;

  private report(
    code: string,
    message: string,
    span: Span,
    label: string,
    notes?: readonly string[],
  ): void {
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
        this.typeOf(stmt.iterable);
        const saved = this.scope;
        this.scope = new Scope(saved);
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
    this.scope = savedScope;
    this.returnTy = savedReturn;
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
        if (expr.op === '==' || expr.op === '!=') return BOOL;
        if (expr.op === '<' || expr.op === '<=' || expr.op === '>' || expr.op === '>=') return BOOL;
        // `+` is also string and list concatenation, so it only yields Num when
        // both sides are known to be numbers.
        if (left.k === 'num' && right.k === 'num') return NUM;
        if (expr.op === '+' && left.k === 'str' && right.k === 'str') return STR;
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

      case 'AssignExpr':
        this.typeOf(expr.target);
        return this.typeOf(expr.value);

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
