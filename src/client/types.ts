export type ReportMeta = {
  tasks: Array<{ agent: string; taskId: string }>;
};

// The unit differs by provider (kiro: its own "credits" point system,
// claude: an estimated cost in dollars). The display side tells them apart by `unit`
// (when omitted, i.e. an old record, it is treated as "kiro_credits").
export type MeteringUsage = {
  credits: number;
  turnDurationMs: number | null;
  unit?: "usd" | "kiro_credits";
};

// The kinds of roles can be defined freely per ship (ship.yml),
// so they are treated as strings, not as a fixed union type.
export type CrewRole = string;

/** Display information of the host a crew member runs on (resolved and sent by the server). */
export type CrewHostInfo = {
  label: string;
  kind: "local" | "remote";
  /** Actual connection target (host name/IP). Not shown if absent. */
  address?: string;
};

export type CrewMemberConfig = {
  name: string;
  provider?: string;
  acp_agent?: string;
  /**
   * Rank on the ship. It decides the authority over tasks (commander: the commander who can handle all reports, chief: can handle those they issued, crew: cannot issue).
   */
  rank?: "commander" | "chief" | "crew";
  /** URL of the icon image (if set. If not, the avatar built from the name is shown). */
  icon?: string;
  /** Attached only to crew members on a remote host (not attached to local crew members). */
  host?: CrewHostInfo;
};

// Lifecycle of a crew task. None (undefined) means either a message from the captain/first_officer,
// or a crew message loaded from history — everything persisted on disk is by definition already complete,
// so those need no explicit "done".
export type CrewStatus = "streaming" | "done" | "error";

// A pending permission request, tracked independently of the conversation — it is never
// tied to a Message. `scope` indicates which agent it belongs to
// ("first_officer" for the commander, and for a crew member its crew role/agent directory name).
// `taskId` is only best-effort display metadata and may be absent.
export type PendingPermission = {
  key: string;
  scope: string;
  // The session (= a (crew member, mission) pair) the request came from.
  // One in a running task has the dedicated scope ("__tasks__").
  missionId: string;
  // The real mission ID this request belongs to (`missionId` is the session's scope).
  ownerMissionId: string;
  // Role name of the crew member awaiting approval (`scope` stays as the agent name). Both are attached by the server.
  role: string;
  requestId: number;
  taskId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  options: Array<{ kind: string; name: string; optionId?: string }>;
  receivedAt: string;
};

export type Message = {
  id: string;
  // Set when `text` is a message the server wrote itself: show the translation of
  // `msg.<messageKey>` instead of `text` (which is the English fallback).
  messageKey?: string;
  // What was written before the turn or task was interrupted by a stop of the server (shown above the notice in `text`).
  partialText?: string;
  // What the crew member did for this item (its tool calls), recorded by the server; shown in the card.
  activity?: ThinkingEntry;
  // The mission this message belongs to.
  // SSE events of turns running in parallel in other missions are dropped by looking at this
  // (so they do not mix into the screen of the mission open now).
  missionId: string;
  role: "captain" | CrewRole;
  text: string;
  timestamp: string;
  cancelled?: boolean;
  reportMeta?: ReportMeta;
  credits?: MeteringUsage;
  taskName?: string;
  instruction?: string;
  turnId?: string;
  status?: CrewStatus;
  // The A2UI form a crew member showed with render_ui in this reply (drawn under the text; only a reply that completed carries one).
  // `state`: "open" — the captain has neither answered nor closed it (it is usable, and the input box is locked until then); "answered" —
  // shown as it was when answered, with the comment the captain wrote (`comment`) and the action they pressed (`actionName`);
  // "dismissed" — the captain closed it without answering (no messages are carried). `locksInput` is set on an open form: the mission
  // accepts no message until it is dealt with.
  a2ui?: { state: "open" | "answered" | "dismissed"; messages: Array<Record<string, unknown>>; comment?: string; actionName?: string; locksInput?: true };
};

