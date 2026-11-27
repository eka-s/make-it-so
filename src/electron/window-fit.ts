/** The window buttons (close, minimize, zoom) of macOS are about this tall, in screen points. */
export const WINDOW_BUTTONS_HEIGHT = 12;

/**
 * The top of the window buttons that puts them in the middle of the header. The header's height is the page's (CSS pixels): what is on the screen is that
 * times the zoom.
 */
export function windowButtonsTop(headerHeight: number, zoom: number): number {
  return Math.round((headerHeight * zoom - WINDOW_BUTTONS_HEIGHT) / 2);
}

/**
 * The width the header needs at no zoom on this system, given the one macOS needs. On Linux the header keeps room at its right end for the window buttons only (92 CSS
 * pixels) where macOS keeps 88 at the left and 24 at the right, and it holds one more button, the one for the app's menu (42 pixels and a gap): measured, the
 * contents need 371 pixels from the left edge, so the header needs 463.
 */
export function headerMinWidth(platform: NodeJS.Platform, macWidth: number, room: number = LINUX_ROOM): number {
  // The room the page keeps for the buttons follows what the window tells it (a theme of the system may draw wider ones): what is more than assumed is added.
  return platform === "linux" ? macWidth + 88 + Math.max(0, room - LINUX_ROOM) : macWidth;
}

/** The room (CSS pixels) the Linux header keeps at its right end for the window buttons when they are as wide as measured: the buttons and a margin. */
export const LINUX_ROOM = 92;

/**
 * The narrowest window, in screen points, in which the header still fits on its one line. `minWidth` is that width with the page at no zoom. Zoomed in,
 * what is between the ends of the header grows with the zoom, but the room kept at the ends for the window buttons (`room`, in CSS pixels) is divided by it
 * and stays the same on the screen, so only the rest is scaled. A window cannot be wider than the screen.
 */
export function minimumWindowWidth(options: { minWidth: number; room: number; zoom: number; screenWidth: number }): number {
  const room = options.room * options.zoom;
  return Math.min(Math.round((options.minWidth - room) * options.zoom + room), options.screenWidth);
}
