import { useEffect } from "react";
import { useI18n } from "./i18n/I18nProvider";
import { isTheme } from "./preferences";
import { api } from "./server-api";
import { inDesktop } from "./shell";
import type { Language, Theme } from "./types";

/** The event the desktop app sends the page when the View menu chooses a theme or a language (`detail` holds what was chosen). */
export const APPEARANCE_EVENT = "makeitso:appearance";

const isLanguage = (value: unknown): value is Language => value === "en" || value === "ja";

/**
 * The View menu of the desktop app chooses the theme and the languages, which the page keeps and draws. A choice arrives as an event and is applied the way
 * the page's own switches apply it; what the page then shows is reported back, which is what the menu marks. `crew`: the page has a crew, whose language
 * is chosen and reported too.
 */
export function useShellAppearance(theme: Theme, setTheme: (theme: Theme) => void, { crew }: { crew: boolean }): void {
  const { language, setLanguage, crewLanguage, setCrewLanguage } = useI18n();

  useEffect(() => {
    if (!inDesktop()) return;
    const onChoice = (event: Event) => {
      // Only the app sends this, with values from its menu; anything else is not a choice.
      const choice = (event as CustomEvent<{ theme?: unknown; language?: unknown; crewLanguage?: unknown } | null>).detail ?? {};
      if (isTheme(choice.theme)) setTheme(choice.theme);
      if (isLanguage(choice.language)) void setLanguage(choice.language);
      if (crew && isLanguage(choice.crewLanguage)) void setCrewLanguage(choice.crewLanguage);
    };
    window.addEventListener(APPEARANCE_EVENT, onChoice);
    return () => window.removeEventListener(APPEARANCE_EVENT, onChoice);
  }, [crew, setTheme, setLanguage, setCrewLanguage]);

  useEffect(() => {
    if (!inDesktop()) return;
    api.reportShellAppearance({ theme, language, ...(crew ? { crewLanguage } : {}) }).catch(() => { /* the menu keeps its last marks */ });
  }, [crew, theme, language, crewLanguage]);
}
