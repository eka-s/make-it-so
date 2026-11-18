// ID of the default mission (the same value as DEFAULT_MISSION_ID in the server-side database.ts).
// Ordinary conversations not tied to a particular issue belong here — all history
// from before missions existed is backfilled here too, so this is right for the initial display.
export const DEFAULT_MISSION_ID = "bridge";
