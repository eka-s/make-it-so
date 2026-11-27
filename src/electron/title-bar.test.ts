import { describe, expect, it } from "vitest";
import { overlayHeight, popupPosition, titleBarOverlay } from "./title-bar.js";

describe("the window buttons drawn over the header", () => {
  it("are as tall as the header is on the screen, at any zoom", () => {
    expect(overlayHeight(56, 1)).toBe(56);
    expect(overlayHeight(56, 1.5)).toBe(84);
    expect(overlayHeight(56, 0.5)).toBe(28);
    expect(overlayHeight(0, 1)).toBe(1);
  });

  it("take the header's color in each theme, with symbols that can be read on it", () => {
    expect(titleBarOverlay("classic", 56, 1)).toEqual({ color: "#ff9900", symbolColor: "#000000", height: 56 });
    expect(titleBarOverlay("light", 48, 2)).toEqual({ color: "#0ea5e9", symbolColor: "#ffffff", height: 96 });
    expect(titleBarOverlay("dark", 56, 1)).toEqual({ color: "#0369a1", symbolColor: "#ffffff", height: 56 });
  });
});

describe("where the app's menu opens", () => {
  it("scales the page's position by the zoom, to whole pixels", () => {
    expect(popupPosition({ x: 100, y: 40 }, 1)).toEqual({ x: 100, y: 40 });
    expect(popupPosition({ x: 100.4, y: 40.5 }, 1.5)).toEqual({ x: 151, y: 61 });
    expect(popupPosition({ x: 100, y: 40 }, 0.5)).toEqual({ x: 50, y: 20 });
  });
});
