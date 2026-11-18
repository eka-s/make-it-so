import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, READY_TIMEOUT_MS, createHostTunnels } from "./host-tunnel.js";
import { logger } from "./logger.js";
import { TUNNEL_READY_MARKER } from "./ssh.js";

// A fake ssh process. Writing the marker to stdout means "established", and making it exit means "dropped".
class FakeSsh extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  emitReady() {
    this.stdout.write(`${TUNNEL_READY_MARKER}\n`);
  }
  exit(code = 255) {
    this.emit("exit", code);
  }
}

const host = { name: "dock", destination: "dock" };
let procs: FakeSsh[];
let spawnCalls: Array<{ command: string; args: string[] }>;
const spawn = (command: string, args: string[]) => {
  spawnCalls.push({ command, args });
  const proc = new FakeSsh();
  procs.push(proc);
  return proc as unknown as ChildProcess;
};

beforeEach(() => {
  vi.useFakeTimers();
  for (const level of ["info", "warn", "error"] as const) vi.spyOn(logger, level).mockImplementation(() => {});
  procs = [];
  spawnCalls = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// readline's 'line' arrives asynchronously, so only the event loop is run without advancing the timers
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("reverse tunnel per host", () => {
  it("it is 'idle' at first. ensureTunnel starts connecting ('connecting'), and when the marker arrives, the waiting call resolves and it becomes 'connected'", async () => {
    const tunnels = createHostTunnels(3000, spawn);
    expect(tunnels.state("dock")).toBe("idle");

    const ready = tunnels.ensureTunnel(host);
    expect(tunnels.state("dock")).toBe("connecting");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("ssh");
    expect(spawnCalls[0].args.join(" ")).toContain("127.0.0.1:3000:127.0.0.1:3000");

    procs[0].emitReady();
    await flush();
    await expect(ready).resolves.toBeUndefined();
    expect(tunnels.state("dock")).toBe("connected");
  });

  it("several calls to the same host share one ssh. If already established, it resolves right away", async () => {
    const tunnels = createHostTunnels(3000, spawn);
    const a = tunnels.ensureTunnel(host);
    const b = tunnels.ensureTunnel(host);
    expect(spawnCalls).toHaveLength(1);
    procs[0].emitReady();
    await flush();
    await Promise.all([a, b]);
    await expect(tunnels.ensureTunnel(host)).resolves.toBeUndefined();
    expect(spawnCalls).toHaveLength(1);
  });

  it("if not established in time, it throws, with the previous ssh's error output attached", async () => {
    const tunnels = createHostTunnels(3000, spawn);
    const ready = tunnels.ensureTunnel(host);
    const rejected = expect(ready).rejects.toThrow(/not ready after 20s: Permission denied/);
    procs[0].stderr.write("Permission denied\n");
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    await rejected;
  });

  it("when it drops, it goes back to 'connecting' and reconnects with exponential backoff (with an upper limit). Once established, the wait goes back to the minimum", async () => {
    const tunnels = createHostTunnels(3000, spawn);
    const ready = tunnels.ensureTunnel(host);
    procs[0].emitReady();
    await flush();
    await ready;

    // dropped → reconnect after the minimum wait
    procs[0].exit();
    expect(tunnels.state("dock")).toBe("connecting");
    await vi.advanceTimersByTimeAsync(BACKOFF_MIN_MS - 1);
    expect(spawnCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCalls).toHaveLength(2);

    // if it keeps dropping without being established, the wait doubles each time and stops at the upper limit
    let expected = BACKOFF_MIN_MS * 2;
    for (let i = 0; i < 6; i++) {
      procs.at(-1)!.exit();
      const before = spawnCalls.length;
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(spawnCalls).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnCalls).toHaveLength(before + 1);
      expected = Math.min(expected * 2, BACKOFF_MAX_MS);
    }
    expect(expected).toBe(BACKOFF_MAX_MS);

    // once established, the next drop starts from the minimum wait
    procs.at(-1)!.emitReady();
    await flush();
    procs.at(-1)!.exit();
    const before = spawnCalls.length;
    await vi.advanceTimersByTimeAsync(BACKOFF_MIN_MS);
    expect(spawnCalls).toHaveLength(before + 1);
  });

  it("each host gets a separate tunnel", () => {
    const tunnels = createHostTunnels(3000, spawn);
    void tunnels.ensureTunnel(host).catch(() => {});
    void tunnels.ensureTunnel({ name: "other", destination: "other" }).catch(() => {});
    expect(spawnCalls).toHaveLength(2);
    expect(tunnels.state("other")).toBe("connecting");
  });
});
