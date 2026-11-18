import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../server-api";
import type { Language } from "../types";
import { en, type MessageKey } from "./en";
import { ja } from "./ja";
import { interpolate, messageForError, translateOr, type Params } from "./translate";

// The UI language and the language the crew speaks are two settings of the server (one
// value each per ship). The browser only keeps a copy of the last UI value, so that the
// first paint does not flash the wrong language; the server's value always wins.
//
// The settings screen has no ship database, so its UI language is the viewer's own choice, kept in the browser
// (`languageStorage="browser"`); until one is made, it follows the language in config.yml.

const CATALOGS: Record<Language, Record<MessageKey, string>> = { en, ja };
const STORAGE_KEY = "language-cache";
const CHOICE_KEY = "settings-language-choice";

function readStored(key: string): Language | null {
  try {
    const saved = localStorage.getItem(key);
    return saved === "ja" || saved === "en" ? saved : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, language: Language): void {
  try {
    localStorage.setItem(key, language);
  } catch {
    // localStorage may be unavailable (private window etc.): the server value still works
  }
}

type I18n = {
  language: Language;
  /** The language the crew speaks (separate from the UI language). */
  crewLanguage: Language;
  t: (key: MessageKey, params?: Params) => string;
  /** Translates a key that may not exist (e.g. sent by the server); `fallback` when unknown. */
  tKey: (key: string, fallback: string, params?: Params) => string;
  /** The text to show for an error response `{ error, message }` from the server. */
  tError: (data: { error?: string; message?: string } | undefined, fallback: string) => string;
  /** Saves the UI language on the server and switches the UI. */
  setLanguage: (language: Language) => Promise<void>;
  /** Saves the crew language on the server (the UI text does not change). */
  setCrewLanguage: (language: Language) => Promise<void>;
  /** True after the crew language was changed from the UI, until the notice is dismissed. */
  noticeVisible: boolean;
  dismissNotice: () => void;
};

const I18nContext = createContext<I18n | null>(null);

/**
 * `languageStorage`: "server" (default) keeps the UI language on the ship's server; "browser" keeps it only in this
 * browser (the settings screen), and the server's value is just the starting point.
 */
export function I18nProvider({ children, languageStorage = "server" }: { children: React.ReactNode; languageStorage?: "server" | "browser" }) {
  const browserOnly = languageStorage === "browser";
  const key = browserOnly ? CHOICE_KEY : STORAGE_KEY;
  const [language, setLanguageState] = useState<Language>(() => readStored(key) ?? "en");
  const [crewLanguage, setCrewLanguageState] = useState<Language>("en");
  const [noticeVisible, setNoticeVisible] = useState(false);

  // Take the server's value on load.
  useEffect(() => {
    const controller = new AbortController();
    api.getConfig(controller.signal)
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        if (data.language === "en" || data.language === "ja") {
          // A choice made in this browser stands over the server's default.
          if (!browserOnly || readStored(CHOICE_KEY) === null) setLanguageState(data.language);
          if (!browserOnly) writeStored(STORAGE_KEY, data.language);
        }
        if (data.crewLanguage === "en" || data.crewLanguage === "ja") setCrewLanguageState(data.crewLanguage);
      })
      .catch(() => { /* keep the cached language */ });
    return () => controller.abort();
  }, [browserOnly]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback(async (next: Language) => {
    if (!browserOnly) {
      const res = await api.setLanguage(next);
      if (!res.ok) return;
    }
    setLanguageState(next);
    writeStored(key, next);
  }, [browserOnly, key]);

  const setCrewLanguage = useCallback(async (next: Language) => {
    const res = await api.setCrewLanguage(next);
    if (!res.ok) return;
    setCrewLanguageState(next);
    // running crew sessions keep the old language until they are restarted
    setNoticeVisible(true);
  }, []);

  const value = useMemo<I18n>(() => {
    const catalog = CATALOGS[language];
    return {
      language,
      crewLanguage,
      t: (key, params) => interpolate(catalog[key], params),
      tKey: (key, fallback, params) => translateOr(catalog, key, fallback, params),
      tError: (data, fallback) => messageForError(catalog, data, fallback),
      setLanguage,
      setCrewLanguage,
      noticeVisible,
      dismissNotice: () => setNoticeVisible(false),
    };
  }, [language, crewLanguage, setLanguage, setCrewLanguage, noticeVisible]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>");
  return value;
}

/** The translate function only (most components need nothing else). */
export function useT(): I18n["t"] {
  return useI18n().t;
}
