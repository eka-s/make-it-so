import express from "express";
import { LANGUAGES, isLanguage, type Language } from "../language.js";

// Settings that can be changed from the UI.

/** What this route needs. index.ts wires the real ones; tests pass fakes. */
export type SettingsRouterDeps = {
  /** Saves the UI language (it overrides the default in config.yml). */
  setLanguage: (language: Language) => void;
  /** Saves the language the crew speaks (it overrides the default in config.yml). */
  setCrewLanguage: (language: Language) => void;
};

export function createSettingsRouter(deps: SettingsRouterDeps): express.Router {
  const router = express.Router();

  // Both routes take { language: "en" | "ja" } and answer with the saved value.
  const languageRoute = (save: (language: Language) => void): express.RequestHandler => (req, res) => {
    const { language } = (req.body ?? {}) as { language?: unknown };
    if (!isLanguage(language)) {
      res.status(400).json({ error: "invalid_language", message: `language must be one of ${LANGUAGES.join(", ")}` });
      return;
    }
    save(language);
    res.json({ language });
  };

  router.put("/api/config/language", languageRoute(deps.setLanguage));
  router.put("/api/config/crew-language", languageRoute(deps.setCrewLanguage));

  return router;
}
