import { useState, useEffect, useCallback, useRef } from "react";
import { CrewIcon } from "./crewIcons";
import { CrewProfilePopup } from "./CrewProfilePopup";
import { PopupOpenButton } from "./PopupOpenButton";
import "./CrewStatusPanel.css";
import { api } from "./server-api";
import type { AgentStatus, CrewHostGroup, CrewMemberConfig, TaskHistoryEntry } from "./types";
import { useI18n, useT } from "./i18n/I18nProvider";

type CrewStatus = AgentStatus;

// The task history of a crew member is kept per mission, so switching missions never shows the
// history of the previous one (a response that arrives late is stored under its own mission).
function historyKey(missionId: string, role: string): string {
  return `${missionId}::${role}`;
}

type RoleTasks = {
  current: { taskId: string; taskName: string } | null;
  history: TaskHistoryEntry[];
  hasMore: boolean;
  limit: number;
  loading: boolean;
};

// Number of task history entries when a row is expanded (default: the latest 5; a button loads 5 more at a time).
const HISTORY_PAGE_SIZE = 5;

type CrewStatusPanelProps = {
  // The crew's running state grouped per host (in the shape the server decided; App.tsx fetches it with useCrewStatus and passes it in).
  crewGroups: CrewHostGroup[];
  // The crew composition (icons, etc.) changed. The caller re-fetches the composition.
  onCrewChanged: () => void;
  // The crew's actual composition (from the ship's ship.yml). Used only to resolve display names and icons
  // — which roles are listed follows the result of GET /api/crew/status itself.
  crewConfig?: Record<string, CrewMemberConfig>;
  // When a task in the history is clicked, the existing TaskReportPopup is opened
  // (no new popup is made here — the path unified via App.tsx).
  // Clicking a history item: scrolls to that task's card in the conversation (the timestamp is the time it completed; there is none while running).
  onJump?: (taskId: string, timestamp?: string) => void;
  // Button shown when the mouse is over an item: opens that task's report in a popup.
  onOpenResult?: (taskId: string, name?: string) => void;
  // A lightweight signal that "crew-related state may have changed", riding on App.tsx's SSE timeline (timeline:upsert).
  // It refreshes immediately every time tick changes — rather than raising the polling frequency, it reacts the moment
  // something happens, which reduces the total number of polls.
  activitySignal?: { role: string | null; tick: number };
  // The mission open now (crew status and unreported counts are shown narrowed per mission). A restart
  // also targets this mission's session.
  missionId: string;
  // Crew members (roles) awaiting approval in this mission, and the counts. The key is absent if there are none.
  pendingByRole?: Record<string, number>;
};

function StatusDot({ status }: { status: CrewStatus }) {
  return <span className={`crew-status-dot crew-status-dot--${status}`}>●</span>;
}

function getContextColor(percentage: number): string {
  if (percentage > 95) return "var(--context-color-critical, #ff4444)";
  if (percentage > 90) return "var(--context-color-warning-high, #ff8800)";
  if (percentage > 75) return "var(--context-color-warning, #ffcc00)";
  return "var(--context-color-ok, #44cc44)";
}

/**
 * Context usage (%) of the conversation session in this mission (a short bar + the percentage on the right).
 * Placed next to the status. It goes inside a button, so only span elements are used.
 * When there is no session yet (or the value is unknown), an empty frame and "--" are shown.
 */
