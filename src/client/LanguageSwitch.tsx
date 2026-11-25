import { useEffect, useRef, useState } from "react";
import "./LanguageSwitch.css";
import { useI18n } from "./i18n/I18nProvider";
import { LANGUAGE_LABELS, LANGUAGE_OPTIONS } from "./i18n/languages";

/** "EN | 日本語" switch for the UI language (the settings window's header; the language of the crew is chosen in the left pane's settings). */
export function LanguageSwitch() {
  const { t, language, setLanguage } = useI18n();
  return (
    <div className="language-switch" role="group" aria-label={t("language.switch.label")}>
      <span className="language-switch-tag">{t("language.switch.tag.ui")}</span>
      {LANGUAGE_OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          lang={value}
          className={`language-switch-btn${value === language ? " language-switch-btn--active" : ""}`}
          aria-pressed={value === language}
          onClick={() => { if (value !== language) void setLanguage(value); }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** A dismissible notice shown after the language was changed (the crew needs a new session). */
export function LanguageNotice() {
  const { noticeVisible, dismissNotice, t } = useI18n();
  if (!noticeVisible) return null;
  return (
    <div className="language-notice" role="status">
      <span>{t("language.notice")}</span>
      <button className="language-notice-close" onClick={dismissNotice}>{t("language.notice.dismiss")}</button>
    </div>
  );
}

/**
 * Header control for the UI language: a quiet label (like the search and split buttons) that opens a small popup holding the switch.
 * The hover text spells out what the label means.
 */
export function LanguageMenu() {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const detail = t("language.menu.detailUi", { ui: LANGUAGE_LABELS[language] });
  return (
    <div className="language-menu" ref={rootRef}>
      <button
        className="language-menu-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        title={detail}
        aria-label={detail}
      >
        {LANGUAGE_LABELS[language]}
      </button>
      {open && (
        <div className="language-menu-popup" role="dialog" aria-label={t("language.switch.label")}>
          <LanguageSwitch />
        </div>
      )}
    </div>
  );
}
