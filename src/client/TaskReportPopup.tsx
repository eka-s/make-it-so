import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { markdownComponents } from "./markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { formatCredits } from "./ChatMessage";
import { api } from "./server-api";
import type { TaskDetail } from "./types";
import { useT } from "./i18n/I18nProvider";

type Tab = "report" | "instruction";

type TaskReportPopupProps = {
  taskId: string;
  // The crew member's display name (if known). If missing, only the taskId is shown in the title.
  name?: string;
  onClose: () => void;
  /**
   * Moves to this task's card in the conversation (the caller closes the popup and moves, including switching the mission).
   */
  onJump?: (target: { missionId: string; id: string; timestamp: string }) => void;
};

// A popup showing the full report of one task — the completion badge of a crew report group and the report badge of a report message,
// which used to be two popups with nearly the same look but separate implementations, are unified here
// (the former displayed directly from the loaded local Message state; the latter re-fetched from the server separately — it could refer to an old task
// outside the timeline's loaded window, so it could not rely on local state).
//
// Whichever caller opens it, it always fetches from `GET /api/results/:taskId`
// (the single source of truth on the server, `getTaskDetail()` in database.ts) — there is no branch of
// "use the local one if available, otherwise fetch". When opened inside a crew report group, the same content
// should already be in the local Message state too, but by always asking the server,
// a mismatch in what is displayed depending on the caller structurally cannot occur.
export function TaskReportPopup({ taskId, name, onClose, onJump }: TaskReportPopupProps) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [tab, setTab] = useState<Tab>("report");

  useEffect(() => {
    const controller = new AbortController();

    async function fetchDetail() {
      try {
        const res = await api.getTaskResult(taskId, controller.signal);
        if (!res.ok) {
          setError(res.status === 404 ? t("taskReport.notFound") : t("taskReport.fetchError", { status: res.status }));
          setLoading(false);
          return;
        }
        const data: TaskDetail = await res.json();
        setDetail(data);
        setLoading(false);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(t("taskReport.fetchFailed"));
        setLoading(false);
      }
    }

    fetchDetail();
    return () => controller.abort();
  }, [taskId, t]);

  const hasInstruction = !!detail?.instruction;
  const activeText = tab === "instruction" && detail?.instruction ? detail.instruction : detail?.text ?? "";
  const isError = detail?.status === "error";

  return (
    <div className="report-popup-overlay" onClick={onClose}>
      <div className="report-popup" onClick={(e) => e.stopPropagation()}>
        <div className="report-popup-header">
          <span className="report-popup-title">
            {isError ? "⚠️" : "📄"} {name ?? taskId}
            {name && <span className="report-popup-title-id">{taskId}</span>}
          </span>
          {detail?.credits && detail.credits.credits > 0 && (
            <span className="report-popup-credits">💳 {formatCredits(detail.credits)}</span>
          )}
          {detail && onJump && (
            <button
              className="report-popup-jump"
              onClick={() => onJump({ missionId: detail.missionId, id: taskId, timestamp: detail.timestamp })}
              title={t("taskReport.jump")}
            >
              ↪ {t("messagePopup.jumpLabel")}
            </button>
          )}
          {detail && <CopyButton text={activeText} title={tab === "instruction" ? t("taskReport.copyInstruction") : t("taskReport.copyReport")} />}
          <button className="report-popup-close" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        {hasInstruction && (
          <div className="report-popup-tabs">
            <button
              className={`report-popup-tab ${tab === "instruction" ? "report-popup-tab--active" : ""}`}
              onClick={() => setTab("instruction")}
            >
              {t("report.instruction")}
            </button>
            <button
              className={`report-popup-tab ${tab === "report" ? "report-popup-tab--active" : ""}`}
              onClick={() => setTab("report")}
            >
              {t("report.report")}
            </button>
          </div>
        )}

        {loading && (
          <div className="report-popup-body">
            <div className="report-popup-loading">{t("common.loading")}</div>
          </div>
        )}

        {error && (
          <div className="report-popup-body">
            <div className="report-popup-error">{error}</div>
          </div>
        )}

        {detail && (
          <div className="report-popup-body markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{activeText}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
