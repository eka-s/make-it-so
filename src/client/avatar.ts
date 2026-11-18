// The avatar built from the name (initial + color) shown for a crew member with no icon (image) set. A pure function that does not depend on the screen.

/** The initial to show (the first character of the name; a question mark if empty). */
export function avatarInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}

/** Hue decided from the name (0-359). The same name always gets the same color. */
export function avatarHue(name: string): number {
  let hash = 0;
  for (const ch of name.trim().toLowerCase()) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}
