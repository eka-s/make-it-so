// The top/bottom split of the conversation: the top pane shows earlier messages while the bottom pane stays
// with the live conversation. The ratio is the top pane's share of the conversation area's height.

export const DEFAULT_SPLIT_RATIO = 0.25;
export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.8;

/** Keeps a ratio inside the allowed range (a broken value falls back to the default). */
export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

/** The ratio for a divider dragged to `pointerY` inside an area that starts at `areaTop` and is `areaHeight` tall. */
export function splitRatioFromPointer(pointerY: number, areaTop: number, areaHeight: number): number {
  if (areaHeight <= 0) return DEFAULT_SPLIT_RATIO;
  return clampSplitRatio((pointerY - areaTop) / areaHeight);
}
