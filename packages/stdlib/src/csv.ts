/**
 * `std/csv` — comma-separated values, as they actually arrive.
 *
 * CSV looks like `text.split("\n").map(fn(l) { l.split(",") })` and is not.
 * That version is wrong for any file containing a comma inside a field, a quote
 * inside a field, or a newline inside a field — which is to say, for any file
 * exported from a spreadsheet by anybody describing anything. This module is
 * here so that nobody writes that line again.
 *
 * What it handles, all of it from RFC 4180 and from what real files do anyway:
 *
 *   - a field quoted with `"`, which may contain the delimiter, a line break,
 *     or a `""` standing for one literal quote;
 *   - `\r\n` and `\n` line endings, mixed in one file, with a `\r\n` inside a
 *     quoted field kept as data;
 *   - a trailing newline, or none;
 *   - a delimiter that is not a comma, because half of Europe writes `;`.
 *
 * **A ragged row is an error, not a guess.** A row with more or fewer fields
 * than the header is where silent data corruption comes from: pad it and every
 * later column is wrong by one, drop the extras and the data is gone. `records`
 * says which row and stops; `rows` hands back the grid for a caller who knows
 * what their file is doing.
 *
 * A blank line is not a ragged row. `records` skips it — it is no data rather
 * than misaligned data — while `rows` keeps it, because `rows` is the grid with
 * no judgement applied at all.
 */

import { list, map, str, type Value } from '@lumen-lang/core';
import {
  Err,
  Ok,
  arg,
  expectList,
  expectStr,
  fn,
  moduleOf,
  withDocs,
  withSignatures,
} from './support.js';

/**
 * Split CSV text into a grid, or say where it goes wrong.
 *
 * One pass, character by character, with two states: inside a quoted field and
 * outside one. Everything awkward about the format is one of those two states
 * meeting a `"`, a delimiter or a line break, which is why it is written as a
 * loop rather than as a regular expression — the expression that does this
 * correctly is longer than the loop and nobody can read it.
 */
function parseRows(text: string, delimiter: string): string[][] | string {
  if (delimiter.length !== 1) return 'the delimiter must be one character, got `' + delimiter + '`';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false; // whether anything at all has been seen on this row
  let line = 1;

  const endField = (): void => {
    row.push(field);
    field = '';
    started = true;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;

    if (quoted) {
      if (c === '"') {
        // `""` inside a quoted field is one literal quote; a lone `"` ends it.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
        continue;
      }
      if (c === '\n') line += 1;
      field += c;
      continue;
    }

    if (c === '"' && field === '') {
      quoted = true;
      started = true;
      continue;
    }
    if (c === delimiter) {
      endField();
      continue;
    }
    if (c === '\r') {
      // A bare `\r` is a line ending too — old Mac files exist — so the `\n`
      // of a `\r\n` is consumed here rather than ending a second empty row.
      if (text[i + 1] === '\n') i += 1;
      line += 1;
      endRow();
      continue;
    }
    if (c === '\n') {
      line += 1;
      endRow();
      continue;
    }
    field += c;
    started = true;
  }

  if (quoted) return 'unterminated quoted field starting on line ' + String(line);
  // A file usually ends with a line break, and that must not add an empty row.
  // One that does not must still yield its last row, which is what `started`
  // and a non-empty field distinguish.
  if (started || field !== '' || row.length > 0) endRow();
  return rows;
}

