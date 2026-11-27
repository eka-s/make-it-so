import path from "node:path";

/**
 * The window icon on Linux, where a window has no icon unless the app gives one (the packaged app's icon file is not the window's: the desktop reads it for the launcher only).
 * A packaged app carries the picture beside its resources (`extraResources` in package.json); an app run from the build finds it in the repository's `build/`.
 */
export function appIconPath(options: { packaged: boolean; resourcesPath: string; electronDir: string }): string {
  return options.packaged ? path.join(options.resourcesPath, "icon.png") : path.join(options.electronDir, "..", "..", "build", "icon.png");
}
