import { DEFAULT_MISSION_ID } from "./constants";
import { GROUP_MODES, type GroupMode } from "./search-group";
import type { Theme } from "./types";

// Personal display settings kept in the browser (localStorage) (the left pane width, the height of each section,
// the conversation partner per mission, the selected mission). All of them are "nice to have" state, and the screen works fine even if reading or writing fails (private
// browsing, etc.).

// Saving and restoring sizes that can be changed by dragging (the left pane width, the height of the collapsible sections).
// They are remembered even after the browser is closed. Only positive numbers are treated as valid values, and when nothing is saved or
// it is broken, null is returned (the caller decides the default).
// The heights of the collapsible sections (missions/crew status/pins) stretch and shrink independently and
// cannot be widened beyond the height at which the whole list inside is visible (CollapsibleSection
// computes the upper limit from scrollHeight). While it has never been dragged
// (no saved value) it is null — in that case the section opens as far as the height at which the whole content is visible,
// and is shrunk by dragging when needed.
export function loadStoredNumber(key: string): number | null {
  try {
    const saved = Number(localStorage.getItem(key));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  } catch {
    return null;
  }
}

export function persistNumber(key: string, height: number): void {
  try {
    localStorage.setItem(key, String(height));
  } catch {
    // Ignore (when localStorage is unavailable, e.g. in private browsing)
  }
}

// Persisting the conversation partner. This prevents it from being reset to the commander ("first_officer")
// on session switch or reload. The partner differs "per mission", so
// missionId is included in the storage key — with a single global one, every mission switch
// would overwrite it with the previous mission's partner, and it would be lost when coming back
// (A→B→A would fall back to the commander). An empty string is treated as an invalid value, and null is returned if none.
const CHAT_TARGET_STORAGE_PREFIX = "chat-default-target";

export function chatTargetStorageKey(missionId: string): string {
  return `${CHAT_TARGET_STORAGE_PREFIX}:${missionId}`;
}

export function loadStoredChatTarget(missionId: string): string | null {
  try {
    const saved = localStorage.getItem(chatTargetStorageKey(missionId));
    return saved && saved.length > 0 ? saved : null;
  } catch {
    return null;
  }
}

export function persistChatTarget(missionId: string, role: string): void {
  try {
    localStorage.setItem(chatTargetStorageKey(missionId), role);
  } catch {
    // Ignore (when localStorage is unavailable, e.g. in private browsing)
  }
}

// The order of the conversation-partner buttons (an array of roles). One per browser, regardless of mission. A broken value, or
// an array containing non-strings, is treated as nonexistent (applyOrder fixes it to match the composition).
const TARGET_ORDER_STORAGE_KEY = "chat-target-order";

export function loadStoredTargetOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TARGET_ORDER_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") ? parsed : [];
  } catch {
    return [];
  }
}

export function persistTargetOrder(order: string[]): void {
  try {
    localStorage.setItem(TARGET_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Ignore (when localStorage is unavailable, e.g. in private browsing)
  }
}

// How search results are grouped (by mission / by crew / mission × crew). An invalid value is treated as the default (by mission).
const SEARCH_GROUP_MODE_STORAGE_KEY = "search-group-mode";

export function loadStoredSearchGroupMode(): GroupMode {
  try {
    const saved = localStorage.getItem(SEARCH_GROUP_MODE_STORAGE_KEY);
    return GROUP_MODES.includes(saved as GroupMode) ? (saved as GroupMode) : "mission";
  } catch {
    return "mission";
  }
}

export function persistSearchGroupMode(mode: GroupMode): void {
  try {
    localStorage.setItem(SEARCH_GROUP_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore (when localStorage is unavailable, e.g. in private browsing)
  }
}

// Persisting the active mission. To restore the mission that was selected last time
// on reload. If nothing is saved, it starts from the default mission
// (DEFAULT_MISSION_ID).
const ACTIVE_MISSION_STORAGE_KEY = "active-mission-id";

export function loadStoredActiveMissionId(): string {
  try {
    const saved = localStorage.getItem(ACTIVE_MISSION_STORAGE_KEY);
    return saved && saved.length > 0 ? saved : DEFAULT_MISSION_ID;
  } catch {
    return DEFAULT_MISSION_ID;
  }
}

export function persistActiveMissionId(missionId: string): void {
  try {
    localStorage.setItem(ACTIVE_MISSION_STORAGE_KEY, missionId);
  } catch {
    // Ignore (when localStorage is unavailable, e.g. in private browsing)
  }
}

// Whether the conversation is split into a top pane (earlier messages) and a bottom pane (the live conversation).
// Off by default; the pane's size is saved with persistNumber ("chat-split-ratio").
const SPLIT_ENABLED_STORAGE_KEY = "chat-split-enabled";

export function loadStoredSplitEnabled(): boolean {
  try {
    return localStorage.getItem(SPLIT_ENABLED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistSplitEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SPLIT_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore (when localStorage is unavailable, e.g. in private browsing)
  }
}

// Whether the left pane (missions, crew, pins, settings) is shown. Shown by default.
const LEFT_PANE_OPEN_STORAGE_KEY = "left-pane-open";

export function loadStoredLeftPaneOpen(): boolean {
  try {
    return localStorage.getItem(LEFT_PANE_OPEN_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function persistLeftPaneOpen(open: boolean): void {
  try {
    localStorage.setItem(LEFT_PANE_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // Ignore (when localStorage is unavailable, e.g. in private browsing)
  }
}

// The look of the screen. The server only gives the default (config.yml); a choice made with the switch is kept
// here, per browser, and wins over it. The default is cached too, so the first paint does not flash the wrong look.
const THEME_CHOICE_KEY = "theme-choice";
const THEME_DEFAULT_KEY = "theme-default-cache";

export function isTheme(value: unknown): value is Theme {
  return value === "classic" || value === "light" || value === "dark";
}

function loadStoredTheme(key: string): Theme | null {
  try {
    const saved = localStorage.getItem(key);
    return isTheme(saved) ? saved : null;
  } catch {
    return null;
  }
}

function persistTheme(key: string, theme: Theme): void {
  try {
    localStorage.setItem(key, theme);
  } catch {
    // Ignore (when localStorage is unavailable, e.g. in private browsing)
  }
}

export const loadThemeChoice = () => loadStoredTheme(THEME_CHOICE_KEY);
export const persistThemeChoice = (theme: Theme) => persistTheme(THEME_CHOICE_KEY, theme);
export const loadThemeDefault = () => loadStoredTheme(THEME_DEFAULT_KEY);
export const persistThemeDefault = (theme: Theme) => persistTheme(THEME_DEFAULT_KEY, theme);
