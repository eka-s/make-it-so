import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseAcpClient } from "./base-acp-client.js";
import type { PermissionRequest } from "./agent-client.interface.js";
import { logger } from "./logger.js";
import { FakeAcpProcess } from "./testing/fake-acp-process.js";

const settings = {
  port: 4000,
  acp: { kiro: { command: "kiro", args: [] }, claude: { command: "claude-acp", args: ["--flag"] } },
};

class TestClient extends BaseAcpClient {
  buildSpawnArgs(agentName?: string) {
    return { command: "agent", args: agentName ? ["--agent", agentName] : [] };
  }
}

let proc: FakeAcpProcess;
let spawned: Array<{ command: string; args: string[]; cwd: string }>;
let client: TestClient;

// readline's 'line' arrives asynchronously, so the event loop is run once around
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const lastWritten = () => proc.written.at(-1)!;

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => {});
  proc = new FakeAcpProcess();
  spawned = [];
  client = new TestClient(settings, (command, args, options) => {
    spawned.push({ command, args, cwd: options.cwd });
    return proc.asChildProcess();
  });
  client.spawn(undefined, "/work");
});
afterEach(() => vi.restoreAllMocks());

describe("startup", () => {
  it("locally, the agent's command is started in the given cwd", () => {
    expect(spawned).toEqual([{ command: "agent", args: [], cwd: "/work" }]);
    expect(client.pid).toBe(4242);
  });

  it("the agent name is passed to the command's arguments", () => {
    const c = new TestClient(settings, (command, args, options) => {
      spawned.push({ command, args, cwd: options.cwd });
      return new FakeAcpProcess().asChildProcess();
    });
    c.spawn("sam", "/work");
    expect(spawned.at(-1)!.args).toEqual(["--agent", "sam"]);
  });

  it("when a remote host is specified, the same command is run over ssh (cwd is a path on the remote side)", () => {
    const c = new TestClient(settings, (command, args, options) => {
      spawned.push({ command, args, cwd: options.cwd });
      return new FakeAcpProcess().asChildProcess();
    });
    c.spawn(undefined, "/remote/work", { name: "dock", destination: "dock" });
    expect(spawned.at(-1)!.command).toBe("ssh");
    expect(spawned.at(-1)!.args.join(" ")).toContain("/remote/work");
    expect(spawned.at(-1)!.cwd).toBe(process.cwd());
  });

  it("a command that cannot be started is a failure of this agent only: exit is notified once and requests fail", async () => {
    const exits: Array<number | null> = [];
    client.on("exit", (code) => exits.push(code));
    const pending = client.initialize();
    const rejected = expect(pending).rejects.toThrow(/could not be started or failed: spawn agent ENOENT/);
    proc.fail();
    await rejected;
    proc.exit(1); // an "exit" after the "error" is not reported a second time
    expect(exits).toEqual([null]);
    expect(client.pid).toBeNull();
  });

  it("an error while writing to the agent's stdin does not crash (the exit that follows is what ends the session)", () => {
    expect(() => proc.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
  });

  it("kill() rejects waiting requests at once, and a process that ignores SIGTERM is killed with SIGKILL after a grace period", async () => {
    vi.useFakeTimers();
    try {
      const pending = client.initialize();
      const rejected = expect(pending).rejects.toThrow(/was killed/);
      client.kill();
      await rejected;
      expect(proc.signals).toEqual([undefined]);
      vi.advanceTimersByTime(5000);
      expect(proc.signals).toEqual([undefined, "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a process that left on SIGTERM is not killed again", () => {
    vi.useFakeTimers();
    try {
      client.kill();
      proc.exitCode = 0;
      vi.advanceTimersByTime(5000);
      expect(proc.signals).toEqual([undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("when the process exits, exit is notified and all requests awaiting a response fail", async () => {
    const exits: Array<number | null> = [];
    client.on("exit", (code) => exits.push(code));
    const pending = client.initialize();
    const rejected = expect(pending).rejects.toThrow(/exited with code 3/);
    proc.exit(3);
    await rejected;
    expect(exits).toEqual([3]);
    expect(client.pid).toBeNull();
  });

  it("kill() stops the child process. The stderr output is left in the error log", async () => {
    proc.stderr.write("boom\n");
    await tick();
    expect(logger.error).toHaveBeenCalledWith("[acp:stderr] boom");
    client.kill();
    expect(proc.killed).toBe(true);
    expect(client.pid).toBeNull();
  });
});

describe("requests and responses (JSON-RPC)", () => {
  it("initialize sends the protocol version and the client name, and returns the contents of the response", async () => {
    const result = client.initialize();
    expect(lastWritten()).toMatchObject({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "make-it-so" } } });
    proc.respond(lastWritten().id, { agentInfo: "x" });
    await expect(result).resolves.toEqual({ agentInfo: "x" });
  });

  it("an error response becomes a reject. Lines that are not JSON and ids with no pending request are ignored", async () => {
    const result = client.initialize();
    proc.send("this is not JSON");
    proc.respond(9999);
    proc.send({ jsonrpc: "2.0", id: lastWritten().id, error: { code: -1, message: "failed" } });
    await expect(result).rejects.toThrow("failed");
  });

  it("request ids are sequential, and even when sent in parallel the responses are matched correctly", async () => {
    const a = client.initialize();
    const b = client.initialize();
    const [first, second] = proc.written;
    expect(Number(second.id)).toBe(Number(first.id) + 1);
    proc.respond(second.id, { n: 2 });
    proc.respond(first.id, { n: 1 });
    expect(await a).toEqual({ n: 1 });
    expect(await b).toEqual({ n: 2 });
  });

  it("newSession passes the bulletin-board MCP with the cwd, additional directories, and identification header, and returns the sessionId", async () => {
    const result = client.newSession("/work", ["/extra"], { "x-crew": "sam", "x-mission": "m1" });
    expect(lastWritten()).toMatchObject({
      method: "session/new",
      params: {
        cwd: "/work",
        additionalDirectories: ["/extra"],
        mcpServers: [{
          name: "board",
          type: "http",
          url: "http://127.0.0.1:4000/mcp",
          headers: [{ name: "x-crew", value: "sam" }, { name: "x-mission", value: "m1" }],
        }],
      },
    });
    proc.respond(lastWritten().id, { sessionId: "s1" });
    await expect(result).resolves.toBe("s1");
  });

  it("sendCancel sends a notification (no id). An exception if stdin is unavailable", () => {
    client.sendCancel("s1");
    expect(lastWritten()).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
    proc.stdin.destroy();
    expect(() => client.sendCancel("s1")).toThrow(/not writable/);
  });
});

describe("model and permission mode", () => {
  const configOptions = [
    { id: "model", currentValue: "opus", options: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] },
    { id: "mode", options: [{ value: "default" }, { value: "auto" }] },
    { id: "agent", currentValue: "default", options: [{ value: "default" }, { value: "scout" }] },
  ];

  async function startSession(result: Record<string, unknown>) {
    const session = client.newSession("/work");
    proc.respond(lastWritten().id, { sessionId: "s1", ...result });
    await session;
  }

  it("extracts the model information from the session/new response. null if there are no options", async () => {
    expect(client.getModelState()).toBeNull();
    await startSession({ configOptions });
    expect(client.getModelState()).toEqual({ current: "opus", options: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] });
  });

  it("setModel sends the setting change and updates with the model information in the response. Does nothing for a provider that does not support it", async () => {
    await client.setModel("s1", "sonnet");
    expect(proc.written).toEqual([]);

    await startSession({ configOptions });
    const changing = client.setModel("s1", "sonnet");
    expect(lastWritten()).toMatchObject({ method: "session/set_config_option", params: { sessionId: "s1", configId: "model", value: "sonnet" } });
    proc.respond(lastWritten().id, {});
    await changing;
    // if the response has no model information, the given value becomes the current model
    expect(client.getModelState()?.current).toBe("sonnet");
  });

  it("setPermissionMode sends and returns true only for a selectable mode. For an unselectable value it returns false and sends nothing", async () => {
    await startSession({ configOptions });
    const before = proc.written.length;
    await expect(client.setPermissionMode("s1", "plan")).resolves.toBe(false);
    expect(proc.written).toHaveLength(before);

    const changing = client.setPermissionMode("s1", "auto");
    expect(lastWritten()).toMatchObject({ method: "session/set_config_option", params: { configId: "mode", value: "auto" } });
    proc.respond(lastWritten().id, {});
    await expect(changing).resolves.toBe(true);
  });
});

describe("selection of the agent (the provider-side agent definition)", () => {
  async function startSession(configOptions: unknown) {
    const session = client.newSession("/work");
    proc.respond(lastWritten().id, { sessionId: "s1", configOptions });
    await session;
  }

  it("setAgent sends and returns true only for an agent that is in the session's options. For a name that is not there, it returns false and sends nothing", async () => {
    await startSession([{ id: "agent", options: [{ value: "default" }, { value: "scout" }] }]);
    const before = proc.written.length;
    await expect(client.setAgent("s1", "typo")).resolves.toBe(false);
    expect(proc.written).toHaveLength(before);

    const changing = client.setAgent("s1", "scout");
    expect(lastWritten()).toMatchObject({ method: "session/set_config_option", params: { sessionId: "s1", configId: "agent", value: "scout" } });
    proc.respond(lastWritten().id, {});
    await expect(changing).resolves.toBe(true);
  });

  it("in a session with no agent options (not supported), always false", async () => {
    await startSession([{ id: "mode", options: [{ value: "default" }] }]);
    await expect(client.setAgent("s1", "scout")).resolves.toBe(false);
  });
});

describe("prompts and streaming", () => {
  it("sendPrompt sends the text, resolves with the end reason, and notifies complete", async () => {
    const completes: string[] = [];
    client.on("complete", ({ stopReason }) => completes.push(stopReason));
    const turn = client.sendPrompt("s1", "hello");
    expect(lastWritten()).toMatchObject({ method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "hello" }] } });
    proc.respond(lastWritten().id, { stopReason: "end_turn" });
    await expect(turn).resolves.toEqual({ stopReason: "end_turn" });
    expect(completes).toEqual(["end_turn"]);
  });

  it("a response with no end reason is 'unknown'. An error response rejects and does not notify complete", async () => {
    const completes: string[] = [];
    client.on("complete", ({ stopReason }) => completes.push(stopReason));
    const first = client.sendPrompt("s1", "a");
    proc.respond(lastWritten().id, {});
    await expect(first).resolves.toEqual({ stopReason: "unknown" });

    const second = client.sendPrompt("s1", "b");
    proc.send({ jsonrpc: "2.0", id: lastWritten().id, error: { message: "went down" } });
    await expect(second).rejects.toThrow("went down");
    expect(completes).toEqual(["unknown"]);
  });

  it("notifies the response chunks, tool calls, and tool results as events", async () => {
    const events: Array<[string, string]> = [];
    client.on("chunk", (t) => events.push(["chunk", t]));
    client.on("toolCall", (t) => events.push(["toolCall", t]));
    client.on("toolCallUpdate", (t) => events.push(["toolCallUpdate", t]));

    proc.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hel" } });
    proc.update({ sessionUpdate: "tool_call", title: "Read file" });
    // the result joins the text of the content. If there is no content, the title is used instead
    proc.update({ sessionUpdate: "tool_call_update", content: [{ content: { text: "a" } }, { content: { text: "b" } }, {}] });
    proc.update({ sessionUpdate: "tool_call_update", title: "Done" });
    // an update of unknown kind or unexpected shape is ignored
    proc.update({ sessionUpdate: "unknown_kind" });
    proc.update({ nothing: true });
    await tick();
    expect(events).toEqual([
      ["chunk", "hel"],
      ["toolCall", "Read file"],
      ["toolCallUpdate", "ab"],
      ["toolCallUpdate", "Done"],
    ]);
  });

  it("context usage (usage_update) is notified as a percentage of used/size. Not notified if size is 0", async () => {
    const usages: number[] = [];
    client.on("usageUpdate", (p) => usages.push(p));
    proc.update({ sessionUpdate: "usage_update", used: 50, size: 200 });
    proc.update({ sessionUpdate: "usage_update", used: 50, size: 0 });
    await tick();
    expect(usages).toEqual([25]);
  });

  it("the list of available slash commands (available_commands_update) is notified as a whole on every update, and held", async () => {
    const lists: unknown[] = [];
    client.on("commands", (c) => lists.push(c));
    expect(client.getCommands()).toEqual([]);
    proc.update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "context", description: "d", input: null }] });
    proc.update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "loop", description: "l", input: { hint: "[x]" } }] });
    await tick();
    expect(lists).toEqual([
      [{ name: "context", description: "d" }],
      [{ name: "loop", description: "l", hint: "[x]" }],
    ]);
    expect(client.getCommands()).toEqual([{ name: "loop", description: "l", hint: "[x]" }]);
  });

  it("cost is cumulative, so the difference from the start of the turn is notified. Not notified if it has not increased", async () => {
    const credits: Array<[number, string]> = [];
    client.on("creditUsage", (amount, _ms, unit) => credits.push([amount, unit]));
    const cost = (amount: number) => proc.update({ sessionUpdate: "usage_update", used: 1, size: 100, cost: { amount } });

    // 1st turn: the cumulative goes 0 → 0.5 → 0.75 (the notification is the cumulative difference within that turn)
    const turn1 = client.sendPrompt("s1", "1");
    cost(0.5);
    cost(0.75);
    await tick();
    proc.respond(lastWritten().id, { stopReason: "end_turn" });
    await turn1;

    // 2nd turn: the cumulative at the start is 0.75. The difference is 0.25
    const turn2 = client.sendPrompt("s1", "2");
    cost(0.75); // not increased → not notified
    cost(1.0);
    await tick();
    proc.respond(lastWritten().id, { stopReason: "end_turn" });
    await turn2;

    expect(credits).toEqual([[0.5, "usd"], [0.75, "usd"], [0.25, "usd"]]);
  });
});

