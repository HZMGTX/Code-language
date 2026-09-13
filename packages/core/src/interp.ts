/**
 * The Lumen evaluator: an async tree-walking interpreter.
 *
 * Why async: every `evaluate` returns a promise, so a native function may do
 * real I/O and the interpreter simply awaits it. The consequence is that Lumen
 * code has **no async colouring** — `chat(...)` and `read(...)` look and compose
 * exactly like pure functions, and there is no `async fn` to thread through a
 * call stack. The cost is speed, which is the right trade for v0.1; a bytecode
 * VM is the planned answer (see ROADMAP).
 *
 * Control flow (`return`, `break`, `continue`, and `?` propagation) is
 * implemented with exceptions, which unwind the JS stack alongside the Lumen
 * one for free.
 */

import type {
  Arg,
  Block,
  Expr,
  FnDecl,
  Module,
  Param,
  Pattern,
  Stmt,
} from './ast.js';
import { LumenError, type Diagnostic, type Note, type Span } from './diagnostics.js';
import { parse } from './parser.js';
import {
  Env,
  NIL,
  NONE,
  type CallCtx,
  type EnumValue,
  type FnValue,
  type Host,
  type ListValue,
  type MapValue,
  type ModuleValue,
  type NativeValue,
  type SourceUnit,
  type StructValue,
  type Value,
  bool,
  display,
  enumValue,
  inspect,
  list,
  map,
  num,
  str,
  suggest,
  truthy,
  typeName,
  valuesEqual,
} from './values.js';

// ------------------------------------------------------------------ signals

class ReturnSignal {
  constructor(readonly value: Value) {}
}
/**
 * The deepest chain of Lumen calls allowed before `RT045`.
 *
 * High enough that no reasonable recursion reaches it — a balanced tree of ten
 * thousand nodes is fourteen deep, and a list walked recursively would have to
 * hold ten thousand items — and low enough to fail in well under a second.
 */
const MAX_CALL_DEPTH = 10000;

/**
 * The "it takes: ..." note, which cannot list parameter names for a callee
 * whose parameters have none — an enum variant's payload is positional, so
 * `field0` is an implementation detail rather than something to suggest.
 */
function takesNote(paramNames: readonly string[], positional: boolean): string {
  if (positional) {
    return paramNames.length === 1
      ? 'it takes 1 value, by position'
      : 'it takes ' + paramNames.length + ' values, by position';
  }
  return 'it takes: ' + (paramNames.length === 0 ? '(nothing)' : paramNames.join(', '));
}

class BreakSignal {}
class ContinueSignal {}
/** Raised by postfix `?` to carry an `Err`/`None` out of the enclosing function. */
class TryPropagate {
  constructor(readonly value: Value) {}
}

/** A range materialised by `..` may not exceed this, to turn OOM into an error. */
const MAX_RANGE = 10_000_000;

// ----------------------------------------------------------------- resolver

export interface ResolvedModule {
  /** Cache key; identical specs resolving here share one module instance. */
  readonly key: string;
  /** A module implemented in the host language. */
  readonly exports?: ReadonlyMap<string, Value>;
  /** A module written in Lumen. */
  readonly file?: string;
  readonly source?: string;
}

export interface ModuleResolver {
  resolve(spec: string, fromFile: string): Promise<ResolvedModule | undefined>;
}

export interface InterpreterOptions {
  readonly host: Host;
  readonly resolver?: ModuleResolver;
}

// -------------------------------------------------------------- interpreter

export class Interpreter {
  readonly globals = new Env();
  readonly host: Host;
  private readonly resolver: ModuleResolver | undefined;
  private readonly units: SourceUnit[] = [];
  /** How many Lumen calls are currently on the way in. See `MAX_CALL_DEPTH`. */
  private depth = 0;
  private readonly moduleCache = new Map<string, ModuleValue>();
  private readonly loading = new Set<string>();
  /**
   * Method tables, keyed by type name ("Str", "List", "Map").
   *
   * `core` cannot import the standard library, so the tables are registered
   * from outside. That indirection is what lets `"hi".upper()` work without the
   * language itself knowing anything about `std/str`.
   */
  private readonly methodTables = new Map<string, ReadonlyMap<string, Value>>();
  /** Methods on every value: the ones whose subject is genuinely any value. */
  private universalMethods: ReadonlyMap<string, Value> = new Map();

  constructor(options: InterpreterOptions) {
    this.host = options.host;
    this.resolver = options.resolver;
    installBuiltins(this.globals);
  }

  /** Register a native module so `import { x } from "name"` can find it. */
  /**
   * Make `functions` callable as methods on values of type `typeName`.
   *
   * Because every standard-library function takes its subject first, this makes
   * `x.f(a)`, `f(x, a)` and `x |> f(a)` three spellings of one thing.
   */
  registerMethods(typeName: string, functions: ReadonlyMap<string, Value>): void {
    const existing = this.methodTables.get(typeName);
    if (existing === undefined) {
      this.methodTables.set(typeName, functions);
      return;
    }
    this.methodTables.set(typeName, new Map([...existing, ...functions]));
  }

  /**
   * Make `functions` callable as methods on **every** value.
   *
   * For the handful whose subject is genuinely any value — `str`, `inspect`,
   * `type` — and not a general fallback to whatever is in scope. That
   * distinction is the point: falling back to every global would make
   * `[1, 2].upper()` call `upper` with a List and fail somewhere inside
   * `std/str`, where today it is `RT027: List has no method \`upper\`` with a
   * list of the ones it does have. Trading a good error for a worse one is not
   * worth the convenience.
   *
   * A type-specific method of the same name always wins, so registering one of
   * these can never change what an existing call means.
   */
  registerUniversalMethods(functions: ReadonlyMap<string, Value>): void {
    this.universalMethods = new Map([...this.universalMethods, ...functions]);
  }

  /** The method names available on a type, for error messages and `help()`. */
  methodNames(typeName: string): string[] {
    return [
      ...new Set([
        ...(this.methodTables.get(typeName)?.keys() ?? []),
        ...this.universalMethods.keys(),
      ]),
    ];
  }

  /** Look up `name` as a method on `receiver`, already bound to it. */
  private lookupMethod(typeOf: string, name: string, receiver: Value): Value | undefined {
    const found = this.methodTables.get(typeOf)?.get(name) ?? this.universalMethods.get(name);
    if (found === undefined) return undefined;
    return found.k === 'native' ? bindReceiver(found, receiver) : found;
  }

  private unit(): SourceUnit {
    return this.units[this.units.length - 1] ?? { file: '<unknown>', source: '' };
  }

  /** Raise a located runtime error. Always throws. */
  fail(code: string, message: string, span: Span, label?: string, notes?: readonly string[]): never {
    const unit = this.unit();
    const diagnostic: Diagnostic = {
      severity: 'error',
      code,
      message,
      span,
      ...(label === undefined ? {} : { label }),
      ...(notes === undefined ? {} : { notes: notes.map((m): Note => ({ message: m })) }),
    };
    throw new LumenError([diagnostic], unit.file, unit.source);
  }

  // ------------------------------------------------------------- entry points

