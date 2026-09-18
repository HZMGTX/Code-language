/**
 * `lumen repl` — an interactive session.
 *
 * The REPL keeps one scope alive across inputs, and knows when a line is
 * unfinished: an unbalanced bracket, an unterminated string, or a trailing
 * operator all mean "keep reading", so multi-line definitions can be pasted or
 * typed without ceremony.
 */

import * as readline from 'node:readline';

import {
  Env,
  Interpreter,
  LumenError,
  checkModule,
  inspect,
  lex,
  parse,
  typeName,
  type Diagnostic,
  type ResolveOptions,
  type SourceUnit,
} from '@lumen-lang/core';
import { STD_MODULE_NAMES } from '@lumen-lang/stdlib';
import { renderNode } from './inspect.js';
import { VERSION, checkOptions, newInterpreter, reportWarnings, useColor } from '../support.js';

/** Operators that cannot legally end an input. */
const DANGLING: readonly string[] = [
  '|>', '+', '-', '*', '/', '%', '=', ',', '&&', '||', 'and', 'or',
  '.', '->', '=>', '==', '!=', '<', '<=', '>', '>=', ':', '..',
];

/** Codes meaning "the text was cut off", as opposed to "the text is wrong". */
const INCOMPLETE_CODES = new Set(['LX002', 'LX003', 'LX006']);

function needsMoreInput(buffer: string): boolean {
  let tokens;
  try {
    tokens = lex(buffer, '<repl>');
  } catch (error) {
    if (error instanceof LumenError) {
      return error.diagnostics.some((d) => INCOMPLETE_CODES.has(d.code));
    }
    return false;
  }

  let depth = 0;
  for (const token of tokens) {
    if (token.kind === '(' || token.kind === '[' || token.kind === '{') depth += 1;
    if (token.kind === ')' || token.kind === ']' || token.kind === '}') depth -= 1;
  }
  if (depth > 0) return true;

  const meaningful = tokens.filter((t) => t.kind !== 'newline' && t.kind !== 'eof');
  const last = meaningful[meaningful.length - 1];
  return last !== undefined && DANGLING.includes(last.kind);
}

const HELP = [
  'Commands',
  '  :help            show this message',
  '  :type <expr>     show the type of an expression',
  '  :ast <expr>      show how Lumen parsed an expression',
  '  :env             list the names bound in this session',
  '  :modules         list the standard modules',
  '  :clear           forget everything bound in this session',
  '  :quit            leave (Ctrl-D also works)',
  '',
  'Anything else is evaluated. Definitions persist across inputs.',
  'An unfinished line continues on the next one; a blank line abandons it.',
].join('\n');

/**
 * The warnings that mean something at a prompt.
 *
 * All of them but `RS011`. A binding made at the REPL is *for* the inputs that
 * come after it — that is what a session is — so "never read" is true of nearly
 * every one and means nothing about any of them. `RS011` already declines to
 * report anything a module exports, and a session's top level is the same idea
 * with no keyword for it.
 *
 * Everything else applies exactly as it does in a file: a statement that can
 * never run is still dead, and a call whose answer nobody takes still does
 * nothing.
 */
function sessionWarnings(warnings: readonly Diagnostic[]): readonly Diagnostic[] {
  return warnings.filter((warning) => warning.code !== 'RS011');
}

/**
 * What the static passes are told about a session, rather than about a file.
 *
 * A name the session has bound **shadows** the prelude's, so the prelude's
 * signature must stop applying to it — and it did not:
 *
 *     lumen> let fixed = 1
 *     lumen> fixed + 1
 *     error[TY005]: cannot add fn(Num, Num) -> Str and Num
 *
 * `fixed` is `std/math.fixed`, whose signature the checker seeds its root scope
 * with. The session's own `fixed` was passed across as a *name* and nothing
 * more, so it resolved but carried no type, and the prelude's won — rejecting a
 * line that works, which is the one thing these passes must never do.
 *
 * Dropping the signature leaves the binding `Any`, which is what the session
 * actually knows about it: the REPL carries no type from one input to the next,
 * and inventing one here would be guessing. Methods are left alone, because a
 * method comes from the receiver's type and never from scope — `"mine".len()`
 * is `Str.len` whatever a session has bound `len` to.
 */
function sessionOptions(scope: Env): ResolveOptions {
  const options = checkOptions(scope.visibleNames());
  const bound = scope.ownNames();
  if (bound.length === 0 || options.signatures === undefined) return options;

  const signatures = new Map(options.signatures);
  for (const name of bound) signatures.delete(name);
  return { ...options, signatures };
}

