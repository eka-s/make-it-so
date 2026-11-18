// State of the conversation partner (pure functions that do not depend on the screen). It holds "the base partner (base)" and "the destination of the next message only (once)".
// base is saved and does not change after sending. once is used only for the next send and is cancelled when sent (going back to base).

export type TargetState = {
  /** The base conversation partner (whom you keep talking to; saved per mission). */
  base: string;
  /** The destination of the next message only. null if none. */
  once: string | null;
};

/**
 * The actual destination of the next send. The one-message destination if there is one, otherwise the base partner.
 */
export function effectiveTarget(state: TargetState): string {
  return state.once ?? state.base;
}

/**
 * Selects a crew member. A normal selection (not `once`) switches the base partner (and cancels the one-message destination).
 * Selecting with Shift (`once`) makes it the destination of the next message only. However, if the one to go back to (the base partner), or the crew member that is already
 * the one-message destination, is selected again with Shift, the one-message destination is cancelled.
 */
export function selectTarget(state: TargetState, role: string, once: boolean): TargetState {
  if (!once) return { base: role, once: null };
  if (role === state.base || role === state.once) return { ...state, once: null };
  return { ...state, once: role };
}

/** Sent. Cancels the one-message destination (goes back to the base partner). */
export function consumeOnce(state: TargetState): TargetState {
  return state.once === null ? state : { ...state, once: null };
}

/**
 * Fixes a destination that does not exist in the ship's composition (roles). If there is no base partner it becomes `fallback`, and if the one-message destination does not exist it is cancelled.
 * If there is nothing to change, returns the same state (the same reference).
 */
export function pruneTargets(state: TargetState, roles: readonly string[], fallback: string): TargetState {
  const base = roles.includes(state.base) ? state.base : fallback;
  const once = state.once !== null && roles.includes(state.once) && state.once !== base ? state.once : null;
  return base === state.base && once === state.once ? state : { base, once };
}
