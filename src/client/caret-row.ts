/**
 * Whether the caret of a textarea is on its first visual row (a long line that wraps has several rows, and ↑ there should move
 * the caret up as usual). It lays out the text before the caret in a hidden copy of the textarea and compares its height with one row.
 */
export function caretOnFirstRow(textarea: HTMLTextAreaElement): boolean {
  const before = textarea.value.slice(0, textarea.selectionStart);
  if (before.includes("\n")) return false;
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const copied = ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "tabSize"] as const;
  for (const key of copied) mirror.style[key] = style[key];
  // The text area's real line width: its inner width without padding and without the scroll bar (clientWidth leaves out the bar).
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  mirror.style.boxSizing = "content-box";
  mirror.style.width = `${textarea.clientWidth - padding}px`;
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: style.wordBreak });
  document.body.appendChild(mirror);
  try {
    // A trailing character keeps a caret at the end of a full row from being counted on the row below.
    mirror.textContent = `${before}\u200b`;
    const caretBottom = mirror.scrollHeight;
    mirror.textContent = "\u200b";
    return caretBottom <= mirror.scrollHeight + 1;
  } finally {
    mirror.remove();
  }
}
