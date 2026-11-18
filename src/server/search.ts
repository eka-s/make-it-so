// The part of conversation search that depends on neither the screen nor the DB (splitting the search terms, material for building LIKE, excerpts of the matches).

/** Upper limit on the number of search terms (too many only slows things down without helping). */
export const MAX_SEARCH_TERMS = 8;
/** Maximum length of one search term. */
export const MAX_TERM_LENGTH = 100;

/**
 * Splits the search string into AND-search terms on whitespace (including full-width). Empty terms are dropped and duplicates collapsed to one
 * (case-insensitive). Terms beyond the limit and terms that are too long are cut off.
 */
export function parseSearchTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const term = raw.slice(0, MAX_TERM_LENGTH);
    const key = term.toLowerCase();
    if (term === "" || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_SEARCH_TERMS) break;
  }
  return terms;
}

/**
 * Escapes the special characters of LIKE (`%`, `_`, and the escape character itself) so they are treated literally. Used together with `ESCAPE '\'`.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Excerpt: a part of the text and the matched ranges inside it (ranges of terms, `[start, end)`). */
export type Snippet = {
  text: string;
  /** Ranges in `text` that matched a search term (overlaps already merged, ascending by start). */
  ranges: Array<[number, number]>;
  /** The start/end of the text was cut off (the screen adds "…"). */
  cutStart: boolean;
  cutEnd: boolean;
};

const BEFORE = 40;
const AFTER = 120;

/**
 * Replaces newlines and tabs with one space each (the length does not change, so positions do not shift).
 */
function flatten(text: string): string {
  return text.replace(/[\r\n\t\u2028\u2029]/g, " ");
}

/** Adjusts the position so it does not cut in the middle of a surrogate pair (emoji etc.). */
function onBoundary(text: string, index: number, direction: 1 | -1): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
  const code = text.charCodeAt(index);
  const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
  return isLowSurrogate ? index + direction : index;
}

/**
 * Cuts out the area around the first match and returns the matches of all search terms inside the window.
 * When there is no match, cuts out the beginning of the text (the matched ranges are empty).
 */
export function makeSnippet(text: string, terms: string[]): Snippet {
  const flat = flatten(text);
  const lower = flat.toLowerCase();
  const lowered = terms.map((t) => t.toLowerCase()).filter((t) => t !== "");

  let first = -1;
  for (const term of lowered) {
    const at = lower.indexOf(term);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }

  const start = first < 0 ? 0 : onBoundary(flat, Math.max(0, first - BEFORE), 1);
  const end = onBoundary(flat, Math.min(flat.length, (first < 0 ? 0 : first) + AFTER), -1);
  const windowText = flat.slice(start, end);

  const raw: Array<[number, number]> = [];
  for (const term of lowered) {
    let from = start;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at < 0 || at + term.length > end) break;
      raw.push([at - start, at - start + term.length]);
      from = at + term.length;
    }
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const ranges: Array<[number, number]> = [];
  for (const range of raw) {
    const last = ranges.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([range[0], range[1]]);
  }

  return { text: windowText, ranges, cutStart: start > 0, cutEnd: end < flat.length };
}
