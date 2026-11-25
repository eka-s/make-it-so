import type { MenuItemConstructorOptions } from "electron";
import { LANGUAGES, type Language } from "../server/language.js";
import { THEMES, type Theme } from "../server/theme.js";
import type { PageAppearance } from "./shell-requests.js";

/** The choices of the page that are in the View menu: what is marked, the words, and what choosing one does. */
export type AppearanceMenu = {
  current: PageAppearance | null;
  text: { view: string; theme: string; themes: Record<Theme, string>; language: string; languages: Record<Language, string>; crewLanguage: string };
  onTheme: (theme: Theme) => void;
  onLanguage: (language: Language) => void;
  /** Without it there is no menu for the language the crew speaks (a window that has no crew). */
  onCrewLanguage?: (language: Language) => void;
};

// What the `viewMenu` role holds, written out because a role's menu cannot be added to. It is a copy of Electron's list: keep it the same when Electron's changes.
const VIEW_ITEMS: MenuItemConstructorOptions[] = [
  { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" },
  { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
];

function radios<T extends string>(values: readonly T[], names: Record<T, string>, checked: T | undefined, onChoose: (value: T) => void): MenuItemConstructorOptions[] {
  // Until the page has said what it shows, nothing is marked.
  return values.map((value) => ({ label: names[value], type: "radio", checked: checked === value, click: () => onChoose(value) }));
}

function viewMenu(appearance: AppearanceMenu | undefined): MenuItemConstructorOptions {
  if (!appearance) return { role: "viewMenu" };
  const { current, text } = appearance;
  const crew = appearance.onCrewLanguage;
  return {
    label: text.view,
    submenu: [
      { label: text.theme, submenu: radios(THEMES, text.themes, current?.theme, appearance.onTheme) },
      { label: text.language, submenu: radios(LANGUAGES, text.languages, current?.language, appearance.onLanguage) },
      ...(crew ? [{ label: text.crewLanguage, submenu: radios(LANGUAGES, text.languages, current?.crewLanguage, crew) }] : []),
      { type: "separator" },
      ...VIEW_ITEMS,
    ],
  };
}

/**
 * The menu of the app. The standard roles are kept (without an edit menu, copy and paste do not work on macOS); what is added is the
 * way to the settings, where each platform expects it: the app menu on macOS, the file menu elsewhere.
 */
export function buildMenuTemplate(options: {
  platform: NodeJS.Platform;
  appName: string;
  /** The text of the settings item, and what it does. Without `onSettings` there is no such item (the settings window has no use for it). */
  settingsLabel: string;
  onSettings?: () => void;
  /** Without it the View menu is the standard one (a window that has no theme or language of its own to choose). */
  appearance?: AppearanceMenu;
}): MenuItemConstructorOptions[] {
  const settings: MenuItemConstructorOptions[] = options.onSettings
    ? [{ label: options.settingsLabel, accelerator: "CmdOrCtrl+,", click: options.onSettings }, { type: "separator" }]
    : [];
  const common: MenuItemConstructorOptions[] = [{ role: "editMenu" }, viewMenu(options.appearance), { role: "windowMenu" }];
  if (options.platform === "darwin") {
    return [
      { label: options.appName, submenu: [{ role: "about" }, { type: "separator" }, ...settings, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
      ...common,
    ];
  }
  return [{ label: "File", submenu: [...settings, { role: "quit" }] }, ...common];
}
