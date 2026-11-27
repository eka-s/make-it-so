import type { MouseEvent } from "react";
import { useT } from "./i18n/I18nProvider";
import { api } from "./server-api";
import { inDesktopLinux } from "./shell";

/**
 * The button for the app's menu, at the right end of the header. On Linux the desktop app hides the title bar and with it the menu bar, so the menu
 * (the settings, the View menu) opens from here, as a menu of the system, at the button. It is not shown anywhere else.
 */
export function ShellMenuButton() {
  const t = useT();
  if (!inDesktopLinux()) return null;
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    api.openShellMenu({ x: Math.max(0, box.left), y: Math.max(0, box.bottom) }).catch(() => { /* the menu does not open: nothing else is lost */ });
  };
  return (
    <button className="app-shell-menu" onClick={open} title={t("app.shellMenu")} aria-label={t("app.shellMenu")} aria-haspopup="menu">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="2.8" r="1.5" />
        <circle cx="8" cy="8" r="1.5" />
        <circle cx="8" cy="13.2" r="1.5" />
      </svg>
    </button>
  );
}
