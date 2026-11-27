import { isLanguage, type Language } from "../server/language.js";
import { isTheme, type Theme } from "../server/theme.js";
import type { InMemoryFetch } from "./in-memory-fetch.js";

/** The paths the page asks the app itself on, instead of the ship: what only the window around the page can do. */
export const WINDOW_PATH = "/__shell/window";
export const APPEARANCE_PATH = "/__shell/appearance";
export const MENU_PATH = "/__shell/menu";

/** What the page is showing now, told to the app so that the menu can mark it. A page that has no crew to speak to (the settings) leaves `crewLanguage` out. */
export type PageAppearance = { theme: Theme; language: Language; crewLanguage?: Language };

/** Where the page asks the app's menu to open: the corner of its menu button, in CSS pixels from the top left of the page. */
export type MenuPosition = { x: number; y: number };

/** What the page tells the window, in CSS pixels: how tall its header is, and how much room the header keeps at both ends together (for the window buttons). */
export type PageReport = { height: number; room: number };

// A page can say anything: a value that cannot be a header height is refused rather than passed to the window.
const MIN_HEIGHT = 8;
const MAX_HEIGHT = 600;
const MAX_ROOM = 2000;

function parseReport(text: string): PageReport | null {
  try {
    const value = JSON.parse(text) as { height?: unknown; room?: unknown } | null;
    const { height, room } = value ?? {};
    if (typeof height !== "number" || !Number.isInteger(height) || height < MIN_HEIGHT || height > MAX_HEIGHT) return null;
    if (typeof room !== "number" || !Number.isInteger(room) || room < 0 || room > MAX_ROOM) return null;
    return { height, room };
  } catch {
    return null;
  }
}

const MAX_POSITION = 20000;

function parseMenuPosition(text: string): MenuPosition | null {
  try {
    const { x, y } = (JSON.parse(text) ?? {}) as { x?: unknown; y?: unknown };
    const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_POSITION;
    return ok(x) && ok(y) ? { x, y } : null;
  } catch {
    return null;
  }
}

function parseAppearance(text: string): PageAppearance | null {
  try {
    const { theme, language, crewLanguage } = (JSON.parse(text) ?? {}) as { theme?: unknown; language?: unknown; crewLanguage?: unknown };
    if (!isTheme(theme) || !isLanguage(language)) return null;
    if (crewLanguage === undefined) return { theme, language };
    return isLanguage(crewLanguage) ? { theme, language, crewLanguage } : null;
  } catch {
    return null;
  }
}

export type ShellHandlers = {
  /** Fits the window to the report and gives back the page's zoom, which is the answer. */
  onWindow: (report: PageReport) => { zoom: number };
  onAppearance: (appearance: PageAppearance) => void;
  /** Opens the app's menu at the position (the page has no menu bar to click: the header's menu button asks for it). */
  onMenu?: (position: MenuPosition) => void;
};

/**
 * Answers the page's reports to the window itself and hands every other request to the ship. A report that is not understood is answered with 400,
 * so a page that sends a wrong value is told rather than ignored.
 */
export function withShellRequests(serve: InMemoryFetch, handlers: ShellHandlers): InMemoryFetch {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname !== WINDOW_PATH && pathname !== APPEARANCE_PATH && pathname !== MENU_PATH) return serve(request);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const text = await request.text();
    if (pathname === MENU_PATH) {
      const position = parseMenuPosition(text);
      if (!position) return new Response("not a menu position", { status: 400 });
      handlers.onMenu?.(position);
      return new Response(null, { status: 204 });
    }
    if (pathname === WINDOW_PATH) {
      const report = parseReport(text);
      return report ? Response.json(handlers.onWindow(report)) : new Response("not a window report", { status: 400 });
    }
    const appearance = parseAppearance(text);
    if (!appearance) return new Response("not an appearance report", { status: 400 });
    handlers.onAppearance(appearance);
    return new Response(null, { status: 204 });
  };
}
