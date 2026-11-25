import { beforeEach, describe, expect, it } from "vitest";
import { ClaudeAgentClient } from "./claude-agent-client.js";
import { KiroAgentClient } from "./kiro-agent-client.js";
import { FakeAcpProcess } from "./testing/fake-acp-process.js";

const settings = {
  mcpPort: 4000,
  acp: { kiro: { command: "kiro-cli", args: ["acp"] }, claude: { command: "claude-acp", args: ["--flag"] } },
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("startup command per provider", () => {
  it("kiro adds --agent to the configured arguments if there is an agent name. Session resumption is needed", () => {
    const client = new KiroAgentClient(settings);
    expect(client.buildSpawnArgs()).toEqual({ command: "kiro-cli", args: ["acp"] });
    expect(client.buildSpawnArgs("sam")).toEqual({ command: "kiro-cli", args: ["acp", "--agent", "sam"] });
    expect(client.requiresSessionResume()).toBe(true);
  });

  it("claude uses the configured command and arguments as is (the agent name is not used). Session resumption is not needed", () => {
    const client = new ClaudeAgentClient(settings);
    expect(client.buildSpawnArgs("sam")).toEqual({ command: "claude-acp", args: ["--flag"] });
    expect(client.requiresSessionResume()).toBe(false);
  });
});

describe("agent selection", () => {
  it("kiro already received it via the startup argument (--agent), so selecting after session creation does nothing and returns true. claude returns false if there are no options", async () => {
    await expect(new KiroAgentClient(settings).setAgent()).resolves.toBe(true);
    await expect(new ClaudeAgentClient(settings).setAgent("s1", "scout")).resolves.toBe(false);
  });
});

describe("kiro's metadata notification", () => {
  let proc: FakeAcpProcess;
  let usages: number[];
  let credits: Array<[number, number | null, string]>;

  beforeEach(() => {
    proc = new FakeAcpProcess();
    const client = new KiroAgentClient(settings, () => proc.asChildProcess());
    client.spawn(undefined, "/work");
    usages = [];
    credits = [];
    client.on("usageUpdate", (p) => usages.push(p));
    client.on("creditUsage", (amount, ms, unit) => credits.push([amount, ms, unit]));
  });

  const metadata = (params: Record<string, unknown>) => proc.send({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params });

  it("notifies the credits of the new format (meteringUsage), the context usage, and the duration", async () => {
    metadata({ contextUsagePercentage: 12.5, meteringUsage: [{ value: 0.4, unit: "credit" }], turnDurationMs: 900 });
    await tick();
    expect(usages).toEqual([12.5]);
    expect(credits).toEqual([[0.4, 900, "kiro_credits"]]);
  });

  it("falls back to the old format (credits) too. If the new format exists, it takes priority", async () => {
    metadata({ credits: 0.2 });
    metadata({ credits: 9, meteringUsage: [{ value: 0.7, unit: "credit" }] });
    await tick();
    expect(credits).toEqual([[0.2, null, "kiro_credits"], [0.7, null, "kiro_credits"]]);
  });

  it("a notification with neither usage nor credits, and other notifications, are ignored", async () => {
    metadata({});
    proc.send({ jsonrpc: "2.0", method: "_other/thing", params: { credits: 1 } });
    await tick();
    expect(usages).toEqual([]);
    expect(credits).toEqual([]);
  });
});
