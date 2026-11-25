import type { MenuItemConstructorOptions } from "electron";

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
}): MenuItemConstructorOptions[] {
  const settings: MenuItemConstructorOptions[] = options.onSettings
    ? [{ label: options.settingsLabel, accelerator: "CmdOrCtrl+,", click: options.onSettings }, { type: "separator" }]
    : [];
  const common: MenuItemConstructorOptions[] = [{ role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }];
  if (options.platform === "darwin") {
    return [
      { label: options.appName, submenu: [{ role: "about" }, { type: "separator" }, ...settings, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
      ...common,
    ];
  }
  return [{ label: "File", submenu: [...settings, { role: "quit" }] }, ...common];
}
