import { describe, expect, it } from "vitest";
import { ancestorPaths, flattenGroups, groupHits } from "./search-group";
import type { SearchHit } from "./types";

const hit = (id: string, missionId: string, role: string, missionName = `Mission ${missionId}`): SearchHit => ({
  id, missionId, missionName, role, kind: "reply", timestamp: "2026-11-14T00:00:00.000Z",
  snippet: { text: id, ranges: [], cutStart: false, cutEnd: false }, matchedIn: null,
});
const title = (role: string) => (role === "captain" ? "Captain" : role.toUpperCase());

// Results in newest-first order
const hits = [
  hit("1", "a", "alex"), hit("2", "b", "captain"), hit("3", "a", "sam"), hit("4", "b", "alex"), hit("5", "a", "alex"),
];
const ids = (list: SearchHit[]) => list.map((h) => h.id);

describe("groupHits", () => {
  it("by mission: gathered per mission. The order of groups is the order of the newest result in each mission. The order inside stays newest first", () => {
    const groups = groupHits(hits, "mission", title);
    expect(groups.map((g) => [g.key, g.title, g.count])).toEqual([["a", "Mission a", 3], ["b", "Mission b", 2]]);
    expect(ids(groups[0].hits)).toEqual(["1", "3", "5"]);
    expect(ids(groups[1].hits)).toEqual(["2", "4"]);
    expect(groups.every((g) => g.children.length === 0)).toBe(true);
  });

  it("by crew: gathered per role (several missions mix). The captain uses the heading's display name", () => {
    const groups = groupHits(hits, "crew", title);
    expect(groups.map((g) => [g.key, g.title, g.count])).toEqual([["alex", "ALEX", 3], ["captain", "Captain", 1], ["sam", "SAM", 1]]);
    expect(ids(groups[0].hits)).toEqual(["1", "4", "5"]); // missions a and b are mixed
  });

  it("mission × crew: sub-headings per crew member within a mission. The count is the sum of the children", () => {
    const groups = groupHits(hits, "mission-crew", title);
    expect(groups.map((g) => [g.key, g.count, g.hits.length])).toEqual([["a", 3, 0], ["b", 2, 0]]);
    expect(groups[0].children.map((c) => [c.key, c.count])).toEqual([["alex", 2], ["sam", 1]]);
    expect(ids(groups[0].children[0].hits)).toEqual(["1", "5"]);
    expect(groups[1].children.map((c) => c.title)).toEqual(["Captain", "ALEX"]);
  });

  it("if the results are empty, the groups are empty too", () => {
    for (const mode of ["mission", "crew", "mission-crew"] as const) expect(groupHits([], mode, title)).toEqual([]);
  });
});

describe("flattenGroups", () => {
  it("lays the results out in one list in the order they appear on screen (the order of ↑↓ on the keyboard)", () => {
    expect(ids(flattenGroups(groupHits(hits, "mission", title)))).toEqual(["1", "3", "5", "2", "4"]);
    expect(ids(flattenGroups(groupHits(hits, "crew", title)))).toEqual(["1", "4", "5", "2", "3"]);
    expect(ids(flattenGroups(groupHits(hits, "mission-crew", title)))).toEqual(["1", "5", "3", "2", "4"]);
  });
});

describe("path (the identifier of a group)", () => {
  it("by mission and by crew are one-level paths. Mission × crew follows the parent's path. Even for the same role, a different mission is a different path", () => {
    expect(groupHits(hits, "mission", title).map((g) => g.path)).toEqual(["m:a", "m:b"]);
    expect(groupHits(hits, "crew", title).map((g) => g.path)).toEqual(["c:alex", "c:captain", "c:sam"]);
    const nested = groupHits(hits, "mission-crew", title);
    expect(nested[0].children.map((c) => c.path)).toEqual(["m:a/c:alex", "m:a/c:sam"]);
    expect(nested[1].children.map((c) => c.path)).toEqual(["m:b/c:captain", "m:b/c:alex"]);
  });

  it("paths do not collide even if the ID contains a separator / or symbols", () => {
    const odd = [hit("1", "a/b", "x:y"), hit("2", "a", "b/x:y")];
    const paths = groupHits(odd, "mission-crew", title).flatMap((g) => [g.path, ...g.children.map((c) => c.path)]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("ancestorPaths returns the parent paths from the top. Empty for a top-level group", () => {
    expect(ancestorPaths("m:a/c:b")).toEqual(["m:a"]);
    expect(ancestorPaths("m:a")).toEqual([]);
    expect(ancestorPaths("a/b/c")).toEqual(["a", "a/b"]);
  });
});

describe("flattenGroups: collapsed groups", () => {
  it("the results of a collapsed group are not included (what is navigated with ↑↓ on the keyboard is only what is on screen)", () => {
    const groups = groupHits(hits, "mission", title);
    expect(ids(flattenGroups(groups, new Set(["m:a"])))).toEqual(["2", "4"]);
    expect(ids(flattenGroups(groups, new Set(["m:a", "m:b"])))).toEqual([]);
  });

  it("in nesting, collapsing a parent excludes the children too. Collapsing only a child excludes only that child", () => {
    const groups = groupHits(hits, "mission-crew", title);
    expect(ids(flattenGroups(groups, new Set(["m:a"])))).toEqual(["2", "4"]);
    expect(ids(flattenGroups(groups, new Set(["m:a/c:alex"])))).toEqual(["3", "2", "4"]);
  });
});
