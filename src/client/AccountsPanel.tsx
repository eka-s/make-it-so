import { useState } from "react";
import "./AccountsPanel.css";
import type { AccountsSnapshot, AccountUsage, CreditsUsageData } from "./types";
import { useT } from "./i18n/I18nProvider";

type AccountsPanelProps = {
  /** Usage per account as built by the server (null if it has not arrived yet). */
  snapshot: AccountsSnapshot | null;
  /** Re-fetches the usage (returns a Promise so completion can be awaited). */
  onRefresh: () => Promise<void>;
};

function getCreditsColor(percent: number): string {
  if (percent > 95) return "#ff4444";
  if (percent > 80) return "#ff8800";
  if (percent > 50) return "#ffcc00";
  return "#44cc44";
}

type UsageRowProps = { label: string; percent: number; text: string; resetsAt: string };

function UsageRow({ label, percent, text, resetsAt }: UsageRowProps) {
  const t = useT();
  return (
    <div className="accounts-usage">
      <span className="accounts-usage-label">{label}</span>
      <div className="accounts-usage-bar">
        <div
          className="accounts-usage-bar-fill"
          style={{ width: `${Math.min(100, percent)}%`, backgroundColor: getCreditsColor(percent) }}
        />
      </div>
      <span className="accounts-usage-value">
        {text}
        <span className="accounts-usage-resets"> | {t("accounts.resets", { when: resetsAt })}</span>
      </span>
    </div>
  );
}

function UsageRows({ usage }: { usage: CreditsUsageData | null }) {
  const t = useT();
  if (!usage) {
    return (
      <div className="accounts-usage accounts-usage--waiting">
        <span className="accounts-usage-label">{t("accounts.credits")}</span>
        <span />
        <span className="accounts-usage-value">--</span>
      </div>
    );
  }
  const main =
    usage.used != null && usage.limit != null
      ? `${usage.used}/${usage.limit} (${usage.usedPercent.toFixed(1)}%)`
      : `${usage.usedPercent.toFixed(1)}%`;
  return (
    <>
      <UsageRow label={usage.label ?? t("accounts.credits")} percent={usage.usedPercent} text={main} resetsAt={usage.resetsAt} />
      {usage.secondary && (
        <UsageRow
          label={usage.secondary.label}
          percent={usage.secondary.usedPercent}
          text={`${usage.secondary.usedPercent.toFixed(1)}%`}
          resetsAt={usage.secondary.resetsAt}
        />
      )}
    </>
  );
}

// The "Accounts" section of the left pane. A frame is made per authenticated account, showing the usage and the crew members running
// on that account. How they are grouped (deciding whether the credentials are the same) is decided by the server; this only
// lays out what it receives.
export function AccountsPanel({ snapshot, onRefresh }: AccountsPanelProps) {
  const t = useT();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  if (!snapshot) return <div className="accounts-placeholder">--</div>;

  return (
    <div className="accounts-panel">
      <div className="accounts-toolbar">
        <button className="accounts-refresh" onClick={() => void refresh()} disabled={isRefreshing} title={t("accounts.refresh")}>
          🔄
        </button>
      </div>
      {snapshot.accounts.map((account: AccountUsage) => (
        <section className="accounts-card" key={account.key}>
          <div className="accounts-card-title">
            <span className={`accounts-card-name ${account.label ? "" : "accounts-card-name--unknown"}`} title={account.label ?? undefined}>
              {account.label ?? t("accounts.unknown", { provider: account.provider })}
            </span>
            {account.plan && <span className="accounts-card-plan">{account.plan}</span>}
          </div>
          <UsageRows usage={account.usage} />
          <div className="accounts-crews">{account.crews.join(" · ")}</div>
        </section>
      ))}
      {snapshot.untracked.length > 0 && (
        <section className="accounts-card accounts-card--untracked">
          <div className="accounts-card-title">
            <span className="accounts-card-name accounts-card-name--unknown">{t("accounts.untracked")}</span>
          </div>
          <div className="accounts-crews">{snapshot.untracked.join(" · ")}</div>
          <div className="accounts-note">{t("accounts.untrackedNote")}</div>
        </section>
      )}
    </div>
  );
}