export async function startRepl(): Promise<void> {
  const color = useColor();
  let interpreter: Interpreter = newInterpreter();
  let scope = new Env(interpreter.globals);
  const unit: SourceUnit = { file: '<repl>', source: '' };

  process.stdout.write('Lumen ' + VERSION + ' — type :help for help, :quit to leave\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'lumen> ',
    historySize: 500,
  });

  let buffer = '';
  rl.on('SIGINT', () => {
    buffer = '';
    process.stdout.write('\n');
    rl.setPrompt('lumen> ');
    rl.prompt();
  });

  const evaluate = async (source: string): Promise<void> => {
    // Keep the unit's source in step so diagnostics render the right text.
    const currentUnit: SourceUnit = { file: '<repl>', source };
    try {
      const module = parse(source, '<repl>');
      // Everything bound in the session so far counts as already in scope.
      //
      // `checkModule` raises on an error and *returns* the warnings, so a
      // caller that drops the return value shows none of them. The REPL did,
      // which is the same bug the language server had: an unreachable statement
      // or a call whose answer nobody takes was reported by `lumen run` and
      // silently accepted here.
      reportWarnings(sessionWarnings(checkModule(module, source, sessionOptions(scope))), '<repl>', source);
      const value = await interpreter.runStatements(module.stmts, scope, currentUnit);
      if (value.k !== 'nil') process.stdout.write(inspect(value) + '\n');
    } catch (error) {
      if (error instanceof LumenError) {
        process.stdout.write(error.render(color) + '\n');
        return;
      }
      throw error;
    }
  };

  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();

    // A blank line abandons a half-written expression. Without this there is
    // no way out of a continuation but to finish it: typing `1 +` by mistake
    // left every later line, `:quit` included, being swallowed as more of it.
    if (buffer !== '' && trimmed === '') {
      buffer = '';
      process.stdout.write('(abandoned)\n');
      rl.setPrompt('lumen> ');
      rl.prompt();
      continue;
    }

    // Meta commands are only recognised at the start of a fresh input.
    if (buffer === '' && trimmed.startsWith(':')) {
      const [command, ...rest] = trimmed.slice(1).split(/\s+/);
      const argument = rest.join(' ');
      switch (command) {
        case 'help':
        case 'h':
          process.stdout.write(HELP + '\n');
          break;
        case 'quit':
        case 'q':
        case 'exit':
          rl.close();
          return;
        case 'clear':
          interpreter = newInterpreter();
          scope = new Env(interpreter.globals);
          process.stdout.write('session cleared\n');
          break;
        case 'env': {
          const own = scope.ownNames();
          process.stdout.write(
            own.length === 0 ? '(nothing bound yet)\n' : own.sort().join('\n') + '\n',
          );
          break;
        }
        case 'modules':
          process.stdout.write(STD_MODULE_NAMES.join('\n') + '\n');
          break;
        case 'type': {
          if (argument === '') {
            process.stdout.write('usage: :type <expression>\n');
            break;
          }
          try {
            const module = parse(argument, '<repl>');
            const value = await interpreter.runStatements(module.stmts, new Env(scope), {
              file: '<repl>',
              source: argument,
            });
            process.stdout.write(typeName(value) + '\n');
          } catch (error) {
            if (error instanceof LumenError) process.stdout.write(error.render(color) + '\n');
            else throw error;
          }
          break;
        }
        case 'ast': {
          if (argument === '') {
            process.stdout.write('usage: :ast <expression>\n');
            break;
          }
          try {
            const module = parse(argument, '<repl>');
            // The same renderer `lumen ast` uses, so the two never disagree.
            const lines: string[] = [];
            renderNode(module.stmts, 0, lines);
            process.stdout.write(lines.join('\n') + '\n');
          } catch (error) {
            if (error instanceof LumenError) process.stdout.write(error.render(color) + '\n');
            else throw error;
          }
          break;
        }
        default:
          process.stdout.write('unknown command `:' + String(command) + '` — try :help\n');
      }
      rl.prompt();
      continue;
    }

    buffer = buffer === '' ? line : buffer + '\n' + line;

    if (buffer.trim() === '') {
      buffer = '';
      rl.prompt();
      continue;
    }

    if (needsMoreInput(buffer)) {
      rl.setPrompt('  ...  ');
      rl.prompt();
      continue;
    }

    const source = buffer;
    buffer = '';
    rl.setPrompt('lumen> ');
    await evaluate(source);
    rl.prompt();
  }
}