/** What the captain pressed on an A2UI form: the A2UI action the renderer reported, the values of the form's surface at that moment and the comment they wrote. */
export type A2uiAnswer = {
  action: { name: string; surfaceId: string; sourceComponentId: string; timestamp: string; context: Record<string, unknown> };
  dataModel: Record<string, unknown>;
  comment: string;
};

export type PinnedMessage = {
  messageId: string;
  role: "captain" | CrewRole;
  text: string;
  timestamp: string;
  pinnedAt: string;
  missionId: string;
  isFloating: boolean;
};

export type ThinkingOperation = {
  title: string;
  output: string;
};

export type ThinkingEntry = {
  id: string;
  operations: ThinkingOperation[];
  isActive: boolean;
  timestamp: string;
};

export type CreditsUsageData = {
  usedPercent: number;
  used?: number;
  limit?: number;
  resetsAt: string;
  label?: string;
  secondary?: { label: string; usedPercent: number; resetsAt: string };
};

/**
 * Usage of one account (the same credentials) and the crew members running on that account.
 * The screen ("Accounts" in the left pane) renders this shape as built by the server.
 */
export type AccountUsage = {
  /**
   * Key that decides whether two crew members share the same credentials ("claude:<organization ID>" for an identified claude, the provider name otherwise).
   */
  key: string;
  provider: string;
  /** Name of the identified account (the email address). null if it could not be identified. */
  label: string | null;
  /** Kind of plan (pro, max, etc.). Omitted if unknown. */
  plan?: string;
  /** Usage. null if it has not been fetched yet or the fetch failed. */
  usage: CreditsUsageData | null;
  /** Display names of the crew members running on this account. */
  crews: string[];
};

/** List of usage per account (the shape of the SSE `credits:usage` and of what the refresh API returns). */
export type AccountsSnapshot = {
  accounts: AccountUsage[];
  /**
   * Display names of crew members whose account could not be identified and whose usage is not counted (crew members on remote hosts).
   */
  untracked: string[];
};

/**
 * The boundary of a conversation. Meant to be created per issue.
 * There is no notion of a crew member belonging to a mission; every crew member exists in every mission at all times
 * (they can be called any time with an @mention) — so this is purely
 * a "named box for a conversation".
 */
export type Mission = {
  id: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
};

/** What the settings screen shows first (GET /api/settings/overview): the state of ~/.make-it-so. */
export type SettingsOverview = {
  dir: string;
  exists: boolean;
  files: { name: string; exists: boolean }[];
  personnelCount: number;
  ships: { id: string; name?: string; port?: number; error?: string }[];
};

/** One field of the config.yml form (GET /api/settings/config). The server defines the fields; the screen draws them. */
export type SettingsConfigField = {
  key: string;
  group: "general" | "acp" | "server" | "logging";
  type: "enum" | "text" | "boolean" | "number" | "list";
  options?: string[];
  min?: number;
  max?: number;
  default: string | boolean | number | string[] | null;
  /** The value in the file, or null when the key is not set (the default applies). */
  value: unknown;
};
export type SettingsConfigState = { file: string; exists: boolean; fields: SettingsConfigField[] };

/** An item of the custom menu as one ship sees it (`shared`: other ships have it too, so a change reaches them). */
export type QuickActionItem = {
  id: string;
  name: string;
  kind: "message" | "slash";
  command: string;
  send: "now" | "fill";
  shared: boolean;
};
/** An item in the settings app: it also says on which ships it is enabled ("all" or the ship IDs). */
export type SettingsQuickAction = Omit<QuickActionItem, "shared"> & { ships: "all" | string[]; except?: string[] };
export type SettingsQuickActionsState = { actions: SettingsQuickAction[]; ships: { id: string; name: string }[] };

export type SettingsHost = { name: string; destination: string; usedBy: string[] };
export type SettingsHostsState = { file: string; exists: boolean; hosts: SettingsHost[] };

