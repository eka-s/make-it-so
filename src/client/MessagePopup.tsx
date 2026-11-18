import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { markdownComponents } from "./markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { CrewIcon } from "./crewIcons";
import { speakerName } from "./speaker";
import { api } from "./server-api";
import type { CrewMemberConfig, Message } from "./types";
import { useI18n } from "./i18n/I18nProvider";

/**
 * The message to open in a popup. If `fallback` is given (e.g. a pin, which already has the body), it is shown without fetching.
 */
export type MessagePopupTarget = {
  missionId: string;
  id: string;
  fallback?: { role: string; text: string; timestamp: string };
};

type MessagePopupProps = {
  target: MessagePopupTarget;
  crewConfig: Record<string, CrewMemberConfig>;
  onClose: () => void;
  /**
   * Moves to that message in the conversation (the caller closes the popup and moves, including switching the mission).
   */
  onJump: (target: { missionId: string; id: string; timestamp: string }) => void;
};

type Shown = { role: string; text: string; timestamp: string };

// A screen to read one ordinary conversation message in a popup (built like `TaskReportPopup`, the task report popup).
// Opened from a list (pins, search results) with the button that appears on mouse hover. For the body, a pin uses the body it already has,
// and otherwise only that one item is fetched from the timeline (no new API is made). "Go to conversation" moves to the real position in the conversation.
export function MessagePopup({ target, crewConfig, onClose, onJump }: MessagePopupProps) {
  const { t, tKey } = useI18n();
  const [shown, setShown] = useState<Shown | null>(target.fallback ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target.fallback) {
      setShown(target.fallback);
      return;
    }
    setShown(null);
    setError(null);
    const controller = new AbortController();
    api.getTimelineRange({ missionId: target.missionId, afterId: target.id, inclusive: true, dir: "asc", limit: 1 })
      .then(async (res) => {
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setError(t("messagePopup.fetchError", { status: res.status }));
          return;
        }
        const data = (await res.json()) as unknown as { items: Message[] };
        const item = data.items.find((m) => m.id === target.id);
        if (!item) {
          setError(t("messagePopup.notFound"));
          return;
        }
        const text = item.messageKey ? tKey(`msg.${item.messageKey}`, item.text) : item.text;
        setShown({ role: item.role, text, timestamp: item.timestamp });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t("messagePopup.fetchFailed"));
      });
    return () => controller.abort();
  }, [target, t, tKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const name = shown ? speakerName(shown.role, crewConfig, t("role.captain")) : "";
  const isCaptain = shown?.role === "captain";

  return (
    <div className="report-popup-overlay" onClick={onClose}>
      <div className="report-popup" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="report-popup-header">
          <span className="report-popup-title">
            {shown && !isCaptain && <CrewIcon name={name} iconUrl={crewConfig[shown.role]?.icon} size={18} />}
            {shown ? name : t("common.loading")}
            {shown && <span className="report-popup-title-id">{new Date(shown.timestamp).toLocaleString()}</span>}
          </span>
          {shown && (
            <button
              className="report-popup-jump"
              onClick={() => onJump({ missionId: target.missionId, id: target.id, timestamp: shown.timestamp })}
              title={t("messagePopup.jump")}
            >
              ↪ {t("messagePopup.jumpLabel")}
            </button>
          )}
          {shown && <CopyButton text={shown.text} title={t("messagePopup.copy")} />}
          <button className="report-popup-close" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        {!shown && !error && (
          <div className="report-popup-body">
            <div className="report-popup-loading">{t("common.loading")}</div>
          </div>
        )}
        {error && (
          <div className="report-popup-body">
            <div className="report-popup-error">{error}</div>
          </div>
        )}
        {shown && (
          isCaptain ? (
            <div className="report-popup-body report-popup-body--plain">{shown.text}</div>
          ) : (
            <div className="report-popup-body markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{shown.text}</ReactMarkdown>
            </div>
          )
        )}
      </div>
    </div>
  );
}
