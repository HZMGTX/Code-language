/**
 * `std/time` — instants, as milliseconds since 1970.
 *
 * ## There is one kind of time value, and it is a number
 *
 * `now()` in `std/core` gives milliseconds since the Unix epoch, and every
 * function here takes or returns that same number. No `DateTime` type, no
 * wrapper struct: an instant is a `Num`, so `later - earlier` is the elapsed
 * milliseconds, `<` compares two instants, `sorted()` sorts a list of them, and
 * `max` finds the latest — all without this module being involved.
 *
 * ## Everything is UTC, and that is the whole point
 *
 * `iso`, `parts`, `date`, `time` and the rest are all UTC. Not a shortcut — a
 * decision, and the one that keeps two promises the project makes elsewhere:
 *
 *   - **No dependencies.** Real local time means time-zone names (`Europe/Oslo`),
 *     which means the IANA database, which is a few hundred kilobytes that
 *     changes several times a year as governments change their minds. Shipping
 *     it means shipping a dependency; not shipping it and pretending otherwise
 *     means being quietly wrong about historical dates.
 *   - **The same program prints the same thing.** A log line, a golden test
 *     file, a filename built from a date: if those followed the machine's
 *     zone, the same program would produce different output on two computers,
 *     and a test that passed in one office would fail in another.
 *
 * What is offered instead is `offsetMinutes`, which reports what this machine
 * believes its offset from UTC is *at a given instant* — so daylight saving is
 * accounted for, because the answer depends on the instant rather than being a
 * constant. Add it to shift an instant into local time for display, knowing
 * exactly where the assumption entered:
 *
 *     let local = t + offsetMinutes(t) * 60000
 *     print("filed at ${time(local)} local")
 *
 * ## Formatting
 *
 * `format` takes the pieces it is given rather than a pattern language:
 * `YYYY`, `MM`, `DD`, `hh`, `mm`, `ss` and `SSS` are replaced, and every other
 * character is left exactly as it is. That covers the formats people actually
 * write — `"YYYY-MM-DD"`, `"DD/MM/YYYY hh:mm"`, `"YYYY-MM-DD_hh-mm-ss"` — and
 * it has no escaping rules to learn or to get wrong.
 */

import { bool, list, map, num, str, truthy, type Value } from '@lumen-lang/core';
import { Err, Ok, arg, expectInt, expectNum, expectStr, fn, moduleOf, withDocs } from './support.js';

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;

/**
 * The largest instant a `Date` can hold, either side of the epoch.
 *
 * Past it every accessor answers `NaN`, and a `NaN` year silently poisons
 * whatever it is interpolated into. Saying so is better than printing
 * `NaN-NaN-NaN`.
 */
const LIMIT = 8640000000000000;

/**
 * Days in 400 Gregorian years: 400 × 365 plus 97 leap days.
 *
 * The calendar repeats exactly over that span, which is what makes shifting a
 * year by 400 and subtracting the days back an identity rather than an
 * approximation.
 */
const GREGORIAN_CYCLE_DAYS = 146097;

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** An instant argument, checked so no `NaN` can escape into a formatted string. */
function instant(value: Value, ctx: { panic: (m: string, notes?: readonly string[]) => never }, what: string): Date {
  if (value.k !== 'num') {
    return ctx.panic(what + ' must be a Num of milliseconds since 1970, got ' + value.k);
  }
  if (!Number.isFinite(value.v) || Math.abs(value.v) > LIMIT) {
    return ctx.panic(what + ' is not a time that can be represented: ' + String(value.v), [
      'instants run from -' + String(LIMIT) + ' to ' + String(LIMIT) + ' milliseconds',
      'that is about 273,000 years either side of 1970',
    ]);
  }
  return new Date(value.v);
}

const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');

/** The year, padded to four digits, with a sign for the years before 0. */
function year(d: Date): string {
  const y = d.getUTCFullYear();
  return (y < 0 ? '-' : '') + pad(y, 4);
}

function isoOf(d: Date): string {
  return (
    year(d) + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
    'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) +
    '.' + pad(d.getUTCMilliseconds(), 3) + 'Z'
  );
}

