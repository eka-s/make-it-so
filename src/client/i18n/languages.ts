import type { Language } from "../types";

// Language names are always written in their own language (the same in every UI
// language), so a user who cannot read the current language can still find theirs.
export const LANGUAGE_LABELS: Record<Language, string> = { en: "EN", ja: "日本語" };
