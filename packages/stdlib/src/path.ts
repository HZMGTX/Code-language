/**
 * `std/path` — file paths as text.
 *
 * Pure string work, with no filesystem behind it: `exists` lives in `std/fs`
 * because it asks the machine a question, and everything here answers from the
 * path alone. That separation is why this module can be used to plan work
 * before doing any of it, and why it is deterministic enough to have goldens.
 *
 * **One separator.** A path is written with `/` and read with either, so a
 * Windows path pasted into a program works and a path this module produces
 * looks the same everywhere. Node's `path` module changes behaviour with the
 * platform, which would make the same Lumen program print different things on
 * different machines — the same reason `std/time` has only UTC.
 *
 * A Windows drive letter (`C:`) and a UNC root (`//server/share`) are
 * understood and preserved, because losing one silently turns an absolute path
 * into a relative one, and a program that then writes a file writes it in the
 * wrong place.
 */

import { bool, list, str, type Value } from '@lumen-lang/core';
import { arg, expectStr, fn, moduleOf, withDocs, withSignatures } from './support.js';

/** `C:` or `//server/share`, and how much of the path it took. */
interface Root {
  readonly prefix: string;
  readonly rest: string;
  readonly absolute: boolean;
}

function rootOf(raw: string): Root {
  const text = raw.replace(/\\/g, '/');
  // `//server/share/...` — the first two segments are the root together.
  const unc = /^\/\/([^/]+)\/([^/]+)(\/.*)?$/.exec(text);
  if (unc !== null) {
    return { prefix: '//' + unc[1] + '/' + unc[2], rest: unc[3] ?? '', absolute: true };
  }
  const drive = /^([A-Za-z]:)(.*)$/.exec(text);
  if (drive !== null) {
    const rest = drive[2] ?? '';
    // `C:/x` is absolute; `C:x` is relative to the drive's own directory, and
    // treating the two alike is how a program ends up writing to the root.
    return { prefix: drive[1] ?? '', rest, absolute: rest.startsWith('/') };
  }
  if (text.startsWith('/')) return { prefix: '', rest: text, absolute: true };
  return { prefix: '', rest: text, absolute: false };
}

/**
 * A path with `.`, empty segments and resolvable `..` removed.
 *
 * A leading `..` on a relative path is kept — it means something, and dropping
 * it would turn `../sibling` into `sibling`. On an absolute path it is dropped,
 * because `/..` is `/` on every system there is.
 */
