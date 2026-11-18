import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createShipRuntime } from "./ship-runtime.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mis-runtime-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Reply = { ok?: boolean; body?: unknown } | "refused";

function runtime(opts: { port?: number | null; reply?: Reply } = {}) {
  const spawned: { command: string; args: string[]; logFile: string }[] = [];
  const killed: [number, string][] = [];
  const rt = createShipRuntime({
    dir: tmp,
    command: { execPath: "node", args: ["--flag", "cli.js"] },
    portOf: () => (opts.port === undefined ? 4000 : opts.port),
    fetch: (async () => {
      if (opts.reply === "refused" || opts.reply === undefined) throw new Error("ECONNREFUSED");
      return { ok: opts.reply.ok ?? true, json: async () => opts.reply && opts.reply !== "refused" ? opts.reply.body : null };
    }) as unknown as typeof fetch,
    spawn: (command, args, logFile) => { spawned.push({ command, args, logFile }); },
    kill: (pid, signal) => { killed.push([pid, signal]); },
  });
  return { rt, spawned, killed };
}

describe("status", () => {
  it("running: the ship on its port says it is this ship (and gives its process ID)", async () => {
    const { rt } = runtime({ reply: { body: { shipId: "alpha", pid: 123 } } });
    expect(await rt.status("alpha")).toEqual({ id: "alpha", port: 4000, state: "running", pid: 123 });
  });

  it("conflict: something else answers on the port (another ship, or another program)", async () => {
    expect(await runtime({ reply: { body: { shipId: "beta", pid: 1 } } }).rt.status("alpha")).toMatchObject({ state: "conflict" });
    expect(await runtime({ reply: { ok: true, body: "<html>" } }).rt.status("alpha")).toMatchObject({ state: "conflict" });
    expect(await runtime({ reply: { ok: false, body: {} } }).rt.status("alpha")).toMatchObject({ state: "conflict" });
  });

  it("stopped: nothing answers, or the ship has no port", async () => {
    expect(await runtime({ reply: "refused" }).rt.status("alpha")).toEqual({ id: "alpha", port: 4000, state: "stopped" });
    expect(await runtime({ port: null }).rt.status("alpha")).toEqual({ id: "alpha", port: null, state: "stopped" });
  });
});

describe("start", () => {
  it("starts a stopped ship with the same program, and its output goes to logs/stdout.log", async () => {
    const { rt, spawned } = runtime({ reply: "refused" });
    expect(await rt.start("alpha")).toEqual({ ok: true });
    expect(spawned).toEqual([{ command: "node", args: ["--flag", "cli.js", "--ship", "alpha"], logFile: path.join(tmp, "ships/alpha/logs/stdout.log") }]);
    expect(fs.existsSync(path.join(tmp, "ships/alpha/logs"))).toBe(true);
  });

  it("does not start a ship that is already running, or whose port something else holds, or that has no port", async () => {
    const running = runtime({ reply: { body: { shipId: "alpha", pid: 1234 } } });
    expect(await running.rt.start("alpha")).toEqual({ ok: false, reason: "running" });
    const conflict = runtime({ reply: { body: { shipId: "other", pid: 1 } } });
    expect(await conflict.rt.start("alpha")).toEqual({ ok: false, reason: "conflict" });
    const noPort = runtime({ port: null });
    expect(await noPort.rt.start("alpha")).toEqual({ ok: false, reason: "no_port" });
    expect([running, conflict, noPort].every((r) => r.spawned.length === 0)).toBe(true);
  });
});

describe("stop", () => {
  it("sends SIGTERM to the process the ship itself reported", async () => {
    const { rt, killed } = runtime({ reply: { body: { shipId: "alpha", pid: 321 } } });
    expect(await rt.stop("alpha")).toEqual({ ok: true });
    expect(killed).toEqual([[321, "SIGTERM"]]);
  });

  it("never signals a process when the ship is not the one answering", async () => {
    const stopped = runtime({ reply: "refused" });
    const conflict = runtime({ reply: { body: { shipId: "other", pid: 99 } } });
    expect(await stopped.rt.stop("alpha")).toEqual({ ok: false, reason: "not_running" });
    expect(await conflict.rt.stop("alpha")).toEqual({ ok: false, reason: "not_running" });
    expect([...stopped.killed, ...conflict.killed]).toEqual([]);
  });
});

describe("log", () => {
  it("gives the last lines of stdout.log, or nothing when there is none", () => {
    const { rt } = runtime();
    expect(rt.log("alpha")).toBe("");
    const file = path.join(tmp, "ships/alpha/logs/stdout.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
    const lines = rt.log("alpha").split("\n");
    expect(lines).toHaveLength(60);
    expect(lines.at(-1)).toBe("line 99");
  });
});

describe("starting twice at the same moment", () => {
  it("starts one process; the second request is told the ship is already running", async () => {
    const { rt, spawned } = runtime({ reply: "refused" });
    const [a, b] = await Promise.all([rt.start("alpha"), rt.start("alpha")]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, reason: "running" });
    expect(spawned).toHaveLength(1);
  });

  it("another ship can be started at the same time", async () => {
    const { rt, spawned } = runtime({ reply: "refused" });
    await Promise.all([rt.start("alpha"), rt.start("beta")]);
    expect(spawned).toHaveLength(2);
  });
});

describe("what comes from outside is checked", () => {
  it("a pid that is not a plain process id (0, negative, 1, a fraction) does not make a ship 'running' (it would be signalled)", async () => {
    for (const pid of [0, -1, 1, 2.5]) {
      expect(await runtime({ reply: { body: { shipId: "alpha", pid } } }).rt.status("alpha"), String(pid)).toMatchObject({ state: "conflict" });
    }
  });

  it("a ship ID that is not a directory name is not a ship: no status, no start, no log", async () => {
    const { rt, spawned } = runtime({ reply: "refused" });
    expect(await rt.status("../x")).toEqual({ id: "../x", port: null, state: "stopped" });
    expect(await rt.start("../x")).toEqual({ ok: false, reason: "no_port" });
    expect(rt.log("../../etc")).toBe("");
    expect(spawned).toHaveLength(0);
  });
});

describe("log", () => {
  it("returns the last lines of a large file without reading all of it", () => {
    const file = path.join(tmp, "ships/alpha/logs/stdout.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = Array.from({ length: 200_000 }, (_, i) => `line ${i}`);
    fs.writeFileSync(file, lines.join("\n"));
    const { rt } = runtime({ reply: "refused" });
    const out = rt.log("alpha").split("\n");
    expect(out).toHaveLength(60);
    expect(out.at(-1)).toBe("line 199999");
  });

  it("is empty when there is no file", () => {
    expect(runtime({ reply: "refused" }).rt.log("alpha")).toBe("");
  });
});

describe("isStarting", () => {
  it("is true just after a start (the ship may not answer yet) and false for a ship that was not started", async () => {
    const { rt } = runtime({ reply: "refused" });
    expect(rt.isStarting("alpha")).toBe(false);
    await rt.start("alpha");
    expect(rt.isStarting("alpha")).toBe(true);
    expect(rt.isStarting("beta")).toBe(false);
  });
});