/** A crew member of the roster (GET /api/settings/roster). */
export type SettingsMember = {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  permission_mode: string | null;
  rules: string[];
  skills: string[];
  hasPersona: boolean;
  usedBy: { ship: string; role: string }[];
};
export type SettingsRosterState = { file: string; exists: boolean; members: SettingsMember[]; permissionModes: string[]; providers: string[] };
/** The fields of a member that the form edits (the ID is separate). */
export type SettingsMemberFields = Pick<SettingsMember, "name" | "provider" | "model" | "permission_mode" | "rules" | "skills">;

/** A role of a ship (GET /api/settings/ships/:id): which roster member holds it, and how. */
export type SettingsShipRole = {
  role: string;
  member: string;
  rank: "commander" | "chief" | "crew";
  model: string | null;
  permission_mode: string | null;
  cwd: string | null;
  agent: string | null;
  host: string | null;
  access: { target: string; mode: "readonly" | "readwrite" }[];
};
export type SettingsShipFields = {
  port: number;
  name: string | null;
  cwd: string | null;
  rules: string[];
  skills: string[];
  targets: { name: string; path: string }[];
  crew: SettingsShipRole[];
};
export type SettingsShipState = {
  id: string;
  fields: SettingsShipFields;
  options: { members: { id: string; name: string }[]; hosts: string[]; ranks: string[]; permissionModes: string[]; accessModes: string[] };
};

/** A draft of members and a ship made from an existing project (POST /api/settings/import/scan). */
export type SettingsImportDraft = {
  provider: "claude" | "kiro";
  projectDir: string;
  members: { id: string; input: SettingsMemberFields; exists: boolean; reuse: boolean }[];
  ship: { id: string; fields: SettingsShipFields };
  ruleCandidates: { label: string; path: string }[];
  mcp: { file: string; servers: string[] } | null;
  notes: { code: "unreadable" | "bypassNotImported"; file: string }[];
};
export type SettingsImportScan = {
  dir: string;
  isDirectory: boolean;
  found: { claude: boolean; kiro: boolean };
  drafts: { claude: SettingsImportDraft; kiro: SettingsImportDraft } | null;
};
/** What is sent to save a (changed) draft. `reuse` members are not created. */
export type SettingsImportRequest = {
  members: { id: string; reuse: boolean; input: SettingsMemberFields }[];
  ship: { id: string; fields: SettingsShipFields };
};
/** The refusal of an import: field errors of the ship, and of each member by ID. */
export type SettingsImportErrors = { ship: Record<string, string>; members: Record<string, Record<string, string>> };

/** Whether a ship's process is running (GET /api/settings/runtime). conflict: something else answers on the ship's port. */
export type SettingsShipRuntime = { id: string; port: number | null; state: "running" | "stopped" | "conflict"; pid?: number; url: string | null; devCommand: string };

/** The reply to a refused save: a message key per field (or per host name). */
export type SettingsSaveErrors = { error: "invalid"; errors: Record<string, string> };

/** A supported language. The UI language and the crew language are separate settings kept on the server. */
export type Language = "en" | "ja";

// --- Types of API responses ---

/** Running state of one crew member (GET /api/crew/status). */
/**
 * idle = waiting, working = working, starting = starting up, restarting = restarting (the server decides the stage of coming up).
 */
export type AgentStatus = "idle" | "working" | "starting" | "restarting";

export type CrewStatusEntry = {
  role: string;
  status: AgentStatus;
  unreportedCount: number;
  /** Context usage (%) of the conversation session. null if there is no session or in an overview. */
  contextPercent: number | null;
  /**
   * Slash commands available in the conversation session (notified by the provider). Before startup, the previous list (the cache). Empty if there is no cache, or in an overview.
   */
  commands: SlashCommand[];
  /**
   * Whether `commands` is the latest one that arrived from the running session (if false, the previous list = the cache, or empty).
   */
  commandsLive: boolean;
};