function normalise(raw: string): string {
  const { prefix, rest, absolute } = rootOf(raw);
  const out: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const last = out[out.length - 1];
      if (last !== undefined && last !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const body = out.join('/');
  if (absolute) return prefix + '/' + body;
  if (prefix !== '') return prefix + body;
  // The empty path is `.`, not the empty string: a program that joins it onto
  // something else must not produce an absolute path by accident.
  return body === '' ? '.' : body;
}

/** Everything up to the last separator, or `.` when there is none. */
function dirOf(raw: string): string {
  const normalised = normalise(raw);
  const { prefix, rest, absolute } = rootOf(normalised);
  const at = rest.lastIndexOf('/');
  if (at === -1) return prefix === '' ? '.' : prefix;
  if (at === 0) return absolute ? prefix + '/' : prefix;
  return prefix + rest.slice(0, at);
}

/** The part after the last separator. */
function baseOf(raw: string): string {
  const { rest } = rootOf(normalise(raw));
  const at = rest.lastIndexOf('/');
  return at === -1 ? rest : rest.slice(at + 1);
}

/**
 * The extension of a name, including its dot, or `""`.
 *
 * A leading dot is part of the name rather than an extension: `.gitignore` is a
 * file called `.gitignore`, not an empty name with a `.gitignore` extension.
 * `archive.tar.gz` has the extension `.gz`, which is what every tool means by
 * "the extension" even when it is not what a person means by it.
 */
function extOf(raw: string): string {
  const base = baseOf(raw);
  // `.` and `..` are directory references, not files whose name is empty and
  // whose extension is a dot. Without this, `ext("..")` was `"."` and
  // `stem("..")` was `"."` — a path walking upwards would lose half of itself
  // to a function that was only supposed to look at it.
  if (/^\.+$/.test(base)) return '';
  const at = base.lastIndexOf('.');
  return at <= 0 ? '' : base.slice(at);
}

/** A path as its root and its segments, for comparing one against another. */
function partsOf(raw: string): { root: string; absolute: boolean; segments: string[] } {
  const { prefix, rest, absolute } = rootOf(normalise(raw));
  // `.` is dropped as well as the empties. `normalise` already removes every
  // interior `.`, so the only one that can survive is a path that is *entirely*
  // `.` — which is here, and is zero segments rather than one named `.`.
  return {
    root: prefix,
    absolute,
    segments: rest.split('/').filter((segment) => segment !== '' && segment !== '.'),
  };
}

/**
 * No entry for `join`: it is variadic, and a variadic declares no signature —
 * a fixed parameter list cannot describe "any number of parts", and the
 * checker's argument-count rule would then be wrong about it in the one
 * direction that rejects working programs. See `withSignatures`.
 */
const SIGNATURES: Readonly<Record<string, string>> = {
  normalize: '(path: Str) -> Str',
  dir: '(path: Str) -> Str',
  base: '(path: Str) -> Str',
  stem: '(path: Str) -> Str',
  ext: '(path: Str) -> Str',
  withExt: '(path: Str, extension: Str) -> Str',
  split: '(path: Str) -> List<Str>',
  isAbsolute: '(path: Str) -> Bool',
  relative: '(base: Str, target: Str) -> Str',
  resolve: '(base: Str, path: Str) -> Str',
  isInside: '(parent: Str, child: Str) -> Bool',
};

export function stdPath(): Map<string, Value> {
  return withSignatures(
    withDocs(
      moduleOf(
        /**
         * Every part joined with one separator, then normalised.
         *
         * Variadic, because the alternative is `a.join("/").join("/")` and a
         * careful reading of whether each part already ends in one.
         *
         * A single list works too, the same way `min` takes either — and here
         * it is not a convenience but the inverse of `split`. `split` answers
         * with a list, so without this there is no way to put a path back
         * together: `join(split(p))` was a run-time error, and the language has
         * no spread at a call site to work around it with.
         */
        {
          k: 'native',
          name: 'join',
          params: [],
          variadic: true,
          call: (args: readonly Value[], ctx) => {
            const only = args[0];
            const given = args.length === 1 && only?.k === 'list' ? only.items : args;
            const parts = given.map((part, i) => expectStr(part, ctx, 'join part ' + (i + 1)));
            // A part that is absolute starts again, the way every other path
            // library works: `join("/tmp", "/etc")` is `/etc`. Surprising in
            // isolation, unsurprising the moment a variable holds a path the
            // caller did not write.
            let out = '';
            for (const part of parts) {
              if (part === '') continue;
              if (out === '' || rootOf(part).absolute || rootOf(part).prefix !== '') out = part;
              // Not `out + '/' + part`: when `out` is already a root that ends
              // in one, that doubles it — and `//abs/x` is not `/abs/x`, it is
              // the UNC share `x` on the server `abs`. So `join("/", "abs",
              // "x.txt")` answered `//abs/x.txt/`, which is exactly what
              // `join(split(p))` hits for any absolute path.
              else out = out + (out.endsWith('/') ? '' : '/') + part;
            }
            return str(normalise(out));
          },
        },

        fn('normalize', ['path'], (a, c) => str(normalise(expectStr(arg(a, 0), c, 'normalize(path)')))),
        fn('dir', ['path'], (a, c) => str(dirOf(expectStr(arg(a, 0), c, 'dir(path)')))),
        fn('base', ['path'], (a, c) => str(baseOf(expectStr(arg(a, 0), c, 'base(path)')))),
        fn('ext', ['path'], (a, c) => str(extOf(expectStr(arg(a, 0), c, 'ext(path)')))),

        /** The file name with its extension taken off. */
        fn('stem', ['path'], (a, c) => {
          const base = baseOf(expectStr(arg(a, 0), c, 'stem(path)'));
          const extension = extOf(base);
          return str(extension === '' ? base : base.slice(0, base.length - extension.length));
        }),

        /**
         * The same path with a different extension.
         *
         * The dot is optional in what you pass — `withExt(p, "txt")` and
         * `withExt(p, ".txt")` do the same thing, because half of callers will
         * write each and neither is wrong. An empty extension removes it.
         */
        fn('withExt', ['path', 'extension'], (a, c) => {
          const target = expectStr(arg(a, 0), c, 'withExt(path)');
          const wanted = expectStr(arg(a, 1), c, 'withExt(extension)');
          const base = baseOf(target);
          const extension = extOf(base);
          const stem = extension === '' ? base : base.slice(0, base.length - extension.length);
          const suffix = wanted === '' || wanted.startsWith('.') ? wanted : '.' + wanted;
          const parent = dirOf(target);
          return str(parent === '.' ? stem + suffix : normalise(parent + '/' + stem + suffix));
        }),

        /**
         * The path as its segments, with the root — if any — as the first.
         *
         * `["/", "usr", "bin"]` rather than `["", "usr", "bin"]`, so that the
         * first element says whether the path was absolute instead of the
         * caller having to notice an empty string.
         */
        fn('split', ['path'], (a, c) => {
          const target = normalise(expectStr(arg(a, 0), c, 'split(path)'));
          const { prefix, rest, absolute } = rootOf(target);
          const segments = rest.split('/').filter((segment) => segment !== '');
          const root = absolute ? prefix + '/' : prefix;
          return list([...(root === '' ? [] : [str(root)]), ...segments.map((s) => str(s))]);
        }),

        fn('isAbsolute', ['path'], (a, c) =>
          bool(rootOf(expectStr(arg(a, 0), c, 'isAbsolute(path)')).absolute),
        ),

        /**
         * `path`, read as relative to `base`.
         *
         * An absolute `path` is already the answer, which is what makes this
         * safe to apply to whatever a user typed.
         */
        fn('resolve', ['base', 'path'], (a, c) => {
          const base = expectStr(arg(a, 0), c, 'resolve(base)');
          const target = expectStr(arg(a, 1), c, 'resolve(path)');
          if (rootOf(target).absolute) return str(normalise(target));
          // Not a separator when the base already ends in one. `resolve("/",
          // "a/c/d")` built `//a/c/d`, which `rootOf` then reads as a UNC
          // network path — `//a/c` is a server and a share — so resolving
          // against the root produced a path pointing at another machine.
          const joined =
            base === '' ? target : base.endsWith('/') ? base + target : base + '/' + target;
          return str(normalise(joined));
        }),

        /**
         * How to get from one path to another, as a relative path.
         *
         * `relative("/a/b", "/a/c/d")` is `"../c/d"`. Both are normalised
         * first, so a `.` or a doubled separator in either changes nothing.
         */
        // `base` and `target` rather than the conventional `from` and `to`,
        // because `from` is a keyword: `fn relative(from, to)` is a syntax
        // error, so a parameter by that name is one no Lumen program could
        // have declared. `std/str.replace` had the same problem.
        fn('relative', ['base', 'target'], (a, c) => {
          const fromRaw = normalise(expectStr(arg(a, 0), c, 'relative(base)'));
          const toRaw = normalise(expectStr(arg(a, 1), c, 'relative(target)'));
          const fromRoot = rootOf(fromRaw);
          const toRoot = rootOf(toRaw);
          // Nothing relative connects `C:/x` to `D:/y`, or an absolute path to
          // a relative one: the honest answer is the destination itself.
          if (fromRoot.prefix !== toRoot.prefix || fromRoot.absolute !== toRoot.absolute) {
            return str(toRaw);
          }
          // `.` is a segment that means "here", and `normalise` leaves it as
          // the whole of a path that is only that. Counting it as a directory
          // made `relative(".", "docs/spec.md")` climb out of a directory that
          // was never entered — `"../docs/spec.md"` — for the commonest base
          // anybody passes, and broke the round trip with `resolve`.
          const segments = (rest: string): string[] =>
            rest.split('/').filter((s) => s !== '' && s !== '.');
          const fromParts = segments(fromRoot.rest);
          const toParts = segments(toRoot.rest);
          let shared = 0;
          while (
            shared < fromParts.length &&
            shared < toParts.length &&
            fromParts[shared] === toParts[shared]
          ) {
            shared += 1;
          }
          const up = Array.from({ length: fromParts.length - shared }, () => '..');
          const down = toParts.slice(shared);
          const joined = [...up, ...down].join('/');
          return str(joined === '' ? '.' : joined);
        }),

        /**
         * Whether `child` is `parent` or something under it.
         *
         * The check a program serving files needs before opening one, and the
         * one that is easy to get wrong: comparing the text alone makes
         * `/publicity` look like it is inside `/public`, and forgetting to
         * normalise lets `/public/../etc/passwd` through. Both are handled
         * here so that nobody has to remember them at the call site.
         */
        fn('isInside', ['parent', 'child'], (a, c) => {
          const parent = partsOf(expectStr(arg(a, 0), c, 'isInside(parent)'));
          const child = partsOf(expectStr(arg(a, 1), c, 'isInside(child)'));

          // Compared segment by segment rather than as text. A prefix test is
          // the obvious way and is wrong twice: `/publicity` starts with
          // `/public`, and — the one that took writing a probe to find —
          // `isInside(".", "a")` was false, because `"a"` does not start with
          // `"./"`. A program checking that a relative path stays under the
          // working directory would have been told no every time.
          if (parent.root !== child.root || parent.absolute !== child.absolute) return bool(false);

          // A relative path that climbs out is not inside, whatever its
          // segments look like afterwards: `..` cannot be matched against a
          // parent's name, because it is not a name.
          if (child.segments[0] === '..') return bool(false);

          if (child.segments.length < parent.segments.length) return bool(false);
          for (const [i, segment] of parent.segments.entries()) {
            if (child.segments[i] !== segment) return bool(false);
          }
          return bool(true);
        }),
      ),
      {
        join: 'Join parts into one path, with a single separator between them.',
        normalize: 'Remove `.`, doubled separators and resolvable `..`.',
        dir: 'Everything up to the last separator, or "." if there is none.',
        base: 'The part after the last separator.',
        stem: 'The file name without its extension.',
        ext: 'The extension including its dot, or "" if there is none.',
        withExt: 'The same path with a different extension. The dot is optional.',
        split: 'The path as its segments, with the root first if it has one.',
        isAbsolute: 'True if the path starts from a root rather than from here.',
        relative: 'How to get from one path to another, as a relative path.',
        resolve: 'A path read as relative to a base. An absolute path is itself.',
        isInside: 'True if the second path is the first, or something under it.',
      },
    ),
    SIGNATURES,
  );
}
