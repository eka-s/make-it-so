import type { Theme } from "../server/theme.js";

// The window buttons (minimize, maximize, close) that Electron draws over the page's header on Linux, where the page's own header is the title bar.
// Their background has to be the header's, or they stand out from it, so it follows the theme the page shows (the colors are those of the header in App.css and
// theme-light-dark.css: the classic header keeps an orange block at its right end for them, and the light and dark headers are a band of blue with white text).

export type TitleBarOverlay = { color: string; symbolColor: string; height: number };

const COLORS: Record<Theme, { color: string; symbolColor: string }> = {
  classic: { color: "#ff9900", symbolColor: "#000000" },
  light: { color: "#0ea5e9", symbolColor: "#ffffff" },
  dark: { color: "#0369a1", symbolColor: "#ffffff" },
};

/** The height of the header on the screen (the header's is in CSS pixels, and a page zoom scales it), which is how tall the window buttons are. */
export function overlayHeight(headerHeight: number, zoom: number): number {
  return Math.max(1, Math.round(headerHeight * zoom));
}

/** Just the colors, for when the theme changes (`setTitleBarOverlay` leaves out what is not given). */
export function overlayColors(theme: Theme): { color: string; symbolColor: string } {
  return { ...COLORS[theme] };
}

/** What `titleBarOverlay` / `setTitleBarOverlay` take for a theme and a header height (in CSS pixels). */
export function titleBarOverlay(theme: Theme, headerHeight: number, zoom: number): TitleBarOverlay {
  return { ...COLORS[theme], height: overlayHeight(headerHeight, zoom) };
}

/** Where a menu opens on the window: the page's position (CSS pixels) is scaled by the page's zoom on the screen. */
export function popupPosition(position: { x: number; y: number }, zoom: number): { x: number; y: number } {
  return { x: Math.round(position.x * zoom), y: Math.round(position.y * zoom) };
}
