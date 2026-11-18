import { ChatMessage, TASK_COLLAPSED_MAX_PX } from "./ChatMessage";
import type { Message, CrewMemberConfig } from "./types";
import { useT } from "./i18n/I18nProvider";

type Props = {
  messages: Message[];
  crewConfig?: Record<string, CrewMemberConfig>;
  onCancel?: (taskId: string) => void;
  // The task card's "show in popup" button: opens the report popup (TaskReportPopup).
  onOpenResult?: (taskId: string, name?: string) => void;
};

// A task that is still running: drawn like a message of the normal conversation (the "thinking"
// bubble, then the message card), nested in the task card. One of these per crew member at work.
function TaskCard({ msg, crewConfig, onCancel, onOpenResult }: {
  msg: Message;
  crewConfig?: Record<string, CrewMemberConfig>;
  onCancel?: (taskId: string) => void;
  onOpenResult?: (taskId: string, name?: string) => void;
}) {
  return (
    <div className="response-group crew-task-running">
      <ChatMessage
        message={msg}
        thinking={msg.activity ? [msg.activity] : undefined}
        crewConfig={crewConfig}
        collapsedMaxPx={TASK_COLLAPSED_MAX_PX}
        onCancel={onCancel ? () => onCancel(msg.id) : undefined}
        // Button shown when the mouse is over the heading: opens that task's report (and instruction) in a popup
        onOpenPopup={onOpenResult ? () => onOpenResult(msg.id, crewConfig?.[msg.role]?.name ?? msg.role) : undefined}
      />
    </div>
  );
}

export function CrewReportGroup({ messages, crewConfig, onCancel, onOpenResult }: Props) {
  const t = useT();
  const streamingItems = messages.filter((m) => m.status === "streaming");
  const isLive = streamingItems.length > 0;

  const headerLabel = isLive
    ? t("report.countLive", { running: streamingItems.length, total: messages.length })
    : t("report.count", { total: messages.length });

  return (
    <div className={`crew-report-group${isLive ? " crew-tasks-live" : ""}`}>
      <div className="crew-report-group-header">
        <span className="crew-report-group-icon">{isLive ? "⚡" : "📋"}</span>
        <span className="crew-report-group-title">{t("report.groupTitle")}</span>
        <span className="crew-report-group-count">{headerLabel}</span>
      </div>
      {/*
         A card displayed the same as an ordinary conversation, both while running and after completion (it does not shrink into a badge even when done).
                   The jump target marker (data-message-id) is attached by ChatMessage.
         */}
      <div className="crew-report-group-items">
        {messages.map((msg) => (
          <TaskCard key={msg.id} msg={msg} crewConfig={crewConfig} onCancel={onCancel} onOpenResult={onOpenResult} />
        ))}
      </div>
    </div>
  );
}
