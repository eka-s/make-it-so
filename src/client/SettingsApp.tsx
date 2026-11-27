import { useEffect, useRef, useState } from "react";
import { api } from "./server-api";
import type { SettingsOverview, SettingsShipRuntime } from "./types";
import { BottomBar } from "./BottomBar";
import { LanguageMenu } from "./LanguageSwitch";
import { useT } from "./i18n/I18nProvider";
import { SettingsConfigForm } from "./SettingsConfigForm";
import { SettingsHostsForm } from "./SettingsHostsForm";
import { SettingsQuickActionsForm } from "./SettingsQuickActionsForm";
import { SettingsRosterForm } from "./SettingsRosterForm";
import { SettingsShipsForm } from "./SettingsShipsForm";
import { SettingsImportForm } from "./SettingsImportForm";
import { ThemeMenu } from "./ThemeMenu";
import { useTheme } from "./use-theme";
import { useShellAppearance } from "./use-shell-appearance";
import { useShellWindow } from "./use-shell-window";
import { ShellMenuButton } from "./ShellMenuButton";
import { confirmDiscard, type DirtyRegistry } from "./use-unsaved";
import "./SettingsApp.css";

const TABS = ["overview", "config", "hosts", "quick", "roster", "ships", "import"] as const;
type Tab = (typeof TABS)[number];

// The settings screen (served by `--settings`). It draws what the settings server reports.
export function SettingsApp() {
  const t = useT();
  const { theme, setTheme } = useTheme();
  const headerRef = useRef<HTMLElement>(null);
  useShellWindow(headerRef);
  useShellAppearance(theme, setTheme, { crew: false });
  const [overview, setOverview] = useState<SettingsOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  // The ship the ships tab opens on (the one just made from a project).
  const [openShip, setOpenShip] = useState<string | undefined>(undefined);
  const [runtime, setRuntime] = useState<SettingsShipRuntime[]>([]);
  // The desktop app opens a ship in a window: there is no count of running ships to show.
  const [desktop, setDesktop] = useState(false);
  // What the form on screen says about unsaved input (it registers itself here).
  const dirty = useRef<() => boolean>(() => false) as DirtyRegistry;
  const goTo = (next: Tab, shipId?: string) => {
    if (next !== tab && !confirmDiscard(dirty.current(), t("settings.unsaved"))) return;
    if (shipId !== undefined) setOpenShip(shipId);
    setTab(next);
  };
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty.current()) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // How many ships are running, for the header (asked again every few seconds: ships can be started and stopped elsewhere).
  useEffect(() => {
    let alive = true;
    const load = () => api.getSettingsRuntime().then(async (res) => { if (alive && res.ok) { const data = await res.json(); setRuntime(data.ships); setDesktop(data.desktop); } }).catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.getSettingsOverview(controller.signal)
      .then(async (res) => {
        if (!res.ok) { setFailed(true); return; }
        setOverview(await res.json());
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);

  return (
    <div className="settings-app">
      <header className="settings-header" ref={headerRef}>
        <h1>Make-It-So</h1>
        <span className="settings-title">{t("settings.title")}</span>
        <div className="settings-header-switch"><ThemeMenu theme={theme} onSelect={setTheme} /><LanguageMenu /></div>
        {!desktop && (
          <span className="settings-status">
            <span className={runtime.some((s) => s.state === "running") ? "settings-dot settings-dot--running" : "settings-dot"} aria-hidden="true" />
            {t("settings.status.running", { running: runtime.filter((s) => s.state === "running").length, total: runtime.length })}
          </span>
        )}
        <ShellMenuButton />
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label={t("settings.title")}>
          {TABS.map((id) => (
            <button key={id} className={id === tab ? "settings-nav-item settings-nav-item--active" : "settings-nav-item"} onClick={() => goTo(id)} aria-current={id === tab ? "page" : undefined}>
              {t(`settings.nav.${id}` as const)}
            </button>
          ))}
        </nav>
        <main className="settings-main">
        {tab === "config" && <SettingsConfigForm dirty={dirty} />}
        {tab === "hosts" && <SettingsHostsForm dirty={dirty} />}
        {tab === "quick" && <SettingsQuickActionsForm dirty={dirty} />}
        {tab === "roster" && <SettingsRosterForm dirty={dirty} />}
        {tab === "ships" && <SettingsShipsForm initialShip={openShip} dirty={dirty} />}
        {tab === "import" && <SettingsImportForm dirty={dirty} onShips={(id) => { dirty.current = () => false; goTo("ships", id); }} />}
        {tab === "overview" && failed && <p className="settings-error">{t("settings.loadFailed")}</p>}
        {tab === "overview" && !failed && !overview && <p>{t("settings.loading")}</p>}
        {tab === "overview" && overview && (
          <>
            {overview.ships.length === 0 && (
              <section className="settings-section">
                <h2>{t("settings.start.title")}</h2>
                <p>{t("settings.start.text")}</p>
                <div className="settings-actions">
                  <button type="button" onClick={() => goTo("import")}>{t("settings.start.button")}</button>
                </div>
              </section>
            )}

            <section className="settings-section">
              <h2>{t("settings.dir")}</h2>
              <code className="settings-dir">{overview.dir}</code>
              {!overview.exists && (
                <p className="settings-notice">
                  {t("settings.missing")} {t("settings.missingHint")}
                </p>
              )}
            </section>

            <section className="settings-section">
              <h2>{t("settings.files")}</h2>
              <ul className="settings-list">
                {overview.files.map((f) => (
                  <li key={f.name}>
                    <code>{f.name}</code>
                    <span className={f.exists ? "settings-ok" : "settings-dim"}>
                      {f.exists ? t("settings.exists") : t("settings.absent")}
                      {f.name !== "roster.yml" && !f.exists && ` (${t("settings.optional")})`}
                    </span>
                  </li>
                ))}
                <li>
                  <code>personnel/</code>
                  <span className="settings-dim">{t("settings.personnel")}: {overview.personnelCount}</span>
                </li>
              </ul>
            </section>

            <section className="settings-section">
              <h2>{t("settings.ships")}</h2>
              {overview.ships.length === 0 ? (
                <p className="settings-dim">{t("settings.noShips")}</p>
              ) : (
                <ul className="settings-list">
                  {overview.ships.map((ship) => (
                    <li key={ship.id}>
                      <code>{ship.id}</code>
                      <span>{ship.name ?? ""}</span>
                      <span className="settings-dim">{ship.port !== undefined ? `:${ship.port}` : ""}</span>
                      {ship.error && <span className="settings-error">{ship.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
        </main>
      </div>
      <BottomBar />
    </div>
  );
}
