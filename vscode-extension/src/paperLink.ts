/**
 * Rocq ↔ PDF linking.
 *
 * The association between a Rocq entry and a spot in the compiled paper is an
 * explicit anchor placed in the LaTeX source by the author:
 *
 *   \rocqanchor{<rocq entry name>}
 *
 * which expands (see the macro shipped in the docs) to
 * `\phantomsection\label{rocq:<name>}`. Forward navigation (.v → PDF) only needs
 * to locate the *line* of that anchor in some .tex file; SyncTeX (via LaTeX
 * Workshop) turns the (file, line) into a PDF position. The `\label` is there for
 * the reverse direction and for a page-level fallback via the .aux file.
 *
 * If no anchor exists for an entry, there is nothing to jump to — that is a
 * deliberate, graceful no-op, not an error.
 */

/** Escapes a string for literal use inside a RegExp. */
export function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches either `\rocqanchor{name}` or `\label{rocq:name}` for a given entry
 * name, tolerating surrounding whitespace inside the braces. The `u` flag keeps
 * it consistent with the Unicode-aware identifiers used elsewhere.
 */
export function anchorRegExp(name: string): RegExp {
  const n = escapeForRegExp(name);
  return new RegExp(
    `\\\\rocqanchor\\{\\s*${n}\\s*\\}|\\\\label\\{\\s*rocq:${n}\\s*\\}`,
    'u',
  );
}

/**
 * Returns the 1-based line number of the first anchor for `name` in `texContent`,
 * or `undefined` if there is none. Lines starting with `%` (commented out) are
 * skipped so a commented anchor never wins.
 */
export function findAnchorLine(
  texContent: string,
  name: string,
): number | undefined {
  if (!name) return undefined;
  const re = anchorRegExp(name);
  const lines = texContent.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*%/.test(line)) continue;
    if (re.test(line)) return i + 1;
  }
  return undefined;
}

/** The macro authors add once to their preamble (e.g. defs.tex). */
export const ROCQ_ANCHOR_MACRO =
  '\\providecommand{\\rocqanchor}[1]{\\phantomsection\\label{rocq:#1}}';
