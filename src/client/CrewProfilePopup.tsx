import { useCallback, useEffect, useRef, useState } from "react";
import "./CrewProfilePopup.css";
import { CrewIcon } from "./crewIcons";
import { CrewModelSelect } from "./CrewModelSelect";
import { HostBadge } from "./HostBadge";
import { api } from "./server-api";
import type { AgentStatus, CrewModelEntry, CrewPersona, CrewProfile } from "./types";
import { useI18n } from "./i18n/I18nProvider";

type CrewProfilePopupProps = {
  role: string;
  /**
   * The display name and icon come from the crew composition (crewConfig). They can be shown even before fetching.
   */
  name: string;
  iconUrl?: string;
  missionId: string;
  /** The current state of the crew member (it can be restarted only while idle). */
  status: AgentStatus;
  onClose: () => void;
  /** The icon was changed. The caller re-fetches the crew composition. */
  onCrewChanged: () => void;
};

const ICON_ERROR_KEYS: Record<string, string> = {
  unsupported_type: "profile.icon.error.unsupportedType",
  too_large: "profile.icon.error.tooLarge",
  empty: "profile.icon.error.empty",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="profile-field">
      <span className="profile-field-label">{label}</span>
      <span className="profile-field-value">{children}</span>
    </div>
  );
}

function PersonaSection({ persona, provider, memberId }: { persona: CrewPersona; provider: string; memberId: string | null }) {
  const { t } = useI18n();
  if (persona.source === "none") {
    return <p className="profile-note">{t("profile.persona.none", { file: `personnel/${memberId ?? "?"}.md` })}</p>;
  }
  if (persona.source === "personnel") {
    return (
      <>
        <p className="profile-note">{t("profile.persona.fromPersonnel", { file: persona.path })}</p>
        <pre className="profile-text">{persona.text}</pre>
      </>
    );
  }
  if (persona.status === "found") {
    return (
      <>
        <p className="profile-note">{t("profile.persona.fromAgent", { provider, agent: persona.agent, file: persona.path })}</p>
        <pre className="profile-text">{persona.text}</pre>
        <p className="profile-note profile-note--dim">{t("profile.persona.agentCaveat")}</p>
      </>
    );
  }
  return (
    <p className="profile-note">
      {persona.status === "remote"
        ? t("profile.persona.agentRemote", { agent: persona.agent })
        : t("profile.persona.agentNotFound", { provider, agent: persona.agent })}
    </p>
  );
}

