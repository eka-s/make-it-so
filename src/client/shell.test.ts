import { describe, expect, it } from "vitest";
import { inDesktop, shellOf } from "./shell";

const MAC_ELECTRON = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Make-It-So/0.1.0 Chrome/156.0.0.0 Electron/45.4.1 Safari/537.36";

describe("which window the page is in", () => {
  it("knows the desktop app on macOS", () => {
    expect(shellOf(MAC_ELECTRON)).toBe("desktop-mac");
  });

  it("leaves a browser alone, on macOS and elsewhere", () => {
    expect(shellOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")).toBeNull();
    expect(shellOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36")).toBeNull();
  });

  it("leaves the desktop app on other systems alone: only macOS hides the title bar", () => {
    expect(shellOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Electron/45.4.1 Safari/537.36")).toBeNull();
    expect(shellOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Electron/45.4.1 Safari/537.36")).toBeNull();
  });
});

describe("whether the page is in the desktop app", () => {
  it("is true on every system the app runs on, and false in a browser", () => {
    expect(inDesktop(MAC_ELECTRON)).toBe(true);
    expect(inDesktop("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Electron/45.4.1 Safari/537.36")).toBe(true);
    expect(inDesktop("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")).toBe(false);
  });
});
