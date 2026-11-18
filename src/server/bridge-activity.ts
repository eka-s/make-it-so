// A small dependency-free channel for the signal "something happened in this mission's current turn" that originates
// outside bridge.ts (permission request/response handling lives in crew-manager.ts and
// index.ts). It is kept as an independent leaf module so those files can report activity without
// importing bridge.ts — importing it would create a circular import (bridge.ts already imports crew-manager.ts).
//
// **Separated per mission**: turns of different missions run in parallel, so each mission's turn must read and write
// only its own slot. A single shared slot would let one mission's turn overwrite another's bump function, and the idle timeout (5 minutes)
// could fire by mistake (treated as a hang and auto-cancelled) while a turn is silently waiting for a permission response.
// The slots are therefore a Map keyed by mission ID.
const handlers = new Map<string, () => void>();

/**
 * bridge.ts calls this before and after each prompt to set/clear the bump function of that mission's idle timer.
 */
export function setActivityHandler(missionId: string, fn: (() => void) | null): void {
  if (fn) handlers.set(missionId, fn);
  else handlers.delete(missionId);
}

/**
 * crew-manager.ts / index.ts call this when a permission request fires or is answered. Does nothing if that mission has no turn right now (e.g. a permission from a task-running session).
 */
export function reportActivity(missionId: string): void {
  handlers.get(missionId)?.();
}
