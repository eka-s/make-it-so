import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUsageFetcher,
  parseClaudeUsageOutput,
  parseUsageOutput,
  stripAnsi,
} from "./usage-fetcher.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("stripAnsi", () => {
  it("strips ANSI escapes such as color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m plain \x1b[1;32mgreen\x1b[0m")).toBe("red plain green");
  });
});

describe("parseUsageOutput (kiro's /usage)", () => {
  const sample = [
    "\x1b[1mEstimated Usage\x1b[0m | resets on 2026-09-01 | KIRO PRO+",
    "Credits (1876.05 of 2000 covered in plan)",
    "████████████████████ 93.8%",
  ].join("\n");

  it("reads the usage, limit, and reset date, and computes the percentage from used/limit", () => {
    const parsed = parseUsageOutput(sample)!;
    expect(parsed).toMatchObject({ used: 1876.05, limit: 2000, resetsAt: "2026-09-01" });
    expect(parsed.usedPercent).toBeCloseTo(93.8, 1);
  });

  it("does not pick up the displayed decimal \"93.8%\" directly (a regression for the bug that picked up only the 8 after the decimal point)", () => {
    expect(parseUsageOutput(sample)!.usedPercent).toBeGreaterThan(90);
  });

  it("a reset date of only month and day (08/01) can be read too. unknown if absent", () => {
    expect(parseUsageOutput("resets on 08/01\nCredits (10 of 100 covered)")!.resetsAt).toBe("08/01");
    expect(parseUsageOutput("Credits (10 of 100 covered)")!.resetsAt).toBe("unknown");
  });

  it("if the limit is 0, it is treated as 0% (no division by zero)", () => {
    expect(parseUsageOutput("Credits (0 of 0)")!.usedPercent).toBe(0);
  });

  it("null if the usage cannot be read", () => {
    expect(parseUsageOutput("no output")).toBeNull();
  });
});

describe("parseClaudeUsageOutput (claude's /usage)", () => {
  const sample = [
    "Current session: 35% used · resets Aug 9, 8:49pm (Asia/Tokyo)",
    "Current week (all models): 5% used · resets Aug 13, 9pm (Asia/Tokyo)",
  ].join("\n");

  it("reads the weekly usage as the main one and the session usage as the auxiliary one", () => {
    expect(parseClaudeUsageOutput(sample)).toEqual({
      usedPercent: 5,
      resetsAt: "Aug 13, 9pm",
      label: "Weekly",
      secondary: { label: "Session", usedPercent: 35, resetsAt: "Aug 9, 8:49pm" },
    });
  });

  it("if there is no session row, no auxiliary is attached", () => {
    const parsed = parseClaudeUsageOutput("Current week (all models): 5% used · resets Aug 13, 9pm (Asia/Tokyo)")!;
    expect(parsed.secondary).toBeUndefined();
  });

  it("null if there is no weekly row", () => {
    expect(parseClaudeUsageOutput("Current session: 35% used · resets Aug 9, 8:49pm (Asia/Tokyo)")).toBeNull();
  });
});

describe("createUsageFetcher: credits", () => {
  const kiroOutput = "resets on 2026-09-01\nCredits (50 of 100 covered)";
  const claudeOutput = "Current week (all models): 7% used · resets Aug 13, 9pm (Asia/Tokyo)";
  let time: number;
  let runKiroUsage: ReturnType<typeof vi.fn>;
  let runClaudeUsage: ReturnType<typeof vi.fn>;

  function fetcher() {
    return createUsageFetcher({
      commands: { runKiroUsage, runClaudeUsage },
      now: () => time,
    });
  }

  beforeEach(() => {
    time = 1_000_000;
    runKiroUsage = vi.fn(async () => kiroOutput);
    runClaudeUsage = vi.fn(async () => claudeOutput);
  });

  it("uses the kiro or claude command depending on the provider. An unknown provider is null", async () => {
    const f = fetcher();
    expect((await f.fetchUsage("kiro"))?.used).toBe(50);
    expect(runKiroUsage).toHaveBeenCalledTimes(1);
    expect(runClaudeUsage).not.toHaveBeenCalled();

    expect((await f.fetchUsage("claude"))?.usedPercent).toBe(7);
    expect(runClaudeUsage).toHaveBeenCalledTimes(1);

    expect(await f.fetchUsage("other")).toBeNull();
  });

  it("the cache is per provider. Fetching one does not fill the other's cache", async () => {
    const f = fetcher();
    await f.fetchUsage("kiro");
    expect(f.getCached("kiro")?.used).toBe(50);
    expect(f.getCached("claude")).toBeNull();
  });

  it("a re-fetch within 5 minutes returns the cache and does not re-run the command. After 5 minutes it re-fetches", async () => {
    const f = fetcher();
    await f.fetchUsage("kiro");
    time += 4 * 60 * 1000;
    await f.fetchUsage("kiro");
    expect(runKiroUsage).toHaveBeenCalledTimes(1);

    time += 2 * 60 * 1000; // 6 minutes in total
    await f.fetchUsage("kiro");
    expect(runKiroUsage).toHaveBeenCalledTimes(2);
  });

  it("fetchUsageForced ignores the throttling and re-fetches", async () => {
    const f = fetcher();
    await f.fetchUsage("kiro");
    await f.fetchUsageForced("kiro");
    expect(runKiroUsage).toHaveBeenCalledTimes(2);
  });

  it("getCached returns only the cache without triggering a fetch", async () => {
    const f = fetcher();
    expect(f.getCached("kiro")).toBeNull();
    await f.fetchUsage("kiro");
    expect(f.getCached("kiro")?.used).toBe(50);
    expect(runKiroUsage).toHaveBeenCalledTimes(1);
  });

  it("if the command fails, returns the cache if there is one, otherwise null", async () => {
    const f = fetcher();
    runKiroUsage.mockRejectedValueOnce(new Error("timeout"));
    expect(await f.fetchUsage("kiro")).toBeNull();

    await f.fetchUsageForced("kiro"); // succeeds and is cached
    runKiroUsage.mockRejectedValueOnce(new Error("timeout"));
    expect((await f.fetchUsageForced("kiro"))?.used).toBe(50); // old cache
  });

  it("if the output cannot be read, returns null and does not break the existing cache", async () => {
    const f = fetcher();
    await f.fetchUsageForced("kiro");
    runKiroUsage.mockResolvedValueOnce("broken output");
    expect(await f.fetchUsageForced("kiro")).toBeNull();
    expect(f.getCached("kiro")?.used).toBe(50);
  });

  it("the cache is independent per fetcher", async () => {
    const a = fetcher();
    const b = fetcher();
    await a.fetchUsage("kiro");
    expect(b.getCached("kiro")).toBeNull();
  });
});
