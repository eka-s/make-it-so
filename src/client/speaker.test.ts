import { describe, expect, it } from "vitest";
import { speakerName } from "./speaker";
import type { CrewMemberConfig } from "./types";

const crew = { chief_engineer: { name: "Jordan" } } as unknown as Record<string, CrewMemberConfig>;

describe("speakerName", () => {
  it("shows the captain's label for the captain", () => {
    expect(speakerName("captain", crew, "Captain")).toBe("Captain");
  });

  it("shows the crew member's display name (not a fixed name) for any crew role", () => {
    expect(speakerName("chief_engineer", crew, "Captain")).toBe("Jordan");
  });

  it("falls back to the role when the crew has no entry (or the crew is not loaded yet)", () => {
    expect(speakerName("ensign", crew, "Captain")).toBe("ensign");
    expect(speakerName("ensign", undefined, "Captain")).toBe("ensign");
  });
});
