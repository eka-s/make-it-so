import type { SlashCommand } from "./types";

// Computation of the slash command candidates shown for a leading `/` in the input box (pure functions that do not depend on the screen).

/**
 * If what is before the cursor is only "a leading `/` + a string with no whitespace", returns the string after that `/` (the search term).
 * Otherwise null (not in the middle of typing a command: in the middle of a path, after starting to type arguments, etc.).
 */
export function slashQuery(text: string, cursor: number): string | null {
  const match = /^\/(\S*)$/.exec(text.slice(0, cursor));
  return match ? match[1] : null;
}

/**
 * Narrows the candidates by the search term. Prefix matches on the name come first, then partial matches on the name (case-insensitive).
 */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/**
 * Replaces the leading `/search term` (before the cursor) with the chosen command's `/name `. What is after the cursor is kept
 * (no extra space is added if what follows already starts with whitespace). Returns the text after the replacement and the cursor position.
 */
export function completeSlash(text: string, cursor: number, name: string): { text: string; cursor: number } {
  const rest = text.slice(cursor);
  const head = `/${name}`;
  const inserted = /^\s/.test(rest) ? head : `${head} `;
  return { text: inserted + rest, cursor: inserted.length + (/^\s/.test(rest) ? 1 : 0) };
}

/**
 * How the slash command menu is shown.
 * - candidates: show candidates (a command is being typed and there are matching candidates).
 * - not-started: there are no candidates, but that partner has not started yet (the list has not arrived), so guidance is shown.
 * - none: show nothing (not typing a command, closed with Esc, or already started with no matching candidates = a path, etc.).
 */
export type SlashMenuMode = "candidates" | "not-started" | "none";

export function slashMenuMode(query: string | null, dismissed: boolean, candidateCount: number, live: boolean): SlashMenuMode {
  if (query === null || dismissed) return "none";
  if (candidateCount > 0) return "candidates";
  return live ? "none" : "not-started";
}