  /**
   * Run a parsed module as the program. Declarations are hoisted, top-level
   * statements run in order, and a `main` function, if one is declared, is
   * called afterwards.
   */
  async runModule(module: Module, source: string): Promise<void> {
    const unit: SourceUnit = { file: module.file, source };
    this.units.push(unit);
    const env = new Env(this.globals);
    try {
      await this.hoist(module.stmts, env, unit);
      for (const stmt of module.stmts) {
        await this.execStmt(stmt, env, unit);
      }
      const main = env.lookup('main');
      if (main !== undefined && (main.value.k === 'fn' || main.value.k === 'native')) {
        await this.callValue(main.value, [], module.span);
      }
    } catch (error) {
      if (error instanceof TryPropagate) {
        // `?` used at top level with nothing to return to.
        this.fail(
          'RT001',
          '`?` propagated ' + inspect(error.value) + ' out of the program',
          module.span,
          'unhandled at top level',
          ['handle it with `match`, or return it from a function that yields a Result'],
        );
      }
      if (error instanceof ReturnSignal) return;
      throw error;
    } finally {
      this.units.pop();
    }
  }

  /** Evaluate a single expression against a scope — used by the REPL. */
  async runExpression(expr: Expr, env: Env, unit: SourceUnit): Promise<Value> {
    this.units.push(unit);
    try {
      return await this.evaluate(expr, env);
    } finally {
      this.units.pop();
    }
  }

  /** Execute statements against an existing scope — used by the REPL. */
  async runStatements(stmts: readonly Stmt[], env: Env, unit: SourceUnit): Promise<Value> {
    this.units.push(unit);
    try {
      await this.hoist(stmts, env, unit);
      let last: Value = NIL;
      for (const stmt of stmts) {
        last = await this.execStmt(stmt, env, unit);
      }
      return last;
    } finally {
      this.units.pop();
    }
  }

  // ------------------------------------------------------------------ hoisting

  /**
   * Pre-declare functions and types so they can be referenced before their
   * definition — which is what makes mutual recursion and a `main` at the top
   * of the file work.
   */
  private async hoist(stmts: readonly Stmt[], env: Env, unit: SourceUnit): Promise<void> {
    for (const stmt of stmts) {
      const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
      switch (decl.kind) {
        case 'FnDecl':
          env.declare(decl.name, this.makeFunction(decl, env, unit), false);
          break;
        case 'StructDecl':
          env.declare(
            decl.name,
            { k: 'structType', name: decl.name, fieldNames: decl.fields.map((f) => f.name) },
            false,
          );
          break;
        case 'EnumDecl': {
          const variants = new Map<string, number>();
          for (const variant of decl.variants) variants.set(variant.name, variant.fields.length);
          env.declare(decl.name, { k: 'enumType', name: decl.name, variants }, false);
          break;
        }
        default:
          break;
      }
    }
  }

  private makeFunction(decl: FnDecl, closure: Env, unit: SourceUnit): FnValue {
    return {
      k: 'fn',
      name: decl.name,
      params: decl.params,
      body: decl.body,
      closure,
      unit,
    };
  }

  // ---------------------------------------------------------------- statements

  private async execStmt(stmt: Stmt, env: Env, unit: SourceUnit): Promise<Value> {
    switch (stmt.kind) {
      case 'LetDecl': {
        const value = this.evalLeaf(stmt.value, env) ?? (await this.evaluate(stmt.value, env));
        env.declare(stmt.name, value, stmt.mutable);
        return NIL;
      }
      case 'DestructureDecl': {
        const value = await this.evaluate(stmt.value, env);
        // The same matcher `match` and `for` use. A `let` has no second arm to
        // fall through to, so a pattern that does not fit is an error here
        // rather than a miss.
        if (!(await this.matchPattern(stmt.pattern, value, env, stmt.mutable))) {
          this.fail(
            'RT047',
            'the pattern does not fit ' + inspect(value),
            stmt.pattern.span,
            'cannot be taken apart this way',
            ['use `match` when a value may or may not have this shape'],
          );
        }
        return NIL;
      }
      case 'FnDecl':
        // Already hoisted, but re-declare so a nested redefinition takes effect.
        env.declare(stmt.name, this.makeFunction(stmt, env, unit), false);
        return NIL;
      case 'StructDecl':
      case 'EnumDecl':
        return NIL; // handled by hoisting
      case 'ReturnStmt': {
        const value = stmt.value === undefined ? NIL : await this.evaluate(stmt.value, env);
        throw new ReturnSignal(value);
      }
      case 'BreakStmt':
        throw new BreakSignal();
      case 'ContinueStmt':
        throw new ContinueSignal();
      case 'WhileStmt':
        await this.execWhile(stmt.condition, stmt.body, env, unit);
        return NIL;
      case 'ForStmt':
        await this.execFor(stmt.binding, stmt.iterable, stmt.body, env, unit);
        return NIL;
      case 'ExprStmt':
        return await this.evaluate(stmt.expr, env);
      case 'ImportDecl': {
        const module = await this.loadModule(stmt.from, unit, stmt.span);
        for (const spec of stmt.specifiers) {
          const value = module.exports.get(spec.name);
          if (value === undefined) {
            const hint = suggest(spec.name, [...module.exports.keys()]);
            this.fail(
              'RT002',
              'module "' + stmt.from + '" has no export named `' + spec.name + '`',
              spec.span,
              'not exported',
              hint === undefined
                ? ['it exports: ' + [...module.exports.keys()].sort().join(', ')]
                : ['did you mean `' + hint + '`?'],
            );
          }
          env.declare(spec.alias ?? spec.name, value, false);
        }
        return NIL;
      }
      case 'ExportDecl':
        return await this.execStmt(stmt.declaration, env, unit);
    }
  }

  private async execWhile(condition: Expr, body: Block, env: Env, unit: SourceUnit): Promise<void> {
    for (;;) {
      const test = this.evalLeaf(condition, env) ?? (await this.evaluate(condition, env));
      if (!truthy(test)) return;
      try {
        await this.execBlock(body, new Env(env), unit);
      } catch (error) {
        if (error instanceof BreakSignal) return;
        if (error instanceof ContinueSignal) continue;
        throw error;
      }
    }
  }

  private async execFor(
    binding: Pattern,
    iterable: Expr,
    body: Block,
    env: Env,
    unit: SourceUnit,
  ): Promise<void> {
    const subject = await this.evaluate(iterable, env);
    const items = this.iterableOf(subject, iterable.span);
    for (const item of items) {
      const loopEnv = new Env(env);
      if (!(await this.matchPattern(binding, item, loopEnv))) {
        this.fail(
          'RT003',
          'loop pattern did not match ' + inspect(item),
          binding.span,
          'pattern does not fit this element',
        );
      }
      try {
        await this.execBlock(body, loopEnv, unit);
      } catch (error) {
        if (error instanceof BreakSignal) return;
        if (error instanceof ContinueSignal) continue;
        throw error;
      }
    }
  }

  /** The element sequence for `for ... in`. */
  private iterableOf(value: Value, span: Span): Value[] {
    switch (value.k) {
      case 'list':
        return [...value.items];
      case 'str':
        return [...value.v].map((ch) => str(ch));
      case 'map':
        return [...value.entries].map(([key, item]) => list([str(key), item]));
      default:
        return this.fail(
          'RT004',
          'cannot iterate over ' + typeName(value),
          span,
          'not iterable',
          ['`for` works over List, Str, Map, and ranges like `0..10`'],
        );
    }
  }

  /** Run a block's statements in `env`; its value is that of its last statement. */
  private async execBlock(block: Block, env: Env, unit: SourceUnit): Promise<Value> {
    await this.hoist(block.stmts, env, unit);
    let last: Value = NIL;
    for (const stmt of block.stmts) {
      last = await this.execStmt(stmt, env, unit);
    }
    return last;
  }

  // --------------------------------------------------------------- expressions

