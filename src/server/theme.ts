// The looks of the screen. config.yml sets the default for every browser; a choice made in a browser (on the
// ship's screen) is kept in that browser and wins over it, so there is nothing to save on the server.

export const THEMES = ["classic", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "classic";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}
