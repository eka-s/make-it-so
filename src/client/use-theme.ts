import { useCallback, useEffect, useState } from "react";
import { isTheme, loadThemeChoice, loadThemeDefault, persistThemeChoice, persistThemeDefault } from "./preferences";
import { api } from "./server-api";
import type { Theme } from "./types";

/**
 * The look of the screen, set as `data-theme` on <html> (the stylesheets switch on it). A choice made in this browser
 * wins; otherwise the default from config.yml (cached, so the first paint is right) applies.
 */
export const THEME_ORDER: Theme[] = ["classic", "light", "dark"];

export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const [choice, setChoice] = useState<Theme | null>(loadThemeChoice);
  const [serverDefault, setServerDefault] = useState<Theme>(() => loadThemeDefault() ?? "classic");

  useEffect(() => {
    const controller = new AbortController();
    api.getConfig(controller.signal)
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        if (isTheme(data.theme)) {
          setServerDefault(data.theme);
          persistThemeDefault(data.theme);
        }
      })
      .catch(() => { /* keep the cached default */ });
    return () => controller.abort();
  }, []);

  const theme = choice ?? serverDefault;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setChoice(next);
    persistThemeChoice(next);
  }, []);

  return { theme, setTheme };
}
