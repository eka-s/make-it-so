import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./server-api";
import type { SettingsOverview, SettingsShipFields, SettingsShipRole, SettingsShipRuntime, SettingsShipState } from "./types";
import { useI18n } from "./i18n/I18nProvider";
import { confirmDiscard, useRegisterDirty, type DirtyRegistry } from "./use-unsaved";

// The ship form: a ship's port, name, targets, rules and skills, and which roster member holds which role. The server
// validates it the way startup would and answers with message keys per field (`crew.<role>.<field>` for a role's field).

type Draft = { port: string; name: string; cwd: string; rules: string; skills: string; targets: SettingsShipFields["targets"]; crew: SettingsShipRole[]; /** A stable key per role (parallel to `crew`), so a role keeps its open/closed state when others are added or removed. */ roleKeys: number[] };
type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string };

const NEW = "";

let nextRoleKey = 0;

const toDraft = (f: SettingsShipFields): Draft => ({
  roleKeys: f.crew.map(() => nextRoleKey++),
  port: String(f.port), name: f.name ?? "", cwd: f.cwd ?? "", rules: f.rules.join("\n"), skills: f.skills.join("\n"),
  targets: f.targets.map((t) => ({ ...t })), crew: f.crew.map((r) => ({ ...r, access: r.access.map((a) => ({ ...a })) })),
});

const toFields = (d: Draft): SettingsShipFields => ({
  port: Number(d.port),
  name: d.name.trim() || null,
  cwd: d.cwd.trim() || null,
  rules: d.rules.split("\n"),
  skills: d.skills.split("\n"),
  targets: d.targets,
  crew: d.crew,
});

/** The form's fields in a shape that two equal forms compare equal in (the empty lines of a text area are not content). */
const comparable = (f: SettingsShipFields) => JSON.stringify({ ...f, rules: f.rules.filter((x) => x.trim() !== ""), skills: f.skills.filter((x) => x.trim() !== "") });

/** The ranks that stand out in the role bar. */
const RANK_CLASS: Record<SettingsShipRole["rank"], string> = { commander: "settings-badge settings-badge--commander", chief: "settings-badge settings-badge--chief", crew: "settings-badge" };

const emptyRole = (member: string): SettingsShipRole => ({ role: "", member, rank: "crew", model: null, permission_mode: null, cwd: null, agent: null, host: null, access: [] });

