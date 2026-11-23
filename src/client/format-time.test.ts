import { describe, expect, it } from "vitest";
import { formatMessageTime } from "./format-time";

describe("formatMessageTime", () => {
  it("is yyyy/mm/dd hh:mm:ss in the local time zone, every part padded to two digits", () => {
    const local = new Date(2026, 0, 5, 3, 4, 9);
    expect(formatMessageTime(local.toISOString())).toBe("2026/01/05 03:04:09");
  });
});
