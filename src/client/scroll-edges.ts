// Decides "is it at the very top / the very bottom" of a scroll area (a pure function that does not depend on the screen).

export type ScrollMetrics = { scrollTop: number; clientHeight: number; scrollHeight: number };

/** Within this distance (px) of an edge, it is considered to be at that edge. */
export const EDGE_THRESHOLD = 24;

/**
 * Returns whether it is at the very top / very bottom. When the content fits in the area (it cannot scroll), both are true
 * (there is nowhere to move in either direction, so no scroll buttons are shown).
 */
export function scrollEdges(m: ScrollMetrics, threshold: number = EDGE_THRESHOLD): { atTop: boolean; atBottom: boolean } {
  return {
    atTop: m.scrollTop <= threshold,
    atBottom: m.scrollHeight - m.scrollTop - m.clientHeight <= threshold,
  };
}
