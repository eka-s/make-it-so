import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// crew-runner does not depend on the ship config, so it can be loaded without a mock.
import { CrewRunner, taskSessionScope, missionFromTaskScope, type TaskEvent } from "./crew-runner.js";
import type { CrewManager } from "./crew-manager.js";

describe("scope of the task-running session", () => {
  it("builds the scope string from a mission ID and can restore the original mission ID", () => {
    // Does not depend on the internal string format; only checks the property that it round-trips back to the original
    expect(missionFromTaskScope(taskSessionScope("m123"))).toBe("m123");
  });

  it("a scope that is not for task running (a mission's conversation session) is undefined", () => {
    expect(missionFromTaskScope("m123")).toBeUndefined();
    expect(missionFromTaskScope("chief_engineer")).toBeUndefined();
    expect(missionFromTaskScope("")).toBeUndefined();
  });

  it("the scope differs per mission (it can run in parallel with tasks of other missions)", () => {
    expect(taskSessionScope("a")).not.toBe(taskSessionScope("b"));
  });
});

describe("how a crew task ends", () => {
  /** Runs one task against a fake agent whose prompt ends with the given stop reason (or fails). */
  async function runTask(prompt: () => Promise<{ stopReason: string }>) {
    const client = Object.assign(new EventEmitter(), { sendPrompt: prompt, sendCancel: () => {} });
    const manager = Object.assign(new EventEmitter(), {
      getOrCreateSession: async () => ({ client, sessionId: "s1" }),
      killSession: () => {},
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-runner-"));
    try {
      const runner = new CrewRunner(manager as unknown as CrewManager, dir);
      const event: TaskEvent = {
        agent: "crew1", taskId: "t1", missionId: "m1", originalName: "crew1",
        content: "do it", dispatchedBy: "chief",
      };
      const result = new Promise<{ kind: "done"; cancelled?: boolean } | { kind: "error"; message: string }>((resolve) => {
        runner.on("done", (_t, _a, _c, cancelled) => resolve({ kind: "done", cancelled }));
        runner.on("error", (_t, _a, message) => resolve({ kind: "error", message }));
      });
      runner.dispatch(event);
      return await result;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a task that ran to the end is done and not cancelled", async () => {
    expect(await runTask(async () => ({ stopReason: "end_turn" }))).toEqual({ kind: "done", cancelled: false });
  });

  it("a task the captain cancelled (stop reason cancelled) is done with the cancelled flag", async () => {
    expect(await runTask(async () => ({ stopReason: "cancelled" }))).toEqual({ kind: "done", cancelled: true });
  });

  it("a task whose prompt failed is an error, not done", async () => {
    const result = await runTask(async () => { throw new Error("boom"); });
    expect(result.kind).toBe("error");
  });
});

describe("crew tasks around errors and cancellation", () => {
  type Ended = { kind: "done"; cancelled?: boolean } | { kind: "error"; message: string };

  /** A runner over a fake manager. `prompts` are the sendPrompt implementations, used one per task in order. */
  function setup(prompts: Array<() => Promise<{ stopReason: string }>>) {
    const killed: string[] = [];
    const sent: string[] = [];
    let call = 0;
    const client = Object.assign(new EventEmitter(), {
      sendPrompt: (_s: string, text: string) => { sent.push(text); return prompts[call++]!(); },
      sendCancel: () => {},
      pendingPermission: false,
      hasPendingPermissions() { return this.pendingPermission; },
    });
    let sessions = 0;
    const manager = Object.assign(new EventEmitter(), {
      getOrCreateSession: async () => { sessions++; return { client, sessionId: `s${sessions}` }; },
      killSession: (agent: string, scope: string) => { killed.push(`${agent}@${scope}`); },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-runner-"));
    const runner = new CrewRunner(manager as unknown as CrewManager, dir);
    const ended = new Map<string, Promise<Ended>>();
    const task = (taskId: string): TaskEvent => ({ agent: "crew1", taskId, missionId: "m1", originalName: taskId, content: `do ${taskId}`, dispatchedBy: "chief" });
    const expectEnd = (taskId: string) => {
      ended.set(taskId, new Promise<Ended>((resolve) => {
        runner.on("done", (t, _a, _c, cancelled) => { if (t === taskId) resolve({ kind: "done", cancelled }); });
        runner.on("error", (t, _a, message) => { if (t === taskId) resolve({ kind: "error", message }); });
      }));
      return ended.get(taskId)!;
    };
    return { runner, task, expectEnd, killed, sent, client, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  it("a task that failed discards its session, so the next task does not share a process that may still be stuck", async () => {
    const t = setup([async () => { throw new Error("hung"); }, async () => ({ stopReason: "end_turn" })]);
    try {
      const first = t.expectEnd("t1");
      t.runner.dispatch(t.task("t1"));
      expect((await first).kind).toBe("error");
      expect(t.killed).toEqual(["crew1@__tasks__:m1"]);
    } finally { t.cleanup(); }
  });

  it("a task waiting for the captain's answer to a permission request is not treated as hung, however long the wait", async () => {
    vi.useFakeTimers();
    try {
      let answer!: () => void;
      const t = setup([() => new Promise((resolve) => { answer = () => resolve({ stopReason: "end_turn" }); })]);
      t.client.pendingPermission = true;
      const first = t.expectEnd("t1");
      t.runner.dispatch(t.task("t1"));
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000); // four times the 5 minute limit
      expect(t.killed).toEqual([]);
      answer();
      expect(await first).toEqual({ kind: "done", cancelled: false });
      t.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a task that is silent with nothing waiting on the captain is still treated as hung after the limit", async () => {
    vi.useFakeTimers();
    try {
      const t = setup([() => new Promise(() => {})]);
      const first = t.expectEnd("t1");
      t.runner.dispatch(t.task("t1"));
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      expect((await first).kind).toBe("error");
      t.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a task that ended normally keeps its session", async () => {
    const t = setup([async () => ({ stopReason: "end_turn" })]);
    try {
      const first = t.expectEnd("t1");
      t.runner.dispatch(t.task("t1"));
      await first;
      expect(t.killed).toEqual([]);
    } finally { t.cleanup(); }
  });

  it("cancelling a task that is still queued ends it as cancelled without ever sending its prompt", async () => {
    let release!: () => void;
    const t = setup([() => new Promise((resolve) => { release = () => resolve({ stopReason: "end_turn" }); }), async () => ({ stopReason: "end_turn" })]);
    try {
      const first = t.expectEnd("t1");
      const second = t.expectEnd("t2");
      t.runner.dispatch(t.task("t1"));
      t.runner.dispatch(t.task("t2")); // queued behind t1 (same crew member and mission)
      expect(t.runner.cancel("t2")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20)); // t1's prompt has started by now
      release();
      expect(await first).toEqual({ kind: "done", cancelled: false });
      expect(await second).toEqual({ kind: "done", cancelled: true });
      expect(t.sent).toEqual(["do t1"]);
    } finally { t.cleanup(); }
  });

  it("cancel says so when there is no such task (it already finished, or never existed)", async () => {
    const t = setup([async () => ({ stopReason: "end_turn" })]);
    try {
      const first = t.expectEnd("t1");
      t.runner.dispatch(t.task("t1"));
      await first;
      expect(t.runner.cancel("t1")).toBe(false);
      expect(t.runner.cancel("nope")).toBe(false);
    } finally { t.cleanup(); }
  });

  it("a failing 'started' listener does not leave the crew member busy or fail the task", async () => {
    const t = setup([async () => ({ stopReason: "end_turn" })]);
    try {
      t.runner.on("started", () => { throw new Error("listener broke"); });
      const first = t.expectEnd("t1");
      t.runner.dispatch(t.task("t1"));
      expect(await first).toEqual({ kind: "done", cancelled: false });
      expect(t.runner.isRunning("crew1")).toBe(false);
    } finally { t.cleanup(); }
  });
});

describe("cancelling while the session is being set up", () => {
  it("leaves no running entry behind: a later cancel of the same task reports 'no such task' and stops nothing else", async () => {
    let setupDone!: () => void;
    const cancels: string[] = [];
    const client = Object.assign(new EventEmitter(), { sendPrompt: async () => ({ stopReason: "end_turn" }), sendCancel: (s: string) => { cancels.push(s); }, hasPendingPermissions: () => false });
    const manager = Object.assign(new EventEmitter(), {
      getOrCreateSession: () => new Promise((resolve) => { setupDone = () => resolve({ client, sessionId: "shared" }); }),
      killSession: () => {},
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-runner-"));
    try {
      const runner = new CrewRunner(manager as unknown as CrewManager, dir);
      const ended = new Promise<void>((resolve) => { runner.on("done", () => resolve()); });
      runner.dispatch({ agent: "crew1", taskId: "t1", missionId: "m1", originalName: "t1", content: "x", dispatchedBy: "chief" });
      await new Promise((resolve) => setTimeout(resolve, 10)); // t1 is in session setup
      expect(runner.cancel("t1")).toBe(true);
      setupDone();
      await ended;
      expect(runner.cancel("t1")).toBe(false);
      expect(cancels).toEqual([]); // nothing was sent to the shared session
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