  /**
   * Evaluate an expression that cannot possibly do I/O, without a promise.
   *
   * Returns `undefined` for anything else, so callers fall back to the async
   * path. It handles only leaves — literals and names — which is exactly where
   * the cost was: `while i < 300000 { total += i * 2 - 1 }` evaluates six
   * leaves per iteration, and each one was allocating a promise that resolved
   * immediately. There is no correctness question, because none of these can
   * suspend; the two paths return the same value for the same node.
   *
   * This is a narrow version of the hybrid sync/async evaluator the roadmap
   * describes. The full one means rewriting every `for…of` with an await into
   * a step function and every `try` to handle a throw and a rejection — a CPS
   * rewrite that a bytecode VM would then discard. This part is none of that.
   */
  private evalLeaf(expr: Expr, env: Env): Value | undefined {
    switch (expr.kind) {
      case 'NumberLit':
        return num(expr.value);
      case 'StringLit':
        return str(expr.value);
      case 'BoolLit':
        return bool(expr.value);
      case 'NilLit':
        return NIL;
      case 'Ident':
        return this.lookupName(expr, env);
      default:
        return undefined;
    }
  }

  /** The `Ident` case, shared by both paths so they cannot drift apart. */
  private lookupName(expr: Extract<Expr, { kind: 'Ident' }>, env: Env): Value {
    const slot = env.lookup(expr.name);
    if (slot === undefined) {
      const hint = suggest(expr.name, env.visibleNames());
      this.fail(
        'RT005',
        '`' + expr.name + '` is not defined',
        expr.span,
        'not found in this scope',
        hint === undefined ? undefined : ['did you mean `' + hint + '`?'],
      );
    }
    return slot.value;
  }

  async evaluate(expr: Expr, env: Env): Promise<Value> {
    switch (expr.kind) {
      case 'NumberLit':
        return num(expr.value);
      case 'StringLit':
        return str(expr.value);
      case 'BoolLit':
        return bool(expr.value);
      case 'NilLit':
        return NIL;

      case 'TemplateLit': {
        let out = '';
        for (const part of expr.parts) {
          out +=
            part.kind === 'text'
              ? part.value
              : display(this.evalLeaf(part.expr, env) ?? (await this.evaluate(part.expr, env)));
        }
        return str(out);
      }

      case 'Ident':
        return this.lookupName(expr, env);

      case 'Unary': {
        const operand = this.evalLeaf(expr.operand, env) ?? (await this.evaluate(expr.operand, env));
        if (expr.op === '-') {
          if (operand.k !== 'num') {
            this.fail('RT006', 'cannot negate ' + typeName(operand), expr.span, 'expected a Num');
          }
          return num(-operand.v);
        }
        return bool(!truthy(operand));
      }

      case 'Binary':
        return await this.evalBinary(expr.op, expr.left, expr.right, env, expr.span);

      case 'Logical': {
        const left = this.evalLeaf(expr.left, env) ?? (await this.evaluate(expr.left, env));
        const takeRight = expr.op === '&&' ? truthy(left) : !truthy(left);
        if (!takeRight) return left;
        return this.evalLeaf(expr.right, env) ?? (await this.evaluate(expr.right, env));
      }

      case 'RangeExpr': {
        const start = await this.evaluate(expr.start, env);
        const end = await this.evaluate(expr.end, env);
        if (start.k !== 'num' || end.k !== 'num') {
          this.fail(
            'RT007',
            'a range needs two Nums, got ' + typeName(start) + ' and ' + typeName(end),
            expr.span,
            'not a range',
          );
        }
        if (!Number.isInteger(start.v) || !Number.isInteger(end.v)) {
          this.fail('RT007', 'range bounds must be whole numbers', expr.span, 'not whole numbers');
        }
        const size = Math.max(0, end.v - start.v);
        if (size > MAX_RANGE) {
          this.fail(
            'RT008',
            'range of ' + size + ' elements is too large',
            expr.span,
            'over the ' + MAX_RANGE + ' element limit',
            ['ranges are materialised as lists in v0.1; use a `while` loop for very large spans'],
          );
        }
        const items: Value[] = [];
        for (let i = start.v; i < end.v; i += 1) items.push(num(i));
        return list(items);
      }

      case 'ListLit': {
        const items: Value[] = [];
        for (const item of expr.items) {
          items.push(this.evalLeaf(item, env) ?? (await this.evaluate(item, env)));
        }
        return list(items);
      }

      case 'MapLit': {
        const entries = new Map<string, Value>();
        for (const entry of expr.entries) {
          const key = await this.evaluate(entry.key, env);
          if (key.k !== 'str') {
            this.fail(
              'RT009',
              'map keys must be Str, got ' + typeName(key),
              entry.key.span,
              'not a string key',
            );
          }
          entries.set(key.v, await this.evaluate(entry.value, env));
        }
        return map(entries);
      }

      case 'StructLit':
        return await this.evalStructLit(expr.name, expr.fields, env, expr.span);

      case 'LambdaExpr':
        return {
          k: 'fn',
          name: '',
          params: expr.params,
          body: expr.body,
          closure: env,
          unit: this.unit(),
        };

      case 'BlockExpr':
        return await this.execBlock(expr.block, new Env(env), this.unit());

      case 'IfExpr': {
        const cond = this.evalLeaf(expr.condition, env) ?? (await this.evaluate(expr.condition, env));
        if (truthy(cond)) {
          return await this.execBlock(expr.then, new Env(env), this.unit());
        }
        if (expr.otherwise === undefined) return NIL;
        if (expr.otherwise.kind === 'Block') {
          return await this.execBlock(expr.otherwise, new Env(env), this.unit());
        }
        return await this.evaluate(expr.otherwise, env);
      }

      case 'MatchExpr':
        return await this.evalMatch(expr.subject, expr.arms, env, expr.span);

      case 'CallExpr': {
        const callee = this.evalLeaf(expr.callee, env) ?? (await this.evaluate(expr.callee, env));
        const args = await this.evalArgs(expr.args, env);
        return await this.callValue(callee, args, expr.span);
      }

      case 'PipelineExpr': {
        const piped = await this.evaluate(expr.left, env);
        if (expr.right.kind === 'CallExpr') {
          const callee = await this.evaluate(expr.right.callee, env);
          const rest = await this.evalArgs(expr.right.args, env);
          return await this.callValue(
            callee,
            [{ name: undefined, value: piped, span: expr.left.span }, ...rest],
            expr.span,
          );
        }
        const callee = await this.evaluate(expr.right, env);
        return await this.callValue(
          callee,
          [{ name: undefined, value: piped, span: expr.left.span }],
          expr.span,
        );
      }

      case 'IndexExpr': {
        const target = this.evalLeaf(expr.target, env) ?? (await this.evaluate(expr.target, env));
        const index = this.evalLeaf(expr.index, env) ?? (await this.evaluate(expr.index, env));
        return this.readIndex(target, index, expr.span);
      }

      case 'MemberExpr': {
        const target = this.evalLeaf(expr.target, env) ?? (await this.evaluate(expr.target, env));
        if (expr.optional && target.k === 'nil') return NIL;
        return this.readMember(target, expr.name, expr.span);
      }

      case 'AssignExpr':
        return await this.evalAssign(expr.op, expr.target, expr.value, env, expr.span);

      case 'TryExpr': {
        const value = await this.evaluate(expr.operand, env);
        if (value.k === 'enum') {
          if (value.enumName === 'Result') {
            if (value.variant === 'Ok') return value.values[0] ?? NIL;
            if (value.variant === 'Err') throw new TryPropagate(value);
          }
          if (value.enumName === 'Option') {
            if (value.variant === 'Some') return value.values[0] ?? NIL;
            if (value.variant === 'None') throw new TryPropagate(value);
          }
        }
        return this.fail(
          'RT010',
          '`?` needs a Result or Option, got ' + typeName(value),
          expr.span,
          'cannot propagate this',
          ['`?` unwraps `Ok`/`Some` and returns `Err`/`None` from the enclosing function'],
        );
      }

      case 'AwaitExpr':
        // Lumen awaits I/O implicitly, so `await` simply yields its operand.
        return await this.evaluate(expr.operand, env);

      case 'JumpExpr': {
        // The same signals the statement forms raise, so a `return` inside a
        // match arm and a `return` on its own line are one mechanism.
        if (expr.jump === 'break') throw new BreakSignal();
        if (expr.jump === 'continue') throw new ContinueSignal();
        const value = expr.value === undefined ? NIL : await this.evaluate(expr.value, env);
        throw new ReturnSignal(value);
      }
    }
  }

