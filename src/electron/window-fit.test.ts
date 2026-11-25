import { describe, expect, it } from "vitest";
import { minimumWindowWidth, windowButtonsTop } from "./window-fit.js";

describe("where the window buttons go", () => {
  it("puts them in the middle of the header on the screen, at any zoom", () => {
    expect(windowButtonsTop(56, 1)).toBe(22);
    expect(windowButtonsTop(40, 1)).toBe(14);
    expect(windowButtonsTop(56, 2)).toBe(50); // the header is 112 points tall
    expect(windowButtonsTop(56, 0.5)).toBe(8); // 28 points tall
  });
});

describe("the narrowest window", () => {
  // The classic header keeps 88 + 156 points for the buttons; the page reports that room in CSS pixels, which is that many points divided by the zoom.
  const classic = (zoom: number) => ({ minWidth: 960, room: 244 / zoom, zoom, screenWidth: 2560 });

  it("is the given width at no zoom", () => {
    expect(minimumWindowWidth(classic(1))).toBe(960);
  });

  it("scales what is between the ends of the header and not the room kept for the window buttons", () => {
    expect(minimumWindowWidth(classic(2))).toBe(1676); // (960 - 244) * 2 + 244
    expect(minimumWindowWidth(classic(0.5))).toBe(602); // (960 - 244) * 0.5 + 244
    expect(minimumWindowWidth(classic(1.5))).toBe(1318);
  });

  it("uses the room the page reports, which differs per theme (the modern header keeps less)", () => {
    expect(minimumWindowWidth({ minWidth: 960, room: 176 / 2, zoom: 2, screenWidth: 2560 })).toBe(1744);
  });

  it("is never wider than the screen", () => {
    expect(minimumWindowWidth({ ...classic(2), screenWidth: 1440 })).toBe(1440);
  });
});
