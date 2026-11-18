import { describe, expect, it, vi } from "vitest";
import { createAccountUsage, groupCrewByProvider, type AccountCrewMember } from "./account-usage.js";
import type { AccountIdentity } from "./account-identity.js";
import type { CreditsUsageData } from "./types.js";

const claudeUsage: CreditsUsageData = { usedPercent: 5, resetsAt: "Aug 13", label: "Weekly" };
const kiroUsage: CreditsUsageData = { usedPercent: 50, used: 50, limit: 100, resetsAt: "2026-09-01" };
const me: AccountIdentity = { key: "claude:org-1", label: "me@example.com", plan: "pro" };

const crew: Record<string, AccountCrewMember> = {
  first_officer: { name: "Alex" },
  chief_engineer: { name: "Sam", provider: "claude" },
  science_officer: { name: "Jo", provider: "kiro" },
  away: { name: "Data", provider: "claude", host: { name: "remote" } },
};

function setup(overrides: { identify?: () => Promise<AccountIdentity | null> } = {}) {
  const cache = new Map<string, CreditsUsageData>();
  const source = { claude: claudeUsage, kiro: kiroUsage } as Record<string, CreditsUsageData>;
  const usage = {
    fetchUsage: vi.fn(async (p: string) => {
      if (source[p]) cache.set(p, source[p]);
      return source[p] ?? null;
    }),
    fetchUsageForced: vi.fn(async (p: string) => {
      if (source[p]) cache.set(p, source[p]);
      return source[p] ?? null;
    }),
    getCached: (p: string) => cache.get(p) ?? null,
  };
  const identify = vi.fn(overrides.identify ?? (async () => me));
  const service = createAccountUsage({ crew, defaultProvider: "claude", usage, identify: { claude: identify } });
  return { service, usage, identify };
}

describe("groupCrewByProvider", () => {
  it("local crew members are grouped per provider (the default provider if none is specified), and remote crew members are left out of the count", () => {
    const { byProvider, untracked } = groupCrewByProvider(crew, "claude");
    expect([...byProvider]).toEqual([
      ["claude", ["Alex", "Sam"]],
      ["kiro", ["Jo"]],
    ]);
    expect(untracked).toEqual(["Data"]);
  });
});

describe("createAccountUsage", () => {
  it("even before fetching, the mapping of accounts to crew members is returned (usage is null, identification not done yet)", () => {
    const { service } = setup();
    expect(service.snapshot()).toEqual({
      accounts: [
        { key: "claude", provider: "claude", label: null, usage: null, crews: ["Alex", "Sam"] },
        { key: "kiro", provider: "kiro", label: null, usage: null, crews: ["Jo"] },
      ],
      untracked: ["Data"],
    });
  });

  it("after fetching, claude has the identified account's key, name, and plan, while kiro is not identified and keeps the provider name with its usage", async () => {
    const { service } = setup();
    expect(await service.refresh()).toEqual({
      accounts: [
        { key: "claude:org-1", provider: "claude", label: "me@example.com", plan: "pro", usage: claudeUsage, crews: ["Alex", "Sam"] },
        { key: "kiro", provider: "kiro", label: null, usage: kiroUsage, crews: ["Jo"] },
      ],
      untracked: ["Data"],
    });
  });

  it("once identified, a normal refresh does not identify again. A forced refresh re-fetches", async () => {
    const { service, identify, usage } = setup();
    await service.refresh();
    await service.refresh();
    expect(identify).toHaveBeenCalledTimes(1);
    expect(usage.fetchUsageForced).not.toHaveBeenCalled();

    await service.refresh({ force: true });
    expect(identify).toHaveBeenCalledTimes(2);
    expect(usage.fetchUsageForced).toHaveBeenCalledWith("claude");
    expect(usage.fetchUsageForced).toHaveBeenCalledWith("kiro");
  });

  it("refreshes asked for at the same moment share one run (a reload storm does not start the commands once per request)", async () => {
    const { service, identify, usage } = setup();
    const results = await Promise.all([service.refresh({ force: true }), service.refresh({ force: true }), service.refresh({ force: true })]);
    expect(identify).toHaveBeenCalledTimes(1);
    expect(usage.fetchUsageForced).toHaveBeenCalledTimes(2); // claude and kiro, once each
    expect(results[1]).toBe(results[0]);

    await service.refresh({ force: true }); // a new one after the first finished runs again
    expect(identify).toHaveBeenCalledTimes(2);
  });

  it("a plain refresh is served by a forced one that is running, but a forced one is not served by a plain one", async () => {
    const { service, identify } = setup();
    const forced = service.refresh({ force: true });
    await service.refresh();
    await forced;
    expect(identify).toHaveBeenCalledTimes(1);

    const plain = service.refresh();
    await service.refresh({ force: true });
    await plain;
    expect(identify).toHaveBeenCalledTimes(2); // the forced one ran (identifying again) and was not replaced by the plain one
  });

  it("even when it cannot be identified, the usage is not stopped. It is retried at the next refresh", async () => {
    const identify = vi.fn<() => Promise<AccountIdentity | null>>().mockRejectedValueOnce(new Error("no claude")).mockResolvedValue(me);
    const { service } = setup({ identify });
    const first = await service.refresh();
    expect(first.accounts[0]).toMatchObject({ key: "claude", label: null, usage: claudeUsage });

    const second = await service.refresh();
    expect(second.accounts[0]).toMatchObject({ key: "claude:org-1", label: "me@example.com" });
  });

  it("when a forced refresh can no longer identify (e.g. logged out), the old account name is not kept on display", async () => {
    const identify = vi.fn<() => Promise<AccountIdentity | null>>().mockResolvedValueOnce(me).mockResolvedValue(null);
    const { service } = setup({ identify });
    await service.refresh();
    const after = await service.refresh({ force: true });
    expect(after.accounts[0]).toMatchObject({ key: "claude", label: null });
  });
});
