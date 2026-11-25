import { describe, expect, it } from "vitest";
import { launcherLanguage, menuText, renderLauncherPage, settingsLabel } from "./launcher-page.js";

describe("the ship list", () => {
  it("offers each ship as a form button that posts its id, labelled with its name", () => {
    const html = renderLauncherPage({ ships: [{ id: "alpha", name: "Alpha Ship" }, { id: "beta" }], language: "en" });
    expect(html).toContain('<button type="submit" name="ship" value="alpha"><div class="name">Alpha Ship</div><div class="meta">alpha</div></button>');
    expect(html).toContain('name="ship" value="beta"><div class="name">beta</div>');
  });

  it("escapes what the ship files say, so a name cannot add markup to the page", () => {
    const html = renderLauncherPage({ ships: [{ id: "x", name: '<img src=x onerror="alert(1)">' }], language: "en" });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("shows a ship whose file cannot be read, but does not let it be chosen", () => {
    const html = renderLauncherPage({ ships: [{ id: "broken", error: "bad yaml" }], language: "en" });
    expect(html).toContain("disabled");
    expect(html).toContain("Cannot be opened: bad yaml");
  });

  it("says how to make a ship when there is none, and still offers the settings where a ship is made", () => {
    const html = renderLauncherPage({ ships: [], language: "en" });
    expect(html).toContain("There is no ship yet.");
    expect(html).toContain("settings screen");
    expect(html).not.toContain('name="ship"');
    expect(html).toContain('<form class="settings" method="post" action="/settings">');
  });

  it("offers the settings below the ships", () => {
    const html = renderLauncherPage({ ships: [{ id: "a" }], language: "en" });
    expect(html.indexOf('name="ship"')).toBeLessThan(html.indexOf('action="/settings"'));
  });

  it("allows no script on the page", () => {
    expect(renderLauncherPage({ ships: [{ id: "a" }], language: "en" })).toContain("default-src 'none'");
  });

  it("is in Japanese for a Japanese system and in English otherwise", () => {
    expect(launcherLanguage("ja-JP")).toBe("ja");
    expect(launcherLanguage("en-US")).toBe("en");
    expect(launcherLanguage("fr")).toBe("en");
    expect(renderLauncherPage({ ships: [], language: "ja" })).toContain("まだ艦がありません");
    expect(settingsLabel("ja")).toBe("設定");
    expect(settingsLabel("en")).toBe("Settings");
  });
});

describe("the words of the app menu", () => {
  it("has every word in English and in Japanese, and names each language in its own language in both", () => {
    for (const language of ["en", "ja"] as const) {
      const text = menuText(language);
      for (const word of [text.view, text.theme, text.language, text.crewLanguage, ...Object.values(text.themes), ...Object.values(text.languages)]) expect(word).not.toBe("");
      expect(text.languages).toEqual({ en: "English", ja: "日本語" });
    }
    expect(menuText("en").view).toBe("View");
    expect(menuText("ja").view).toBe("表示");
  });
});
