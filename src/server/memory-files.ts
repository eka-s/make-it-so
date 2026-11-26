import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// How the Memory touches the disk. The bundle is a directory anyone on the machine (a crew member with file tools, the captain) can put
// things in, so nothing here trusts what it finds: a link is not followed, a file that is not an ordinary file is not opened (a pipe would
// block the whole server), a file is not read past a size cap, and a file is written by creating a new one beside it and renaming it into
// place, which replaces a link instead of writing through it.

/** A file bigger than this is not read: it cannot be a memo anyone wrote on purpose, and reading it would take the server's memory. */
export const MAX_MEMORY_FILE_BYTES = 16 * 1024 * 1024;

export type FileRead = { kind: "ok"; content: Buffer } | { kind: "missing" } | { kind: "unsafe" } | { kind: "too-large"; size: number };

/**
 * Reads an ordinary file. It is opened without following a link and without blocking, and looked at once it is open, so a file swapped
 * for a link or a pipe after it was checked cannot be read.
 */
export function readRegularFile(file: string): FileRead {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    if (code === "ELOOP" || code === "EMLINK" || code === "EISDIR") return { kind: "unsafe" };
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    // A second name for the same file (a hard link) could lead to a file outside the bundle.
    if (!stat.isFile() || stat.nlink > 1) return { kind: "unsafe" };
    // On a system without O_NOFOLLOW the link is caught here.
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return { kind: "unsafe" };
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return { kind: "missing" };
      throw err;
    }
    if (stat.size > MAX_MEMORY_FILE_BYTES) return { kind: "too-large", size: stat.size };
    // Read at most the cap, and one byte more to see whether the file grew after it was measured.
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_MEMORY_FILE_BYTES) + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > MAX_MEMORY_FILE_BYTES) return { kind: "too-large", size: length };
    return { kind: "ok", content: buffer.subarray(0, length) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether `rel` (a path inside `root`) goes through a symbolic link, which is not followed. A part that does not exist yet is not one. */
export function linkInPath(root: string, rel: string): boolean {
  let current = root;
  for (const segment of rel.split("/")) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Whether `target` is a directory and not a link to one. */
export function isRealDirectory(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Writes a file by creating a new one beside it (under a name nobody can guess, failing if it exists) and renaming it over the target, so
 * a link planted at the target or at the temporary name is never written through. Right before the rename it checks that the directory
 * is still inside `root`, which catches a directory swapped for a link after the path was checked.
 */
export function writeFileAtomic(root: string, file: string, bytes: Buffer | string): void {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    if (!insideRoot(root, file)) throw new Error("The directory is outside the Memory.");
    fs.renameSync(temporary, file);
  } catch (err) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* the directory is gone; the error below says why */ }
    throw err;
  }
}

/** Whether `file` is still inside `root` once every link along the way is resolved (checked again right before something is done to it). */
export function insideRoot(root: string, file: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const realDirectory = fs.realpathSync(path.dirname(file));
    return realDirectory === realRoot || realDirectory.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}