export function stdTime(): Map<string, Value> {
  return withDocs(
    moduleOf(
      /** `2026-09-13T12:34:56.789Z` — the one format every other system reads. */
      fn('iso', ['instant'], (a, c) => str(isoOf(instant(arg(a, 0), c, 'iso(instant)')))),

      /** `2026-09-13`. */
      fn('date', ['instant'], (a, c) => {
        const d = instant(arg(a, 0), c, 'date(instant)');
        return str(year(d) + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()));
      }),

      /** `12:34:56`. Pass `seconds: false` for `12:34`. */
      fn('time', ['instant', { name: 'seconds', defaultValue: bool(true) }], (a, c) => {
        const d = instant(arg(a, 0), c, 'time(instant)');
        const hm = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
        return str(truthy(arg(a, 1)) ? hm + ':' + pad(d.getUTCSeconds()) : hm);
      }),

      /**
       * Every piece of an instant, as a Map.
       *
       * `month` is 1-12 and `weekday` is 0-6 from Sunday. The first because a
       * month numbered from zero is a bug waiting to be written, the second
       * because it indexes `weekdayNames()`.
       */
      fn('parts', ['instant'], (a, c) => {
        const d = instant(arg(a, 0), c, 'parts(instant)');
        const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1);
        return map(
          new Map<string, Value>([
            ['year', num(d.getUTCFullYear())],
            ['month', num(d.getUTCMonth() + 1)],
            ['day', num(d.getUTCDate())],
            ['hour', num(d.getUTCHours())],
            ['minute', num(d.getUTCMinutes())],
            ['second', num(d.getUTCSeconds())],
            ['millisecond', num(d.getUTCMilliseconds())],
            ['weekday', num(d.getUTCDay())],
            ['dayOfYear', num(Math.floor((d.getTime() - startOfYear) / DAY) + 1)],
          ]),
        );
      }),

      /**
       * An instant from its pieces, all UTC. `month` is 1-12.
       *
       * Out-of-range pieces roll over rather than failing, which is what makes
       * arithmetic on dates work: month 13 is January of the next year, and day
       * 0 is the last day of the month before — the usual way to ask for it.
       */
      fn(
        'fromParts',
        [
          'year',
          { name: 'month', defaultValue: num(1) },
          { name: 'day', defaultValue: num(1) },
          { name: 'hour', defaultValue: num(0) },
          { name: 'minute', defaultValue: num(0) },
          { name: 'second', defaultValue: num(0) },
          { name: 'millisecond', defaultValue: num(0) },
        ],
        (a, c) => {
          const y = expectInt(arg(a, 0), c, 'fromParts(year)');
          const rest = [
            expectInt(arg(a, 1), c, 'fromParts(month)') - 1,
            expectInt(arg(a, 2), c, 'fromParts(day)'),
            expectInt(arg(a, 3), c, 'fromParts(hour)'),
            expectInt(arg(a, 4), c, 'fromParts(minute)'),
            expectInt(arg(a, 5), c, 'fromParts(second)'),
            expectInt(arg(a, 6), c, 'fromParts(millisecond)'),
          ] as const;

          // Years 0 to 99 have to go the long way round. The host's `Date.UTC`
          // still carries a rule written for two-digit years in the nineties: it
          // reads a year in that range as 1900 + it, so `fromParts(50)` answered
          // 1950 and `fromParts(0)` answered 1900. Computing four hundred years
          // later and subtracting them back is exact, because the Gregorian
          // calendar repeats every 400 years to the day — and it keeps working
          // when the month or day rolls over into the next year, which patching
          // the year afterwards would not.
          const shift = y >= 0 && y <= 99 ? 400 : 0;
          const at = Date.UTC(y + shift, ...rest) - shift * (GREGORIAN_CYCLE_DAYS / 400) * DAY;
          if (!Number.isFinite(at) || Math.abs(at) > LIMIT) {
            return c.panic('those pieces do not make a time that can be represented');
          }
          return num(at);
        },
      ),

      /**
       * Read a time back from text. `Ok(instant)` or `Err(why)`.
       *
       * Accepts what `iso` writes, and the shorter ISO 8601 forms alongside it —
       * a bare `2026-09-13`, a `T` or a space between date and time, an offset
       * or none. Text with no zone is read as UTC, which is the only
       * self-consistent choice for a module whose every other function is UTC:
       * guessing the machine's zone would make the same input parse to different
       * instants on different computers.
       */
      fn('parseIso', ['text'], (a, c) => {
        const text = expectStr(arg(a, 0), c, 'parseIso(text)').trim();
        if (text === '') return Err(str('cannot read a time from an empty string'));
        // Node parses a bare date as UTC and a date-and-time without a zone as
        // local, which is a split nobody wants. Adding the `Z` ourselves makes
        // both UTC, as documented.
        const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
        const spaced = text.includes(' ') && !text.includes('T') ? text.replace(' ', 'T') : text;
        const hasTime = spaced.includes('T');
        const at = Date.parse(hasTime && !zoned ? spaced + 'Z' : spaced);
        if (Number.isNaN(at)) {
          return Err(
            str(
              'cannot read a time from "' + text + '": expected something like ' +
                '"2026-09-13" or "2026-09-13T12:34:56Z"',
            ),
          );
        }
        return Ok(num(at));
      }),

      /**
       * An instant shifted by any number of each unit. Negative values go back.
       *
       * Days, hours, minutes and seconds only: months and years are not fixed
       * lengths, so "one month later" has no single answer — `fromParts` with
       * `month + 1` says which one you meant, and rolls over for you.
       */
      fn(
        'plus',
        [
          'instant',
          { name: 'days', defaultValue: num(0) },
          { name: 'hours', defaultValue: num(0) },
          { name: 'minutes', defaultValue: num(0) },
          { name: 'seconds', defaultValue: num(0) },
          { name: 'milliseconds', defaultValue: num(0) },
        ],
        (a, c) => {
          const at = instant(arg(a, 0), c, 'plus(instant)').getTime();
          const shifted =
            at +
            expectNum(arg(a, 1), c, 'plus days') * DAY +
            expectNum(arg(a, 2), c, 'plus hours') * HOUR +
            expectNum(arg(a, 3), c, 'plus minutes') * MINUTE +
            expectNum(arg(a, 4), c, 'plus seconds') * 1000 +
            expectNum(arg(a, 5), c, 'plus milliseconds');
          if (!Number.isFinite(shifted) || Math.abs(shifted) > LIMIT) {
            return c.panic('that shift lands outside the times that can be represented');
          }
          return num(shifted);
        },
      ),

      /** Midnight UTC at the start of the instant's day. */
      fn('startOfDay', ['instant'], (a, c) => {
        const d = instant(arg(a, 0), c, 'startOfDay(instant)');
        return num(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      }),

      /** The name of the instant's day: `"Sunday"` … `"Saturday"`. */
      fn('weekdayName', ['instant'], (a, c) => {
        const d = instant(arg(a, 0), c, 'weekdayName(instant)');
        return str(WEEKDAYS[d.getUTCDay()] ?? 'Sunday');
      }),

      /** The name of the instant's month: `"January"` … `"December"`. */
      fn('monthName', ['instant'], (a, c) => {
        const d = instant(arg(a, 0), c, 'monthName(instant)');
        return str(MONTHS[d.getUTCMonth()] ?? 'January');
      }),

      /** All seven day names, Sunday first, so `parts(t).weekday` indexes it. */
      fn('weekdayNames', [], () => list(WEEKDAYS.map((name) => str(name)))),

      /** All twelve month names, January first. */
      fn('monthNames', [], () => list(MONTHS.map((name) => str(name)))),

      /**
       * An instant as text, replacing the pieces named in a template.
       *
       * `YYYY MM DD hh mm ss SSS` are replaced; every other character is kept
       * exactly. There is nothing to escape, which is the trade: a template
       * cannot contain a literal `MM`, and in exchange there are no rules to
       * remember. `date`, `time` and `iso` cover the common cases already.
       */
      fn('format', ['instant', { name: 'template', defaultValue: str('YYYY-MM-DD hh:mm:ss') }], (a, c) => {
        const d = instant(arg(a, 0), c, 'format(instant)');
        const template = expectStr(arg(a, 1), c, 'format(template)');
        const pieces: readonly [string, string][] = [
          ['YYYY', year(d)],
          ['SSS', pad(d.getUTCMilliseconds(), 3)],
          ['MM', pad(d.getUTCMonth() + 1)],
          ['DD', pad(d.getUTCDate())],
          ['hh', pad(d.getUTCHours())],
          ['mm', pad(d.getUTCMinutes())],
          ['ss', pad(d.getUTCSeconds())],
        ];
        // One left-to-right pass, so a replacement cannot be re-read as a
        // placeholder: without it, a template ending `SSS` would have its
        // milliseconds' digits rescanned and `MM` could match inside them.
        let out = '';
        let i = 0;
        outer: while (i < template.length) {
          for (const [token, value] of pieces) {
            if (template.startsWith(token, i)) {
              out += value;
              i += token.length;
              continue outer;
            }
          }
          out += template[i] ?? '';
          i += 1;
        }
        return str(out);
      }),

      /**
       * A length of time in milliseconds, written for a person: `"2h 3m"`.
       *
       * The two largest units that apply, because that is how people say it —
       * "two hours and three minutes", not "two hours, three minutes and eleven
       * seconds". `0` is `"0s"` rather than an empty string.
       */
      fn('describe', ['milliseconds'], (a, c) => {
        const total = expectNum(arg(a, 0), c, 'describe(milliseconds)');
        if (!Number.isFinite(total)) return c.panic('describe needs a finite number of milliseconds');
        const sign = total < 0 ? '-' : '';
        let left = Math.floor(Math.abs(total));
        const units: readonly [number, string][] = [
          [DAY, 'd'],
          [HOUR, 'h'],
          [MINUTE, 'm'],
          [1000, 's'],
          [1, 'ms'],
        ];
        const said: string[] = [];
        for (const [size, suffix] of units) {
          if (said.length === 2) break;
          const n = Math.floor(left / size);
          if (n === 0 && said.length === 0) continue;
          if (n === 0) break;
          said.push(String(n) + suffix);
          left -= n * size;
        }
        return str(sign + (said.length === 0 ? '0s' : said.join(' ')));
      }),

      /**
       * What this machine thinks its offset from UTC is, in minutes, at that
       * instant. East of Greenwich is positive.
       *
       * The one place the local zone enters, and it takes an instant rather than
       * being a constant so that daylight saving is accounted for. Everything
       * else in this module is UTC; add this to shift an instant for display,
       * and the assumption is visible at the point it is made:
       *
       *     let local = t + offsetMinutes(t) * 60000
       *
       * Note that `parts(local)` then describes local wall-clock time, while the
       * number itself is no longer a real instant — do it for display only.
       */
      fn('offsetMinutes', ['instant'], (a, c) => {
        const d = instant(arg(a, 0), c, 'offsetMinutes(instant)');
        // `getTimezoneOffset` is minutes to *add to local to get UTC*, which is
        // the opposite sign from how offsets are written (`+02:00`).
        return num(-d.getTimezoneOffset());
      }),
    ),
    {
      iso: 'The full ISO 8601 form in UTC: 2026-09-13T12:34:56.789Z.',
      date: 'Just the date, in UTC: 2026-09-13.',
      time: 'Just the time, in UTC. Pass seconds: false to drop them.',
      parts: 'Every piece as a Map: year, month (1-12), day, hour, minute, second, millisecond, weekday (0-6), dayOfYear.',
      fromParts: 'An instant from its pieces, all UTC. Out-of-range pieces roll over.',
      parseIso: 'Read a time from ISO 8601 text. Ok(instant), or Err(why). No zone means UTC.',
      plus: 'An instant shifted by days, hours, minutes, seconds or milliseconds.',
      startOfDay: 'Midnight UTC at the start of that day.',
      weekdayName: 'The name of that day of the week.',
      monthName: 'The name of that month.',
      weekdayNames: 'All seven day names, Sunday first.',
      monthNames: 'All twelve month names, January first.',
      format: 'An instant as text, replacing YYYY MM DD hh mm ss SSS in a template.',
      describe: 'A length of time written for a person: "2h 3m".',
      offsetMinutes: 'This machine’s offset from UTC in minutes at that instant.',
    },
  );
}