  private async evalArgs(args: readonly Arg[], env: Env): Promise<EvaluatedArg[]> {
    const out: EvaluatedArg[] = [];
    for (const arg of args) {
      const value = this.evalLeaf(arg.value, env) ?? (await this.evaluate(arg.value, env));
      out.push({ name: arg.name, value, span: arg.span });
    }
    return out;
  }

  private async evalStructLit(
    name: string,
    fields: readonly { name: string; value: Expr; span: Span }[],
    env: Env,
    span: Span,
  ): Promise<Value> {
    const slot = env.lookup(name);
    if (slot === undefined) {
      const hint = suggest(name, env.visibleNames());
      this.fail(
        'RT011',
        'no struct named `' + name + '`',
        span,
        'unknown type',
        hint === undefined ? undefined : ['did you mean `' + hint + '`?'],
      );
    }
    if (slot.value.k !== 'structType') {
      this.fail(
        'RT012',
        '`' + name + '` is not a struct',
        span,
        'this is ' + typeName(slot.value),
      );
    }
    const type = slot.value;
    const values = new Map<string, Value>();
    for (const field of fields) {
      if (!type.fieldNames.includes(field.name)) {
        const hint = suggest(field.name, type.fieldNames);
        this.fail(
          'RT013',
          '`' + name + '` has no field `' + field.name + '`',
          field.span,
          'unknown field',
          hint === undefined
            ? ['its fields are: ' + type.fieldNames.join(', ')]
            : ['did you mean `' + hint + '`?'],
        );
      }
      if (values.has(field.name)) {
        this.fail('RT014', 'field `' + field.name + '` is set twice', field.span, 'duplicate field');
      }
      values.set(
        field.name,
        this.evalLeaf(field.value, env) ?? (await this.evaluate(field.value, env)),
      );
    }
    const missing = type.fieldNames.filter((f) => !values.has(f));
    if (missing.length > 0) {
      this.fail(
        'RT015',
        '`' + name + '` is missing ' + (missing.length === 1 ? 'field' : 'fields') + ' ' +
          missing.map((f) => '`' + f + '`').join(', '),
        span,
        'incomplete struct literal',
      );
    }
    return { k: 'struct', typeName: name, fields: values };
  }

  private async evalBinary(
    op: string,
    leftExpr: Expr,
    rightExpr: Expr,
    env: Env,
    span: Span,
  ): Promise<Value> {
    const left = this.evalLeaf(leftExpr, env) ?? (await this.evaluate(leftExpr, env));
    const right = this.evalLeaf(rightExpr, env) ?? (await this.evaluate(rightExpr, env));

    if (op === '==') return bool(valuesEqual(left, right));
    if (op === '!=') return bool(!valuesEqual(left, right));

    if (op === '+') {
      if (left.k === 'num' && right.k === 'num') {
        return this.checked(left.v + right.v, op, left.v, right.v, span);
      }
      if (left.k === 'str' && right.k === 'str') return str(left.v + right.v);
      if (left.k === 'list' && right.k === 'list') return list([...left.items, ...right.items]);
      return this.fail(
        'RT016',
        'cannot add ' + typeName(left) + ' and ' + typeName(right),
        span,
        'mismatched operands',
        left.k === 'str' || right.k === 'str'
          ? ['to build a string from mixed values use interpolation: "${a}${b}"']
          : undefined,
      );
    }

    if (op === '-' || op === '*' || op === '/' || op === '%' || op === '**') {
      if (left.k !== 'num' || right.k !== 'num') {
        return this.fail(
          'RT017',
          'cannot apply `' + op + '` to ' + typeName(left) + ' and ' + typeName(right),
          span,
          'expected two Nums',
        );
      }
      if ((op === '/' || op === '%') && right.v === 0) {
        return this.fail(
          'RT018',
          op === '/' ? 'division by zero' : 'remainder by zero',
          span,
          'the right operand is 0',
        );
      }
      // `0 ** -1` is one over zero by another spelling, and gets the same
      // answer as `1 / 0` rather than Infinity.
      if (op === '**' && left.v === 0 && right.v < 0) {
        return this.fail(
          'RT018',
          'division by zero',
          span,
          '0 raised to a negative power',
          ['`0 ** ' + display(num(right.v)) + '` is 1 / 0, which has no value'],
        );
      }
      // A fractional power of a negative number has no real answer: `(-8) **
      // (1 / 3)` is NaN in IEEE 754 even though -2 cubed is -8. Saying so is
      // more use than a NaN, and more use than the RT046 it would otherwise
      // reach, which talks about infinities cancelling.
      if (op === '**' && left.v < 0 && !Number.isInteger(right.v)) {
        return this.fail(
          'RT048',
          'cannot raise a negative number to a fractional power',
          span,
          'no real number answers this',
          [
            display(num(left.v)) + ' ** ' + display(num(right.v)) + ' has no real value',
            'a root of a negative number is imaginary; Lumen has only real numbers',
          ],
        );
      }
      switch (op) {
        case '-':
          return this.checked(left.v - right.v, op, left.v, right.v, span);
        case '*':
          return this.checked(left.v * right.v, op, left.v, right.v, span);
        case '/':
          return this.checked(left.v / right.v, op, left.v, right.v, span);
        case '**':
          return this.checked(left.v ** right.v, op, left.v, right.v, span);
        default:
          return this.checked(left.v % right.v, op, left.v, right.v, span);
      }
    }

    // Ordering comparisons.
    if (left.k === 'num' && right.k === 'num') return bool(compare(op, left.v, right.v));
    if (left.k === 'str' && right.k === 'str') return bool(compare(op, left.v, right.v));
    return this.fail(
      'RT019',
      'cannot compare ' + typeName(left) + ' with ' + typeName(right),
      span,
      'not comparable',
      ['`<`, `<=`, `>` and `>=` work on two Nums or two Strs'],
    );
  }

  /**
   * Arithmetic that refuses to produce a value nobody can use.
   *
   * `Infinity - Infinity` is NaN in IEEE 754, and NaN in Lumen would be a
   * value that displays as `NaN`, is not equal to another value that displays
   * as `NaN`, and is neither less than nor greater than anything. Lumen
   * already declines to produce nonsense quietly — `1 / 0` and `sqrt(-1)` are
   * errors rather than Infinity and NaN — so this is the same rule applied
   * where it was still missing.
   *
   * Infinity itself is left alone: it means "larger than we can say", it
   * compares consistently, and it is equal to itself.
   */
  private checked(result: number, op: string, left: number, right: number, span: Span): Value {
    if (Number.isNaN(result) && !Number.isNaN(left) && !Number.isNaN(right)) {
      return this.fail(
        'RT046',
        'the result of ' + display(num(left)) + ' ' + op + ' ' + display(num(right)) + ' is undefined',
        span,
        'no number answers this',
        [
          'this comes from infinities cancelling, which usually means an earlier ' +
            'result overflowed',
        ],
      );
    }
    return num(result);
  }

