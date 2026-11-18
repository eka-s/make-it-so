import { useState } from "react";
import { api } from "./server-api";
import type { SettingsImportDraft, SettingsImportErrors, SettingsImportScan } from "./types";
import { useI18n } from "./i18n/I18nProvider";
import { useRegisterDirty, type DirtyRegistry } from "./use-unsaved";

// Making a ship from an existing project. The server reads the project and drafts the crew and the ship; this form shows
// the draft, lets it be changed (IDs, names, the commander, which rule files to add) and sends it back to be saved.
// The draft's own structure is kept as the server made it: the members and the ship's roles are parallel lists.

type Provider = "claude" | "kiro";
type Row = { id: string; name: string; reuse: boolean; exists: boolean; agent: string | null };
type Edit = { shipId: string; shipName: string; port: string; rows: Row[]; commander: number | null; rules: Set<string> };
type Status = { kind: "idle" } | { kind: "working" } | { kind: "failed"; message: string };

/** An edit as plain data (the rule files are a Set), to compare two edits. */
const serializable = (e: Edit) => ({ ...e, rules: [...e.rules].sort() });

const toEdit = (d: SettingsImportDraft): Edit => ({
  shipId: d.ship.id,
  shipName: d.ship.fields.name ?? "",
  port: String(d.ship.fields.port),
  rows: d.members.map((m, i) => ({ id: m.id, name: m.input.name, reuse: m.reuse, exists: m.exists, agent: d.ship.fields.crew[i]?.agent ?? null })),
  commander: null,
  rules: new Set(),
});

