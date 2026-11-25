import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { buildMenuTemplate } from "./application-menu.js";

const submenu = (item: MenuItemConstructorOptions) => (item.submenu ?? []) as MenuItemConstructorOptions[];
const settingsItem = (items: MenuItemConstructorOptions[]) => items.find((i) => i.accelerator === "CmdOrCtrl+,");

describe("the app menu", () => {
  it("puts the settings in the app menu on macOS, with the usual shortcut", () => {
    const onSettings = vi.fn();
    const template = buildMenuTemplate({ platform: "darwin", appName: "Make-It-So", settingsLabel: "Settings", onSettings });
    expect(template[0].label).toBe("Make-It-So");
    const item = settingsItem(submenu(template[0]));
    expect(item?.label).toBe("Settings");
    (item?.click as () => void)();
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("puts the settings in the file menu on other platforms", () => {
    const template = buildMenuTemplate({ platform: "linux", appName: "Make-It-So", settingsLabel: "Settings", onSettings: () => {} });
    expect(template[0].label).toBe("File");
    expect(settingsItem(submenu(template[0]))).toBeDefined();
  });

  it("has no settings item when there is nothing to open", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const template = buildMenuTemplate({ platform, appName: "Make-It-So", settingsLabel: "Settings" });
      expect(settingsItem(submenu(template[0]))).toBeUndefined();
    }
  });

  it("keeps the edit menu, so copy and paste work", () => {
    const template = buildMenuTemplate({ platform: "darwin", appName: "Make-It-So", settingsLabel: "Settings" });
    expect(template.some((i) => i.role === "editMenu")).toBe(true);
  });

  describe("the View menu", () => {
    const text = { view: "View", theme: "Theme", themes: { classic: "Classic", light: "Light", dark: "Dark" }, language: "Language", crewLanguage: "Crew language", languages: { en: "English", ja: "Japanese" } };
    const viewOf = (appearance: Parameters<typeof buildMenuTemplate>[0]["appearance"]) =>
      buildMenuTemplate({ platform: "darwin", appName: "Make-It-So", settingsLabel: "Settings", appearance }).find((i) => i.label === "View");
    const radios = (view: MenuItemConstructorOptions | undefined, label: string) =>
      submenu(submenu(view as MenuItemConstructorOptions).find((i) => i.label === label) as MenuItemConstructorOptions);

    it("marks the theme and the language the page shows, and tells the page what is chosen", () => {
      const onTheme = vi.fn();
      const onLanguage = vi.fn();
      const view = viewOf({ current: { theme: "dark", language: "ja" }, text, onTheme, onLanguage });
      const themes = radios(view, "Theme");
      expect(themes.map((i) => [i.label, i.checked])).toEqual([["Classic", false], ["Light", false], ["Dark", true]]);
      (themes[1].click as () => void)();
      expect(onTheme).toHaveBeenCalledWith("light");
      const languages = radios(view, "Language");
      expect(languages.map((i) => [i.label, i.checked])).toEqual([["English", false], ["Japanese", true]]);
      (languages[0].click as () => void)();
      expect(onLanguage).toHaveBeenCalledWith("en");
    });

    it("marks nothing before the page has said what it shows, and keeps the standard items", () => {
      const view = viewOf({ current: null, text, onTheme: () => {}, onLanguage: () => {} });
      expect(radios(view, "Theme").every((i) => i.checked === false)).toBe(true);
      expect(submenu(view as MenuItemConstructorOptions).some((i) => i.role === "toggleDevTools")).toBe(true);
    });

    it("is the standard View menu without it", () => {
      expect(buildMenuTemplate({ platform: "darwin", appName: "Make-It-So", settingsLabel: "Settings" }).some((i) => i.role === "viewMenu")).toBe(true);
    });

    it("has a menu for the language of the crew only where there is a crew, and marks the one the page reports", () => {
      const onCrewLanguage = vi.fn();
      const withCrew = viewOf({ current: { theme: "dark", language: "ja", crewLanguage: "en" }, text, onTheme: () => {}, onLanguage: () => {}, onCrewLanguage });
      const crew = radios(withCrew, "Crew language");
      expect(crew.map((i) => [i.label, i.checked])).toEqual([["English", true], ["Japanese", false]]);
      (crew[1].click as () => void)();
      expect(onCrewLanguage).toHaveBeenCalledWith("ja");
      const without = viewOf({ current: null, text, onTheme: () => {}, onLanguage: () => {} });
      expect(submenu(without as MenuItemConstructorOptions).some((i) => i.label === "Crew language")).toBe(false);
    });

    it("is the same on the other systems, where the View menu is among the menus after File", () => {
      const template = buildMenuTemplate({ platform: "win32", appName: "Make-It-So", settingsLabel: "Settings", appearance: { current: null, text, onTheme: () => {}, onLanguage: () => {} } });
      expect(template.map((i) => i.label ?? i.role)).toEqual(["File", "editMenu", "View", "windowMenu"]);
    });
  });
});