  private async evalMatch(
    subjectExpr: Expr,
    arms: readonly { pattern: Pattern; guard: Expr | undefined; body: Expr }[],
    env: Env,
    span: Span,
  ): Promise<Value> {
    const subject = this.evalLeaf(subjectExpr, env) ?? (await this.evaluate(subjectExpr, env));
    for (const arm of arms) {
      const armEnv = new Env(env);
      if (!(await this.matchPattern(arm.pattern, subject, armEnv))) continue;
      if (arm.guard !== undefined && !truthy(await this.evaluate(arm.guard, armEnv))) continue;
      return await this.evaluate(arm.body, armEnv);
    }
    return this.fail(
      'RT020',
      'no match arm matched ' + inspect(subject),
      span,
      'unmatched value',
      [
        'add an arm for this case, or a `_ => ...` catch-all',
        'the value has type ' + typeName(subject),
      ],
    );
  }

  /** Try a pattern against a value, binding names into `env` on success. */
  /**
   * Match `value` against `pattern`, declaring its bindings into `env`.
   *
   * `mutable` exists for `var [a, b] = pair`; every other caller — match arms,
   * loop bindings — binds immutably, which is why it defaults that way.
   */
  private async matchPattern(
    pattern: Pattern,
    value: Value,
    env: Env,
    mutable = false,
  ): Promise<boolean> {
    switch (pattern.kind) {
      case 'PWildcard':
        return true;

      case 'PBinding':
        env.declare(pattern.name, value, mutable);
        return true;

      case 'PLiteral': {
        const literal = await this.evaluate(pattern.value, env);
        return valuesEqual(literal, value);
      }

      case 'PEnum': {
        if (value.k !== 'enum') return false;
        if (pattern.enumName !== undefined && pattern.enumName !== value.enumName) return false;
        if (pattern.variant !== value.variant) return false;
        if (pattern.args.length === 0) return true;
        if (pattern.args.length !== value.values.length) return false;
        for (let i = 0; i < pattern.args.length; i += 1) {
          const sub = pattern.args[i];
          const item = value.values[i];
          if (sub === undefined || item === undefined) return false;
          if (!(await this.matchPattern(sub, item, env, mutable))) return false;
        }
        return true;
      }

      case 'PStruct': {
        if (value.k !== 'struct' || value.typeName !== pattern.name) return false;
        for (const field of pattern.fields) {
          const fieldValue = value.fields.get(field.name);
          if (fieldValue === undefined) return false;
          if (!(await this.matchPattern(field.pattern, fieldValue, env, mutable))) return false;
        }
        return true;
      }

      case 'PList': {
        if (value.k !== 'list') return false;
        const fixed = pattern.items.length;
        if (pattern.rest === undefined ? value.items.length !== fixed : value.items.length < fixed) {
          return false;
        }
        for (let i = 0; i < fixed; i += 1) {
          const sub = pattern.items[i];
          const item = value.items[i];
          if (sub === undefined || item === undefined) return false;
          if (!(await this.matchPattern(sub, item, env, mutable))) return false;
        }
        if (pattern.rest !== undefined) {
          env.declare(pattern.rest, list(value.items.slice(fixed)), false);
        }
        return true;
      }
    }
  }

  // ------------------------------------------------------------- places

  private readIndex(target: Value, index: Value, span: Span): Value {
    if (target.k === 'list') {
      if (index.k !== 'num') {
        this.fail('RT021', 'list index must be a Num, got ' + typeName(index), span, 'not a number');
      }
      const at = index.v < 0 ? target.items.length + index.v : index.v;
      if (!Number.isInteger(at) || at < 0 || at >= target.items.length) {
        this.fail(
          'RT022',
          'index ' + index.v + ' is out of bounds for a list of length ' + target.items.length,
          span,
          'out of range',
          ['negative indices count from the end, so `-1` is the last element'],
        );
      }
      return target.items[at] ?? NIL;
    }
    if (target.k === 'str') {
      if (index.k !== 'num') {
        this.fail('RT021', 'string index must be a Num, got ' + typeName(index), span, 'not a number');
      }
      const chars = [...target.v];
      const at = index.v < 0 ? chars.length + index.v : index.v;
      if (!Number.isInteger(at) || at < 0 || at >= chars.length) {
        this.fail(
          'RT022',
          'index ' + index.v + ' is out of bounds for a string of length ' + chars.length,
          span,
          'out of range',
        );
      }
      return str(chars[at] ?? '');
    }
    if (target.k === 'map') {
      if (index.k !== 'str') {
        this.fail('RT021', 'map keys must be Str, got ' + typeName(index), span, 'not a string');
      }
      // A missing key reads as nil; use `std/map.get` for an Option instead.
      return target.entries.get(index.v) ?? NIL;
    }
    return this.fail('RT023', 'cannot index ' + typeName(target), span, 'not indexable');
  }

  private readMember(target: Value, name: string, span: Span): Value {
    switch (target.k) {
      case 'struct': {
        const value = target.fields.get(name);
        if (value === undefined) {
          const method = this.lookupMethod(target.typeName, name, target);
          if (method !== undefined) return method;
          const hint = suggest(name, [...target.fields.keys()]);
          this.fail(
            'RT024',
            '`' + target.typeName + '` has no field `' + name + '`',
            span,
            'unknown field',
            hint === undefined
              ? ['its fields are: ' + [...target.fields.keys()].join(', ')]
              : ['did you mean `' + hint + '`?'],
          );
        }
        return value;
      }
      case 'map': {
        // A real key always wins over a method of the same name, so adding
        // methods can never change what an existing map lookup returns.
        const own = target.entries.get(name);
        if (own !== undefined) return own;
        const method = this.lookupMethod('Map', name, target);
        if (method !== undefined) return method;
        // A missing key is still nil, as documented.
        return NIL;
      }
      case 'module': {
        const value = target.exports.get(name);
        if (value === undefined) {
          const hint = suggest(name, [...target.exports.keys()]);
          this.fail(
            'RT025',
            'module `' + target.name + '` has no export `' + name + '`',
            span,
            'not exported',
            hint === undefined ? undefined : ['did you mean `' + hint + '`?'],
          );
        }
        return value;
      }
      case 'enumType': {
        const arity = target.variants.get(name);
        if (arity === undefined) {
          const hint = suggest(name, [...target.variants.keys()]);
          this.fail(
            'RT026',
            'enum `' + target.name + '` has no variant `' + name + '`',
            span,
            'unknown variant',
            hint === undefined
              ? ['its variants are: ' + [...target.variants.keys()].join(', ')]
              : ['did you mean `' + hint + '`?'],
          );
        }
        if (arity === 0) return enumValue(target.name, name, []);
        // A variant with a payload is a constructor function.
        const enumName = target.name;
        const params = Array.from({ length: arity }, (_, i) => ({ name: 'field' + i }));
        const ctor: NativeValue = {
          k: 'native',
          name: enumName + '.' + name,
          params,
          // Its payload is positional: `Shape.Rect(3, 4)` has no `field0` in
          // it, so no diagnostic about it should mention one.
          positional: true,
          call: (args) => enumValue(enumName, name, [...args]),
        };
        return ctor;
      }
      default: {
        // Str, List and Num reach here: they have no fields, only methods.
        const method = this.lookupMethod(typeName(target), name, target);
        if (method !== undefined) return method;
        const available = this.methodNames(typeName(target));
        const hint = suggest(name, available);
        return this.fail(
          'RT027',
          typeName(target) + ' has no method `' + name + '`',
          span,
          'not available here',
          hint !== undefined
            ? ['did you mean `' + hint + '`?']
            : available.length > 0
              ? ['available on ' + typeName(target) + ': ' + available.sort().join(', ')]
              : undefined,
        );
      }
    }
  }

