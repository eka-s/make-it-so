import path from "node:path";
import { describe, expect, it } from "vitest";
import { appIconPath } from "./app-icon.js";

describe("the window icon", () => {
  it("is beside the resources in a packaged app", () => {
    expect(appIconPath({ packaged: true, resourcesPath: "/opt/app/resources", electronDir: "/opt/app/resources/app.asar/dist/electron" })).toBe(path.join("/opt/app/resources", "icon.png"));
  });

  it("is in the repository's build directory when run from the build (dist/electron is two levels down)", () => {
    expect(appIconPath({ packaged: false, resourcesPath: "/x/electron/dist/resources", electronDir: "/repo/dist/electron" })).toBe(path.join("/repo", "build", "icon.png"));
  });
});
