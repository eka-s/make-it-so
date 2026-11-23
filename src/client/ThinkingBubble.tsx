import { useState } from "react";
import type { ThinkingEntry } from "./types";
import { useT } from "./i18n/I18nProvider";
import { formatMessageTime } from "./format-time";

// A gear. It turns while the crew member is working (the operations are still coming in) and stands still once they are done.
function Gear({ turning }: { turning: boolean }) {
  return (
    <svg className={turning ? "thinking-gear thinking-gear--turning" : "thinking-gear"} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path fillRule="evenodd" d="M10.55 4.54 L10.82 1.67 L13.18 1.67 L13.45 4.54 L16.25 5.70 L18.47 3.86 L20.14 5.53 L18.30 7.75 L19.46 10.55 L22.33 10.82 L22.33 13.18 L19.46 13.45 L18.30 16.25 L20.14 18.47 L18.47 20.14 L16.25 18.30 L13.45 19.46 L13.18 22.33 L10.82 22.33 L10.55 19.46 L7.75 18.30 L5.53 20.14 L3.86 18.47 L5.70 16.25 L4.54 13.45 L1.67 13.18 L1.67 10.82 L4.54 10.55 L5.70 7.75 L3.86 5.53 L5.53 3.86 L7.75 5.70 Z M8.6 12 a3.4 3.4 0 1 0 6.8 0 a3.4 3.4 0 1 0 -6.8 0 Z" fill="currentColor" />
    </svg>
  );
}

type ThinkingBubbleProps = {
  entry: ThinkingEntry;
  /** Drawn inside a message card (no frame of its own, no time) instead of as a bubble of its own. */
  embedded?: boolean;
};

export function ThinkingBubble({ entry, embedded = false }: ThinkingBubbleProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  const opCount = entry.operations.length;
  const lastOp = entry.operations[opCount - 1];
  // English needs a singular form ("1 operation"); the other messages of the dictionary avoid plurals
  const plural = opCount === 1 ? "one" : "other";
  const headerText = entry.isActive
    ? t(`thinking.active.${plural}`, { count: opCount })
    : t(`thinking.done.${plural}`, { count: opCount });

  // Preview: shows the title of the last operation + the first 2 lines of its output
  const previewLines: string[] = [];
  if (lastOp) {
    previewLines.push(lastOp.title);
    const outputLines = lastOp.output.split("\n").filter((l) => l.trim());
    previewLines.push(...outputLines.slice(0, 2));
  }

  const time = formatMessageTime(entry.timestamp);

  const content = (
    <>
      <button
        type="button"
        className="thinking-header"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="thinking-header-text">
          <Gear turning={entry.isActive} />
          {headerText}
        </span>
        <span className="thinking-toggle">{expanded ? "▾" : "▸"}</span>
      </button>

      {!expanded && previewLines.length > 0 && (!embedded || entry.isActive) && (
        <div className="thinking-preview">
          {previewLines.map((line, i) => (
            <div key={i} className="thinking-preview-line">{line}</div>
          ))}
        </div>
      )}

      {expanded && (
        <div className="thinking-details">
          {entry.operations.map((op, i) => (
            <div key={i} className="thinking-operation">
              <div className="thinking-op-title">▶ {op.title}</div>
              {op.output && (
                <pre className="thinking-op-output">{op.output}</pre>
              )}
            </div>
          ))}
          {embedded && !entry.isActive && <p className="thinking-saved-note">{t("thinking.savedNote")}</p>}
        </div>
      )}

    </>
  );

  if (embedded) return <div className="thinking-bubble thinking-bubble--embedded">{content}</div>;

  return (
    <div className="message message-crew message-thinking">
      <div className="thinking-bubble">
        {content}
        <div className="message-time">{time}</div>
      </div>
    </div>
  );
}
