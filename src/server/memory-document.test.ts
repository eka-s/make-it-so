import { describe, expect, it } from "vitest";
import { parseMemoryFile, serializeMemoryFile } from "./memory-document.js";
import { lineDiff } from "./memory-diff.js";

describe("memory file", () => {
  it("reads and writes a concept, keeping the keys it does not know", () => {
    const text = "---\ntype: note\ndescription: Hi\nverified:\n  by: someone\n---\nBody\n";
    const parsed = parseMemoryFile(text)!;
    expect(parsed.front).toMatchObject({ type: "note", description: "Hi", status: "stable", extra: { verified: { by: "someone" } } });
    expect(serializeMemoryFile(parsed.front, parsed.body)).toContain("verified:\n  by: someone");
    expect(parseMemoryFile(serializeMemoryFile(parsed.front, parsed.body))?.body).toBe("Body\n");
  });

  it("writes a flag only for a draft or a deprecated memo, and keeps a hand-written tags key without reading it", () => {
    const parsed = parseMemoryFile("---\ntype: note\ndescription: Hi\ntags:\n  - x\n---\nBody\n")!;
    expect(parsed.front.status).toBe("stable");
    const settled = serializeMemoryFile(parsed.front, parsed.body);
    expect(settled).not.toContain("status:");
    expect(settled).toContain("tags:\n  - x");
    expect(serializeMemoryFile({ ...parsed.front, status: "draft" }, parsed.body)).toContain("status: draft");
  });

  it("is not a concept without frontmatter, with broken YAML, or with an empty type", () => {
    expect(parseMemoryFile("# just text")).toBeNull();
    expect(parseMemoryFile("---\ntype: [\n---\nx")).toBeNull();
    expect(parseMemoryFile("---\ntype: \"\"\n---\nx")).toBeNull();
  });
});

describe("lineDiff", () => {
  it("shows removed and added lines with a little context, and nothing when equal", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\n")).toBe(" a\n-b\n+B\n c");
    expect(lineDiff("same", "same")).toBe("");
    expect(lineDiff("", "new\n")).toBe("+new");
  });
});
