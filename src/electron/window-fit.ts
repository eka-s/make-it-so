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
 * The narrowest window, in screen points, in which the header still fits on its one line. `minWidth` is that width with the page at no zoom. Zoomed in,
 * what is between the ends of the header grows with the zoom, but the room kept at the ends for the window buttons (`room`, in CSS pixels) is divided by it
 * and stays the same on the screen, so only the rest is scaled. A window cannot be wider than the screen.
 */
export function minimumWindowWidth(options: { minWidth: number; room: number; zoom: number; screenWidth: number }): number {
  const room = options.room * options.zoom;
  return Math.min(Math.round((options.minWidth - room) * options.zoom + room), options.screenWidth);
}