  private async evalAssign(
    op: string,
    target: Expr,
    valueExpr: Expr,
    env: Env,
    span: Span,
  ): Promise<Value> {
    const incoming = this.evalLeaf(valueExpr, env) ?? (await this.evaluate(valueExpr, env));
    return await this.storeInto(op, target, incoming, env, span);
  }

  /**
   * Put an already-evaluated value into a place.
   *
   * Separate from `evalAssign` so that `[a, b] = [b, a]` can put each element
   * into its own place without evaluating anything twice — which is also why
   * a swap needs no temporary: both new values are in hand before either is
   * stored.
   */
  private async storeInto(
    op: string,
    target: Expr,
    incoming: Value,
    env: Env,
    span: Span,
  ): Promise<Value> {
    /** Apply the compound operator, or just take the incoming value for `=`. */
    const combine = (current: Value): Value => {
      if (op === '=') return incoming;
      if (current.k === 'num' && incoming.k === 'num') {
        switch (op) {
          case '+=':
            return num(current.v + incoming.v);
          case '-=':
            return num(current.v - incoming.v);
          case '*=':
            return num(current.v * incoming.v);
          case '/=':
            if (incoming.v === 0) {
              this.fail('RT018', 'division by zero', span, 'the right operand is 0');
            }
            return num(current.v / incoming.v);
          default:
            break;
        }
      }
      if (op === '+=' && current.k === 'str' && incoming.k === 'str') {
        return str(current.v + incoming.v);
      }
      if (op === '+=' && current.k === 'list' && incoming.k === 'list') {
        return list([...current.items, ...incoming.items]);
      }
      return this.fail(
        'RT028',
        'cannot apply `' + op + '` to ' + typeName(current) + ' and ' + typeName(incoming),
        span,
        'mismatched operands',
      );
    };

    if (target.kind === 'ListLit') {
      if (incoming.k !== 'list' || incoming.items.length !== target.items.length) {
        return this.fail(
          'RT047',
          'the pattern does not fit ' + inspect(incoming),
          target.span,
          'expected a list of ' + String(target.items.length),
          ['assignment takes the elements one for one; there is no `..rest` here'],
        );
      }
      for (let i = 0; i < target.items.length; i += 1) {
        const place = target.items[i];
        const item = incoming.items[i];
        if (place === undefined || item === undefined) continue;
        await this.storeInto('=', place, item, env, span);
      }
      return incoming;
    }

    if (target.kind === 'Ident') {
      const slot = env.lookup(target.name);
      if (slot === undefined) {
        const hint = suggest(target.name, env.visibleNames());
        this.fail(
          'RT005',
          '`' + target.name + '` is not defined',
          target.span,
          'not found in this scope',
          hint === undefined ? ['declare it first with `let` or `var`'] : ['did you mean `' + hint + '`?'],
        );
      }
      if (!slot.mutable) {
        this.fail(
          'RT029',
          'cannot assign to `' + target.name + '`',
          target.span,
          'declared with `let`',
          ['values bound with `let` never change; use `var` if it needs to'],
        );
      }
      const next = combine(slot.value);
      slot.value = next;
      return next;
    }

    if (target.kind === 'MemberExpr') {
      const object = await this.evaluate(target.target, env);
      if (object.k === 'struct') {
        const current = object.fields.get(target.name);
        if (current === undefined) {
          const hint = suggest(target.name, [...object.fields.keys()]);
          this.fail(
            'RT024',
            '`' + object.typeName + '` has no field `' + target.name + '`',
            target.span,
            'unknown field',
            hint === undefined ? undefined : ['did you mean `' + hint + '`?'],
          );
        }
        const next = combine(current);
        object.fields.set(target.name, next);
        return next;
      }
      if (object.k === 'map') {
        const next = combine(object.entries.get(target.name) ?? NIL);
        object.entries.set(target.name, next);
        return next;
      }
      return this.fail(
        'RT030',
        'cannot assign to a field of ' + typeName(object),
        target.span,
        'not assignable',
      );
    }

    // IndexExpr
    if (target.kind === 'IndexExpr') {
      const object = await this.evaluate(target.target, env);
      const index = await this.evaluate(target.index, env);
      if (object.k === 'list') {
        if (index.k !== 'num') {
          this.fail('RT021', 'list index must be a Num, got ' + typeName(index), target.span, 'not a number');
        }
        const at = index.v < 0 ? object.items.length + index.v : index.v;
        if (!Number.isInteger(at) || at < 0 || at >= object.items.length) {
          this.fail(
            'RT022',
            'index ' + index.v + ' is out of bounds for a list of length ' + object.items.length,
            target.span,
            'out of range',
          );
        }
        const next = combine(object.items[at] ?? NIL);
        object.items[at] = next;
        return next;
      }
      if (object.k === 'map') {
        if (index.k !== 'str') {
          this.fail('RT021', 'map keys must be Str, got ' + typeName(index), target.span, 'not a string');
        }
        const next = combine(object.entries.get(index.v) ?? NIL);
        object.entries.set(index.v, next);
        return next;
      }
      return this.fail(
        'RT031',
        'cannot assign into ' + typeName(object),
        target.span,
        'not assignable',
      );
    }

    return this.fail('RT032', 'invalid assignment target', target.span, 'not assignable');
  }

  // ---------------------------------------------------------------- calling

  /** Invoke a Lumen closure or a native function. */
  async callValue(callee: Value, args: readonly EvaluatedArg[], span: Span): Promise<Value> {
    if (callee.k === 'native') return await this.callNative(callee, args, span);
    if (callee.k !== 'fn') {
      return this.fail(
        'RT033',
        'cannot call ' + typeName(callee),
        span,
        'not a function',
        callee.k === 'structType'
          ? ['build a struct with `' + callee.name + ' { field: value }`']
          : undefined,
      );
    }

    const label = callee.name === '' ? 'this anonymous function' : '`' + callee.name + '`';

    // Every call is a promise rather than a stack frame, so runaway recursion
    // would not overflow anything — it would allocate quietly until the
    // process died or the user gave up. A depth limit turns the commonest
    // beginner mistake back into a diagnostic that says what happened.
    if (this.depth >= MAX_CALL_DEPTH) {
      return this.fail(
        'RT045',
        'too many nested calls: ' + label + ' is ' + String(MAX_CALL_DEPTH) + ' deep',
        span,
        'call depth exceeded',
        [
          'this is usually recursion with no base case, or one that never reaches it',
          'a loop uses no call depth at all, if the work can be written as one',
        ],
      );
    }

    const bound = await this.bindParams(label, callee.params, args, span, callee.closure);
    const callEnv = new Env(callee.closure);
    for (const [name, value] of bound) callEnv.declare(name, value, false);

    this.units.push(callee.unit);
    this.depth += 1;
    try {
      return await this.execBlock(callee.body, callEnv, callee.unit);
    } catch (error) {
      if (error instanceof ReturnSignal) return error.value;
      // `?` returns the Err/None from this function.
      if (error instanceof TryPropagate) return error.value;
      throw error;
    } finally {
      this.depth -= 1;
      this.units.pop();
    }
  }