export function SettingsImportForm({ onShips, dirty }: { onShips: (shipId: string) => void; dirty?: DirtyRegistry }) {
  const { t, tKey, tError } = useI18n();
  const [path, setPath] = useState("");
  const [scan, setScan] = useState<SettingsImportScan | null>(null);
  const [provider, setProvider] = useState<Provider>("claude");
  // One set of edits per provider: switching the provider and back keeps what was changed for each.
  const [edits, setEdits] = useState<Partial<Record<Provider, Edit>>>({});
  const [errors, setErrors] = useState<SettingsImportErrors | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [created, setCreated] = useState<string | null>(null);

  const draft = scan?.drafts?.[provider] ?? null;
  // Unsaved input: a draft that was read and then changed (or not yet saved once it has been changed), in either provider's edits.
  const changed = (p: Provider) => scan?.drafts && edits[p] && JSON.stringify(serializable(edits[p]!)) !== JSON.stringify(serializable(toEdit(scan.drafts[p])));
  useRegisterDirty(dirty, created === null && Boolean(changed("claude") || changed("kiro")));
  const edit = edits[provider] ?? null;
  const setEdit = (next: Edit | null | ((e: Edit | null) => Edit | null)) =>
    setEdits((all) => {
      const value = typeof next === "function" ? next(all[provider] ?? null) : next;
      return value === null ? { ...all, [provider]: undefined } : { ...all, [provider]: value };
    });

  const choose = (s: SettingsImportScan, p: Provider) => {
    setProvider(p);
    setErrors(null);
  };

  const read = async () => {
    setStatus({ kind: "working" });
    setScan(null);
    setEdits({});
    setCreated(null);
    setErrors(null);
    try {
      const res = await api.scanSettingsImport(path.trim());
      const data = await res.json();
      if (!res.ok) { setStatus({ kind: "failed", message: tError(data, t("settings.saveFailed")) }); return; }
      setScan(data);
      if (data.drafts) setEdits({ claude: toEdit(data.drafts.claude), kiro: toEdit(data.drafts.kiro) });
      // The provider the project has something for comes first (claude when both or neither).
      choose(data, data.found.kiro && !data.found.claude ? "kiro" : "claude");
      setStatus({ kind: "idle" });
    } catch {
      setStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  const create = async () => {
    if (!draft || !edit) return;
    setStatus({ kind: "working" });
    setErrors(null);
    const members = edit.rows.map((r, i) => ({ id: r.id.trim(), reuse: r.reuse, input: { ...draft.members[i].input, name: r.name } }));
    const crew = draft.ship.fields.crew.map((role, i) => ({ ...role, role: members[i].id, member: members[i].id, rank: edit.commander === i ? ("commander" as const) : ("chief" as const) }));
    try {
      const res = await api.saveSettingsImport({
        members,
        ship: {
          id: edit.shipId.trim(),
          fields: { ...draft.ship.fields, port: Number(edit.port), name: edit.shipName.trim() || null, rules: [...edit.rules], crew },
        },
      });
      const data = await res.json();
      if (res.ok) { setCreated(data.shipId); setStatus({ kind: "idle" }); }
      else if (data.errors) { setErrors(data.errors); setStatus({ kind: "idle" }); }
      else setStatus({ kind: "failed", message: tError(data, t("settings.saveFailed")) });
    } catch {
      setStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  const setRow = (index: number, patch: Partial<Row>) => setEdit((e) => e && { ...e, rows: e.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  const fieldError = (messages: Record<string, string> | undefined) => messages && Object.entries(messages).map(([field, key]) => <p className="settings-error" key={field}>{field}: {tKey(key, key)}</p>);

  if (created !== null) {
    return (
      <div className="settings-form">
        <p className="settings-ok">{t("settings.import.created", { id: created })}</p>
        <div className="settings-actions">
          <button type="button" onClick={() => onShips(created)}>{t("settings.import.toShips")}</button>
          <button type="button" onClick={() => { setCreated(null); setScan(null); setEdits({}); setPath(""); }}>{t("settings.import.another")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-form">
      <p className="settings-help">{t("settings.import.help")}</p>
      <p className="settings-help">{t("settings.import.anyDir")}</p>
      <form className="settings-field" onSubmit={(e) => { e.preventDefault(); void read(); }}>
        <label htmlFor="import-path">{t("settings.import.path")}</label>
        <input id="import-path" type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/repo/my-app" />
        <p className="settings-help">{t("settings.import.pathHelp")}</p>
        <div className="settings-actions">
          <button type="submit" disabled={path.trim() === "" || status.kind === "working"}>{t("settings.import.read")}</button>
          {status.kind === "failed" && <span className="settings-error">{status.message}</span>}
        </div>
      </form>

      {scan && !scan.isDirectory && <p className="settings-error">{t("settings.import.notDirectory")}</p>}

      {scan?.isDirectory && draft && edit && (
        <>
          {!scan.found.claude && !scan.found.kiro && <p className="settings-notice">{t("settings.import.nothingFound")}</p>}
          <div className="settings-field">
            <label htmlFor="import-provider">{t("settings.import.provider")}</label>
            <select id="import-provider" value={provider} onChange={(e) => choose(scan, e.target.value as Provider)}>
              {(["claude", "kiro"] as const).map((p) => <option key={p} value={p}>{p}{scan.found[p] ? ` (${t("settings.import.found")})` : ""}</option>)}
            </select>
          </div>

          {draft.notes.map((n) => <p className="settings-notice" key={`${n.code}${n.file}`}>{t(`settings.import.note.${n.code}` as const, { file: n.file })}</p>)}
          {draft.mcp && <p className="settings-notice">{t("settings.import.mcp", { file: draft.mcp.file, servers: draft.mcp.servers.join(", ") })}</p>}

          <h2>{t("settings.import.draft")}</h2>
          <div className="settings-field">
            <label htmlFor="import-ship-id">{t("settings.import.shipId")}</label>
            <input id="import-ship-id" type="text" value={edit.shipId} onChange={(e) => setEdit({ ...edit, shipId: e.target.value })} />
          </div>
          <div className="settings-field">
            <label htmlFor="import-ship-name">{t("settings.import.shipName")}</label>
            <input id="import-ship-name" type="text" value={edit.shipName} onChange={(e) => setEdit({ ...edit, shipName: e.target.value })} />
          </div>
          <div className="settings-field">
            <label htmlFor="import-ship-port">{t("settings.import.shipPort")}</label>
            <input id="import-ship-port" type="number" min={1} max={65535} value={edit.port} onChange={(e) => setEdit({ ...edit, port: e.target.value })} />
          </div>

          <h2>{t("settings.import.members")}</h2>
          <p className="settings-help">{t("settings.import.membersHelp")}</p>
          {edit.rows.map((r, i) => (
            <div className="settings-role settings-role--open" key={i}>
              <div className="settings-role-body">
                <div className="settings-field">
                  <label>{t("settings.import.agent")}</label>
                  <code>{r.agent ?? t("settings.import.noAgent")}</code>
                </div>
                <div className="settings-field">
                  <label htmlFor={`import-member-${i}-id`}>{t("settings.import.memberId")}</label>
                  <input id={`import-member-${i}-id`} type="text" value={r.id} disabled={r.reuse} onChange={(e) => setRow(i, { id: e.target.value })} />
                </div>
                <div className="settings-field">
                  <label htmlFor={`import-member-${i}-name`}>{t("settings.import.memberName")}</label>
                  <input id={`import-member-${i}-name`} type="text" value={r.name} disabled={r.reuse} onChange={(e) => setRow(i, { name: e.target.value })} />
                </div>
                {r.exists && (
                  <label className="settings-check">
                    <input type="checkbox" checked={r.reuse} onChange={(e) => setRow(i, { reuse: e.target.checked })} /> {t("settings.import.reuse")}
                  </label>
                )}
                {fieldError(errors?.members[r.id.trim()])}
              </div>
            </div>
          ))}

          <div className="settings-field">
            <label htmlFor="import-commander">{t("settings.import.commander")}</label>
            <select id="import-commander" value={edit.commander ?? ""} onChange={(e) => setEdit({ ...edit, commander: e.target.value === "" ? null : Number(e.target.value) })}>
              <option value="">{t("settings.import.commanderNone")}</option>
              {edit.rows.map((r, i) => <option key={i} value={i}>{r.id}</option>)}
            </select>
            <p className="settings-help">{t("settings.import.commanderHelp")}</p>
          </div>

          {draft.ruleCandidates.length > 0 && (
            <div className="settings-field">
              <label>{t("settings.import.rules")}</label>
              {draft.ruleCandidates.map((c) => (
                <label className="settings-check" key={c.path}>
                  <input type="checkbox" checked={edit.rules.has(c.path)}
                    onChange={(e) => { const rules = new Set(edit.rules); if (e.target.checked) rules.add(c.path); else rules.delete(c.path); setEdit({ ...edit, rules }); }} /> {c.label}
                </label>
              ))}
              <p className="settings-help">{t("settings.import.rulesHelp")}</p>
            </div>
          )}

          {errors && Object.keys(errors.ship).length > 0 && (
            <div>
              <p className="settings-error">{t("settings.import.errors")}</p>
              {fieldError(errors.ship)}
            </div>
          )}
          <div className="settings-actions">
            <button type="button" disabled={status.kind === "working"} onClick={() => void create()}>{t("settings.import.create")}</button>
            {status.kind === "failed" && <span className="settings-error">{status.message}</span>}
          </div>
        </>
      )}
    </div>
  );
}
