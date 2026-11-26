// A line diff for the history of a concept file (the crew reads it when asked to summarize what changed). It is a plain
// longest-common-subsequence over lines; a pair of texts too large for that is shown as one whole replacement instead.

const MAX_CELLS = 250_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A unified-style diff (`-` removed, `+` added, ` ` kept, with `context` kept lines around each change). Empty when nothing changed. */
export function lineDiff(before: string, after: string, context = 2): string {
  if (before === after) return "";
  const a = splitLines(before);
  const b = splitLines(after);
  const ops: Array<{ op: " " | "-" | "+"; text: string }> = [];
  if (a.length * b.length > MAX_CELLS) {
    for (const text of a) ops.push({ op: "-", text });
    for (const text of b) ops.push({ op: "+", text });
  } else {
    // lcs[i][j]: the length of the common subsequence of a[i..] and b[j..].
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { ops.push({ op: " ", text: a[i] }); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ op: "-", text: a[i] }); i++; }
      else { ops.push({ op: "+", text: b[j] }); j++; }
    }
    for (; i < a.length; i++) ops.push({ op: "-", text: a[i] });
    for (; j < b.length; j++) ops.push({ op: "+", text: b[j] });
  }

  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((entry, index) => {
    if (entry.op === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach((entry, index) => {
    if (!keep[index]) { skipped = true; return; }
    if (skipped && out.length > 0) out.push("...");
    skipped = false;
    out.push(`${entry.op}${entry.text}`);
  });
  return out.join("\n");
}