// One crew member's "personnel record": a list of the face photo, assignment, and background (persona), like what appears when you look up a crew member
// in the fleet library. Changing the icon, changing the model, and restarting the session are also done here. What is shown renders as is
// the profile the server built (GET /api/crew/:role/profile).
export function CrewProfilePopup({ role, name, iconUrl, missionId, status, onClose, onCrewChanged }: CrewProfilePopupProps) {
  const { t, tKey, tError } = useI18n();
  const [profile, setProfile] = useState<CrewProfile | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [modelEntry, setModelEntry] = useState<CrewModelEntry | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showBriefing, setShowBriefing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const flash = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(null), 6000);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.getCrewProfile(role, controller.signal)
      .then(async (res) => {
        if (res.ok) setProfile((await res.json()) as unknown as CrewProfile);
        else setLoadFailed(true);
      })
      .catch((err) => { if (!(err instanceof Error && err.name === "AbortError")) setLoadFailed(true); });
    api.getCrewModels(missionId, controller.signal)
      .then(async (res) => {
        if (!res.ok) return;
        const list = (await res.json()) as unknown as CrewModelEntry[];
        setModelEntry(list.find((e) => e.role === role) ?? null);
      })
      .catch(() => { /* if it cannot be fetched, the model field is just not shown */ });
    return () => controller.abort();
  }, [role, missionId]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleModelChange = useCallback(async (value: string) => {
    try {
      const res = await api.setCrewModel(missionId, role, value === "" ? null : value);
      const data = await res.json();
      if (!res.ok) {
        flash(`⚠️ ${tError(data, t("crew.model.changeFailed"))}`);
        return;
      }
      setModelEntry(data as unknown as CrewModelEntry);
    } catch {
      flash(`⚠️ ${t("common.networkError")}`);
    }
  }, [missionId, role, t, tError, flash]);

  const handleRestart = useCallback(async () => {
    if (!window.confirm(t("crew.restart.confirm", { name }))) return;
    try {
      const res = await api.restartAgent(role, missionId);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        flash(`⚠️ ${tError(data, "Unknown error")}`);
      }
    } catch {
      flash(`⚠️ ${t("common.networkError")}`);
    }
  }, [role, missionId, name, t, tError, flash]);

  const handleIconFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    try {
      const res = await api.uploadCrewIcon(role, file);
      const data = await res.json();
      if (!res.ok) {
        const key = data.reason ? ICON_ERROR_KEYS[data.reason] : undefined;
        flash(`⚠️ ${key ? tKey(key, t("profile.icon.error.generic")) : t("profile.icon.error.generic")}`);
        return;
      }
      setMessage(null);
      onCrewChanged();
    } catch {
      flash(`⚠️ ${t("common.networkError")}`);
    }
  }, [role, t, tKey, flash, onCrewChanged]);

  const handleIconReset = useCallback(async () => {
    try {
      const res = await api.deleteCrewIcon(role);
      if (!res.ok) {
        flash(`⚠️ ${t("profile.icon.error.generic")}`);
        return;
      }
      onCrewChanged();
    } catch {
      flash(`⚠️ ${t("common.networkError")}`);
    }
  }, [role, t, flash, onCrewChanged]);

  const canRestart = status === "idle";

  return (
    <div className="profile-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="profile-popup" role="dialog" aria-modal="true" aria-label={t("profile.title")} tabIndex={-1} ref={dialogRef}>
        <header className="profile-header">
          <span className="profile-header-title">{t("profile.title")}</span>
          <button className="profile-close" onClick={onClose} aria-label={t("profile.close")} title={t("profile.close")}>×</button>
        </header>

        <div className="profile-body">
          <div className="profile-top">
            <div className="profile-portrait">
              <div className="profile-portrait-frame">
                <CrewIcon name={name} iconUrl={iconUrl} size={132} />
              </div>
              <button className="profile-button" onClick={() => fileRef.current?.click()}>{t("profile.icon.change")}</button>
              {iconUrl && <button className="profile-button profile-button--quiet" onClick={() => void handleIconReset()}>{t("profile.icon.reset")}</button>}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(e) => {
                  void handleIconFile(e.target.files?.[0]);
                  e.target.value = ""; // so that the same file can be selected again
                }}
              />
              <span className="profile-hint">{t("profile.icon.hint")}</span>
            </div>

            <div className="profile-fields">
              <div className="profile-name">{name}</div>
              {loadFailed && <p className="profile-note">{t("profile.loadFailed")}</p>}
              {!profile && !loadFailed && <p className="profile-note">{t("common.loading")}</p>}
              {profile && (
                <>
                  <Field label={t("profile.field.rank")}>
                    <span title={t(`profile.rank.${profile.rank}.hint`)}>{t(`profile.rank.${profile.rank}`)}</span>
                  </Field>
                  <Field label={t("profile.field.role")}>{profile.role}</Field>
                  <Field label={t("profile.field.memberId")}>{profile.memberId ?? "—"}</Field>
                  <Field label={t("profile.field.provider")}>{profile.provider}</Field>
                  <Field label={t("profile.field.permission")}>{profile.permissionMode ?? t("profile.permission.default")}</Field>
                  <Field label={t("profile.field.station")}>
                    {profile.host ? <HostBadge host={profile.host} /> : t("profile.station.local")}
                  </Field>
                  <Field label={t("profile.field.cwd")}><code>{profile.cwd}</code></Field>
                </>
              )}
              {modelEntry && (
                <div className="profile-model">
                  <CrewModelSelect entry={modelEntry} onChange={(value) => void handleModelChange(value)} />
                </div>
              )}
              <Field label={t("profile.field.status")}>
                <span className={`profile-status profile-status--${status}`}>{status}</span>
                <button className="profile-button profile-button--inline" onClick={() => void handleRestart()} disabled={!canRestart} title={canRestart ? undefined : t("profile.restart.busy")}>
                  {t("profile.restart")}
                </button>
              </Field>
            </div>
          </div>

          {message && <p className="profile-message">{message}</p>}

          {profile && (
            <section className="profile-section">
              <h3 className="profile-section-title">{t("profile.persona.title")}</h3>
              <PersonaSection persona={profile.persona} provider={profile.provider} memberId={profile.memberId} />

              <button className="profile-toggle" onClick={() => setShowBriefing((v) => !v)} aria-expanded={showBriefing}>
                {showBriefing ? "▾" : "▸"} {t("profile.briefing.title")}
              </button>
              {showBriefing && (
                <>
                  <p className="profile-note profile-note--dim">{t("profile.briefing.hint")}</p>
                  {profile.briefing !== null
                    ? <pre className="profile-text">{profile.briefing}</pre>
                    : <p className="profile-note">{t("profile.briefing.error", { reason: profile.briefingError ?? "" })}</p>}
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
