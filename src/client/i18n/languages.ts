import type { Language } from "../types";

// Language names are always written in their own language (the same in every UI
// language), so a user who cannot read the current language can still find theirs.
export const LANGUAGE_LABELS: Record<Language, string> = { en: "EN", ja: "日本語" };

/** The languages to choose from, in the order they are shown: `lang` is for the name itself, which is not in the language of the page (a screen reader says it in its own). */
export const LANGUAGE_OPTIONS: { value: Language; label: string; lang: Language }[] = [
  { value: "en", label: LANGUAGE_LABELS.en, lang: "en" },
  { value: "ja", label: LANGUAGE_LABELS.ja, lang: "ja" },
];
