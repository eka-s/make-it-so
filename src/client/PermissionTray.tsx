import { useState } from "react";
import type { PendingPermission, CrewMemberConfig } from "./types";
import { useT } from "./i18n/I18nProvider";

type Props = {
  permissions: PendingPermission[];
  crewConfig: Record<string, CrewMemberConfig>;
  onRespond: (key: string, optionId: string) => void;
};

// Renders all pending permission requests in a fixed, always-visible tray above the input box
// — never inline in the conversation. Requests are tracked independently of `messages` (see App.tsx),
// so this list always matches exactly what is unresolved right now, regardless of whether it can be matched to a particular
// chat bubble or crew card.
// The display name is looked up by the role name (`role`) the server attached (`scope` may be an acp_agent name).
function displayName(permission: PendingPermission, crewConfig: Record<string, CrewMemberConfig>): string {
  return crewConfig[permission.role]?.name ?? crewConfig[permission.scope]?.name ?? permission.scope;
}

function PermissionCard({ permission, name, onRespond }: { permission: PendingPermission; name: string; onRespond: (optionId: string) => void }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const hasInput = permission.toolInput && Object.keys(permission.toolInput).length > 0;

  return (
    <div className="permission-tray-card">
      <div className="permission-tray-card-header">
        <span className="permission-tray-card-agent">🔐 {name}</span>
        {permission.taskId && <span className="permission-tray-card-task">{permission.taskId}</span>}
      </div>
      <div className="permission-tray-card-tool">
        <strong>{permission.toolName}</strong>
        {hasInput && (
          <button
            className="permission-tray-card-toggle"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
          >
            {expanded ? t("permission.hideDetails") : t("permission.showDetails")}
          </button>
        )}
      </div>
      {expanded && hasInput && (
        <pre className="permission-tray-card-input">{JSON.stringify(permission.toolInput, null, 2)}</pre>
      )}
      <div className="permission-tray-card-options">
        {permission.options.map((opt, i) => (
          <button
            key={i}
            className={`permission-btn ${opt.kind === "allow_once" || opt.kind === "allow_always" ? "permission-btn--allow" : "permission-btn--deny"}`}
            onClick={() => onRespond(opt.optionId ?? "reject")}
          >
            {opt.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PermissionTray({ permissions, crewConfig, onRespond }: Props) {
  const t = useT();
  if (permissions.length === 0) return null;

  return (
    <div className="permission-tray">
      <div className="permission-tray-title">{t("permission.title", { count: permissions.length })}</div>
      <div className="permission-tray-list">
        {permissions.map((p) => (
          <PermissionCard
            key={p.key}
            permission={p}
            name={displayName(p, crewConfig)}
            onRespond={(optionId) => onRespond(p.key, optionId)}
          />
        ))}
      </div>
    </div>
  );
}
