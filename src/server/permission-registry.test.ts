import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingPermission } from "./types.js";

// Broadcasting to SSE is a side effect, so it is replaced and only "what was broadcast" is verified.
const broadcast = vi.fn();
vi.mock("./sse-emitter.js", () => ({ broadcast }));

const { registerPermission, peekPermission, resolvePermission, clearScope, listPending } = await import(
  "./permission-registry.js"
);

function permission(key: string, scope: string, missionId: string): PendingPermission {
  return {
    key,
    scope,
    missionId,
    ownerMissionId: missionId,
    role: scope,
    requestId: 1,
    toolName: "Write",
    toolInput: {},
    options: [],
    receivedAt: "2026-11-06T00:00:00.000Z",
  };
}

beforeEach(() => broadcast.mockClear());

// It is a module-level Map, so what is left over is all resolved to empty it in each test.
afterEach(() => {
  for (const p of listPending()) resolvePermission(p.key);
});

describe("permission-registry", () => {
  it("once registered it appears in listPending, and requested is broadcast", () => {
    const p = permission("k1", "chief_engineer", "m1");
    registerPermission(p);
    expect(listPending()).toEqual([p]);
    expect(broadcast).toHaveBeenCalledWith({ type: "permission:requested", data: p });
  });

  it("peek is not destructive", () => {
    registerPermission(permission("k1", "a", "m1"));
    expect(peekPermission("k1")?.key).toBe("k1");
    expect(peekPermission("k1")?.key).toBe("k1");
    expect(listPending()).toHaveLength(1);
  });

  it("resolve removes and returns the entry, and broadcasts resolved", () => {
    registerPermission(permission("k1", "a", "m1"));
    broadcast.mockClear();

    const resolved = resolvePermission("k1");
    expect(resolved?.key).toBe("k1");
    expect(listPending()).toHaveLength(0);
    expect(broadcast).toHaveBeenCalledWith({ type: "permission:resolved", data: { key: "k1" } });
  });

  it("resolve is idempotent (a resolved or unknown key gives undefined and does not broadcast)", () => {
    registerPermission(permission("k1", "a", "m1"));
    resolvePermission("k1");
    broadcast.mockClear();

    expect(resolvePermission("k1")).toBeUndefined();
    expect(resolvePermission("unknown")).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  describe("clearScope", () => {
    beforeEach(() => {
      registerPermission(permission("a-m1", "alice", "m1"));
      registerPermission(permission("a-m2", "alice", "m2"));
      registerPermission(permission("b-m1", "bob", "m1"));
      broadcast.mockClear();
    });

    it("with only scope specified, all missions' entries of that scope are discarded", () => {
      clearScope("alice");
      expect(listPending().map((p) => p.key)).toEqual(["b-m1"]);
      expect(broadcast).toHaveBeenCalledTimes(2);
    });

    it("with missionId too, only that mission's are discarded (sessions of other missions are not affected)", () => {
      clearScope("alice", "m1");
      expect(listPending().map((p) => p.key).sort()).toEqual(["a-m2", "b-m1"]);
      expect(broadcast).toHaveBeenCalledWith({ type: "permission:resolved", data: { key: "a-m1" } });
    });

    it("nothing happens if nothing matches", () => {
      clearScope("carol");
      expect(listPending()).toHaveLength(3);
      expect(broadcast).not.toHaveBeenCalled();
    });
  });
});
