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
});
