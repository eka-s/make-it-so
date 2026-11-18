import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { markdownComponents } from "./markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { PopupOpenButton } from "./PopupOpenButton";
import { CrewIcon } from "./crewIcons";
import { HostBadge } from "./HostBadge";
import { ThinkingBubble } from "./ThinkingBubble";
import type { Message, CrewMemberConfig, MeteringUsage, ThinkingEntry } from "./types";
import { useI18n } from "./i18n/I18nProvider";
import { speakerName } from "./speaker";

/**
 * Makes the usage cost, whose unit differs by provider, visually distinguishable.
 * claude is an estimated cost in dollars, and kiro is its own "credits" point system.
 */
export function formatCredits(credits: MeteringUsage): string {
  if (credits.unit === "usd") return `$${credits.credits.toFixed(4)}`;
  return `${credits.credits.toFixed(2)} cr`;
}

type ChatMessageProps = {
  message: Message;
  crewConfig?: Record<string, CrewMemberConfig>;
  onCancel?: () => void;
  // Right after Stop was pressed (the turn has not ended yet). The stop button shows "stopping" and cannot be pressed.
  isStopping?: boolean;
  isPinned?: boolean;
  onTogglePin?: (message: Message) => void;
  onOpenResult?: (taskId: string, name?: string) => void;
  // When set, a "show in popup" button appears in the heading (visible when the mouse is over it). From a task card, it opens the report popup.
  onOpenPopup?: () => void;
  // The tool-call activity of the turn or task this card is for. It is drawn inside the card, above the text, while the work goes on.
  thinking?: ThinkingEntry[];
  // Height at which the body is collapsed (px). When omitted, the height for an ordinary conversation (about 30 lines). A task card uses half of that (about 15 lines).
  collapsedMaxPx?: number;
};

/**
 * Height control of the conversation body.
 * line-height 1.5 × font-size 0.9rem ≈ 21.6px/line.
 * - COLLAPSED_MAX_PX: the threshold at which normal display collapses (about 30 lines). A body over it
 *   shows only about 30 lines from the top until the "show full text" button is pressed.
 * It is specified in pixels, as a deliberate simplification.
 */
export const COLLAPSED_MAX_PX = 648; // ≈ 30 lines
/** The collapsed height of a task card (half of an ordinary conversation. About 15 lines). */
export const TASK_COLLAPSED_MAX_PX = COLLAPSED_MAX_PX / 2;

