import { describe, expect, it } from "vitest";
import { parseClaudeAuthStatus } from "./account-identity.js";

const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "me@example.com",
    orgId: "org-1",
    orgName: "me@example.com's Organization",
    subscriptionType: "pro",
    ...over,
  });

describe("parseClaudeAuthStatus", () => {
  it("the key is the provider and the organization ID, the display is the email address, and the plan is read too (the email alone is not used for the key, because personal and organization quotas would mix)", () => {
    expect(parseClaudeAuthStatus(status())).toEqual({ key: "claude:org-1", label: "me@example.com", plan: "pro" });
  });

  it("even with the same email address, a different organization ID is a different account", () => {
    const a = parseClaudeAuthStatus(status({ orgId: "org-1" }));
    const b = parseClaudeAuthStatus(status({ orgId: "org-2" }));
    expect(a?.key).not.toBe(b?.key);
  });

  it("without an email address the organization name is used for display, and without that the organization ID. The plan may be absent", () => {
    expect(parseClaudeAuthStatus(status({ email: undefined }))?.label).toBe("me@example.com's Organization");
    expect(parseClaudeAuthStatus(status({ email: undefined, orgName: undefined, subscriptionType: undefined }))).toEqual({
      key: "claude:org-1",
      label: "org-1",
      plan: undefined,
    });
  });

  it("what cannot be identified is null, without guessing (not logged in, no organization ID = API-key auth etc., not JSON, empty)", () => {
    expect(parseClaudeAuthStatus(status({ loggedIn: false }))).toBeNull();
    expect(parseClaudeAuthStatus(status({ orgId: undefined }))).toBeNull();
    expect(parseClaudeAuthStatus(status({ orgId: "  " }))).toBeNull();
    expect(parseClaudeAuthStatus("Not logged in")).toBeNull();
    expect(parseClaudeAuthStatus("")).toBeNull();
    expect(parseClaudeAuthStatus("null")).toBeNull();
  });
});
