import { describe, expect, it } from "vitest";
import { classifyMemoryLink } from "./memory-link";

describe("classifyMemoryLink", () => {
  it("reads a relative link against the memo it is in, and a leading / against the root of the Memory", () => {
    expect(classifyMemoryLink("procedures/deploy.md", "rollback.md")).toEqual({ kind: "memo", path: "procedures/rollback.md" });
    expect(classifyMemoryLink("procedures/deploy.md", "../notes/idea.md")).toEqual({ kind: "memo", path: "notes/idea.md" });
    expect(classifyMemoryLink("procedures/deploy.md", "./x.md")).toEqual({ kind: "memo", path: "procedures/x.md" });
    expect(classifyMemoryLink("procedures/deploy.md", "/top.md")).toEqual({ kind: "memo", path: "top.md" });
    expect(classifyMemoryLink("top.md", "sub/a.md")).toEqual({ kind: "memo", path: "sub/a.md" });
  });

  it("reads a percent-encoded name, and drops a fragment and a query", () => {
    expect(classifyMemoryLink("a/b.md", "%E3%83%A1%E3%83%A2.md")).toEqual({ kind: "memo", path: "a/メモ.md" });
    expect(classifyMemoryLink("a/b.md", "my%20notes.md#part")).toEqual({ kind: "memo", path: "a/my notes.md" });
    expect(classifyMemoryLink("a/b.md", "c.md?x=1")).toEqual({ kind: "memo", path: "a/c.md" });
  });

  it("opens web and mail addresses outside, in any letter case", () => {
    expect(classifyMemoryLink("a.md", "https://example.com/x.md")).toEqual({ kind: "external" });
    expect(classifyMemoryLink("a.md", "HTTP://example.com")).toEqual({ kind: "external" });
    expect(classifyMemoryLink("a.md", "mailto:x@example.com")).toEqual({ kind: "external" });
  });

  it("goes nowhere for an anchor, another scheme, a protocol-relative address, and nothing", () => {
    for (const href of ["#top", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//evil.example/x.md", "", undefined]) {
      expect(classifyMemoryLink("a.md", href), String(href)).toEqual({ kind: "none" });
    }
  });

  it("goes nowhere for a link that climbs out of the Memory, is not a memo file, or is not a valid encoding", () => {
    for (const href of ["../x.md", "../../x.md", "a/../../x.md", "%2e%2e/x.md", "sub/", "pic.png", "a.md/..", "%E3%81", "a\\b.md", "%5C..%5Cx.md"]) {
      expect(classifyMemoryLink("a.md", href), href).toEqual({ kind: "none" });
    }
  });
});