  private async callNative(
    callee: NativeValue,
    args: readonly EvaluatedArg[],
    span: Span,
  ): Promise<Value> {
    const ctx = this.makeCtx(span);
    if (callee.variadic === true) {
      const named = args.find((a) => a.name !== undefined);
      if (named !== undefined) {
        this.fail(
          'RT034',
          '`' + callee.name + '` does not take named arguments',
          named.span,
          'unexpected name',
        );
      }
      return await callee.call(args.map((a) => a.value), ctx);
    }
    const bound = await this.bindNativeParams(callee, args, span);
    return await callee.call(bound, ctx);
  }

  /** Build the call context handed to native functions. */
  makeCtx(span: Span): CallCtx {
    return {
      host: this.host,
      span,
      call: async (fn: Value, callArgs: readonly Value[]): Promise<Value> =>
        await this.callValue(
          fn,
          callArgs.map((value) => ({ name: undefined, value, span })),
          span,
        ),
      panic: (message: string, notes?: readonly string[]): never =>
        this.fail('RT035', message, span, undefined, notes),
    };
  }

  /**
   * Match arguments to parameters. Positional arguments fill in order, named
   * arguments fill by name, and defaults cover the rest.
   */
  private async bindParams(
    what: string,
    params: readonly Param[],
    args: readonly EvaluatedArg[],
    span: Span,
    defaultsEnv: Env,
  ): Promise<Map<string, Value>> {
    const { positional, named } = this.splitArgs(args);
    const paramNames = params.map((p) => p.name);
    this.rejectUnknownNamed(what, paramNames, named, span);
    const out = new Map<string, Value>();
    const filledByName: string[] = [];
    let next = 0;

    for (const param of params) {
      // `..parts` takes everything positional that is left, as a list. It is
      // always last, so this is the end of the loop either way.
      if (param.rest) {
        out.set(param.name, list(positional.slice(next).map((a) => a.value)));
        next = positional.length;
        continue;
      }
      const byName = named.get(param.name);
      if (byName !== undefined) {
        out.set(param.name, byName.value);
        named.delete(param.name);
        filledByName.push(param.name);
        continue;
      }
      const byPosition = positional[next];
      if (byPosition !== undefined) {
        next += 1;
        out.set(param.name, byPosition.value);
        continue;
      }
      if (param.defaultValue !== undefined) {
        out.set(param.name, await this.evaluate(param.defaultValue, defaultsEnv));
        continue;
      }
      this.fail(
        'RT036',
        what + ' is missing a value for `' + param.name + '`',
        span,
        'required argument not supplied',
        ['it takes: ' + params.map((p) => (p.rest ? '..' : '') + p.name).join(', ')],
      );
    }

    this.rejectLeftovers(what, paramNames, positional.slice(next), named, span, filledByName);
    return out;
  }

  private async bindNativeParams(
    callee: NativeValue,
    args: readonly EvaluatedArg[],
    span: Span,
  ): Promise<Value[]> {
    const { positional, named } = this.splitArgs(args);
    const paramNames = callee.params.map((p) => p.name);
    const byPositionOnly = callee.positional === true;
    this.rejectUnknownNamed('`' + callee.name + '`', paramNames, named, span, byPositionOnly);
    const out: Value[] = [];
    const filledByName: string[] = [];
    let next = 0;

    for (const param of callee.params) {
      const byName = named.get(param.name);
      if (byName !== undefined) {
        out.push(byName.value);
        named.delete(param.name);
        filledByName.push(param.name);
        continue;
      }
      const byPosition = positional[next];
      if (byPosition !== undefined) {
        next += 1;
        out.push(byPosition.value);
        continue;
      }
      if (param.defaultValue !== undefined) {
        out.push(param.defaultValue);
        continue;
      }
      this.fail(
        'RT036',
        byPositionOnly
          ? '`' + callee.name + '` is missing a value: it takes ' + String(paramNames.length)
          : '`' + callee.name + '` is missing a value for `' + param.name + '`',
        span,
        'required argument not supplied',
        [takesNote(paramNames, byPositionOnly)],
      );
    }

    this.rejectLeftovers(
      '`' + callee.name + '`',
      paramNames,
      positional.slice(next),
      named,
      span,
      filledByName,
      byPositionOnly,
    );
    return out;
  }

  /**
   * Report a named argument that matches no parameter. This runs *before*
   * missing-argument checks: given `greet(nmae: "Ada")` the useful message is
   * "no parameter named `nmae`, did you mean `name`?", not "missing `name`".
   */
  private rejectUnknownNamed(
    what: string,
    paramNames: readonly string[],
    named: ReadonlyMap<string, EvaluatedArg>,
    _span: Span,
    positional = false,
  ): void {
    for (const [name, arg] of named) {
      if (!positional && paramNames.includes(name)) continue;
      const hint = positional ? undefined : suggest(name, paramNames);
      this.fail(
        'RT039',
        positional
          ? what + ' takes its values by position, not by name'
          : what + ' has no parameter named `' + name + '`',
        arg.span,
        'unknown argument',
        hint === undefined ? [takesNote(paramNames, positional)] : ['did you mean `' + hint + '`?'],
      );
    }
  }

  private splitArgs(args: readonly EvaluatedArg[]): {
    positional: EvaluatedArg[];
    named: Map<string, EvaluatedArg>;
  } {
    const positional: EvaluatedArg[] = [];
    const named = new Map<string, EvaluatedArg>();
    let sawNamed = false;
    for (const arg of args) {
      if (arg.name === undefined) {
        if (sawNamed) {
          this.fail(
            'RT037',
            'positional arguments must come before named ones',
            arg.span,
            'this comes after a named argument',
          );
        }
        positional.push(arg);
        continue;
      }
      sawNamed = true;
      if (named.has(arg.name)) {
        this.fail('RT038', '`' + arg.name + '` is given twice', arg.span, 'duplicate argument');
      }
      named.set(arg.name, arg);
    }
    return { positional, named };
  }

  private rejectLeftovers(
    what: string,
    paramNames: readonly string[],
    extraPositional: readonly EvaluatedArg[],
    leftoverNamed: ReadonlyMap<string, EvaluatedArg>,
    span: Span,
    filledByName: readonly string[] = [],
    positional = false,
  ): void {
    const firstNamed = [...leftoverNamed.entries()][0];
    if (firstNamed !== undefined) {
      const [name, arg] = firstNamed;
      const hint = suggest(name, paramNames);
      this.fail(
        'RT039',
        what + ' has no parameter named `' + name + '`',
        arg.span,
        'unknown argument',
        hint === undefined ? [takesNote(paramNames, positional)] : ['did you mean `' + hint + '`?'],
      );
    }
    const extra = extraPositional[0];
    if (extra === undefined) return;

    // Surplus positional arguments plus a named one means a parameter was
    // filled twice. Saying which one is far more useful than a bare count.
    const clashing = filledByName[0];
    if (clashing !== undefined) {
      this.fail(
        'RT044',
        what + ' was given a value for `' + clashing + '` both positionally and by name',
        extra.span,
        'this value has nowhere to go',
        ['pass `' + clashing + '` either by position or by name, not both'],
      );
    }

    this.fail(
      'RT040',
      what + ' takes ' + paramNames.length +
        (positional ? ' value' : ' argument') + (paramNames.length === 1 ? '' : 's'),
      extra.span,
      'too many arguments',
      [takesNote(paramNames, positional)],
    );
  }