describe("permission confirmation", () => {
  const request = (id: number, params: Record<string, unknown> = {}) =>
    proc.send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: { sessionId: "s1", toolCall: { title: "Write file", toolCallId: "tc1", rawInput: { path: "a.txt" } }, options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }], ...params },
    });

  it("notifies the request with the tool name, input, and options", async () => {
    const requests: PermissionRequest[] = [];
    client.on("permissionRequest", (r) => requests.push(r));
    request(77);
    await tick();
    expect(requests).toEqual([{
      requestId: 77,
      sessionId: "s1",
      toolName: "Write file",
      toolInput: { path: "a.txt" },
      options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
    }]);
  });

  it("if there is no title, toolCallId is used as the tool name, and if that is missing too, 'unknown'", async () => {
    const names: string[] = [];
    client.on("permissionRequest", (r) => names.push(r.toolName));
    request(1, { toolCall: { toolCallId: "tc9" } });
    request(2, { toolCall: {} });
    await tick();
    expect(names).toEqual(["tc9", "unknown"]);
  });

  it("respondToPermission returns the chosen option to the request's id. Even if returned twice, only once", async () => {
    request(77);
    await tick();
    client.respondToPermission(77, "allow");
    client.respondToPermission(77, "allow");
    const responses = proc.written.filter((m) => m.id === 77);
    expect(responses).toEqual([{ jsonrpc: "2.0", id: 77, result: { outcome: { outcome: "selected", optionId: "allow" } } }]);
  });

  it("if the options are empty, it is returned as a cancellation. An answer to an unknown id does nothing", async () => {
    request(78);
    await tick();
    client.respondToPermission(78, "");
    client.respondToPermission(12345, "allow");
    expect(proc.written.filter((m) => m.id === 78)).toEqual([{ jsonrpc: "2.0", id: 78, result: { outcome: { outcome: "cancelled" } } }]);
    expect(proc.written.some((m) => m.id === 12345)).toBe(false);
  });

  it("a request from an unknown server is rejected so it does not hang", async () => {
    proc.send({ jsonrpc: "2.0", id: 55, method: "fs/read_text_file", params: {} });
    await tick();
    expect(proc.written.find((m) => m.id === 55)).toEqual({
      jsonrpc: "2.0",
      id: 55,
      result: { behavior: "deny", message: "Unhandled method: fs/read_text_file" },
    });
  });
});

