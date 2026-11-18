// Languages supported by the UI and by the crew prompts. The UI language and the language
// the crew speaks are two separate settings (both kept per ship), e.g. an English UI
// while talking to the crew in Japanese.

export const LANGUAGES = ["en", "ja"] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "en";

/** Language names as written in the prompts sent to the crew (always English). */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  ja: "Japanese",
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * The language in effect: the value saved from the UI wins over the value in
 * config.yml. An unknown saved value (e.g. a language removed in a later
 * version) is ignored.
 */
export function resolveLanguage(saved: string | undefined, configured: Language): Language {
  return isLanguage(saved) ? saved : configured;
}