  // ---------------------------------------------------------------- modules

  private async loadModule(spec: string, from: SourceUnit, span: Span): Promise<ModuleValue> {
    if (this.resolver === undefined) {
      this.fail('RT041', 'imports are not available here', span, 'no module resolver');
    }
    const resolved = await this.resolver.resolve(spec, from.file);
    if (resolved === undefined) {
      this.fail(
        'RT042',
        'cannot find module "' + spec + '"',
        span,
        'not found',
        ['standard modules look like "std/list"; local files like "./helper.lm"'],
      );
    }

    const cached = this.moduleCache.get(resolved.key);
    if (cached !== undefined) return cached;

    if (resolved.exports !== undefined) {
      const moduleValue: ModuleValue = { k: 'module', name: spec, exports: resolved.exports };
      this.moduleCache.set(resolved.key, moduleValue);
      return moduleValue;
    }

    const file = resolved.file ?? spec;
    const source = resolved.source ?? '';
    if (this.loading.has(resolved.key)) {
      this.fail(
        'RT043',
        'import cycle involving "' + spec + '"',
        span,
        'already being loaded',
        ['modules cannot import each other in a loop'],
      );
    }
    this.loading.add(resolved.key);
    try {
      const parsed = parse(source, file);
      const unit: SourceUnit = { file, source };
      const moduleEnv = new Env(this.globals);
      this.units.push(unit);
      try {
        await this.hoist(parsed.stmts, moduleEnv, unit);
        for (const stmt of parsed.stmts) await this.execStmt(stmt, moduleEnv, unit);
      } finally {
        this.units.pop();
      }
      const exports = new Map<string, Value>();
      for (const stmt of parsed.stmts) {
        if (stmt.kind !== 'ExportDecl') continue;
        const name = stmt.declaration.name;
        const slot = moduleEnv.lookup(name);
        if (slot !== undefined) exports.set(name, slot.value);
      }
      const moduleValue: ModuleValue = { k: 'module', name: spec, exports };
      this.moduleCache.set(resolved.key, moduleValue);
      return moduleValue;
    } finally {
      this.loading.delete(resolved.key);
    }
  }
}

export interface EvaluatedArg {
  readonly name: string | undefined;
  readonly value: Value;
  readonly span: Span;
}

function compare(op: string, a: number | string, b: number | string): boolean {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    default:
      return a >= b;
  }
}

// --------------------------------------------------------------- builtins

/**
 * Turn `f(subject, ...rest)` into a method on `subject`.
 *
 * The first parameter is dropped from the signature, so arity checking, named
 * arguments and defaults all keep working on the parameters that remain:
 * `"a,b".split(",")` reports errors about `separator`, not about `s`.
 */
function bindReceiver(fn: NativeValue, receiver: Value): NativeValue {
  return {
    k: 'native',
    name: fn.name,
    params: fn.params.slice(1),
    ...(fn.doc === undefined ? {} : { doc: fn.doc }),
    ...(fn.variadic === true ? { variadic: true } : {}),
    call: (args, ctx) => fn.call([receiver, ...args], ctx),
  };
}

/** Define a native function with named parameters. */
export function native(
  name: string,
  params: readonly string[],
  call: (args: readonly Value[], ctx: CallCtx) => Value | Promise<Value>,
  doc?: string,
): NativeValue {
  return {
    k: 'native',
    name,
    params: params.map((p) => ({ name: p })),
    ...(doc === undefined ? {} : { doc }),
    call,
  };
}

/** Define a native function that accepts any number of positional arguments. */
export function variadic(
  name: string,
  call: (args: readonly Value[], ctx: CallCtx) => Value | Promise<Value>,
  doc?: string,
): NativeValue {
  return {
    k: 'native',
    name,
    params: [],
    variadic: true,
    ...(doc === undefined ? {} : { doc }),
    call,
  };
}

/**
 * The globals available with no import at all. Everything else lives in a
 * `std/*` module, so the prelude stays small and predictable.
 */
function installBuiltins(globals: Env): void {
  const define = (value: NativeValue): void => globals.declare(value.name, value, false);

  define(
    variadic(
      'print',
      (args, ctx) => {
        ctx.host.writeOut(args.map((a) => display(a)).join(' ') + '\n');
        return NIL;
      },
      'Write values to the output, separated by spaces, followed by a newline.',
    ),
  );

  define(
    native('len', ['value'], (args, ctx) => {
      const value = args[0] ?? NIL;
      switch (value.k) {
        case 'str':
          return num([...value.v].length);
        case 'list':
          return num(value.items.length);
        case 'map':
          return num(value.entries.size);
        default:
          return ctx.panic('len() needs a Str, List or Map, got ' + typeName(value));
      }
    }, 'How many characters, elements or entries a value has.'),
  );

  define(native('type', ['value'], (args) => str(typeName(args[0] ?? NIL)), "The value's type name, as a Str."));

  define(native('str', ['value'], (args) => str(display(args[0] ?? NIL)), 'The value rendered as a Str.'));

  define(
    native('num', ['value'], (args) => {
      const value = args[0] ?? NIL;
      if (value.k === 'num') return value;
      if (value.k === 'str') {
        const parsed = Number(value.v.trim());
        return value.v.trim() !== '' && !Number.isNaN(parsed) ? enumOk(num(parsed)) : enumErr(str('`' + value.v + '` is not a number'));
      }
      return enumErr(str('cannot convert ' + typeName(value) + ' to Num'));
    }, 'Parse a Str as a number. Ok(n), or Err if it is not one.'),
  );

  define(native('bool', ['value'], (args) => bool(truthy(args[0] ?? NIL)), 'The value as a Bool: everything except nil and false is true.'));

  define(
    native('assert', ['condition', 'message'], (args, ctx) => {
      const condition = args[0] ?? NIL;
      const message = args[1];
      if (truthy(condition)) return NIL;
      const text = message !== undefined && message.k === 'str' ? message.v : 'assertion failed';
      return ctx.panic(text);
    }, 'Stop with a message unless the condition is true. The whole of a test framework.'),
  );

  define(
    native('panic', ['message'], (args, ctx) => {
      const message = args[0] ?? NIL;
      return ctx.panic(message.k === 'str' ? message.v : display(message));
    }, 'Stop the program with a located error.'),
  );

  // Result and Option constructors, available without an import.
  define(native('Ok', ['value'], (args) => enumOk(args[0] ?? NIL), 'A Result that succeeded, carrying a value.'));
  define(native('Err', ['error'], (args) => enumErr(args[0] ?? NIL), 'A Result that failed, carrying an error.'));
  define(native('Some', ['value'], (args) => enumValue('Option', 'Some', [args[0] ?? NIL]), 'An Option that holds a value.'));
  globals.declare('None', NONE, false);

  // The enum types themselves, so `Result.Ok` and `match` on them read naturally.
  globals.declare(
    'Result',
    { k: 'enumType', name: 'Result', variants: new Map([['Ok', 1], ['Err', 1]]) },
    false,
  );
  globals.declare(
    'Option',
    { k: 'enumType', name: 'Option', variants: new Map([['Some', 1], ['None', 0]]) },
    false,
  );
}

const enumOk = (v: Value): EnumValue => enumValue('Result', 'Ok', [v]);
const enumErr = (v: Value): EnumValue => enumValue('Result', 'Err', [v]);

export type { ListValue, MapValue, StructValue, FnValue };
