import { useState, useEffect, useLayoutEffect, useRef, useCallback, useReducer, useMemo } from "react";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { MissionPanel } from "./MissionPanel";
import { LeftColumn } from "./LeftColumn";
import { CollapsibleSection } from "./CollapsibleSection";
import { CrewStatusPanel } from "./CrewStatusPanel";
import { BottomBar } from "./BottomBar";
import { AccountsPanel } from "./AccountsPanel";
import { SearchPalette } from "./SearchPalette";
import { ScrollEdgeButtons } from "./ScrollEdgeButtons";
import { MessagePopup, type MessagePopupTarget } from "./MessagePopup";
import { animateScrollTo, scrollTopToReveal } from "./smooth-scroll";
import { PinSidebar } from "./PinSidebar";
import { TaskReportPopup } from "./TaskReportPopup";
import { PermissionTray } from "./PermissionTray";
import { LanguageMenu, LanguageNotice } from "./LanguageSwitch";
import { useSSE } from "./useSSE";
import { useCrewStatus } from "./useCrewStatus";
import type { SearchHit } from "./types";
import { consumeOnce, effectiveTarget, pruneTargets, selectTarget, type TargetState } from "./target-state";
import { usePendingAttention } from "./usePendingAttention";
import { countByMission, countByRole, permissionsOfMission } from "./permission-summary";
import { usePermissions } from "./usePermissions";
import { usePinnedMessages } from "./usePinnedMessages";
import type { A2uiAnswer, AccountsSnapshot, Message, PinnedMessage, CrewMemberConfig, Mission, ThinkingEntry } from "./types";
import { DEFAULT_MISSION_ID } from "./constants";
import { chatReducer, initialChatState, type Gap } from "./chat-state";
import { api, type ApiResponse } from "./server-api";
import { DEFAULT_SPLIT_RATIO, clampSplitRatio, splitRatioFromPointer } from "./split-layout";
import {
  loadStoredNumber,
  persistNumber,
  loadStoredChatTarget,
  persistChatTarget,
  loadStoredActiveMissionId,
  persistActiveMissionId,
  loadStoredSplitEnabled,
  persistSplitEnabled,
} from "./preferences";
import "./App.css";
import { useI18n } from "./i18n/I18nProvider";

