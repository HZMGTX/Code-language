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
  type SourceUnit,
} from '@lumen-lang/core';
import { STD_MODULE_NAMES } from '@lumen-lang/stdlib';
import { renderNode } from './inspect.js';
import { VERSION, newInterpreter, useColor } from '../support.js';

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
      checkModule(module, source, { globals: scope.visibleNames() });
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
