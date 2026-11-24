import type { InMemoryFetch } from "./in-memory-fetch.js";

/** The path the page asks the app itself on, instead of the ship: what only the window around the page can do. */
export const WINDOW_PATH = "/__shell/window";

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

/**
 * Answers the page's reports to the window itself and hands every other request to the ship. `onReport` fits the window to the report and gives back the
 * page's zoom, which is the answer. A report that is not understood is answered with 400, so a page that sends a wrong value is told rather than ignored.
 */
export function withShellRequests(serve: InMemoryFetch, onReport: (report: PageReport) => { zoom: number }): InMemoryFetch {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== WINDOW_PATH) return serve(request);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const report = parseReport(await request.text());
    if (!report) return new Response("not a window report", { status: 400 });
    return Response.json(onReport(report));
  };
}
