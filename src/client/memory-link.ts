// What a link in the text of a memo does when it is pressed. The pane is one page of a fixed address, so a relative link cannot be left to
// the browser (it would be read against that address, not against the memo): it is read against the path of the memo shown. This only decides
// where the pane goes next; what may be read is decided by the server, which checks every path it is asked for.

export type MemoryLink =
  /** Another memo of the Memory, as a path from its root (`procedures/rollback.md`). */
  | { kind: "memo"; path: string }
  /** A web or mail address: opened in a new tab. */
  | { kind: "external" }
  /** Nowhere to go (an anchor, another scheme, something outside the Memory): shown as text. */
  | { kind: "none" };

/** `href` is as the Markdown renderer gives it: percent-encoded. */
export function classifyMemoryLink(fromPath: string, href: string | undefined): MemoryLink {
  if (!href) return { kind: "none" };
  if (/^(https?:|mailto:)/i.test(href)) return { kind: "external" };
  if (href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "none" };
  let target = href.split("#")[0].split("?")[0];
  try { target = decodeURIComponent(target); } catch { return { kind: "none" }; }
  if (target === "" || target.includes("\\")) return { kind: "none" };
  const parts = target.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return { kind: "none" };
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const path = parts.join("/");
  return path.endsWith(".md") ? { kind: "memo", path } : { kind: "none" };
}