function ContextBar({ percent }: { percent: number | null }) {
  const t = useT();
  return (
    <span
      className="crew-context"
      title={percent === null ? t("crew.context.noSession") : t("crew.context.title", { percent: percent.toFixed(1) })}
    >
      <span className="crew-context-bar">
        {percent !== null && (
          <span
            className="crew-context-bar-fill"
            style={{ width: `${Math.min(100, Math.round(percent))}%`, backgroundColor: getContextColor(percent) }}
          />
        )}
      </span>
      <span className="crew-context-value">{percent === null ? "--" : `${Math.round(percent)}%`}</span>
    </span>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function CrewStatusPanel({ crewGroups, onCrewChanged, crewConfig, onJump, onOpenResult, activitySignal, missionId, pendingByRole = {} }: CrewStatusPanelProps) {
  const { t } = useI18n();
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(new Set());
  const [tasksByRole, setTasksByRole] = useState<Record<string, RoleTasks>>({});
  // Clicking the icon opens that crew member's personnel record (the profile popup: changing the icon and model,
  // restarting, showing the persona). Only one at a time.
  const [profileRole, setProfileRole] = useState<string | null>(null);

  // Refs for reading "the role expanded now" and "that role's current limit" from inside the status polling tick.
  // Using the state itself would require putting expandedRoles/tasksByRole into the useEffect dependency
  // array, and the polling setTimeout loop would be recreated at every expand/collapse
  // — by only having refs follow the latest values, the polling lifecycle stays a single one from mount.
  const expandedRolesRef = useRef<Set<string>>(new Set());
  const tasksByRoleRef = useRef<Record<string, RoleTasks>>({});
  useEffect(() => { expandedRolesRef.current = expandedRoles; }, [expandedRoles]);
  useEffect(() => { tasksByRoleRef.current = tasksByRole; }, [tasksByRole]);

  // Refreshes the history of the expanded role in the background, without user action. So that when a new
  // task is issued (dispatch_task → immediately "working"), it is noticed at the next polling tick even with the panel left
  // open (for the same reason this panel itself uses polling, no dedicated SSE kind is added).
  // The `loading` flag is not touched — to avoid the list that was visible a moment ago flickering to "Loading..."
  // at every background update.
  const refreshExpandedTasksQuietly = useCallback(async (role: string, limit: number) => {
    try {
      const res = await api.getCrewTasks(role, limit, missionId);
      if (!res.ok) return;
      const data: { current: { taskId: string; taskName: string } | null; history: TaskHistoryEntry[]; hasMore: boolean } = await res.json();
      setTasksByRole((prev) => {
        const key = historyKey(missionId, role);
        const existing = prev[key];
        if (!existing) return prev; // If before the initial fetch, do nothing (leave it to fetchTasks at expansion)
        return { ...prev, [key]: { ...data, limit, loading: existing.loading } };
      });
    } catch (err) {
      console.error("Failed to refresh crew task history:", err);
    }
  }, [missionId]);

  // If the signal points to the activity of a specific crew role (task start/completion) and that role's row is expanded,
  // the history is updated too (fetching the status list itself is done by useCrewStatus).
  // Do nothing when tick===0 (the initial value, nothing has happened yet).
  useEffect(() => {
    if (!activitySignal || activitySignal.tick === 0) return;
    const { role } = activitySignal;
    if (role && expandedRolesRef.current.has(role)) {
      const limit = tasksByRoleRef.current[historyKey(missionId, role)]?.limit ?? HISTORY_PAGE_SIZE;
      void refreshExpandedTasksQuietly(role, limit);
    }
  }, [activitySignal, refreshExpandedTasksQuietly, missionId]);

  // Fetches the history of the expanded tasks (lazy fetch). While loading, the previous content keeps being shown,
  // and only the "load more" button is disabled — to avoid the list briefly
  // vanishing while it is re-fetched with a larger count.
  const fetchTasks = useCallback(async (role: string, limit: number) => {
    const key = historyKey(missionId, role);
    setTasksByRole((prev) => ({
      ...prev,
      [key]: {
        current: prev[key]?.current ?? null,
        history: prev[key]?.history ?? [],
        hasMore: prev[key]?.hasMore ?? false,
        limit,
        loading: true,
      },
    }));
    try {
      const res = await api.getCrewTasks(role, limit, missionId);
      if (!res.ok) return;
      const data: { current: { taskId: string; taskName: string } | null; history: TaskHistoryEntry[]; hasMore: boolean } = await res.json();
      setTasksByRole((prev) => ({ ...prev, [key]: { ...data, limit, loading: false } }));
    } catch (err) {
      console.error("Failed to fetch crew task history:", err);
      setTasksByRole((prev) => ({
        ...prev,
        [key]: { current: prev[key]?.current ?? null, history: prev[key]?.history ?? [], hasMore: prev[key]?.hasMore ?? false, limit, loading: false },
      }));
    }
  }, [missionId]);

  const toggleExpand = useCallback((role: string) => {
    setExpandedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) {
        next.delete(role);
      } else {
        next.add(role);
      }
      return next;
    });
    setTasksByRole((prev) => {
      // Fetch only at the first expansion — if this mission's has already been fetched, reuse it as is.
      if (prev[historyKey(missionId, role)]) return prev;
      void fetchTasks(role, HISTORY_PAGE_SIZE);
      return prev;
    });
  }, [fetchTasks, missionId]);

  // After switching missions, the roles that are open need the history of the new mission.
  useEffect(() => {
    for (const role of expandedRolesRef.current) {
      if (!tasksByRoleRef.current[historyKey(missionId, role)]) void fetchTasks(role, HISTORY_PAGE_SIZE);
    }
  }, [missionId, fetchTasks]);

  const loadMore = useCallback((role: string) => {
    setTasksByRole((prev) => {
      void fetchTasks(role, (prev[historyKey(missionId, role)]?.limit ?? HISTORY_PAGE_SIZE) + HISTORY_PAGE_SIZE);
      return prev;
    });
  }, [fetchTasks, missionId]);

  // crewConfig (display names and icons, fetched separately on the App.tsx side) and crewGroups
  // (the list of roles this component polls itself) are separate API calls,
  // so there is no guarantee which arrives first. Until both are available, a placeholder is kept
  // so that the raw role key never shows.
  if (crewGroups.length === 0 || !crewConfig || Object.keys(crewConfig).length === 0) {
    return <p className="crew-status-placeholder">{t("crew.noCrew")}</p>;
  }

  return (
    <>
    {crewGroups.map((group) => (
    <section key={`${group.host.kind}:${group.host.label}`} className="crew-host-group">
    {/* Host heading. It shows here which host the crew members run on (no per-crew display) */}
    <h3 className="crew-host-header" title={group.host.address ?? group.host.label}>
      <span className="crew-host-icon">{group.host.kind === "local" ? "🖥" : "🌐"}</span>
      <span className="crew-host-label">{group.host.label}</span>
      {group.host.kind === "local" && <span className="crew-host-local">{t("crew.local")}</span>}
      {group.host.address && <span className="crew-host-address">{group.host.address}</span>}
      {group.tunnel === "connected" && <span className="crew-host-tunnel crew-host-tunnel--ok">{t("crew.tunnel.connected")}</span>}
      {group.tunnel === "connecting" && <span className="crew-host-tunnel crew-host-tunnel--wait">{t("crew.tunnel.connecting")}</span>}
    </h3>
    <ul className="crew-status-list">
      {group.crew.map((member) => {
        const info = crewConfig[member.role];
        const name = info?.name ?? member.role;
        // Every crew member can have its row expanded to see the task history
        const isExpanded = expandedRoles.has(member.role);
        const tasks = tasksByRole[historyKey(missionId, member.role)];
        const isInitialLoading = !tasks || (tasks.loading && tasks.history.length === 0 && !tasks.current);
        // While awaiting approval, the whole row is made prominent and the status label is replaced
        const isPending = (pendingByRole[member.role] ?? 0) > 0;

        const headerContent = (
          <>
            <span className="crew-status-icon-wrap">
              <span
                className="crew-status-icon-btn"
                role="button"
                tabIndex={0}
                title={t("crew.menu.actions", { name })}
                onClick={(e) => {
                  e.stopPropagation();
                  setProfileRole(member.role);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    setProfileRole(member.role);
                  }
                }}
              >
                <CrewIcon name={name} iconUrl={info?.icon} />
              </span>
            </span>
            <StatusDot status={member.status} />
            <span className="crew-status-name">{name}</span>
            {isPending ? (
              <span className="crew-status-label crew-status-label--pending" title={t("crew.approvalTitle")}>approval</span>
            ) : member.status === "starting" || member.status === "restarting" ? (
              // The status name is shown in English whatever the language setting (the same as idle and working)
              <span className="crew-status-label crew-status-label--starting">{member.status}</span>
            ) : (
              <span className={`crew-status-label${member.status === "working" ? " crew-status-label--working" : ""}`}>{member.status}</span>
            )}
            <ContextBar percent={member.contextPercent} />
            {/*
               The unreported badge and the arrow keep their slots even on rows that have none. So that the column positions do not
                               shift from row to row, columns other than the name have a fixed width.
               */}
            <span className="crew-unreported-slot">
              {member.unreportedCount > 0 && (
                <span className="crew-unreported-badge" title={t("crew.unreportedTasks")}>
                  📋{member.unreportedCount}
                </span>
              )}
            </span>
            <span className={`crew-status-chevron ${isExpanded ? "crew-status-chevron--open" : ""}`}>▶</span>
          </>
        );

        return (
          <li key={member.role} className="crew-status-row">
            <button className={`crew-status-row-header${isPending ? " crew-status-row-header--pending" : ""}`} onClick={() => toggleExpand(member.role)} title={isPending ? t("crew.rowPendingTitle", { name }) : name}>
              {headerContent}
            </button>

            {isExpanded && (
              <div className="crew-status-history">
                {isInitialLoading ? (
                  <p className="crew-status-history-loading">{t("common.loading")}</p>
                ) : (
                  <>
                    {tasks.current && (
                      <div className="popup-row">
                      <button
                        className="crew-status-history-item crew-status-history-item--working"
                        onClick={() => onJump?.(tasks.current!.taskId)}
                        title={t("crew.history.jump")}
                      >
                        <span className="crew-status-history-taskid">
                          <span className="crew-status-history-dot">●</span>
                          {tasks.current.taskId}
                        </span>
                        <span className="crew-status-history-meta">
                          <span className="crew-status-history-taskname">{tasks.current.taskName}</span>
                          <span className="crew-status-history-time">{t("crew.history.inProgress")}</span>
                        </span>
                      </button>
                      <PopupOpenButton onClick={() => onOpenResult?.(tasks.current!.taskId, name)} />
                      </div>
                    )}
                    {tasks.history.length === 0 && !tasks.current ? (
                      <p className="crew-status-history-empty">{t("crew.history.empty")}</p>
                    ) : (
                      tasks.history.map((h) => (
                        <div key={h.taskId} className="popup-row">
                        <button
                          className={`crew-status-history-item ${h.status === "error" ? "crew-status-history-item--error" : ""}`}
                          onClick={() => onJump?.(h.taskId, h.completedAt)}
                          title={t("crew.history.jump")}
                        >
                          <span className="crew-status-history-taskid">{h.taskId}</span>
                          <span className="crew-status-history-meta">
                            <span className="crew-status-history-taskname">{h.taskName}</span>
                            <span className="crew-status-history-time">{formatDateTime(h.completedAt)}</span>
                          </span>
                        </button>
                        <PopupOpenButton onClick={() => onOpenResult?.(h.taskId, name)} />
                        </div>
                      ))
                    )}
                    {tasks.hasMore && (
                      <button className="crew-status-history-more" onClick={() => loadMore(member.role)} disabled={tasks.loading}>
                        {tasks.loading ? t("common.loading") : t("crew.history.loadMore")}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
    </section>
    ))}
    {profileRole && (
      <CrewProfilePopup
        role={profileRole}
        name={crewConfig[profileRole]?.name ?? profileRole}
        iconUrl={crewConfig[profileRole]?.icon}
        missionId={missionId}
        status={crewGroups.flatMap((g) => g.crew).find((m) => m.role === profileRole)?.status ?? "idle"}
        onClose={() => setProfileRole(null)}
        onCrewChanged={onCrewChanged}
      />
    )}
    </>
  );
}
