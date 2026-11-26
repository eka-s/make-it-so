import type { ChildProcess } from "node:child_process";

// --- Crew roles ---
// The kinds of roles (chief_engineer/logic_officer, etc.) can be defined freely per ship (ship.yml)
// — they are treated as strings decided at runtime, not as a compile-time fixed union type. Only `first_officer`,
// the only agent managed directly inside the Bridge Console main process, is still
// special-cased as a string literal in various places, as a structural necessity.
export type CrewRole = string;
export type AgentName = CrewRole;

// --- Agents ---

export const AGENT_STATUSES = ["idle", "working", "completed", "failed"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type Agent = {
  name: AgentName;
  status: AgentStatus;
  currentTaskId: string | null;
  process: ChildProcess | null;
  sessionId: string | null;
  pid: number | null;
  startedAt: Date | null;
  idCounter: number;
  generation: number;
};

// --- Tasks ---

export const TASK_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Task = {
  id: string;
  agent: string;
  prompt: string;
  pair: boolean;
  status: TaskStatus;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  response: string | null;
  toolOutput: string | null;
  handoff: string | null;
  stopReason: string | null;
  maxIterations: number;
  timeoutMinutes: number;
  implementation: string | null;
  dataReview: string | null;
  opinion: string | null;
};

// --- Permission ---
// Pending permission requests are tracked independently of any chat message. `scope` indicates which
// agent it belongs to — "first_officer" for the commander, and for a crew member its crew role/agent
// directory name. `taskId` is only best-effort display metadata
// (it can be unknown if the request fired before that task's own "started" event), and must never
// decide whether the request is registered or answerable.
export type PermissionOptionData = { kind: string; name: string; optionId?: string };

export type PendingPermission = {
  key: string;
  scope: string;
  // The session (= a (crew member, mission) pair) the request came from.
  // `scope` stays as the agent name (used to resolve the display name), so this is needed to route the response
  // to the correct session — the same crew member can request permissions in several missions at
  // the same time. For one in a running task it is the dedicated scope ("__tasks__").
  missionId: string;
  // The **real mission ID** this request belongs to. `missionId` is the session's
  // scope (in the form "__tasks__:missionId" while running a task), so to know
  // "which mission is this approval waiting in" the display side uses this one (the server attaches it so that the client
  // does not have to parse the scope string).
  ownerMissionId: string;
  // Role name of the crew member awaiting approval. `scope` stays as the agent name (a role name or an acp_agent name),
  // so this is used when matching with a crew row on screen
  // (the server attaches it so that the client does not have to look the role up from the name again).
  role: string;
  requestId: number;
  taskId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  options: PermissionOptionData[];
  receivedAt: string;
};

// --- Conversation ---
// The set of "captain" and `CrewRole`, which varies per ship (including `first_officer`).
export type ConversationRole = "captain" | CrewRole;

// --- Timeline (the single data source of the chat feed) ---
// Every item shown in the Bridge Console chat — captain, commander, or crew, whether streaming or persisted long ago —
// has this same shape. The server (timeline.ts) is the authority: it keeps in-progress
// items in memory and merges them with the persisted history to answer GET /api/timeline.
// The client just mirrors what arrives via timeline:upsert/append/remove and has no rebuilding logic of its own.
export type TimelineStatus = "streaming" | "done" | "error";

export type TimelineItem = {
  id: string;
  // The mission this item belongs to.
  // Every conversation belongs to some mission — the client renders only the items of the mission that is open now,
  // and drops SSE events of turns running in parallel in other missions by looking at this.
  missionId: string;
  role: ConversationRole;
  text: string;
  timestamp: string;
  cancelled?: boolean;
  reportMeta?: { tasks: Array<{ agent: string; taskId: string }> };
  credits?: MeteringUsage;
  taskName?: string;
  instruction?: string;
  turnId?: string;
  status?: TimelineStatus;
  // Set when `text` is a message the server wrote itself (see messages.ts): the client
  // shows the translation of this key instead of `text`.
  messageKey?: string;
  // What was written before the turn or task was interrupted by a stop of the server (shown above the notice in `text`).
  partialText?: string;
  // The operations (tool calls) the crew member did for this turn or task, from the activity log (activity-log.ts). Present when the
  // log still has them; `isActive` says whether they are still coming in (the item is streaming).
  activity?: ActivityEntry;
  // The A2UI form a crew member showed with render_ui in this reply (drawn under the text; only a reply that completed carries one).
  // `state`: "open" — the captain has neither answered nor closed it (it is usable, and the input box is locked until then); "answered" —
  // shown as it was when answered, with the comment the captain wrote (`comment`) and the action they pressed (`actionName`);
  // "dismissed" — the captain closed it without answering (no messages are carried). `locksInput` is set on an open form: the mission
  // accepts no message until it is dealt with.
  a2ui?: { state: "open" | "answered" | "dismissed"; messages: Array<Record<string, unknown>>; comment?: string; actionName?: string; locksInput?: true };
};

/** The operations of one turn or task, as the screen shows them ("3 operations"; each can be opened to see its output). */
export type ActivityEntry = {
  id: string;
  operations: Array<{ title: string; output: string }>;
  isActive: boolean;
  timestamp: string;
};

// --- SSE events ---

export type SSEEvent =
  | { type: "task:progress"; data: { agent: string; taskId: string; chunk: string; field: "response" | "toolOutput" } }
  | { type: "task:complete"; data: { taskId: string; agent: string; status: TaskStatus; summary: string } }
  // The whole event surface of the chat feed: a whole item (newly created, or a change other than the text — status,
  // credits, reportMeta, etc.), an append-only chunk delta (bandwidth-efficient for a long streaming response —
  // the client appends `text` to what it already has for `id`), or a removal
  // (only for the rare case "there turned out to be nothing to show", e.g. an empty response).
  | { type: "timeline:upsert"; data: TimelineItem }
  | { type: "timeline:append"; data: { id: string; text: string } }
  | { type: "timeline:remove"; data: { id: string } }
  // The operations (tool calls) of an item still being worked on have changed: replaces the `activity` of the item `id`.
  | { type: "timeline:activity"; data: { id: string; activity: ActivityEntry } }
  | { type: "credits:usage"; data: AccountsSnapshot }
  | { type: "notification:task_complete"; data: { taskId: string; agent: string; summary: string; iterations?: number } }
  | { type: "notification:escalation"; data: { taskId: string; agent: string; iteration: number; max: number; issues: string[] } }
  // A signal that a crew member's state (starting, restarting, etc.) changed. It carries no data; a client that
  // receives it just re-fetches the crew status (GET /api/crew/status).
  | { type: "crew:status_changed"; data: { role: string; missionId: string } }
  // A signal that the ship's Memory changed. Like crew:status_changed it carries no data: a client that receives it fetches again what it shows.
  | { type: "memory:changed"; data: Record<string, never> }
  | { type: "permission:requested"; data: PendingPermission }
  | { type: "permission:resolved"; data: { key: string } }
  | { type: "log"; data: { message: string; timestamp: string } };

// --- API requests/responses ---

export type BridgeMessageRequest = {
  text: string;
};

export type BridgeMessageResponse = {
  messageId: string;
  status: "accepted";
};

export type CreateTaskRequest = {
  agent: string;
  id: string;
  prompt: string;
  pair?: boolean;
};

export type HealthResponse = {
  status: "ok";
  /** The ship this process runs and its process ID (the settings server uses them to tell which ship is on a port and to stop it). */
  shipId: string;
  pid: number;
  uptime: number;
  agents: Record<string, AgentStatus>;
};

// --- ACP protocol ---

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
};

export type AcpSessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
  | { sessionUpdate: "tool_call"; title: string; content?: { type: "text"; text: string } }
  | { sessionUpdate: "tool_call_update"; content?: Array<{ type: string; content: { type: "text"; text: string } }>; title?: string; kind?: string; status?: string }
  | { sessionUpdate: "usage_update"; used: number; size: number }
  | { sessionUpdate: "available_commands_update"; availableCommands: unknown };

export type AcpStreamEvent = AcpSessionUpdate;

// --- Credit usage ---

export type CreditsUsageData = {
  usedPercent: number;
  used?: number;
  limit?: number;
  resetsAt: string;
  label?: string;
  secondary?: {
    label: string;
    usedPercent: number;
    resetsAt: string;
  };
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

// --- Metering usage (cost consumed per turn) ---
// The unit differs by provider (kiro: its own "credits" point system,
// claude: an estimated cost in dollars obtained from ACP's usage_update.cost —
// an estimate, not an actual billing statement). The `unit` lets the display side tell them apart.
// When omitted (an old record) it is treated as "kiro_credits" — before the unit column was introduced,
// only kiro was running.

export type MeteringUsage = {
  credits: number;
  turnDurationMs: number | null;
  unit?: "usd" | "kiro_credits";
};