export function SettingsShipsForm({ initialShip, dirty }: { initialShip?: string; dirty?: DirtyRegistry }) {
  const { t, tKey, tError } = useI18n();
  // Answers to a slow ship click must not overwrite a later one.
  const selectSeq = useRef(0);
  const [ships, setShips] = useState<SettingsOverview["ships"]>([]);
  const [selected, setSelected] = useState<string | null>(null); // a ship ID, NEW ("") while adding, or null
  const [state, setState] = useState<SettingsShipState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [options, setOptions] = useState<SettingsShipState["options"] | null>(null);
  const [create, setCreate] = useState({ id: "", port: "", name: "", member: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [runtime, setRuntime] = useState<Record<string, SettingsShipRuntime>>({});
  // Whether a ship started from here serves its screen (not in development, where Vite serves it).
  const [shipUi, setShipUi] = useState(false);
  // What the last start/stop asked for: while it has not come true yet, the screen asks again every moment.
  const [wanted, setWanted] = useState<{ id: string; state: "running" | "stopped" } | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  // While deleting: what has been typed so far (the ship's ID has to be typed to confirm). null: not deleting.
  const [deleting, setDeleting] = useState<string | null>(null);
  // The roles that are open (by their stable keys). They start closed; a new role opens, and so does a role with an error.
  const [openRoles, setOpenRoles] = useState<Set<number>>(new Set());
  const toggleRole = (key: number) => setOpenRoles((set) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  // Unsaved input: a ship being created with anything typed, or an open ship whose form differs from what the server has.
  const isDirty = selected === NEW
    ? create.id !== "" || create.port !== "" || create.name !== ""
    : state !== null && draft !== null && comparable(toFields(draft)) !== comparable(state.fields);
  useRegisterDirty(dirty, isDirty);

  const failed = useCallback((data: unknown) => ({ kind: "failed" as const, message: tError(data as never, t("settings.saveFailed")) }), [t, tError]);

  const loadShips = useCallback(async () => {
    const res = await api.getSettingsOverview();
    if (res.ok) setShips((await res.json()).ships);
  }, []);

  useEffect(() => { void loadShips(); }, [loadShips]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only on opening: `select` changes with every render
  useEffect(() => { if (initialShip) void select(initialShip, { force: true }); }, []);

  const loadRuntime = useCallback(async () => {
    const res = await api.getSettingsRuntime();
    if (res.ok) {
      const data = await res.json();
      setRuntime(Object.fromEntries(data.ships.map((s) => [s.id, s])));
      setShipUi(data.shipUi);
    }
  }, []);

  // The states of the ships: once on opening, and every 1.5 seconds while a start or stop is on its way (for at most 20 seconds).
  useEffect(() => { void loadRuntime(); }, [loadRuntime, ships.length]);
  useEffect(() => {
    if (!wanted) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      void loadRuntime();
      if (Date.now() - startedAt > 20_000) {
        setWanted(null);
        if (wanted.state === "running") {
          setStartFailed(true);
          void api.getSettingsShipLog(wanted.id).then(async (r) => { if (r.ok) setLog((await r.json()).text); });
        }
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [wanted, loadRuntime]);
  useEffect(() => {
    if (wanted && runtime[wanted.id]?.state === wanted.state) setWanted(null);
  }, [wanted, runtime]);

  const startShip = async (id: string) => {
    setStartFailed(false);
    setLog(null);
    try {
      const res = await api.startSettingsShip(id);
      if (res.ok) setWanted({ id, state: "running" });
      else setStatus({ kind: "failed", message: tKey((await res.json()).message ?? "", t("settings.saveFailed")) });
    } catch {
      setStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  const stopShip = async (id: string) => {
    try {
      const res = await api.stopSettingsShip(id);
      if (res.ok) setWanted({ id, state: "stopped" });
      else setStatus({ kind: "failed", message: tKey((await res.json()).message ?? "", t("settings.saveFailed")) });
    } catch {
      setStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  const showLog = async (id: string) => {
    try {
      const res = await api.getSettingsShipLog(id);
      if (res.ok) setLog((await res.json()).text);
    } catch {
      setStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  const adopt = (s: SettingsShipState) => {
    setState(s);
    setOptions(s.options);
    setDraft(toDraft(s.fields));
  };

  const select = async (id: string | null, options: { force?: boolean } = {}) => {
    if (!options.force && !confirmDiscard(isDirty, t("settings.unsaved"))) return;
    const seq = ++selectSeq.current;
    setSelected(id);
    setDeleting(null);
    // What belongs to the ship that was open (a failed start, its log) must not show under the next one.
    setStartFailed(false);
    setLog(null);
    setErrors({});
    setStatus({ kind: "idle" });
    setState(null);
    setDraft(null);
    if (id === NEW) {
      // The members to pick from come with any ship; for a new one, ask via the roster.
      const res = await api.getSettingsRoster();
      if (res.ok && seq === selectSeq.current) {
        const roster = await res.json();
        const members = roster.members.map((m) => ({ id: m.id, name: m.name }));
        setOptions({ members, hosts: [], ranks: [], permissionModes: [], accessModes: [] });
        setCreate({ id: "", port: "", name: "", member: members[0]?.id ?? "" });
      }
    } else if (id) {
      try {
        const res = await api.getSettingsShip(id);
        if (seq !== selectSeq.current) return; // a later click has taken over
        if (res.ok) adopt(await res.json());
        else setStatus(failed(await res.json()));
      } catch {
        if (seq === selectSeq.current) setStatus({ kind: "failed", message: t("settings.saveFailed") });
      }
    }
  };

  const save = async () => {
    if (!draft || !state) return;
    setStatus({ kind: "saving" });
    setErrors({});
    try {
      const res = await api.saveSettingsShip(state.id, toFields(draft));
      const data = await res.json();
      if (res.ok) {
        adopt(data);
        setStatus({ kind: "saved" });
        void loadShips();
      } else if (data.errors) {
        setErrors(data.errors);
        setStatus({ kind: "idle" });
        // Open the roles that have an error, so it can be seen.
        setOpenRoles((set) => {
          const next = new Set(set);
          draft.crew.forEach((r, i) => { if (Object.keys(data.errors!).some((k) => k.startsWith(`crew.${r.role}.`))) next.add(draft.roleKeys[i]); });
          return next;
        });
      } else setStatus(failed(data));
    } catch {
      setStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  const deleteShip = async () => {
    if (!state) return;
    try {
      const res = await api.deleteSettingsShip(state.id);
      if (res.ok) {
        setDeleting(null);
        await loadShips();
        await select(null, { force: true });
      } else {
        setStatus({ kind: "failed", message: tKey((await res.json()).message ?? "", t("settings.saveFailed")) });
      }
    } catch {
      setStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  const createShip = async () => {
    setStatus({ kind: "saving" });
    setErrors({});
    try {
      const res = await api.createSettingsShip({ id: create.id.trim(), port: Number(create.port), name: create.name.trim() || null, member: create.member });
      const data = await res.json();
      if (res.ok) {
        await loadShips();
        setSelected(data.id);
        adopt(data);
        setStatus({ kind: "saved" });
      } else if (data.errors) {
        setErrors(data.errors);
        setStatus({ kind: "idle" });
      } else setStatus(failed(data));
    } catch {
      setStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  const change = (patch: Partial<Draft>) => {
    setDraft((d) => d && { ...d, ...patch });
    setStatus({ kind: "idle" });
  };
  const changeRole = (index: number, patch: Partial<SettingsShipRole>) => change({ crew: draft!.crew.map((r, i) => (i === index ? { ...r, ...patch } : r)) });

  const err = (key: string) => errors[key] && <p className="settings-error">{tKey(errors[key], errors[key])}</p>;
  const orNull = (v: string) => (v === "" ? null : v);

  return (
    <div className="settings-roster">
      <aside className="settings-roster-list">
        <h2>{t("settings.ships.list")}</h2>
        <ul className="settings-list">
          {ships.map((s) => (
            <li key={s.id}>
              <button type="button" className={s.id === selected ? "settings-member settings-member--active" : "settings-member"} onClick={() => void select(s.id)}>
                <span className={`settings-dot settings-dot--${runtime[s.id]?.state ?? "stopped"}`} aria-hidden="true" /> <code>{s.id}</code> {s.name ?? ""}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="settings-add" onClick={() => void select(NEW)}>{t("settings.ships.add")}</button>
      </aside>

      <section className="settings-roster-detail">
        <p className="settings-help">{t("settings.ships.help")}</p>
        {selected === null && <p className="settings-dim">{t("settings.ships.pick")}</p>}

        {selected === NEW && options && (
          <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void createShip(); }}>
            {options.members.length === 0 && <p className="settings-error">{t("settings.ships.noMember")}</p>}
            <div className="settings-field">
              <label htmlFor="ship-id">{t("settings.ships.id")}</label>
              <input id="ship-id" type="text" value={create.id} onChange={(e) => setCreate({ ...create, id: e.target.value })} />
              <p className="settings-help">{t("settings.ships.idHelp")}</p>
              {err("id")}
            </div>
            <div className="settings-field">
              <label htmlFor="ship-port">{t("settings.ships.port")}</label>
              <input id="ship-port" type="number" min={1} max={65535} value={create.port} onChange={(e) => setCreate({ ...create, port: e.target.value })} />
              <p className="settings-help">{t("settings.ships.portHelp")}</p>
              {err("port")}
            </div>
            <div className="settings-field">
              <label htmlFor="ship-name">{t("settings.ships.name")}</label>
              <input id="ship-name" type="text" value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} />
            </div>
            <div className="settings-field">
              <label htmlFor="ship-member">{t("settings.ships.member")}</label>
              <select id="ship-member" value={create.member} onChange={(e) => setCreate({ ...create, member: e.target.value })}>
                {options.members.map((m) => <option key={m.id} value={m.id}>{m.id} — {m.name}</option>)}
              </select>
              {err("crew.lead.member")}
            </div>
            {err("ship")}
            <div className="settings-actions">
              <button type="submit" disabled={status.kind === "saving" || options.members.length === 0}>{t("settings.ships.create")}</button>
              {status.kind === "failed" && <span className="settings-error">{status.message}</span>}
            </div>
          </form>
        )}

        {state && draft && options && (
          <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="settings-field">
              <label>{t("settings.ships.id")}</label>
              <code>{state.id}</code>
            </div>
            <div className="settings-field">
              {(() => {
                const rt = runtime[state.id];
                const busy = wanted?.id === state.id;
                return (
                  <>
                    <span className={`settings-state settings-state--${rt?.state ?? "stopped"}`}>
                      {busy ? t(wanted.state === "running" ? "settings.ships.starting" : "settings.ships.stopping") : t(`settings.ships.state.${rt?.state ?? "stopped"}` as never)}
                      {rt?.state === "running" && rt.pid !== undefined && ` (pid ${rt.pid})`}
                    </span>
                    <div className="settings-actions">
                      {rt?.state !== "running" && <button type="button" disabled={busy || rt?.state === "conflict"} onClick={() => void startShip(state.id)}>{t("settings.ships.start")}</button>}
                      {rt?.state === "running" && <button type="button" disabled={busy} onClick={() => void stopShip(state.id)}>{t("settings.ships.stop")}</button>}
                      {rt?.state === "running" && rt.url !== null && shipUi && <a href={rt.url} target="_blank" rel="noreferrer">{t("settings.ships.open")}</a>}
                      <button type="button" onClick={() => (log === null ? void showLog(state.id) : setLog(null))}>{log === null ? t("settings.ships.showLog") : t("settings.ships.hideLog")}</button>
                    </div>
                    {startFailed && <p className="settings-error">{t("settings.ships.startFailed")}</p>}
                    {log !== null && <pre className="settings-log">{log || t("settings.ships.noLog")}</pre>}
                    {rt?.state === "running" && !shipUi && <p className="settings-help">{t("settings.ships.noUi", { command: rt?.devCommand ?? "" })}</p>}
                    <p className="settings-help">{t("settings.ships.runtimeHelp")}</p>
                  </>
                );
              })()}
            </div>
            <div className="settings-field">
              <label htmlFor="ship-port">{t("settings.ships.port")}</label>
              <input id="ship-port" type="number" min={1} max={65535} value={draft.port} onChange={(e) => change({ port: e.target.value })} />
              <p className="settings-help">{t("settings.ships.portHelp")}</p>
              {err("port")}
            </div>
            <div className="settings-field">
              <label htmlFor="ship-name">{t("settings.ships.name")}</label>
              <input id="ship-name" type="text" value={draft.name} onChange={(e) => change({ name: e.target.value })} />
              <p className="settings-help">{t("settings.ships.nameHelp")}</p>
            </div>
            <div className="settings-field">
              <label htmlFor="ship-cwd">{t("settings.ships.cwd")}</label>
              <input id="ship-cwd" type="text" value={draft.cwd} onChange={(e) => change({ cwd: e.target.value })} />
              <p className="settings-help">{t("settings.ships.cwdHelp")}</p>
              {err("cwd")}
            </div>
            <div className="settings-field">
              <label htmlFor="ship-rules">{t("settings.ships.rules")}</label>
              <textarea id="ship-rules" rows={3} value={draft.rules} onChange={(e) => change({ rules: e.target.value })} />
              <p className="settings-help">{t("settings.ships.rulesHelp")}</p>
              {err("rules")}
            </div>
            <div className="settings-field">
              <label htmlFor="ship-skills">{t("settings.ships.skills")}</label>
              <textarea id="ship-skills" rows={3} value={draft.skills} onChange={(e) => change({ skills: e.target.value })} />
              <p className="settings-help">{t("settings.ships.skillsHelp")}</p>
              {err("skills")}
            </div>

            <h2>{t("settings.ships.targets")}</h2>
            <p className="settings-help">{t("settings.ships.targetsHelp")}</p>
            {draft.targets.map((target, i) => (
              <div className="settings-host" key={i}>
                <input aria-label={t("settings.ships.targetName")} placeholder={t("settings.ships.targetName")} value={target.name}
                  onChange={(e) => change({ targets: draft.targets.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <input aria-label={t("settings.ships.targetPath")} placeholder={t("settings.ships.targetPath")} value={target.path}
                  onChange={(e) => change({ targets: draft.targets.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })} />
                <button type="button" onClick={() => change({ targets: draft.targets.filter((_, j) => j !== i) })}>{t("settings.hosts.remove")}</button>
              </div>
            ))}
            {err("targets")}
            <div className="settings-actions">
              <button type="button" onClick={() => change({ targets: [...draft.targets, { name: "", path: "" }] })}>{t("settings.ships.addTarget")}</button>
            </div>

            <h2>{t("settings.ships.crew")}</h2>
            {err("crew")}
            <div className="settings-actions">
              <button type="button" onClick={() => setOpenRoles(new Set(draft.roleKeys))}>{t("settings.ships.expandAll")}</button>
              <button type="button" onClick={() => setOpenRoles(new Set())}>{t("settings.ships.collapseAll")}</button>
            </div>
            {draft.crew.map((r, i) => {
              const at = (f: string) => `crew.${r.role}.${f}`;
              const key = draft.roleKeys[i];
              const isOpen = openRoles.has(key);
              const hasError = Object.keys(errors).some((k) => k.startsWith(`crew.${r.role}.`));
              return (
                <div className={isOpen ? "settings-role settings-role--open" : "settings-role"} key={key}>
                  <button type="button" className="settings-role-bar" aria-expanded={isOpen} onClick={() => toggleRole(key)}>
                    <span className="settings-role-chevron" aria-hidden="true">{isOpen ? "▼" : "▶"}</span>
                    <span className="settings-role-name">{r.role || t("settings.ships.roleUnnamed")}</span>
                    <span className="settings-role-member">{r.member}</span>
                    <span className={RANK_CLASS[r.rank]}>{r.rank}</span>
                    {r.host && <span className="settings-badge settings-badge--host">{r.host}</span>}
                    {hasError && <span className="settings-badge settings-badge--error" role="img" aria-label={t("settings.ships.roleHasError")}>!</span>}
                  </button>
                  {isOpen && <div className="settings-role-body">
                  <div className="settings-field">
                    <label htmlFor={`role-${key}-role`}>{t("settings.ships.role")}</label>
                    <input id={`role-${key}-role`} type="text" value={r.role} onChange={(e) => changeRole(i, { role: e.target.value })} />
                    {err(at("role"))}
                  </div>
                  <div className="settings-field">
                    <label htmlFor={`role-${key}-member`}>{t("settings.ships.member")}</label>
                    <select id={`role-${key}-member`} value={r.member} onChange={(e) => changeRole(i, { member: e.target.value })}>
                      {!options.members.some((m) => m.id === r.member) && <option value={r.member}>{r.member}</option>}
                      {options.members.map((m) => <option key={m.id} value={m.id}>{m.id} — {m.name}</option>)}
                    </select>
                    {err(at("member"))}
                  </div>
                  <div className="settings-field">
                    <label htmlFor={`role-${key}-rank`}>{t("settings.ships.rank")}</label>
                    <select id={`role-${key}-rank`} value={r.rank} onChange={(e) => changeRole(i, { rank: e.target.value as SettingsShipRole["rank"] })}>
                      {options.ranks.map((rk) => <option key={rk} value={rk}>{rk}</option>)}
                    </select>
                    <p className="settings-help">{t("settings.ships.rankHelp")}</p>
                    {err(at("rank"))}
                  </div>
                  <div className="settings-field">
                    <label htmlFor={`role-${key}-model`}>{t("settings.ships.roleModel")}</label>
                    <input id={`role-${key}-model`} type="text" value={r.model ?? ""} onChange={(e) => changeRole(i, { model: orNull(e.target.value) })} />
                  </div>
                  <div className="settings-field">
                    <label htmlFor={`role-${key}-mode`}>{t("settings.ships.rolePermissionMode")}</label>
                    <input id={`role-${key}-mode`} type="text" list="ship-permission-modes" value={r.permission_mode ?? ""} onChange={(e) => changeRole(i, { permission_mode: orNull(e.target.value) })} />
                  </div>
                  <div className="settings-field">
                    <label htmlFor={`role-${key}-cwd`}>{t("settings.ships.roleCwd")}</label>
                    <input id={`role-${key}-cwd`} type="text" value={r.cwd ?? ""} onChange={(e) => changeRole(i, { cwd: orNull(e.target.value) })} />
                    {err(at("cwd"))}
                  </div>
                  <div className="settings-field">
                    <label htmlFor={`role-${key}-agent`}>{t("settings.ships.agent")}</label>
                    <input id={`role-${key}-agent`} type="text" value={r.agent ?? ""} onChange={(e) => changeRole(i, { agent: orNull(e.target.value) })} />
                    <p className="settings-help">{t("settings.ships.agentHelp")}</p>
                  </div>
                  <div className="settings-field">
                    <label htmlFor={`role-${key}-host`}>{t("settings.ships.host")}</label>
                    <select id={`role-${key}-host`} value={r.host ?? ""} onChange={(e) => changeRole(i, { host: orNull(e.target.value) })}>
                      <option value="">—</option>
                      {options.hosts.map((h) => <option key={h} value={h}>{h}</option>)}
                      {r.host && !options.hosts.includes(r.host) && <option value={r.host}>{r.host}</option>}
                    </select>
                    <p className="settings-help">{t("settings.ships.hostHelp")}</p>
                    {err(at("host"))}
                  </div>
                  <div className="settings-field" role="group" aria-labelledby={`role-${key}-access-label`}>
                    <label id={`role-${key}-access-label`}>{t("settings.ships.access")}</label>
                    {r.access.map((a, j) => (
                      <div className="settings-host" key={j}>
                        <select aria-label={t("settings.ships.accessTarget")} value={a.target}
                          onChange={(e) => changeRole(i, { access: r.access.map((x, k) => (k === j ? { ...x, target: e.target.value } : x)) })}>
                          {!draft.targets.some((tg) => tg.name === a.target) && <option value={a.target}>{a.target}</option>}
                          {draft.targets.map((tg) => <option key={tg.name} value={tg.name}>{tg.name}</option>)}
                        </select>
                        <select value={a.mode} onChange={(e) => changeRole(i, { access: r.access.map((x, k) => (k === j ? { ...x, mode: e.target.value as "readonly" | "readwrite" } : x)) })}>
                          {options.accessModes.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <button type="button" onClick={() => changeRole(i, { access: r.access.filter((_, k) => k !== j) })}>{t("settings.hosts.remove")}</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => changeRole(i, { access: [...r.access, { target: draft.targets[0]?.name ?? "", mode: "readonly" }] })}>{t("settings.ships.addAccess")}</button>
                    {err(at("access"))}
                  </div>
                  <div className="settings-actions">
                    <button type="button" className="settings-danger" onClick={() => { change({ crew: draft.crew.filter((_, k) => k !== i), roleKeys: draft.roleKeys.filter((_, k) => k !== i) }); }}>{t("settings.ships.removeRole")}</button>
                  </div>
                  </div>}
                </div>
              );
            })}
            <datalist id="ship-permission-modes">
              {options.permissionModes.map((m) => <option key={m} value={m} />)}
            </datalist>
            <div className="settings-actions">
              <button type="button" onClick={() => { const key = nextRoleKey++; change({ crew: [...draft.crew, emptyRole(options.members[0]?.id ?? "")], roleKeys: [...draft.roleKeys, key] }); setOpenRoles((set) => new Set(set).add(key)); }}>{t("settings.ships.addRole")}</button>
            </div>

            {errors.ship && <p className="settings-error">{t("settings.ships.shipError", { message: errors.ship })}</p>}
            <div className="settings-actions">
              <button type="submit" disabled={status.kind === "saving"}>{status.kind === "saving" ? t("settings.saving") : t("settings.save")}</button>
              {status.kind === "saved" && <span className="settings-ok">{t("settings.saved")}</span>}
              {status.kind === "failed" && <span className="settings-error">{status.message}</span>}
            </div>

            <h2>{t("settings.ships.delete")}</h2>
            <p className="settings-help">{t("settings.ships.deleteHelp")}</p>
            {deleting === null ? (
              <div className="settings-actions">
                <button type="button" className="settings-danger" disabled={runtime[state.id]?.state === "running"} onClick={() => setDeleting("")}>{t("settings.ships.delete")}</button>
                {runtime[state.id]?.state === "running" && <span className="settings-dim">{t("settings.ships.deleteRunning")}</span>}
              </div>
            ) : (
              <div className="settings-host">
                <input aria-label={t("settings.ships.deleteConfirm", { id: state.id })} placeholder={t("settings.ships.deleteConfirm", { id: state.id })} value={deleting} onChange={(e) => setDeleting(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (deleting === state.id) void deleteShip(); } }} />
                <button type="button" className="settings-danger" disabled={deleting !== state.id} onClick={() => void deleteShip()}>{t("settings.ships.deleteDo")}</button>
                <button type="button" onClick={() => setDeleting(null)}>{t("settings.ships.deleteCancel")}</button>
              </div>
            )}
          </form>
        )}
      </section>
    </div>
  );
}
