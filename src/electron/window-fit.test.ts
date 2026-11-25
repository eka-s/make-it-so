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
  // 480 is the width of the header's contents at no zoom, as an example.
  const classic = (zoom: number) => ({ minWidth: 480, room: 244 / zoom, zoom, screenWidth: 2560 });

  it("is the given width at no zoom", () => {
    expect(minimumWindowWidth(classic(1))).toBe(480);
  });

  it("scales what is between the ends of the header and not the room kept for the window buttons", () => {
    expect(minimumWindowWidth(classic(2))).toBe(716); // (480 - 244) * 2 + 244
    expect(minimumWindowWidth(classic(0.5))).toBe(362); // (480 - 244) * 0.5 + 244
    expect(minimumWindowWidth(classic(1.5))).toBe(598);
  });

  it("uses the room the page reports, which differs per theme (the modern header keeps less)", () => {
    expect(minimumWindowWidth({ minWidth: 480, room: 176 / 2, zoom: 2, screenWidth: 2560 })).toBe(784);
  });

  it("scales nearly all of a narrow minimum where there is little room kept (a window with a frame of its own)", () => {
    expect(minimumWindowWidth({ minWidth: 375, room: 16 / 2, zoom: 2, screenWidth: 2560 })).toBe(734); // the header keeps 8 CSS pixels (16 points) at the right: (375 - 16) * 2 + 16
    expect(minimumWindowWidth({ minWidth: 375, room: 0, zoom: 1, screenWidth: 2560 })).toBe(375);
  });

  it("is never wider than the screen", () => {
    expect(minimumWindowWidth({ ...classic(2), screenWidth: 600 })).toBe(600);
  });
});
