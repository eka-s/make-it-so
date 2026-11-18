import type { SearchHit } from "./types";

// Grouping of search results (pure functions that do not depend on the screen). The server returns the results newest first, so this only
// gathers those with the same key (the order of groups is the order of the newest result in each group = the order of first appearance).

/** By mission / by crew / mission × crew (crew sub-headings within a mission). */
export type GroupMode = "mission" | "crew" | "mission-crew";
export const GROUP_MODES: readonly GroupMode[] = ["mission", "crew", "mission-crew"];

export type SearchGroup = {
  key: string;
  /**
   * Identifier that uniquely represents a group (the collapsed state, the jump target). When nested, it follows the parent's path joined with `/`.
   */
  path: string;
  title: string;
  /** Number of results of this group (including its children). */
  count: number;
  /** Results that directly belong to this group (empty for a group that has children). */
  hits: SearchHit[];
  /** Sub-headings (for mission × crew, the per-crew groups). */
  children: SearchGroup[];
};

function collect<T>(items: T[], keyOf: (item: T) => string): Array<{ key: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return [...groups].map(([key, list]) => ({ key, items: list }));
}

/**
 * Groups the results. `roleTitle` looks up the heading's display name from a role (including captain).
 * A mission heading uses the mission name the results carry.
 */
export function groupHits(hits: SearchHit[], mode: GroupMode, roleTitle: (role: string) => string): SearchGroup[] {
  const byCrew = (list: SearchHit[], parent: string): SearchGroup[] =>
    collect(list, (h) => h.role).map(({ key, items }) => ({
      key,
      path: `${parent}c:${encodeURIComponent(key)}`,
      title: roleTitle(key),
      count: items.length,
      hits: items,
      children: [],
    }));

  if (mode === "crew") return byCrew(hits, "");

  return collect(hits, (h) => h.missionId).map(({ key, items }) => {
    const title = items[0].missionName;
    const path = `m:${encodeURIComponent(key)}`;
    if (mode === "mission") return { key, path, title, count: items.length, hits: items, children: [] };
    return { key, path, title, count: items.length, hits: [], children: byCrew(items, `${path}/`) };
  });
}

/**
 * Lays the results out in one list in the order they appear on screen (the order when moving with ↑↓ on the keyboard). Groups whose path is in `collapsed`
 * are folded and not on screen, so the results inside them (including children) are not included.
 */
export function flattenGroups(groups: SearchGroup[], collapsed: ReadonlySet<string> = new Set()): SearchHit[] {
  return groups.flatMap((g) => (collapsed.has(g.path) ? [] : [...g.hits, ...flattenGroups(g.children, collapsed)]));
}

/**
 * The parent paths of a path (from the top, not nearest first). Example: "m:a/c:b" → ["m:a"]. Empty for a top-level group.
 */
export function ancestorPaths(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}