/** One field as it must be written: quoted only when it has to be. */
function writeField(value: string, delimiter: string): string {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r');
  if (!needsQuotes) return value;
  return '"' + value.replace(/"/g, '""') + '"';
}

const SIGNATURES: Readonly<Record<string, string>> = {
  rows: '(text: Str, delimiter: Str = ",") -> Result',
  records: '(text: Str, delimiter: Str = ",") -> Result',
  write: '(rows: List, delimiter: Str = ",") -> Result',
  writeRecords: '(records: List, columns: List<Str> = [], delimiter: Str = ",") -> Result',
};

export function stdCsv(): Map<string, Value> {
  return withSignatures(
    withDocs(
      moduleOf(
        /**
         * The raw grid: a list of rows, each a list of fields.
         *
         * No header, no judgement about shape. This is what a caller wants when
         * the file is messy, or when the first row is data.
         */
        fn('rows', ['text', { name: 'delimiter', defaultValue: str(',') }], (a, c) => {
          const parsed = parseRows(
            expectStr(arg(a, 0), c, 'rows(text)'),
            expectStr(arg(a, 1), c, 'rows(delimiter)'),
          );
          if (typeof parsed === 'string') return Err(str(parsed));
          return Ok(list(parsed.map((row) => list(row.map((field) => str(field))))));
        }),

        /**
         * The first row as column names, and every later row as a Map.
         *
         * A ragged row is an `Err` naming the row, because there is no safe
         * guess: padding it makes every later column wrong by one, and dropping
         * the extras throws data away. A caller who knows better can use `rows`.
         *
         * A completely blank line is the one exception, and is skipped: it is
         * no data rather than misaligned data, real files are full of them, and
         * it cannot be mistaken for anything else.
         *
         * A duplicate column name is an `Err` too — one of the two would
         * silently win, and which one is not something a reader could predict.
         */
        fn('records', ['text', { name: 'delimiter', defaultValue: str(',') }], (a, c) => {
          const parsed = parseRows(
            expectStr(arg(a, 0), c, 'records(text)'),
            expectStr(arg(a, 1), c, 'records(delimiter)'),
          );
          if (typeof parsed === 'string') return Err(str(parsed));
          const header = parsed[0];
          if (header === undefined) return Ok(list([]));

          const seen = new Set<string>();
          for (const name of header) {
            if (seen.has(name)) return Err(str('the column `' + name + '` appears twice'));
            seen.add(name);
          }

          const out: Value[] = [];
          for (const [i, row] of parsed.slice(1).entries()) {
            // A completely empty line is no data, not misaligned data. Real
            // files have them — a trailing one, a blank between sections — and
            // rejecting them as ragged rows is a rule that is right on paper
            // and wrong on every file anybody actually has. It cannot be
            // confused with data: a genuine one-field row in a four-column file
            // is still short, and still reported.
            if (row.length === 1 && row[0] === '') continue;
            if (row.length !== header.length) {
              const fields = (n: number): string => String(n) + (n === 1 ? ' field' : ' fields');
              return Err(
                str(
                  'row ' + String(i + 2) + ' has ' + fields(row.length) +
                    ' but the header has ' + fields(header.length),
                ),
              );
            }
            const entries = new Map<string, Value>();
            for (const [j, name] of header.entries()) entries.set(name, str(row[j] ?? ''));
            out.push(map(entries));
          }
          return Ok(list(out));
        }),

        /**
         * A grid as CSV text, quoting only the fields that need it.
         *
         * `\n` between rows and a trailing one, which is what every tool reads
         * and what a file ends with.
         */
        fn('write', ['rows', { name: 'delimiter', defaultValue: str(',') }], (a, c) => {
          const given = expectList(arg(a, 0), c, 'write(rows)');
          const delimiter = expectStr(arg(a, 1), c, 'write(delimiter)');
          if (delimiter.length !== 1) {
            return Err(str('the delimiter must be one character, got `' + delimiter + '`'));
          }
          const lines: string[] = [];
          for (const [i, row] of given.items.entries()) {
            const fields = expectList(row, c, 'write row ' + String(i + 1));
            lines.push(
              fields.items
                .map((field, j) =>
                  writeField(
                    expectStr(field, c, 'write row ' + String(i + 1) + ' field ' + String(j + 1)),
                    delimiter,
                  ),
                )
                .join(delimiter),
            );
          }
          return Ok(str(lines.length === 0 ? '' : lines.join('\n') + '\n'));
        }),

        /**
         * Maps as CSV, with a header row.
         *
         * The columns come from the first record when none are given, in the
         * order that record holds them — a Lumen Map keeps its insertion order,
         * so the output is the shape the program built rather than an
         * alphabetical surprise. Naming the columns explicitly is how to pick a
         * different order, or a subset.
         *
         * A record missing a column gets an empty field, which is the one place
         * here a guess is safe: an absent value and an empty one mean the same
         * thing in a format that has no nulls.
         */
        fn(
          'writeRecords',
          [
            'records',
            { name: 'columns', defaultValue: list([]) },
            { name: 'delimiter', defaultValue: str(',') },
          ],
          (a, c) => {
            const given = expectList(arg(a, 0), c, 'writeRecords(records)');
            const wanted = expectList(arg(a, 1), c, 'writeRecords(columns)');
            const delimiter = expectStr(arg(a, 2), c, 'writeRecords(delimiter)');
            if (delimiter.length !== 1) {
              return Err(str('the delimiter must be one character, got `' + delimiter + '`'));
            }

            let columns = wanted.items.map((name, i) =>
              expectStr(name, c, 'writeRecords column ' + String(i + 1)),
            );
            if (columns.length === 0) {
              const first = given.items[0];
              if (first === undefined) return Ok(str(''));
              if (first.k !== 'map') {
                return Err(str('writeRecords needs a list of Maps, got ' + first.k));
              }
              columns = [...first.entries.keys()];
            }

            const lines = [columns.map((name) => writeField(name, delimiter)).join(delimiter)];
            for (const [i, record] of given.items.entries()) {
              if (record.k !== 'map') {
                return Err(str('record ' + String(i + 1) + ' is not a Map'));
              }
              lines.push(
                columns
                  .map((name) => {
                    const held = record.entries.get(name);
                    return writeField(held === undefined ? '' : display(held), delimiter);
                  })
                  .join(delimiter),
              );
            }
            return Ok(str(lines.join('\n') + '\n'));
          },
        ),
      ),
      {
        rows: 'The raw grid: a list of rows, each a list of fields. No header.',
        records: 'The first row as column names, every later row as a Map.',
        write: 'A grid as CSV text, quoting only the fields that need it.',
        writeRecords: 'Maps as CSV with a header row. Columns from the first record, or named.',
      },
    ),
    SIGNATURES,
  );
}

/**
 * A value as the text CSV should carry.
 *
 * CSV has one type, and it is text. A Num written as `1` and read back as `"1"`
 * is the format being honest about itself rather than this module pretending
 * otherwise — see `docs/stdlib.md`.
 */
function display(value: Value): string {
  switch (value.k) {
    case 'str':
      return value.v;
    case 'num':
      return String(value.v);
    case 'bool':
      return value.v ? 'true' : 'false';
    case 'nil':
      return '';
    default:
      return '';
  }
}