export function ChatMessage({ message, crewConfig, onCancel, isStopping, isPinned, onTogglePin, onOpenResult, onOpenPopup, collapsedMaxPx = COLLAPSED_MAX_PX, thinking }: ChatMessageProps) {
  const { t, tKey } = useI18n();
  // A message the server wrote itself is shown in the current language.
  const text = message.messageKey ? tKey(`msg.${message.messageKey}`, message.text) : message.text;
  const isCaptain = message.role === "captain";
  const isStreaming = message.status === "streaming";
  const d = new Date(message.timestamp);
  const time = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

  const isCancelled = message.cancelled === true;
  const showStopButton = isStreaming && onCancel;

  // Height control of the body. `expanded` is kept across SSE updates (re-renders)
  // and returns to the initial value false on a page redraw (remount) — "keep on SSE updates, all collapsed on
  // redraw" is satisfied with a single useState.
  const [expanded, setExpanded] = useState(false);
  // Open/close of the task card's "instruction" (only for a message that has an instruction = a task card)
  const [showInstruction, setShowInstruction] = useState(false);
  // Whether it exceeds the collapse threshold (about 30 lines). Only when exceeded is the "show full text" button shown.
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  // After rendering, measure the actual size and decide whether the collapse threshold was exceeded.
  // It is re-measured when message.text (the body grows), isStreaming, or expanded changes.
  // While streaming it scrolls internally, so no full-text button is shown (the measurement is skipped).
  useLayoutEffect(() => {
    if (isStreaming) {
      setIsOverflowing(false);
      return;
    }
    const el = textRef.current;
    if (!el) return;
    // Measure the plain content height with scrollHeight, including when the clamp is released (expanded).
    setIsOverflowing(el.scrollHeight > collapsedMaxPx + 1);
  }, [text, isStreaming, expanded, collapsedMaxPx]);

  // If the wrapping of the body changes with the window width etc., the number of lines (the height) changes too,
  // so it is re-measured whenever the element's size changes.
  // While streaming the full-text button is not shown, so it is not observed.
  useEffect(() => {
    if (isStreaming) return;
    const el = textRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setIsOverflowing(el.scrollHeight > collapsedMaxPx + 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isStreaming, collapsedMaxPx]);

  // When streaming ends, go back to the normal (collapsed) display.
  // The tail that grew during generation switches, after it ends, to showing about 30 lines from the top.
  useLayoutEffect(() => {
    if (isStreaming) setExpanded(false);
  }, [isStreaming]);

  // Auto-follow of the internal scroll: while streaming, follow to the bottom
  // only when the user is near the end (do not jump around while they are reading the middle).
  //
  // Why following used to fail: the ReactMarkdown body rendering is not yet reflected in the DOM at the moment this
  // effect runs synchronously. If scrollTop is aligned using the old (short)
  // scrollHeight, a new line is rendered right after and scrollHeight grows, leaving us behind the end by
  // that much. When the gap accumulates beyond 40px, the nearBottom judgment is also wrong and the following itself stops.
  //
  // The fix:
  // - The nearBottom judgment is made at the position before the DOM update (at synchronous execution). This is the correct state of
  //   "was the user near the end".
  // - The actual scroll to the bottom is delayed to the next frame with requestAnimationFrame, aligning with the scrollHeight
  //   re-measured after the Markdown rendering has been reflected.
  useLayoutEffect(() => {
    if (!isStreaming) return;
    const el = textRef.current;
    if (!el) return;
    // Decide whether it was near the end, at the position before the DOM update.
    const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!wasNearBottom) return;
    // In the next frame after the Markdown rendering is reflected, follow using the latest scrollHeight.
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [text, isStreaming]);

  // Which CSS class to use. While streaming, --streaming (20 lines, internal scroll);
  // otherwise, if over the threshold and not expanded, --collapsed (cut at 30 lines).
  const collapsed = !isStreaming && isOverflowing && !expanded;
  const textModifierClass = isStreaming
    ? "message-text--streaming"
    : collapsed
      ? "message-text--collapsed"
      : "";

  const displayName = speakerName(message.role, crewConfig, t("role.captain"));
  // The icon that lets you see at a glance who the current partner is and who each past message belongs to
  // in a direct chat with a crew member. The display name and image are looked up from crewConfig (the crew composition).

  const bubbleClasses = [
    "message-bubble",
    isStreaming ? "message-bubble--streaming" : "",
    isCancelled ? "message-bubble--cancelled" : "",
    isPinned ? "message-bubble--pinned" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={`message ${isCaptain ? "message-captain" : "message-crew"}`} data-message-id={message.id}>
      <div className={bubbleClasses}>
        <div className="message-bubble-header">
          <div className="message-sender">
            {!isCaptain && <CrewIcon name={displayName} iconUrl={crewConfig?.[message.role]?.icon} size={16} />}
            {displayName} <HostBadge host={crewConfig?.[message.role]?.host} /> <span className="message-id-badge">{message.id}</span> <span className="message-time-inline">{time}</span>
          </div>
          <div className="message-bubble-actions">
            {onOpenPopup && <PopupOpenButton inline onClick={onOpenPopup} />}
            {text && (
              <CopyButton text={text} title={t("chat.copyText")} />
            )}
            {onTogglePin && !isStreaming && (
              <button
                className={`message-pin-btn ${isPinned ? "message-pin-btn--active" : ""}`}
                onClick={() => onTogglePin(message)}
                title={isPinned ? t("message.unpin") : t("message.pin")}
                aria-label={isPinned ? t("message.unpin") : t("message.pin")}
              >
                📌
              </button>
            )}
            {showStopButton && (
              <button
                className={`message-stop-btn${isStopping ? " message-stop-btn--stopping" : ""}`}
                onClick={() => onCancel?.()}
                disabled={isStopping}
                title={isStopping ? t("message.stopping") : t("message.stop")}
                aria-label={isStopping ? t("message.stopping") : t("message.stop")}
              >
                <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true">
                  <rect x="0" y="0" width="8" height="8" rx="1" />
                </svg>
              </button>
            )}
            {isCancelled && (
              <span className="message-cancelled-badge">{t("message.cancelled")}</span>
            )}
          </div>
        </div>
        {message.instruction && (
          // The task card's instruction: shown above the body as a link that can be opened and closed (inside the card)
          <div className="message-instruction-block">
            <button
              className="crew-task-instruction-toggle"
              aria-expanded={showInstruction}
              onClick={() => setShowInstruction((v) => !v)}
            >
              {showInstruction ? "▾" : "▸"} {t("report.instruction")}
            </button>
            {showInstruction && (
              <div className="crew-task-instruction markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{message.instruction}</ReactMarkdown>
              </div>
            )}
          </div>
        )}
        {thinking && thinking.length > 0 && (
          <div className="message-thinking-inline">
            {thinking.map((entry) => <ThinkingBubble key={entry.id} entry={entry} embedded />)}
          </div>
        )}
        <div
          ref={textRef}
          className={`message-text ${textModifierClass} ${isCaptain ? "" : "markdown-body"}`.trim()}
          style={collapsedMaxPx === COLLAPSED_MAX_PX ? undefined : ({ "--message-collapsed-max": `${collapsedMaxPx}px` } as React.CSSProperties)}
        >
          {isCaptain ? (
            <>
              {text}
              {isStreaming && <span className="streaming-cursor">▌</span>}
            </>
          ) : (
            <>
              {message.partialText && (
                <div className="message-partial">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{message.partialText}</ReactMarkdown>
                </div>
              )}
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {text}
              </ReactMarkdown>
              {isStreaming && <span className="streaming-cursor">▌</span>}
            </>
          )}
        </div>
        {!isStreaming && isOverflowing && (
          <button
            className="message-expand-btn"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? t("common.collapse") : t("chat.showFullText")}
          </button>
        )}
        {message.reportMeta && message.reportMeta.tasks.length > 0 && (
          <div className="message-report-links">
            {message.reportMeta.tasks.map((task) => {
              const name = crewConfig?.[task.agent]?.name ?? task.agent;
              return (
                <button
                  key={`${task.agent}_${task.taskId}`}
                  className="message-report-badge"
                  onClick={() => onOpenResult?.(task.taskId, name)}
                  title={t("chat.showReportOf", { name })}
                >
                  📄 {name}
                  <span className="message-report-badge-id">{task.taskId}</span>
                </button>
              );
            })}
          </div>
        )}
        {!isCaptain && (
          <div className="message-credits">
            💳 {message.credits && message.credits.credits > 0
              ? formatCredits(message.credits)
              : "—"}
          </div>
        )}
      </div>
    </div>
  );
}
