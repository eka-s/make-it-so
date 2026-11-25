import type { OverviewShip } from "../server/settings/settings-overview.js";
import { LAUNCHER_TEXT_JA } from "./launcher-text.ja.js";

export type LauncherLanguage = "en" | "ja";

const TEXT = {
  en: {
    title: "Choose a ship",
    none: "There is no ship yet.",
    noneHint: "Make one on the settings screen (or with `npm run init`).",
    settings: "Settings",
    broken: "Cannot be opened",
    opening: "Opening…",
  },
  ja: LAUNCHER_TEXT_JA,
} as const;

/** The word for the settings, also used by the app menu. */
export function settingsLabel(language: LauncherLanguage): string {
  return TEXT[language].settings;
}

/** The language of the page: Japanese for a Japanese system, English otherwise. */
export function launcherLanguage(locale: string): LauncherLanguage {
  return locale.toLowerCase().startsWith("ja") ? "ja" : "en";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

// The page runs no script: a ship is chosen with a plain form button, so a policy that allows nothing else is enough.
const SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'";

function page(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SECURITY_POLICY}">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, "Segoe UI", sans-serif; }
  body { margin: 0; padding: 32px 28px; background: Canvas; color: CanvasText; }
  h1 { font-size: 18px; margin: 0 0 20px; }
  form { margin: 0; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  button { width: 100%; text-align: left; padding: 12px 14px; font: inherit; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 8px; background: color-mix(in srgb, CanvasText 5%, Canvas); color: inherit; cursor: pointer; }
  button:hover:not(:disabled) { background: color-mix(in srgb, CanvasText 12%, Canvas); }
  button:disabled { cursor: default; opacity: 0.6; }
  .settings { margin-top: 24px; }
  .settings button { text-align: center; }
  .name { font-weight: 600; }
  .meta { font-size: 12px; opacity: 0.7; margin-top: 2px; }
  .hint { opacity: 0.75; line-height: 1.6; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** The list the person chooses a ship from. */
export function renderLauncherPage(options: { ships: OverviewShip[]; language: LauncherLanguage }): string {
  const t = TEXT[options.language];
  const settings = `<form class="settings" method="post" action="/settings"><button type="submit">${escapeHtml(t.settings)}</button></form>`;
  if (options.ships.length === 0) {
    return page(t.title, `<h1>${t.none}</h1><p class="hint">${escapeHtml(t.noneHint)}</p>${settings}`);
  }
  const items = options.ships.map((ship) => {
    const meta = ship.error ? `${t.broken}: ${escapeHtml(ship.error)}` : escapeHtml(ship.id);
    const label = escapeHtml(ship.name ?? ship.id);
    return `<li><form method="post" action="/open"><button type="submit" name="ship" value="${escapeHtml(ship.id)}"${ship.error ? " disabled" : ""}><div class="name">${label}</div><div class="meta">${meta}</div></button></form></li>`;
  });
  return page(t.title, `<h1>${t.title}</h1><ul>${items.join("")}</ul>${settings}`);
}

/** What the chooser shows for the moment between the choice and the ship's own window. */
export function renderOpeningPage(language: LauncherLanguage): string {
  const t = TEXT[language];
  return page(t.opening, `<h1>${t.opening}</h1>`);
}
