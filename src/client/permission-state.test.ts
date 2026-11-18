import { describe, expect, it } from "vitest";
import { initialPermissionState, permissionReducer, type PermissionAction, type PermissionState } from "./permission-state";
import type { PendingPermission } from "./types";

const perm = (key: string): PendingPermission => ({ key, ownerMissionId: "m1", role: "chief_engineer" } as unknown as PendingPermission);
const run = (actions: PermissionAction[], from: PermissionState = initialPermissionState) => actions.reduce(permissionReducer, from);
const keys = (s: PermissionState) => [...s.pending.keys()];

describe("state of pending approvals (permissionReducer)", () => {
  it("keeps the arrived approvals per key. The same key is overwritten", () => {
    const state = run([{ type: "requested", permission: perm("a") }, { type: "requested", permission: perm("b") }, { type: "requested", permission: perm("a") }]);
    expect(keys(state)).toEqual(["a", "b"]);
  });

  it("a resolved one is removed and stays in the resolved record. The record stays even for a key that is not pending", () => {
    const state = run([{ type: "requested", permission: perm("a") }, { type: "resolved", key: "a" }, { type: "resolved", key: "zzz" }]);
    expect(keys(state)).toEqual([]);
    expect([...state.recentlyResolved]).toEqual(["a", "zzz"]);
  });

  it("the server's list is merged per key. Existing ones are not overwritten, and only the missing ones are added", () => {
    const mine = perm("a");
    const state = run([{ type: "requested", permission: mine }, { type: "hydrated", permissions: [perm("a"), perm("b")] }]);
    expect(keys(state)).toEqual(["a", "b"]);
    expect(state.pending.get("a")).toBe(mine);
  });

  it("an old list that arrives right after a resolution does not revive the resolved one", () => {
    const state = run([
      { type: "requested", permission: perm("a") },
      { type: "resolved", key: "a" },
      { type: "hydrated", permissions: [perm("a")] },
    ]);
    expect(keys(state)).toEqual([]);
  });

  it("after the resolved record is forgotten, the ones in the list are taken in", () => {
    const state = run([
      { type: "resolved", key: "a" },
      { type: "resolved-forgotten", key: "a" },
      { type: "hydrated", permissions: [perm("a")] },
    ]);
    expect(keys(state)).toEqual(["a"]);
  });

  it("when nothing changes, the same state is returned (avoids needless re-rendering)", () => {
    const state = run([{ type: "requested", permission: perm("a") }]);
    expect(permissionReducer(state, { type: "hydrated", permissions: [perm("a")] })).toBe(state);
    expect(permissionReducer(state, { type: "resolved-forgotten", key: "unknown" })).toBe(state);
  });

  it("putting it back after a failed response returns it to pending, and the record that blocks reviving is also removed", () => {
    const state = run([
      { type: "requested", permission: perm("a") },
      { type: "resolved", key: "a" },
      { type: "restored", permission: perm("a") },
    ]);
    expect(keys(state)).toEqual(["a"]);
    expect(state.recentlyResolved.has("a")).toBe(false);
  });
});
