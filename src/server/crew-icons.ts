import fs from "node:fs";
import path from "node:path";
import { mkdirPrivate } from "./private-dirs.js";

// Crew member icons (images). By convention they are placed at `personnel/{memberId}.{extension}` in the fleet roster, in the same place and
// under the same ID as the persona file (`personnel/{memberId}.md`). Placing one by hand or uploading one from the screen
// is the same (an upload just writes this file).
//
// Only raster images (png, jpg, webp, gif) are accepted. SVG is not accepted because it can contain scripts.
// The format is decided by the leading bytes of the content (magic numbers), not by the extension or the declared type.

export const MAX_ICON_BYTES = 1024 * 1024;

export type ImageType = { ext: "png" | "jpg" | "webp" | "gif"; mime: string };

const IMAGE_TYPES: ImageType[] = [
  { ext: "png", mime: "image/png" },
  { ext: "jpg", mime: "image/jpeg" },
  { ext: "webp", mime: "image/webp" },
  { ext: "gif", mime: "image/gif" },
];

/** Characters allowed in a member ID (it becomes a file name, so path separators and `..` are rejected). */
const SAFE_MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Decides the image format from the leading bytes of the content. Returns null if it is not a supported format.
 */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  const startsWith = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return IMAGE_TYPES[0];
  if (startsWith(0xff, 0xd8, 0xff)) return IMAGE_TYPES[1];
  // WebP: "RIFF" + 4-byte size + "WEBP"
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return IMAGE_TYPES[2];
  }
  // GIF: "GIF87a" or "GIF89a"
  if (startsWith(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return IMAGE_TYPES[3];
  return null;
}

export type CrewIcon = { file: string; mime: string; mtimeMs: number };

function personnelDir(fleetRoot: string): string {
  return path.join(fleetRoot, "personnel");
}

/** Finds a member's icon. Returns null if the ID is invalid or there is no image. */
export function findCrewIcon(fleetRoot: string, memberId: string): CrewIcon | null {
  if (!SAFE_MEMBER_ID.test(memberId)) return null;
  for (const type of IMAGE_TYPES) {
    const file = path.join(personnelDir(fleetRoot), `${memberId}.${type.ext}`);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) return { file, mime: type.mime, mtimeMs: stat.mtimeMs };
    } catch {
      // If this extension does not exist, look for the next one
    }
  }
  return null;
}

export type SaveIconResult = { ok: true } | { ok: false; reason: "invalid_member" | "unsupported_type" | "too_large" | "empty" };

/**
 * Saves an icon. If validation fails, nothing is written and the reason is returned. Older icons of the same member
 * with other extensions are removed (one image per person).
 */
export function saveCrewIcon(fleetRoot: string, memberId: string, bytes: Uint8Array): SaveIconResult {
  if (!SAFE_MEMBER_ID.test(memberId)) return { ok: false, reason: "invalid_member" };
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > MAX_ICON_BYTES) return { ok: false, reason: "too_large" };
  const type = detectImageType(bytes);
  if (!type) return { ok: false, reason: "unsupported_type" };
  mkdirPrivate(personnelDir(fleetRoot));
  deleteCrewIcon(fleetRoot, memberId);
  fs.writeFileSync(path.join(personnelDir(fleetRoot), `${memberId}.${type.ext}`), bytes);
  return { ok: true };
}

/** Deletes a member's icon (back to the default avatar). Returns true if something was deleted. */
export function deleteCrewIcon(fleetRoot: string, memberId: string): boolean {
  if (!SAFE_MEMBER_ID.test(memberId)) return false;
  let removed = false;
  for (const type of IMAGE_TYPES) {
    try {
      fs.unlinkSync(path.join(personnelDir(fleetRoot), `${memberId}.${type.ext}`));
      removed = true;
    } catch {
      // If there is none, do nothing
    }
  }
  return removed;
}
