// The paths of the Memory bundle (an OKF bundle of Markdown files). The crew chooses them, so every one is checked before it reaches the disk.

const MAX_PATH_LENGTH = 240;
const MAX_SEGMENT_LENGTH = 100;
// `index.md` and `log.md` are reserved by OKF: the server writes the former itself, and the latter is not used.
const RESERVED_NAMES = new Set(["index.md", "log.md"]);

/** Why a path cannot be a concept file of the bundle, or null when it can. */
export function memoryPathProblem(path: string): string | null {
  if (path.length === 0) return "The path is empty.";
  if (path.length > MAX_PATH_LENGTH) return `The path is longer than ${MAX_PATH_LENGTH} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return "The path has a control character or a backslash. Use / to separate directories.";
  // These would be taken for the end of a link target or an escape when a memo links to this one.
  if (/[#?%]/.test(path)) return "The path has a # ? or % character.";
  // Reserved on Windows (a drive, a stream, a wildcard), where the Memory may be kept too.
  if (/[:*"<>|]/.test(path)) return "The path has a character a Windows file name cannot have.";
  if (path.startsWith("/")) return "The path must be relative to the bundle (no leading /).";
  if (!path.endsWith(".md")) return "The path must end with .md.";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return "The path has an empty directory name (a doubled /).";
    if (segment.length > MAX_SEGMENT_LENGTH) return `A name in the path is longer than ${MAX_SEGMENT_LENGTH} characters.`;
    // Covers `.`, `..` and hidden entries such as `.git`.
    if (segment.startsWith(".")) return "A name in the path starts with a dot.";
    // `GIT~1` is another name for `.git` on a Windows disk.
    if (/~\d/.test(segment)) return "A name in the path has a ~ followed by a digit.";
    if (/[. ]$/.test(segment)) return "A name in the path ends with a dot or a space.";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)) return "A name in the path is a reserved device name on Windows.";
  }
  if (RESERVED_NAMES.has(segments[segments.length - 1])) return "index.md and log.md are reserved; the server maintains index.md itself.";
  return null;
}

/** The directory part of a bundle path ("" for the bundle root). */
export function memoryDirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The directory itself and every directory above it, nearest first, ending with the root (""). */
export function memoryDirsUp(dir: string): string[] {
  const dirs: string[] = [];
  let current = dir;
  while (current !== "") {
    dirs.push(current);
    current = memoryDirOf(current);
  }
  dirs.push("");
  return dirs;
}

/** Whether a directory name (as the viewer asks for it) is safe to look up: the same rules as a path, without the file name. */
export function memoryDirProblem(dir: string): string | null {
  if (dir === "") return null;
  return memoryPathProblem(`${dir}/x.md`);
}

/**
 * Resolves a link written in the Markdown of the concept at `fromPath` to a bundle path ("/a/b.md", `/` being the bundle root), or
 * null when it is not a link inside the bundle (an external URL, an anchor only, or one that climbs out of the bundle).
 */
export function resolveBundleLink(fromPath: string, href: string): string | null {
  if (href === "" || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  let target = href.split("#")[0].split("?")[0];
  if (target === "") return null;
  try { target = decodeURIComponent(target); } catch { return null; }
  const base = target.startsWith("/") ? [] : memoryDirOf(fromPath).split("/").filter((s) => s !== "");
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (base.length === 0) return null;
      base.pop();
    } else {
      base.push(segment);
    }
  }
  return `/${base.join("/")}`;
}
