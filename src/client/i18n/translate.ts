// Pure translation helpers (no React). The messages are plain objects of
// "key -> text"; a text may contain {name} placeholders.

export type Params = Record<string, string | number>;

/** Replaces {name} placeholders. A placeholder without a value is left as written. */
export function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** Returns the {name} placeholder names in a text, sorted (used by the parity test). */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

/**
 * Translates a key that may not exist in the dictionary (e.g. an error code sent by
 * the server). Returns `fallback` when the key is unknown.
 */
export function translateOr(
  messages: Record<string, string>,
  key: string,
  fallback: string,
  params?: Params,
): string {
  const text = messages[key];
  return text === undefined ? fallback : interpolate(text, params);
}

/**
 * The text to show for an error response `{ error, message }`. The server sends a code in
 * `error` (translated through the "error.<code>" messages) and an English `message` as a
 * fallback; older/unknown responses may only have a plain `error` string.
 */
export function messageForError(
  messages: Record<string, string>,
  data: { error?: string; message?: string } | undefined,
  fallback: string,
): string {
  const code = data?.error;
  if (code !== undefined) {
    const text = messages[`error.${code}`];
    if (text !== undefined) return text;
  }
  return data?.message ?? data?.error ?? fallback;
}

/** The BCP 47 locale used for dates and numbers in each language. */
export function localeOf(language: "en" | "ja"): string {
  return language === "ja" ? "ja-JP" : "en-US";
}
