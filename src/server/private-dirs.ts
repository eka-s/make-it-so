import fs from "node:fs";

// Everything a ship keeps (the conversation database in plain text, logs, results) and what ~/.make-it-so holds (settings,
// personas) is for its owner only. The directories are created with mode 0700, so other users of the machine cannot read
// anything inside, whatever the mode of the files in them is. (Windows ignores the mode.)

const PRIVATE_MODE = 0o700;

/** Creates a directory (and its parents) readable by its owner only. */
export function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_MODE });
}

/** Makes an existing directory readable by its owner only (one made before this was done, or by another tool). */
export function restrictToOwner(dir: string): void {
  try {
    if (fs.existsSync(dir)) fs.chmodSync(dir, PRIVATE_MODE);
  } catch {
    // Not ours to change (for example a directory owned by someone else): the owner's own checks apply there.
  }
}
