import { describe, it, expect } from "vitest";
import { createMcpTokens } from "./mcp-token.js";

describe("per-session MCP tokens", () => {
  const tokens = createMcpTokens("ship-secret");

  it("accepts the token issued for the same agent and mission", () => {
    expect(tokens.verify("first_officer", "m1", tokens.issue("first_officer", "m1"))).toBe(true);
  });

  it("refuses a token presented with another agent's or mission's identity", () => {
    const token = tokens.issue("first_officer", "m1");
    expect(tokens.verify("chief_engineer", "m1", token)).toBe(false);
    expect(tokens.verify("first_officer", "m2", token)).toBe(false);
  });

  it("does not confuse identities that concatenate to the same text", () => {
    expect(tokens.issue("a", "bc")).not.toBe(tokens.issue("ab", "c"));
  });

  it("refuses a missing, malformed or other ship's token", () => {
    expect(tokens.verify("a", "m", undefined)).toBe(false);
    expect(tokens.verify("a", "m", ["x"])).toBe(false);
    expect(tokens.verify("a", "m", "x")).toBe(false);
    expect(tokens.verify("a", "m", createMcpTokens("other").issue("a", "m"))).toBe(false);
  });
});