describe("cancelling a turn that waits on a permission request", () => {
  async function withPendingPermission(): Promise<{ requestId: number; cancelled: number[][] }> {
    const cancelled: number[][] = [];
    client.on("permissionsCancelled", (ids) => cancelled.push(ids));
    proc.send({ jsonrpc: "2.0", id: 41, method: "session/request_permission", params: { sessionId: "s1", toolCall: { title: "Write" }, options: [{ optionId: "allow", name: "Yes", kind: "allow_once" }] } });
    await tick();
    return { requestId: 41, cancelled };
  }

  it("answers the pending request as cancelled (ACP), instead of leaving the agent waiting until the force-kill", async () => {
    const { cancelled } = await withPendingPermission();
    client.sendCancel("s1");
    const reply = proc.written.find((m) => m.id === 41) as { result: { outcome: { outcome: string } } };
    expect(reply.result.outcome).toEqual({ outcome: "cancelled" });
    expect(cancelled).toEqual([[41]]);
  });

  it("a later answer to that request reports that it reached nothing", async () => {
    const { requestId } = await withPendingPermission();
    client.sendCancel("s1");
    expect(client.respondToPermission(requestId, "allow")).toBe(false);
  });

  it("an answer to a request that is still pending reports that it was delivered", async () => {
    const { requestId } = await withPendingPermission();
    expect(client.respondToPermission(requestId, "allow")).toBe(true);
    const reply = proc.written.find((m) => m.id === 41) as { result: { outcome: { optionId: string } } };
    expect(reply.result.outcome.optionId).toBe("allow");
  });
});