export function App() {
  const { t, tError } = useI18n();
  // Open/closed state of the collapsible sections of the left pane (crew status/pins). Unlike missions,
  // they are not mutually exclusive (both can be kept open at the same time).
  const [isCrewOpen, setIsCrewOpen] = useState(true);
  const [isAccountsOpen, setIsAccountsOpen] = useState(true);
  const [isPinOpen, setIsPinOpen] = useState(false);
  const [crewHeight, setCrewHeight] = useState<number | null>(() => loadStoredNumber("left-section-height-crew"));
  const [accountsHeight, setAccountsHeight] = useState<number | null>(() => loadStoredNumber("left-section-height-accounts"));
  const [pinHeight, setPinHeight] = useState<number | null>(() => loadStoredNumber("left-section-height-pin"));

  const handleResizeCrew = useCallback((height: number) => {
    setCrewHeight(height);
    persistNumber("left-section-height-crew", height);
  }, []);

  const handleResizeAccounts = useCallback((height: number) => {
    setAccountsHeight(height);
    persistNumber("left-section-height-accounts", height);
  }, []);

  const handleResizePin = useCallback((height: number) => {
    setPinHeight(height);
    persistNumber("left-section-height-pin", height);
  }, []);

  // The state of the chat screen (conversation, thinking display, sending state, etc.) is gathered in a reducer that
  // reflects what arrives from the server as is (see chat-state.ts).
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const { messages, isSending, crewActivitySignal, hasMore, isLoadingOlder, openUiItemId } = chat;
  // A form a crew member showed is waiting for the captain: nothing can be sent until it is answered or closed (the server refuses too).
  const uiOpen = openUiItemId !== null;
  // Missions (= the boundary of a conversation). Only the conversation of the mission open now is shown,
  // and this ID is always passed to the API as well. SSE events of turns running in parallel in other missions are
  // dropped by looking at missionId.
  const [missions, setMissions] = useState<Mission[]>([]);
  // At startup, restore the mission selected last time.
  // If nothing is saved, the default mission (DEFAULT_MISSION_ID).
  const [activeMissionId, setActiveMissionId] = useState<string>(loadStoredActiveMissionId);
  // A ref for reading "which mission is being viewed now" from SSE/async fetch callbacks
  // (depending on state would force the handlers to be recreated).
  const activeMissionIdRef = useRef<string>(loadStoredActiveMissionId());
  useEffect(() => { activeMissionIdRef.current = activeMissionId; }, [activeMissionId]);
  // The crew's running state (used by both the crew status in the left pane and the partner's slash commands)
  const crewGroups = useCrewStatus(activeMissionId, crewActivitySignal);
  const [crewConfig, setCrewConfig] = useState<Record<string, CrewMemberConfig>>({});
  // Who a message the captain sends now will reach ("first_officer" = the commander, or
  // a crew member's role name). Exactly one conversation with the captain is active at any time
  // (the server also serializes with isBusy), so it can be represented
  // with a simple string state — it is not designed to talk to several partners in parallel.
  //
  // The conversation partner is persisted to localStorage per mission. At startup it is read from the saved value of the restored
  // active mission. If there is no saved value, the ship's default partner (decided by the server;
  // empty until the config has been loaded).
  //
  // There are the base partner (base; saved) and the destination of the next message only (once; selected while holding Shift;
  // cancelled when sent, going back to base; not saved) (target-state.ts).
  const [targetState, setTargetState] = useState<TargetState>(
    () => ({ base: loadStoredChatTarget(loadStoredActiveMissionId()) ?? "", once: null }),
  );
  // The actual destination of the next send (the one-message destination if there is one)
  const sendTarget = effectiveTarget(targetState);
  // The ship's default partner (defaultTarget of GET /api/config. The commander if there is one, otherwise the first crew member)
  const [defaultTarget, setDefaultTarget] = useState<string | null>(null);
  const defaultTargetRef = useRef<string | null>(null);
  useEffect(() => { defaultTargetRef.current = defaultTarget; }, [defaultTarget]);

  // Slash commands the current partner can run (the server returns them in the crew's running state)
  const targetStatus = useMemo(
    () => crewGroups.flatMap((g) => g.crew).find((m) => m.role === sendTarget),
    [crewGroups, sendTarget],
  );
  const targetCommands = targetStatus?.commands ?? [];
  const targetCommandsLive = targetStatus?.commandsLive ?? false;

  // Selects the partner (the partner buttons / the "@" shortcut). A normal selection switches the base partner
  // (written to the key of the mission active now, and kept across mission switches and reloads).
  // Selecting while holding Shift makes it the destination of the next message only (not saved; goes back to base when sent).
  const handleSelectTarget = useCallback((role: string, once: boolean) => {
    setTargetState((state) => selectTarget(state, role, once));
    if (!once) persistChatTarget(activeMissionIdRef.current, role);
  }, []);

  // Cancels the destination of the next message only (goes back to the base partner)
  const handleCancelOnce = useCallback(() => {
    setTargetState((state) => consumeOnce(state));
  }, []);

  // If the partner is not decided (nothing saved) or does not exist in the current ship's composition (the crew composition changed, etc.),
  // it becomes the ship's default partner. Sending to a nonexistent partner would give a 404.
  // No judgment is made until crewConfig and the default partner have been loaded.
  useEffect(() => {
    if (Object.keys(crewConfig).length === 0 || defaultTarget === null) return;
    setTargetState((state) => pruneTargets(state, Object.keys(crewConfig), defaultTarget));
  }, [crewConfig, defaultTarget]);

  // Pending permissions (approvals). The state is held by the reducer in permission-state.ts (see usePermissions).
  const permissions = usePermissions();
  const { pendingList, hydrate: hydratePermissions } = permissions;
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null);
  const [shipName, setShipName] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // The top/bottom split: the top pane shows earlier messages (the same loaded messages, scrolled on its own)
  // while the bottom pane stays with the live conversation.
  const topContainerRef = useRef<HTMLDivElement>(null);
  const chatAreaRef = useRef<HTMLElement>(null);
  const [splitEnabled, setSplitEnabled] = useState(loadStoredSplitEnabled);
  const [splitRatio, setSplitRatio] = useState(() => clampSplitRatio(loadStoredNumber("chat-split-ratio") ?? DEFAULT_SPLIT_RATIO));
  const [isSplitDragging, setIsSplitDragging] = useState(false);
  // The top pane starts at its bottom (the latest history) when the split is turned on or the mission changes.
  const topNeedsBottomRef = useRef(splitEnabled);
  // Tracks whether the user is at the very bottom — auto-scroll fires only when it is true
  const isAtBottomRef = useRef(true);
  // Counts the POSTs of handleSend/handleReport running locally. The snapshot fetch of GET
  // /api/timeline (loadSnapshot) is a separate request with no ordering
  // guarantee — if it is issued at roughly the same moment
  // (for example when a reconnection happens from a tab visibility change at the same time as the captain pressed send),
  // it can race with the POST and reflect the server state from *before* the send takes effect.
  // While our own send is running, its resolution (the SSE upsert on success,
  // or the error handling below on failure) is itself the authoritative way to update `isSending`,
  // so loadSnapshot must not interfere with it in the meantime and should only reflect in the message contents.
  const pendingSendCountRef = useRef(0);

  // Pin feature
  const { pinnedMessages, isPinned, togglePin } = usePinnedMessages(activeMissionId);

  // Result popup
  const [resultPopup, setResultPopup] = useState<{ taskId: string; name?: string } | null>(null);

  // Scroll the conversation to a message and flash it. Returns false if it is not on screen.
  const scrollToMessage = useCallback((messageId: string): boolean => {
    // With the split on, the move happens in the top pane (a message still being answered is not there, so
    // that one is shown in the bottom pane).
    const selector = `[data-message-id="${CSS.escape(messageId)}"]`;
    const topContainer = splitEnabled ? topContainerRef.current : null;
    const inTop = topContainer?.querySelector<HTMLElement>(selector) ?? null;
    const container = inTop ? topContainer : messagesContainerRef.current;
    const target = inTop ?? container?.querySelector<HTMLElement>(selector);
    if (!container || !target) return false;
    // While moving in the live pane, do not be pulled back by the "auto-scroll to the very bottom" caused by new messages etc.
    // (right after switching missions it is treated as being at the very bottom, so the move was cancelled out). Once the position
    // reaches the very bottom, the scroll tracking sets it back to "at the very bottom".
    if (!inTop) isAtBottomRef.current = false;
    // The browser's built-in smooth scroll cannot change its speed and takes about 1 second for a long distance, so we animate it ourselves
    // (at most 0.5 seconds depending on the distance; smooth-scroll.ts). The flash starts after arriving (for a long distance it would end before arriving).
    const targetTop = scrollTopToReveal(
      { scrollTop: container.scrollTop, clientHeight: container.clientHeight, scrollHeight: container.scrollHeight, top: container.getBoundingClientRect().top },
      { top: target.getBoundingClientRect().top, height: target.getBoundingClientRect().height },
    );
    void animateScrollTo(container, targetTop).finished.then((completed) => {
      if (!completed) return; // The user started scrolling on their own (do not take control away)
      target.classList.add("message--highlight");
      // Remove the class after the glow-and-fade animation (2.4 seconds; .message--highlight in App.css) is over
      setTimeout(() => target.classList.remove("message--highlight"), 2500);
    });
    return true;
  }, [splitEnabled]);

  // A message to scroll to once the messages it was loaded with are on screen.
  const pendingScrollRef = useRef<string | null>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  // Take the conversation to a pinned message. If it is not loaded, load a page of the history that
  // starts at it (the loaded history then has a hole between that page and the rest: see GapRow).
  const jumpToMessage = useCallback(async (target: { messageId: string; timestamp: string }) => {
    if (scrollToMessage(target.messageId)) return;
    // The loaded message just after the target in time: the page is fetched up to it.
    const next = messagesRef.current.find((m) => m.timestamp > target.timestamp);
    if (!next) return;
    try {
      const res = await api.getTimelineRange({
        missionId: activeMissionIdRef.current,
        afterId: target.messageId,
        inclusive: true,
        beforeId: next.id,
        dir: "asc",
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.items.length === 0) return;
      isAtBottomRef.current = false; // do not let the auto-scroll pull the view back down
      pendingScrollRef.current = target.messageId;
      dispatch({ type: "chunk-jump-loaded", items: data.items, complete: data.complete, beforeId: next.id });
    } catch (err) {
      console.error("Failed to jump to the message:", err);
    }
  }, [scrollToMessage]);

  const jumpToPin = useCallback(
    (pin: PinnedMessage) => jumpToMessage({ messageId: pin.messageId, timestamp: pin.timestamp }),
    [jumpToMessage],
  );

  // Load one page of a hole in the history from one of its ends.
  const fillGap = useCallback(async (gap: Gap, side: "top" | "bottom") => {
    const ids = { afterId: gap.afterId, beforeId: gap.beforeId };
    dispatch({ type: "gap-loading-started", ...ids, side });
    try {
      const res = await api.getTimelineRange({ missionId: activeMissionIdRef.current, ...ids, dir: side === "top" ? "asc" : "desc" });
      if (!res.ok) return;
      const data = await res.json();
      dispatch({ type: "gap-filled", ...ids, side, items: data.items, complete: data.complete });
    } catch (err) {
      console.error("Failed to load the messages of the gap:", err);
    } finally {
      dispatch({ type: "gap-loading-finished", ...ids });
    }
  }, []);

  // Result popup
  const openResult = useCallback((taskId: string, name?: string) => {
    setResultPopup({ taskId, name });
  }, []);

  const closeResult = useCallback(() => {
    setResultPopup(null);
  }, []);

  // The single source of information for the whole chat feed: one GET returns everything that should be
  // shown on screen now (persisted history + what is in progress), in exactly the same shape as an SSE
  // upsert — there is no rebuilding on the client side.
  // It is shared by both mount time and reconnection (below), so recovery
  // when the connection drops is done the same way as a fresh load. It only uses dispatch, so
  // it stays a stable reference through the component's lifetime.
  const loadSnapshot = useCallback(async (signal?: AbortSignal, missionIdOverride?: string) => {
    const missionId = missionIdOverride ?? activeMissionIdRef.current;
    try {
      const res = await api.getTimeline(missionId, signal);
      if (!res.ok) return;
      const data = await res.json();
      // Keeping the older pages that had already been loaded by scrolling back, and deciding hasMore and isSending, are done by
      // the reducer (see chat-state.ts). While there is a request in flight,
      // isSending is not overwritten with the server's state.
      dispatch({ type: "snapshot-loaded", items: data.items, hasMore: data.hasMore, openUiItemId: data.openUiItemId, resolveSending: pendingSendCountRef.current === 0 });
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        console.error("Failed to load timeline snapshot:", err);
      }
    }
  }, []);

  // Loads the crew composition (display names, icons, etc.). Used at mount time and after changing an icon.
  const loadCrewConfig = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api.getCrew(signal);
      if (!res.ok) return;
      const data: Record<string, CrewMemberConfig> = await res.json();
      setCrewConfig(data);
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        console.error("Failed to load crew config:", err);
      }
    }
  }, []);

  // Load the crew config and the history on mount
  useEffect(() => {
    const controller = new AbortController();

    async function loadConfig() {
      try {
        const res = await api.getConfig(controller.signal);
        if (!res.ok) return;
        const data: { defaultTarget: string | null; shipName: string } = await res.json();
        setShipName(data.shipName);
        setDefaultTarget(data.defaultTarget);
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          console.error("Failed to load config:", err);
        }
      }
    }

    async function loadMissions() {
      try {
        const res = await api.getMissions(controller.signal);
        if (!res.ok) return;
        setMissions(await res.json() as Mission[]);
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          console.error("Failed to load missions:", err);
        }
      }
    }

    void loadCrewConfig(controller.signal);
    void loadMissions();
    void loadSnapshot(controller.signal);
    loadConfig();
    void hydratePermissions(controller.signal);
    return () => controller.abort();
  }, [hydratePermissions, loadSnapshot, loadCrewConfig]);

  // Switches the mission. Conversations are completely separate per mission, so
  // the displayed messages, thinking display, and conversation partner are reset together and
  // the new mission's snapshot is fetched again (the client does not merge
  // deltas — in line with CLAUDE.md's policy of "render what the server sent as is", switching is also just a re-fetch).
  const handleSelectMission = useCallback((missionId: string) => {
    if (missionId === activeMissionIdRef.current) return;
    activeMissionIdRef.current = missionId;
    setActiveMissionId(missionId);
    // Persist the selected mission so that it can be restored at the next reload.
    persistActiveMissionId(missionId);
    dispatch({ type: "mission-switched" });
    topNeedsBottomRef.current = true;
    // The conversation partner is kept per mission. Restore the saved value of the mission
    // being switched to, and if there is none, use the ship's default partner. This way
    // even going A (some crew member) → B → A keeps A's partner.
    const restoredTarget = loadStoredChatTarget(missionId) ?? defaultTargetRef.current ?? "";
    setTargetState({ base: restoredTarget, once: null });
    isAtBottomRef.current = true;
    void loadSnapshot(undefined, missionId);
  }, [loadSnapshot]);

  // --- Conversation search (SearchPalette) ---
  // A signal, when another mission was switched to, to make the corresponding row of the left pane glow (MissionPanel)
  const [missionFlash, setMissionFlash] = useState<{ missionId: string; tick: number }>({ missionId: "", tick: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  // The jump target when a result of another mission was chosen. Switch to that mission and move after its history has been loaded.
  const [pendingJump, setPendingJump] = useState<{ missionId: string; messageId: string; timestamp: string } | null>(null);

  // For a message of another mission, switch to that mission and move after its history has been loaded. The search palette is closed too.
  const jumpAnywhere = useCallback((target: { missionId: string; messageId: string; timestamp: string }) => {
    setSearchOpen(false);
    const { missionId, ...message } = target;
    if (missionId === activeMissionIdRef.current) {
      void jumpToMessage(message);
      return;
    }
    setPendingJump({ missionId, ...message });
    // Make the corresponding row of the left pane glow to tell that the mission is being switched
    setMissionFlash((f) => ({ missionId, tick: f.tick + 1 }));
    handleSelectMission(missionId);
  }, [jumpToMessage, handleSelectMission]);

  const handleSearchJump = useCallback(
    (hit: SearchHit) => jumpAnywhere({ missionId: hit.missionId, messageId: hit.id, timestamp: hit.timestamp }),
    [jumpAnywhere],
  );

  // --- Open a message in a popup from an item of a list (pins, search results) ---
  const [messagePopup, setMessagePopup] = useState<MessagePopupTarget | null>(null);

  const openPinPopup = useCallback((pin: PinnedMessage) => {
    setMessagePopup({ missionId: activeMissionIdRef.current, id: pin.messageId, fallback: { role: pin.role, text: pin.text, timestamp: pin.timestamp } });
  }, []);

  // A task result is the task report popup. Anything else (the captain's messages, replies) is the ordinary conversation popup.
  const openHitPopup = useCallback((hit: SearchHit) => {
    if (hit.kind === "task") openResult(hit.id, crewConfig[hit.role]?.name);
    else setMessagePopup({ missionId: hit.missionId, id: hit.id });
  }, [openResult, crewConfig]);

  useEffect(() => {
    if (!pendingJump || pendingJump.missionId !== activeMissionId) return;
    if (!messages.some((m) => m.missionId === pendingJump.missionId)) return; // The history of the mission being switched to has not been loaded yet
    setPendingJump(null);
    void jumpToMessage(pendingJump);
  }, [pendingJump, activeMissionId, messages, jumpToMessage]);

  // Open the search with Ctrl+Shift+F (close it if it is open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // If the restored active mission does not exist (the DB was recreated, etc.),
  // it goes back to the default mission. If it stayed nonexistent, the snapshot
  // fetch would silently fail and the chat would stay stuck empty.
  // No judgment is made before the mission list has been loaded (empty).
  useEffect(() => {
    if (missions.length === 0) return;
    if (!missions.some((m) => m.id === activeMissionId)) {
      handleSelectMission(DEFAULT_MISSION_ID);
    }
  }, [missions, activeMissionId, handleSelectMission]);

  const handleCreateMission = useCallback(async (name: string) => {
    const res = await api.createMission(name);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(tError(data, `HTTP ${res.status}`));
    }
    const created = await res.json() as Mission;
    setMissions((prev) => [...prev, created]);
    handleSelectMission(created.id);
  }, [handleSelectMission, tError]);

  // Archive/restore (it only toggles whether it is shown in the list; nothing is deleted).
  // It touches neither the conversation itself nor activeMissionId —
  // even if the mission being viewed now is archived, you can keep viewing it.
  const handleArchiveMission = useCallback(async (missionId: string, archived: boolean) => {
    const res = await api.setMissionArchived(missionId, archived);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(tError(data, `HTTP ${res.status}`));
    }
    const updated = await res.json() as Mission;
    setMissions((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  }, [tError]);

  // Aggregation of pending permissions (approvals). The tray and the crew rows show those of the mission open now,
  // while the mission list and the tab show those of all missions (so that, when running several missions
  // in parallel, an approval pending in another mission is not missed).
  const pendingByMission = countByMission(pendingList);
  const pendingByRole = countByRole(pendingList, activeMissionId);
  const pendingInMission = permissionsOfMission(pendingList, activeMissionId);

  // The ship name is also reflected in the browser tab title — so that when several ships are open
  // in different tabs, you can tell which one you are looking at from the tab alone.
  // While there are pending approvals, it tells the user through the title and icon (so that it is noticed even while looking at another tab).
  usePendingAttention(shipName ? `Make-It-So Bridge Console — ${shipName}` : "Make-It-So Bridge Console", pendingList.length);

  // Loads older messages (before the oldest one currently shown).
  // scrollRestorationRef holds the data needed to restore the scroll position after the DOM update
  const scrollRestorationRef = useRef<{ container: HTMLElement | null; prevScrollHeight: number; prevScrollTop: number } | null>(null);

  // `container` is the pane whose button was pressed (its scroll position is the one to keep).
  const loadOlderMessages = useCallback(async (container: HTMLElement | null) => {
    if (isLoadingOlder || messages.length === 0) return;

    const oldestId = messages[0].id;

    // Record the scroll position before the state change causes a re-render
    scrollRestorationRef.current = {
      container,
      prevScrollHeight: container?.scrollHeight ?? 0,
      prevScrollTop: container?.scrollTop ?? 0,
    };

    dispatch({ type: "older-loading-started" });
    try {
      const res = await api.getOlderTimeline(oldestId, activeMissionIdRef.current);
      if (!res.ok) {
        scrollRestorationRef.current = null;
        return;
      }
      const data: { items: Message[]; hasMore: boolean } = await res.json();

      dispatch({ type: "older-loaded", items: data.items, hasMore: data.hasMore });
      // The scroll restoration when it was fetched is done in the dedicated useLayoutEffect below
      if (data.items.length === 0) scrollRestorationRef.current = null;
    } catch (err) {
      console.error("Failed to load older messages:", err);
      scrollRestorationRef.current = null;
    } finally {
      dispatch({ type: "older-loading-finished" });
    }
  }, [isLoadingOlder, messages]);

  const handleTimelineActivity = useCallback((id: string, activity: ThinkingEntry) => {
    dispatch({ type: "timeline-activity", id, activity });
  }, []);

  // Every item of the chat feed — the commander's own turn and crew
  // tasks alike — is just a Message living in `messages`, updated in place from the server's
  // authoritative TimelineItem. There is no local rebuilding:
  // upsert replaces an item wholesale (a new item, or a change other than the text such as status/credits/
  // reportMeta), append adds a streamed
  // text delta, and remove deletes the item completely (only for a turn that
  // ended with nothing to show).
  const handleTimelineUpsert = useCallback((item: Message) => {
    dispatch({ type: "timeline-upsert", item, activeMissionId: activeMissionIdRef.current });
  }, []);

  const handleTimelineAppend = useCallback((id: string, text: string) => {
    dispatch({ type: "timeline-append", id, text });
  }, []);

  const handleTimelineRemove = useCallback((id: string) => {
    dispatch({ type: "timeline-remove", id });
  }, []);

  // The "stopping…" display right after Stop was pressed. It goes back when the turn ends (when isSending is cleared).
  const [isStopping, setIsStopping] = useState(false);
  useEffect(() => {
    if (!isSending) setIsStopping(false);
  }, [isSending]);

  const handleCancel = useCallback(async () => {
    const missionId = activeMissionIdRef.current;
    setIsStopping(true);
    try {
      const res = await api.cancelTurn(missionId);
      if (!res.ok) {
        // There was nothing to stop on the server (409). Only the screen is still stuck at "processing", so
        // the server's state is fetched again to bring the screen in line.
        setIsStopping(false);
        void loadSnapshot(undefined, missionId);
      }
    } catch {
      // Even if the API call fails, the SSE events handle the state
    }
  }, [loadSnapshot]);

  const handleCrewStatusChanged = useCallback((data: { role: string; missionId: string }) => {
    dispatch({ type: "crew-status-changed", role: data.role });
  }, []);

  const handleCreditsUsage = useCallback((data: AccountsSnapshot) => {
    setAccounts(data);
  }, []);

  const handleCrewCancel = useCallback(async (taskId: string) => {
    try {
      await api.cancelCrewTask(taskId);
    } catch {
      // Ignore — the task will time out eventually
    }
  }, []);

  // Reconnection handler — when the SSE connection drops, we cannot know how many timeline events
  // were missed, so instead of computing a diff of what is missing, we recover by simply
  // doing the same snapshot fetch as at mount time.
  const handleReconnect = useCallback(() => {
    void hydratePermissions();
    void loadSnapshot();
  }, [hydratePermissions, loadSnapshot]);

  // False while the live connection to the ship is down (the page keeps trying to reconnect, and reloads what it missed when it does).
  const [sseConnected, setSseConnected] = useState(true);
  useSSE({ onTimelineUpsert: handleTimelineUpsert, onTimelineAppend: handleTimelineAppend, onTimelineRemove: handleTimelineRemove, onTimelineActivity: handleTimelineActivity, onCreditsUsage: handleCreditsUsage, onCrewStatusChanged: handleCrewStatusChanged, onReconnect: handleReconnect, onConnectionChange: setSseConnected, onPermissionRequested: permissions.onRequested, onPermissionResolved: permissions.onResolved });

  // Refresh handler
  const handleRefreshCredits = useCallback(async () => {
    try {
      await api.refreshCredits();
    } catch {
      // Not fatal
    }
  }, []);

  // Restoring the scroll position after older messages were added at the top.
  // useLayoutEffect runs synchronously after the DOM change and before paint,
  // so the scroll position is restored before the user sees the position jump.
  useLayoutEffect(() => {
    const restoration = scrollRestorationRef.current;
    if (!restoration) return;

    const container = restoration.container;
    if (container) {
      const newScrollHeight = container.scrollHeight;
      container.scrollTop = restoration.prevScrollTop + (newScrollHeight - restoration.prevScrollHeight);
      // After the restoration, the user is not at the very bottom → isAtBottomRef would stay false,
      // so auto-scroll does not fire. Update the ref to reflect the current position.
      if (container === messagesContainerRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = container;
        isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 80;
      }
    }

    scrollRestorationRef.current = null;
  }, [messages]);

  // Scroll position tracking: update isAtBottomRef on the user's scrolling
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // Within 80px of the very bottom is considered "at the very bottom"
      isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 80;
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll — only when the user is at the very bottom.
  // No flag is needed: when older messages are added at the top, useLayoutEffect
  // restores the scroll position → the user is no longer at the very bottom → this
  // effect does nothing.
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages]);

  // Content that grows after it was added keeps a view that was at the very bottom there: an A2UI form is drawn by its renderer a moment
  // after its reply arrives, so the effect above has already run by then. A view the user scrolled away from stays where it is.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    let frame = 0;
    const follow = () => {
      frame = 0;
      if (isAtBottomRef.current) messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    };
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(follow);
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // After a jump to an old pin, scroll to it once the loaded page is on screen (this runs after the
  // auto-scroll above, so it wins).
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (id && scrollToMessage(id)) pendingScrollRef.current = null;
  }, [messages, scrollToMessage]);

  // Turning the split on (or switching the mission) puts the top pane at the latest history.
  useLayoutEffect(() => {
    if (!splitEnabled || !topNeedsBottomRef.current || messages.length === 0) return;
    const top = topContainerRef.current;
    if (!top) return;
    top.scrollTop = top.scrollHeight;
    topNeedsBottomRef.current = false;
  }, [splitEnabled, messages]);

  // Changing the panes' sizes does not fire a scroll event, so a live pane that was at its bottom stays there by hand.
  useLayoutEffect(() => {
    if (isAtBottomRef.current) messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, [splitEnabled, splitRatio]);

  const toggleSplit = useCallback(() => {
    setSplitEnabled((on) => {
      persistSplitEnabled(!on);
      topNeedsBottomRef.current = !on;
      return !on;
    });
  }, []);

  // Dragging the divider between the panes.
  useEffect(() => {
    if (!isSplitDragging) return;
    const handleMove = (e: MouseEvent) => {
      const area = chatAreaRef.current?.getBoundingClientRect();
      if (area) setSplitRatio(splitRatioFromPointer(e.clientY, area.top, area.height));
    };
    const handleUp = () => {
      setIsSplitDragging(false);
      setSplitRatio((r) => {
        persistNumber("chat-split-ratio", r);
        return r;
      });
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
  }, [isSplitDragging]);

  // Report handler — uses the dedicated Report API. The destination is the current partner. The response
  // placeholder is not made here — it arrives a little later via SSE (timeline:upsert,
  // created on the server side before the await in bridge.ts).
  const handleReport = useCallback(async () => {
    if (isSending || !sendTarget) return;
    const target = sendTarget;
    setTargetState((state) => consumeOnce(state)); // The one-message destination goes back to the base on sending

    const missionId = activeMissionId;
    isAtBottomRef.current = true;
    dispatch({
      type: "message-sent",
      message: { id: `captain_${Date.now()}`, missionId, role: "captain", text: "report", timestamp: new Date().toISOString() },
    });

    pendingSendCountRef.current++;
    try {
      const res = await api.sendReport(target, missionId, AbortSignal.timeout(30_000));
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(tError(errData, `HTTP ${res.status}`));
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to send report";
      dispatch({
        type: "send-failed",
        message: { id: `error_${Date.now()}`, missionId, role: target, text: `⚠️ Error: ${errorMsg}`, timestamp: new Date().toISOString() },
      });
    } finally {
      pendingSendCountRef.current--;
    }
  }, [isSending, sendTarget, activeMissionId, tError]);

  // Sends a message. On a timeout + network error it retries automatically once.
  // Like handleReport, there is no local response placeholder; SSE delivers it.
  const handleSend = useCallback(
    async (text: string) => {
      if (isSending) return;

      // The destination mission is also fixed here (even if the captain switches missions
      // while sending, this send is addressed to the mission at the time of the press).
      const missionId = activeMissionId;
      // The user just sent a message — always scroll to the very bottom for the response
      isAtBottomRef.current = true;
      dispatch({
        type: "message-sent",
        message: { id: `captain_${Date.now()}`, missionId, role: "captain", text, timestamp: new Date().toISOString() },
      });

      // The destination of this message is fixed here (even if the value of chatTarget changes afterwards, this function keeps using
      // targetForThisMessage while it runs).
      const targetForThisMessage = sendTarget;
      // The one-message destination is cancelled on sending and goes back to the base partner (it goes back even if sending fails)
      setTargetState((state) => consumeOnce(state));

      const finalizeAsError = (msg: string) => {
        dispatch({
          type: "send-failed",
          message: { id: `error_${Date.now()}`, missionId, role: targetForThisMessage, text: `⚠️ Error: ${msg}`, timestamp: new Date().toISOString() },
        });
      };

      // The destination goes through the same entry point for every crew member (/api/crew/:role/message). The fixed buttons and the custom menu
      // also go through the same path, so they act on the partner currently being talked to.
      const doFetch = async (signal: AbortSignal) => {
        const res = await api.sendMessage(targetForThisMessage, text, missionId, signal);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(tError(errData, `HTTP ${res.status}`));
        }
      };

      const isNetworkError = (err: unknown): boolean => {
        if (!(err instanceof Error)) return false;
        return err.name === "TypeError" || err.message.includes("NetworkError") || err.message === "Failed to fetch";
      };

      const isTimeoutError = (err: unknown): boolean => {
        return err instanceof Error && err.name === "TimeoutError";
      };

      pendingSendCountRef.current++;
      try {
        try {
          await doFetch(AbortSignal.timeout(30_000));
        } catch (firstErr) {
          if (isNetworkError(firstErr) || isTimeoutError(firstErr)) {
            // Retry automatically once after 500ms
            try {
              await new Promise((r) => setTimeout(r, 2000));
              await doFetch(AbortSignal.timeout(30_000));
              return; // the retry succeeded
            } catch (retryErr) {
              const msg = isTimeoutError(retryErr)
                ? t("app.connectionTimeout")
                : retryErr instanceof Error ? retryErr.message : "Failed to send message";
              finalizeAsError(msg);
              return;
            }
          }
          // An error other than the network — do not retry
          const errorMsg = isTimeoutError(firstErr)
            ? t("app.connectionTimeout")
            : firstErr instanceof Error ? firstErr.message : "Failed to send message";
          finalizeAsError(errorMsg);
        }
      } finally {
        pendingSendCountRef.current--;
      }
    },
    [isSending, sendTarget, activeMissionId, t, tError]
  );

  // An action on an A2UI form (answering it, or closing it without answering): the server does the rest (sends the answer to the crew member,
  // records it, and sends the reply again with the form's new state), so only a failure is shown here — in the conversation, without
  // touching the waiting state, since no send is in progress.
  const runA2uiRequest = useCallback(async (request: () => Promise<ApiResponse>) => {
    let failure: string | null = null;
    try {
      const res = await request();
      if (res.ok) return;
      const errData = (await res.json().catch(() => undefined)) as { error?: string; message?: string } | undefined;
      failure = tError(errData, `HTTP ${res.status}`);
    } catch (err) {
      failure = err instanceof Error ? err.message : "Request failed";
    }
    dispatch({
      type: "a2ui-failed",
      message: { id: `error_${Date.now()}`, missionId: activeMissionId, role: "captain", text: `⚠️ Error: ${failure}`, timestamp: new Date().toISOString() },
    });
  }, [activeMissionId, tError]);

  const handleA2uiAction = useCallback(
    (itemId: string, answer: A2uiAnswer) => runA2uiRequest(() => api.answerA2ui(itemId, answer)),
    [runA2uiRequest],
  );
  const handleA2uiDismiss = useCallback((itemId: string) => runA2uiRequest(() => api.dismissA2ui(itemId)), [runA2uiRequest]);

  const listProps = {
    messages,
    gaps: chat.gaps,
    crewConfig,
    isPinned,
    onTogglePin: togglePin,
    onOpenResult: openResult,
    onCancel: handleCancel,
    onCrewCancel: handleCrewCancel,
    isStopping,
    onFillGap: fillGap,
    onA2uiAction: handleA2uiAction,
    onA2uiDismiss: handleA2uiDismiss,
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          Make-It-So
          <span className="app-title-sub">Bridge Console</span>
        </h1>
        <button className="app-search-btn" onClick={() => setSearchOpen(true)} title={t("search.open")} aria-label={t("search.open")}>
          <svg className="app-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="6.5" cy="6.5" r="4.5" />
            <line x1="10" y1="10" x2="14.5" y2="14.5" />
          </svg>
        </button>
        <button
          className={`app-split-btn ${splitEnabled ? "app-split-btn--on" : ""}`}
          onClick={toggleSplit}
          aria-pressed={splitEnabled}
          title={t("app.split")}
          aria-label={t("app.split")}
        >
          <svg className="app-icon" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="2" width="12" height="12" rx="1.5" />
            <line x1="2" y1="8" x2="14" y2="8" />
          </svg>
        </button>
        <LanguageMenu />
        {shipName && <span className="app-ship-name">{shipName}</span>}
      </header>
      <LanguageNotice />
      {!sseConnected && <div className="connection-notice" role="status">{t("app.disconnected")}</div>}

      <div className="app-body">
        {/*
           The left pane is a permanent, single resizable column. Missions/crew
                       status/pins all line up inside it as collapsible sections (CollapsibleSection)
                       — a mission normally shows only the current mission name in the heading,
                       and opening with ▼ allows listing, switching, and creating.
           */}
        <LeftColumn>
          <MissionPanel
            missions={missions}
            activeMissionId={activeMissionId}
            onSelect={handleSelectMission}
            onCreate={handleCreateMission}
            onArchive={handleArchiveMission}
            pendingByMission={pendingByMission}
            flash={missionFlash}
          />
          <CollapsibleSection title={t("app.crewStatus")} badge={pendingInMission.length} isOpen={isCrewOpen} onToggle={() => setIsCrewOpen((v) => !v)} height={crewHeight} onResize={handleResizeCrew}>
            <CrewStatusPanel crewGroups={crewGroups} onCrewChanged={() => void loadCrewConfig()} crewConfig={crewConfig} onJump={(taskId, timestamp) => void jumpToMessage({ messageId: taskId, timestamp: timestamp ?? new Date().toISOString() })} onOpenResult={openResult} activitySignal={crewActivitySignal} missionId={activeMissionId} pendingByRole={pendingByRole} />
          </CollapsibleSection>
          <CollapsibleSection title={t("app.pins")} isOpen={isPinOpen} onToggle={() => setIsPinOpen((v) => !v)} height={pinHeight} onResize={handleResizePin}>
            <PinSidebar pinnedMessages={pinnedMessages} onJump={jumpToPin} onOpenPopup={openPinPopup} />
          </CollapsibleSection>
          <CollapsibleSection title={t("app.accounts")} isOpen={isAccountsOpen} onToggle={() => setIsAccountsOpen((v) => !v)} height={accountsHeight} onResize={handleResizeAccounts}>
            <AccountsPanel snapshot={accounts} onRefresh={handleRefreshCredits} />
          </CollapsibleSection>
        </LeftColumn>

        <div className="app-main">
          <main className="chat-container" ref={chatAreaRef}>
            {splitEnabled && (
              <>
                <div className="split-top" style={{ flex: `0 0 ${splitRatio * 100}%` }}>
                  <div className="messages messages--top" ref={topContainerRef}>
                    {hasMore && (
                      <div className="load-older">
                        <button className="load-older-btn" onClick={() => void loadOlderMessages(topContainerRef.current)} disabled={isLoadingOlder}>
                          {isLoadingOlder ? t("common.loading") : t("app.loadOlder")}
                        </button>
                      </div>
                    )}
                    <MessageList {...listProps} hideStreaming />
                  </div>
                  <ScrollEdgeButtons containerRef={topContainerRef} />
                </div>
                <div
                  className={`split-divider ${isSplitDragging ? "split-divider--dragging" : ""}`}
                  onMouseDown={(e) => { e.preventDefault(); setIsSplitDragging(true); }}
                  title={t("app.splitDrag")}
                  aria-label={t("common.resizeHandle")}
                  role="separator"
                  aria-orientation="horizontal"
                />
              </>
            )}
            <div className="messages" ref={messagesContainerRef}>
              {hasMore && (
                <div className="load-older">
                  <button
                    className="load-older-btn"
                    onClick={() => void loadOlderMessages(messagesContainerRef.current)}
                    disabled={isLoadingOlder}
                  >
                    {isLoadingOlder ? t("common.loading") : t("app.loadOlder")}
                  </button>
                </div>
              )}
              <MessageList {...listProps} />

              <div ref={messagesEndRef} />
            </div>
            <ScrollEdgeButtons containerRef={messagesContainerRef} />
          </main>

          <PermissionTray
            permissions={pendingInMission}
            crewConfig={crewConfig}
            onRespond={permissions.respond}
          />

          <ChatInput
            onSend={handleSend}
            onReport={handleReport}
            disabled={isSending || uiOpen}
            waitingForUi={uiOpen && !isSending}
            missionId={activeMissionId}
            crewConfig={crewConfig}
            baseTarget={targetState.base}
            onceTarget={targetState.once}
            onSelectTarget={handleSelectTarget}
            onCancelOnce={handleCancelOnce}
            commands={targetCommands}
            commandsLive={targetCommandsLive}
          />
        </div>
      </div>

      <BottomBar />

      <SearchPalette
        open={searchOpen}
        missions={missions}
        activeMissionId={activeMissionId}
        crewConfig={crewConfig}
        onClose={() => setSearchOpen(false)}
        onJump={handleSearchJump}
        onOpenPopup={openHitPopup}
      />

      {messagePopup && (
        <MessagePopup
          target={messagePopup}
          crewConfig={crewConfig}
          onClose={() => setMessagePopup(null)}
          onJump={(target) => {
            setMessagePopup(null);
            jumpAnywhere({ missionId: target.missionId, messageId: target.id, timestamp: target.timestamp });
          }}
        />
      )}

      {resultPopup && (
        <TaskReportPopup
          taskId={resultPopup.taskId}
          name={resultPopup.name}
          onClose={closeResult}
          onJump={(target) => {
            closeResult();
            jumpAnywhere({ missionId: target.missionId, messageId: target.id, timestamp: target.timestamp });
          }}
        />
      )}
    </div>
  );
}
