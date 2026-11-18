import { useEffect, useRef, useState } from "react";
import "./LanguageSwitch.css";
import { useI18n } from "./i18n/I18nProvider";
import { LANGUAGE_LABELS } from "./i18n/languages";
import type { Language } from "./types";

const ORDER: Language[] = ["en", "ja"];

/**
 * "EN | 日本語" switch in the header. `target` picks which setting it changes: the UI language
 * or the language the crew speaks (two separate settings, both saved on the server).
 */
export function LanguageSwitch({ target }: { target: "ui" | "crew" }) {
  const i18n = useI18n();
  const { t } = i18n;
  const language = target === "ui" ? i18n.language : i18n.crewLanguage;
  const setLanguage = target === "ui" ? i18n.setLanguage : i18n.setCrewLanguage;
  return (
    <div className="language-switch" role="group" aria-label={t(target === "ui" ? "language.switch.label" : "language.switch.crew.label")}>
      <span className="language-switch-tag">{t(target === "ui" ? "language.switch.tag.ui" : "language.switch.tag.crew")}</span>
      {ORDER.map((code) => (
        <button
          key={code}
          className={`language-switch-btn${code === language ? " language-switch-btn--active" : ""}`}
          aria-pressed={code === language}
          onClick={() => { if (code !== language) void setLanguage(code); }}
        >
          {LANGUAGE_LABELS[code]}
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
 * Header control for the two languages: a quiet "UI / crew" label (like the search and split buttons)
 * that opens a small popup holding the two switches. The hover text spells out what the label means.
 */
export function LanguageMenu() {
  const { t, language, crewLanguage } = useI18n();
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

  const detail = t("language.menu.detail", { ui: LANGUAGE_LABELS[language], crew: LANGUAGE_LABELS[crewLanguage] });
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
        {LANGUAGE_LABELS[language]} / {LANGUAGE_LABELS[crewLanguage]}
      </button>
      {open && (
        <div className="language-menu-popup" role="dialog" aria-label={t("language.menu.title")}>
          <LanguageSwitch target="ui" />
          <LanguageSwitch target="crew" />
        </div>
      )}
    </div>
  );
}
