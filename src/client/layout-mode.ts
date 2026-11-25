import { useCallback, useSyncExternalStore } from "react";

// The widths (CSS pixels) where the layout changes. They are kept here and nowhere else: the page marks <html> with `data-narrow` / `data-compact` for the style sheets
// (watchLayoutMode), so no media query repeats them, and the desktop app's smallest window (SHIP_MIN_WIDTH in src/electron/main.ts) is a window this layout fits in.

/** At most this wide, the left pane no longer fits beside the conversation, and it becomes a drawer over it. */
export const NARROW_WIDTH = 860;

/** At most this wide (a phone), the buttons beside the message box take too much of it: all but Send are kept in a menu. */
export const COMPACT_WIDTH = 600;

const query = (width: number) => `(max-width: ${width}px)`;

/** Whether the window is at most `width` wide; follows the window as it is resized or zoomed. */
export function useNarrowWindow(width: number = NARROW_WIDTH): boolean {
  const q = query(width);
  const subscribe = useCallback((onChange: () => void) => {
    const list = window.matchMedia(q);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [q]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(q).matches);
}

/** Marks the page (`data-narrow`, `data-compact` on the root) with the widths it is at, and keeps the marks current. Called once, before the page is drawn. */
export function watchLayoutMode(root: HTMLElement = document.documentElement): void {
  for (const [attribute, width] of [["narrow", NARROW_WIDTH], ["compact", COMPACT_WIDTH]] as const) {
    const list = window.matchMedia(query(width));
    const mark = () => root.toggleAttribute(`data-${attribute}`, list.matches);
    mark();
    list.addEventListener("change", mark);
  }
}
