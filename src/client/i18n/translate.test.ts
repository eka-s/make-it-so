import { describe, expect, it } from "vitest";
import { interpolate, localeOf, messageForError, placeholdersOf, translateOr } from "./translate";

describe("interpolate", () => {
  it("replaces {name} placeholders with the given values", () => {
    expect(interpolate("Hello {name}, you have {count} items", { name: "Alex", count: 3 })).toBe("Hello Alex, you have 3 items");
  });
  it("replaces every occurrence and leaves a placeholder without a value as written", () => {
    expect(interpolate("{a}{a}{b}", { a: "x" })).toBe("xx{b}");
  });
  it("returns the text as is when there are no params", () => {
    expect(interpolate("No {placeholders} here")).toBe("No {placeholders} here");
  });
});

describe("placeholdersOf", () => {
  it("lists the distinct placeholder names, sorted", () => {
    expect(placeholdersOf("{b} and {a} and {b}")).toEqual(["a", "b"]);
    expect(placeholdersOf("none")).toEqual([]);
  });
});

describe("translateOr", () => {
  it("uses the dictionary text when the key exists, else the fallback", () => {
    expect(translateOr({ "error.busy": "Busy: {who}" }, "error.busy", "fallback", { who: "Sam" })).toBe("Busy: Sam");
    expect(translateOr({}, "error.unknown", "fallback")).toBe("fallback");
  });
});

describe("localeOf", () => {
  it("maps each language to a locale for dates and numbers", () => {
    expect(localeOf("en")).toBe("en-US");
    expect(localeOf("ja")).toBe("ja-JP");
  });
});

describe("messageForError", () => {
  const messages = { "error.agent_busy": "This crew member is busy." };
  it("translates a known error code", () => {
    expect(messageForError(messages, { error: "agent_busy", message: "English fallback" }, "x")).toBe("This crew member is busy.");
  });
  it("falls back to the server's message, then to the plain error string, then to the given fallback", () => {
    expect(messageForError(messages, { error: "unknown_code", message: "Server message" }, "x")).toBe("Server message");
    expect(messageForError(messages, { error: "Unknown role" }, "x")).toBe("Unknown role");
    expect(messageForError(messages, undefined, "HTTP 500")).toBe("HTTP 500");
  });
});
