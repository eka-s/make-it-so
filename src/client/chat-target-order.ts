// Computation of the order of the conversation-partner buttons and how many fit in the width (pure functions that do not depend on the screen).

/**
 * Applies the saved order to the current ship's composition (roles).
 * Among those in the saved order, the ones that are in the current composition come first; ones not in the saved order (new ones) are added at the end, in composition order.
 * Ones that are no longer in the composition are dropped.
 */
export function applyOrder(roles: string[], saved: string[]): string[] {
  const present = new Set(roles);
  const ordered = saved.filter((role, i) => present.has(role) && saved.indexOf(role) === i);
  const placed = new Set(ordered);
  return [...ordered, ...roles.filter((role) => !placed.has(role))];
}

/**
 * Moves `from` to where `to` was (if `from` came from before `to`, it goes after `to`; if from after,
 * it goes before `to` — that is, the moved item ends up at the dropped position). If either is missing, returns as is.
 */
export function moveRole(order: string[], from: string, to: string): string[] {
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return order;
  const next = order.filter((role) => role !== from);
  next.splice(toIndex, 0, from);
  return next;
}

/**
 * How many buttons can be placed from the start in the width `available`. If all fit, the full count. If not,
 * returns the number that fit after leaving room for the "more" button on the right (width `overflowWidth`) (0 is possible).
 * `gap` is the spacing between buttons.
 */
export function countFitting(widths: number[], available: number, gap: number, overflowWidth: number): number {
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return widths.length;
  let used = overflowWidth;
  let count = 0;
  for (const width of widths) {
    const next = used + gap + width;
    if (next > available) break;
    used = next;
    count += 1;
  }
  return count;
}

/**
 * Moves the position selected with the keyboard by `delta` (±1). At the ends it wraps around to the other side.
 * If the current position (current) is not in the list, it starts from the first (delta>0) or the last (delta<0).
 */
export function stepHighlight(order: string[], current: string | null, delta: 1 | -1): string | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.indexOf(current);
  if (index < 0) return delta > 0 ? order[0] : order[order.length - 1];
  return order[(index + delta + order.length) % order.length];
}
