/**
 * Which window the page is in, when that changes how it is drawn: the desktop app on macOS hides the title bar, so the header is the title bar
 * and the window buttons sit over its left end (desktop-shell.css). A page in a browser has none of that.
 */
export type Shell = "desktop-mac";

export function shellOf(userAgent: string): Shell | null {
  return /\bElectron\//.test(userAgent) && /\bMacintosh\b/.test(userAgent) ? "desktop-mac" : null;
}

/** Whether the page is in the desktop app on macOS (see `markShell`). */
export function inDesktopMac(root: HTMLElement = document.documentElement): boolean {
  return root.dataset.shell === "desktop-mac";
}

/** Marks the page (`data-shell` on the root) for the style sheet; a page outside the desktop app is left as it is. */
export function markShell(root: HTMLElement = document.documentElement, userAgent: string = navigator.userAgent): void {
  const shell = shellOf(userAgent);
  if (shell) root.dataset.shell = shell;
}

/** Whether the page is in the desktop app (on any platform), whose menu can choose the theme and the language. */
export function inDesktop(userAgent: string = navigator.userAgent): boolean {
  return /\bElectron\//.test(userAgent);
}
