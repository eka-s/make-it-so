/**
 * Which window the page is in, when that changes how it is drawn: the desktop app on macOS and on Linux hides the title bar, so the header is the title bar.
 * On macOS the window buttons sit over its left end, and on Linux the app draws them over its right end (desktop-shell.css). A page in a browser has none of that.
 */
export type Shell = "desktop-mac" | "desktop-linux";

export function shellOf(userAgent: string): Shell | null {
  if (!/\bElectron\//.test(userAgent)) return null;
  if (/\bMacintosh\b/.test(userAgent)) return "desktop-mac";
  return /\bLinux\b/.test(userAgent) && !/\bAndroid\b/.test(userAgent) ? "desktop-linux" : null;
}

/** Whether the page is in the desktop app on macOS (see `markShell`). */
export function inDesktopMac(root: HTMLElement = document.documentElement): boolean {
  return root.dataset.shell === "desktop-mac";
}

/** Whether the page is in the desktop app on Linux (see `markShell`), where the header holds the button for the app's menu. */
export function inDesktopLinux(root: HTMLElement = document.documentElement): boolean {
  return root.dataset.shell === "desktop-linux";
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
