import { describe, expect, it } from "vitest";
import { countByMission, countByRole, permissionsOfMission, tabTitle } from "./permission-summary";
import type { PendingPermission } from "./types";

function perm(key: string, ownerMissionId: string, role: string, missionId = ownerMissionId): PendingPermission {
  return { key, scope: role, missionId, ownerMissionId, role, requestId: 1, toolName: "Write", toolInput: {}, options: [], receivedAt: "" };
}

// m1 has 2 approvals in the conversation (commander, chief), 1 approval in a running task of m1 (chief), and m2 has 1
const all = [
  perm("a", "m1", "first_officer"),
  perm("b", "m1", "chief_engineer"),
  perm("c", "m1", "chief_engineer", "__tasks__:m1"), // even with a task scope, counted under the real mission
  perm("d", "m2", "science_officer"),
];

describe("aggregation of pending approvals", () => {
  it("returns only those of the given mission (those in running tasks are included in that mission too)", () => {
    expect(permissionsOfMission(all, "m1").map((p) => p.key)).toEqual(["a", "b", "c"]);
    expect(permissionsOfMission(all, "m2").map((p) => p.key)).toEqual(["d"]);
    expect(permissionsOfMission(all, "m3")).toEqual([]);
  });

  it("counts per mission and per crew member", () => {
    expect(countByMission(all)).toEqual({ m1: 3, m2: 1 });
    expect(countByRole(all, "m1")).toEqual({ first_officer: 1, chief_engineer: 2 });
    expect(countByRole(all, "m2")).toEqual({ science_officer: 1 });
  });

  it("tab title: if there are pending approvals, 🔐 and the total count across all missions are put at the front", () => {
    expect(tabTitle("Bridge Console", 0)).toBe("Bridge Console");
    expect(tabTitle("Bridge Console — Example Ship", 4)).toBe("🔐(4) Bridge Console — Example Ship");
  });
});
