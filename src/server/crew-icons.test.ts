import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteCrewIcon, detectImageType, findCrewIcon, MAX_ICON_BYTES, saveCrewIcon } from "./crew-icons.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mis-icons-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50, 1]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe("detectImageType", () => {
  it("png, jpg, webp, and gif are recognized by the leading bytes of the content", () => {
    expect(detectImageType(PNG)?.ext).toBe("png");
    expect(detectImageType(JPG)?.ext).toBe("jpg");
    expect(detectImageType(WEBP)?.ext).toBe("webp");
    expect(detectImageType(GIF)?.ext).toBe("gif");
  });

  it("SVG, text, empty, truncated, and RIFF that is not WEBP are not accepted as images", () => {
    expect(detectImageType(SVG)).toBeNull();
    expect(detectImageType(new TextEncoder().encode("hello"))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
    expect(detectImageType(Uint8Array.from([0x89, 0x50]))).toBeNull();
    expect(detectImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]))).toBeNull(); // AVI
  });
});

describe("saveCrewIcon / findCrewIcon / deleteCrewIcon", () => {
  it("when saved, it is written to personnel/{ID}.{extension} and can be found (the kind is decided by the content)", () => {
    expect(saveCrewIcon(root, "alex", PNG)).toEqual({ ok: true });
    const icon = findCrewIcon(root, "alex");
    expect(icon).toMatchObject({ file: path.join(root, "personnel", "alex.png"), mime: "image/png" });
    expect(fs.readFileSync(icon!.file)).toEqual(Buffer.from(PNG));
  });

  it("saving again in another format removes the file with the old extension (one image per person)", () => {
    saveCrewIcon(root, "alex", PNG);
    saveCrewIcon(root, "alex", JPG);
    expect(fs.readdirSync(path.join(root, "personnel"))).toEqual(["alex.jpg"]);
    expect(findCrewIcon(root, "alex")?.mime).toBe("image/jpeg");
  });

  it("other files in the same place, such as the persona file (.md), are not touched", () => {
    fs.mkdirSync(path.join(root, "personnel"));
    fs.writeFileSync(path.join(root, "personnel", "alex.md"), "persona");
    saveCrewIcon(root, "alex", PNG);
    deleteCrewIcon(root, "alex");
    expect(fs.readFileSync(path.join(root, "personnel", "alex.md"), "utf-8")).toBe("persona");
  });

  it("if validation fails, the reason is returned and nothing is written (SVG, too large, empty, invalid ID)", () => {
    expect(saveCrewIcon(root, "alex", SVG)).toEqual({ ok: false, reason: "unsupported_type" });
    expect(saveCrewIcon(root, "alex", new Uint8Array(MAX_ICON_BYTES + 1))).toEqual({ ok: false, reason: "too_large" });
    expect(saveCrewIcon(root, "alex", new Uint8Array())).toEqual({ ok: false, reason: "empty" });
    expect(saveCrewIcon(root, "../evil", PNG)).toEqual({ ok: false, reason: "invalid_member" });
    expect(saveCrewIcon(root, "a/b", PNG)).toEqual({ ok: false, reason: "invalid_member" });
    expect(fs.existsSync(path.join(root, "personnel"))).toBe(false);
  });

  it("a size exactly at the limit passes", () => {
    const exact = new Uint8Array(MAX_ICON_BYTES);
    exact.set(PNG);
    expect(saveCrewIcon(root, "alex", exact)).toEqual({ ok: true });
  });

  it("after deleting, it is not found. Deleting something that does not exist is not an error. An invalid ID is not looked up", () => {
    saveCrewIcon(root, "alex", PNG);
    expect(deleteCrewIcon(root, "alex")).toBe(true);
    expect(findCrewIcon(root, "alex")).toBeNull();
    expect(deleteCrewIcon(root, "alex")).toBe(false);
    expect(findCrewIcon(root, "../alex")).toBeNull();
    expect(deleteCrewIcon(root, "../alex")).toBe(false);
  });
});
