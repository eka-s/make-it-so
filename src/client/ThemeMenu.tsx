import { useEffect, useRef, useState } from "react";
import "./ThemeMenu.css";
import { useI18n } from "./i18n/I18nProvider";
import { THEME_ORDER } from "./use-theme";
import type { Theme } from "./types";

/** Header control for the look of the screen: a button naming the current theme that opens a small list of all of them. */
export function ThemeMenu({ theme, onSelect }: { theme: Theme; onSelect: (theme: Theme) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="theme-menu" ref={rootRef}>
      <button
        className="theme-menu-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        title={t("theme.menu.title")}
      >
        {t(`theme.${theme}`)}
      </button>
      {open && (
        <div className="theme-menu-popup" role="listbox" aria-label={t("theme.menu.title")}>
          {THEME_ORDER.map((code) => (
            <button
              key={code}
              role="option"
              aria-selected={code === theme}
              className={`theme-menu-item theme-menu-item--${code}${code === theme ? " theme-menu-item--active" : ""}`}
              onClick={() => { onSelect(code); setOpen(false); }}
            >
              {t(`theme.${code}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