/** A provider-specific slash command. `name` does not include the leading `/`. */
export type SlashCommand = {
  name: string;
  description: string;
  /** Input hint for the arguments (e.g. `[interval] [prompt]`). */
  hint?: string;
};

/**
 * The crew's running state grouped per host (local/remote) (GET /api/crew/status).
 * The grouping and the order are decided by the server. The client renders in the order received.
 */
export type CrewHostGroup = {
  host: CrewHostInfo;
  /** State of the tunnel to the remote host. null for local. */
  tunnel: "connected" | "connecting" | "idle" | null;
  crew: CrewStatusEntry[];
};

/** Data for displaying the model of one crew member (GET /api/missions/:id/crew-models). */
export type CrewModelEntry = {
  role: string;
  name: string;
  /** Selectable models. Empty means switching is not supported, or the session has not been started yet. */
  options: { value: string; name: string }[];
  /** The model decided by configuration (null if none is specified). */
  effective: string | null;
  /** Where `effective` comes from. "mission" = changed in this mission. */
  source: "mission" | "config" | "default";
  /** The model the running session is actually using (null if there is no session). */
  live: string | null;
};

/** One entry of the history of tasks that ended as completed/error (GET /api/crew/:role/tasks). */
export type TaskHistoryEntry = {
  taskId: string;
  taskName: string;
  status: "done" | "error";
  completedAt: string;
};

/** One crew member's running task and history (GET /api/crew/:role/tasks). */
export type CrewTasks = {
  current: { taskId: string; taskName: string } | null;
  history: TaskHistoryEntry[];
  hasMore: boolean;
};

/** The full detail of one task (GET /api/results/:taskId). */
export type TaskDetail = {
  text: string;
  status: "done" | "error";
  taskName?: string;
  instruction?: string;
  credits?: MeteringUsage;
  /**
   * The mission the task belongs to, and the time it completed (used to move to that task's card in the conversation).
   */
  missionId: string;
  timestamp: string;
};

/**
 * One crew member's personnel record (GET /api/crew/:role/profile). The server decides how it is assembled, and the screen only renders it.
 */
export type CrewProfile = {
  role: string;
  name: string;
  rank: "commander" | "chief" | "crew";
  /** Member ID in the roster (roster.yml). It becomes the name of the persona file and the icon. */
  memberId: string | null;
  provider: string;
  permissionMode: string | null;
  cwd: string;
  /** Only for a remote host's crew member. */
  host: CrewHostInfo | null;
  persona: CrewPersona;
  /**
   * The full text sent at session start (persona, rules, skills, system guidance). null if it cannot be assembled.
   */
  briefing: string | null;
  briefingError?: string;
};

/** Where the persona comes from and its contents. */
export type CrewPersona =
  | { source: "personnel"; text: string; path: string }
  | { source: "agent"; status: "found"; agent: string; text: string; path: string }
  | { source: "agent"; status: "not_found" | "remote"; agent: string }
  | { source: "none" };

// --- Conversation search (GET /api/search). The grouping is only about the screen display; searching and building excerpts is done by the server ---

/** Excerpt: a part of the text and the matched ranges inside it (`[start, end)`). */
export type SearchSnippet = {
  text: string;
  ranges: Array<[number, number]>;
  /** The start/end of the text was cut off (a "…" is added). */
  cutStart: boolean;
  cutEnd: boolean;
};

/** One search hit. `id` is the id of the item in the conversation view (the jump target). */
export type SearchHit = {
  id: string;
  missionId: string;
  missionName: string;
  /** "captain", or the crew member's role name. */
  role: string;
  kind: "captain" | "reply" | "task";
  timestamp: string;
  snippet: SearchSnippet;
  /** For a task result, whether the match was in the report or the instruction. */
  matchedIn: "report" | "instruction" | null;
};

export type SearchResponse = {
  /** Total number of matches (ignoring the upper limit on the count). */
  total: number;
  /** The total is larger than the number returned (the user is asked to narrow the conditions). */
  truncated: boolean;
  hits: SearchHit[];
};
