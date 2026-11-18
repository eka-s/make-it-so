// make-it-so's own "bulletin board" MCP server.
// Sessions of every crew member can call it as typed tools instead of curl or file writes.
// It is just embedded in the existing Express server as the `/mcp` route and starts no separate process (HTTP transport,
// stateless mode).
//
// The tools are thin wrappers that only call the existing APIs (getUnreportedTasks/getTaskOutcome/getTaskStarted, etc.)
// — logic is not duplicated (CLAUDE.md policy).
import { z } from "zod";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getUnreportedTasks, getTaskOutcome, isTaskCancelled, getTaskStarted, nextTaskId } from "./database.js";
import { MCP_AGENT_HEADER, MCP_MISSION_HEADER } from "./crew-manager.js";
import { canDispatch, type CrewRank } from "./fleet-config.js";
import { missionFromTaskScope } from "./crew-runner.js";
import type { CrewRunner } from "./crew-runner.js";
import { logger } from "./logger.js";

/** External dependencies of the bulletin-board MCP. index.ts wires them in production; tests pass fakes. */
export type McpBoardDeps = {
  /**
   * Puts a task into the run queue with dispatch_task (only the dispatch part of CrewRunner).
   * It sends a prompt into a real crew session, so the CrewRunner that the main process creates at startup is passed in.
   * Pure read tools such as list_unreported_tasks work with the DB alone and do not need this.
   */
  crewRunner: Pick<CrewRunner, "dispatch">;
  /**
   * Records the taskIds returned by list_unreported_tasks, tied to the caller's turn
   * (recordUnreportedFetch in bridge.ts). Importing bridge.ts directly would create a circular dependency,
   * so index.ts passes it in at startup.
   */
  recordUnreportedFetch: (caller: { agent: string; missionId: string }, taskIds: string[]) => void;
  /** The conversation turn running in a mission right now (the one that is issuing a task), or undefined when there is none. */
  currentTurnId?: (missionId: string) => string | undefined;
  /** Looks up the human-readable display name from the agent's directory name/role name. */
  displayName: (agentDir: string) => string;
  /** The role of the caller (agent directory name/role name). undefined if not in the ship. */
  roleOf: (agent: string) => string | undefined;
  /**
   * The rank of the role. undefined if not in the ship. Issuing tasks and what reports are visible are decided by rank alone.
   */
  rankOf: (role: string) => CrewRank | undefined;
};

/**
 * Identification of the calling session (from the HTTP header that base-acp-client.ts put in when creating the session).
 * It can be trusted because it is a value make-it-so itself embedded when it created that session, not the model's self-report.
 * A static `.mcp.json` in the ship directory is not used, so normally it is attached to every call
 * — it is undefined only when the call came through an unexpected path.
 */
type CallerIdentity = { agent: string; missionId: string };

/**
 * Creates an McpServer dedicated to the caller (`caller`). The tool definitions are gathered here.
 * Tests can connect an MCP client directly to this server and call each tool.
 */
export function createBoardServer(deps: McpBoardDeps, caller?: CallerIdentity): McpServer {
  const server = new McpServer({ name: "make-it-so-board", version: "1.0.0" });

  server.registerTool(
    "list_unreported_tasks",
    {
      description: "Gets the list of unreported crew tasks that you can report on: the tasks you delegated yourself (a commander gets the unreported tasks of every crew member). Use it when the captain asks for a report (\"report\" etc.).",
    },
    async () => {
      const missionId = resolveCallerMission(caller);
      if (!missionId) {
        logger.error("[MCP] list_unreported_tasks: no caller identity (headers are missing)");
        return { content: [{ type: "text" as const, text: "Error: the caller could not be identified." }], isError: true };
      }

      // What is visible: for the commander, everything on the ship; for everyone else, only what they issued themselves (decided by rank alone)
      const callerRole = deps.roleOf(caller!.agent);
      const sees = callerRole !== undefined && deps.rankOf(callerRole) === "commander" ? undefined : callerRole ?? caller!.agent;
      const tasks = getUnreportedTasks(missionId, sees).map((t) => ({
        agent: deps.displayName(t.agent),
        taskId: t.taskId,
        taskName: t.taskName,
        report: getTaskOutcome(t.taskId),
        cancelled: isTaskCancelled(t.taskId),
      }));

      // Records the taskIds this tool returned as "the subject of this report" —
      // when the turn completes normally, this record is treated as reported as is
      // (see bridge.ts). Having the model write a marker into the response text
      // repeatedly dropped some taskIds when reporting multiple tasks; here the server records exactly what it
      // actually returned, so there is no room for the commander's formatting mistakes to creep in.
      deps.recordUnreportedFetch(caller!, tasks.map((t) => t.taskId));

      if (tasks.length === 0) {
        return { content: [{ type: "text" as const, text: "There are no unreported tasks." }] };
      }

      // Returns formatted text that is easy to use for reporting instead of raw JSON
      // (about 47% smaller for the same data).
      const text = tasks
        .map((t) => `## ${t.agent}: ${t.taskId} (${t.taskName})${t.cancelled ? " [cancelled by the captain — the output below is partial]" : ""}\n${t.report ?? "(no result)"}`)
        .join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.registerTool(
    "dispatch_task",
    {
      description: "Delegates a task to a crew member (instead of writing a file to agents/{role}/tasks/). The instruction is recorded on the bulletin board (DB) and only a short notification reaches the assignee, who calls get_task to read it.",
      inputSchema: {
        agent: z.string().describe("Role name of the assignee (e.g. chief_engineer) or acp_agent name (e.g. sam)"),
        task_name: z.string().describe("A short English snake_case name describing the task (e.g. fix_login_validation)"),
        instruction: z.string().describe("Background, instructions and completion criteria of the task"),
      },
    },
    async ({ agent, task_name, instruction }) => {
      const missionId = resolveCallerMission(caller);
      if (!missionId) {
        logger.error("[MCP] dispatch_task: no caller identity (headers are missing)");
        return { content: [{ type: "text" as const, text: "Error: the caller could not be identified. No task was issued." }], isError: true };
      }
      // Only the commander and chiefs can issue tasks (decided by rank; we do not rely on a "please" in the prompt)
      const callerRole = deps.roleOf(caller!.agent);
      const rank = callerRole !== undefined ? deps.rankOf(callerRole) : undefined;
      if (callerRole === undefined || rank === undefined || !canDispatch(rank)) {
        logger.warn(`[MCP] dispatch_task rejected: ${caller!.agent} (rank: ${rank ?? "unknown"}) cannot delegate tasks`);
        return { content: [{ type: "text" as const, text: "Error: your rank does not allow you to delegate tasks (only a commander or a chief can). No task was issued." }], isError: true };
      }
      // The assignee may be given as a role name or as an acp_agent name; it is canonicalised to the role, and anything that
      // is not a crew member of this ship is refused here (the name becomes a directory name and a queue key below).
      const assigneeRole = deps.roleOf(agent);
      if (assigneeRole === undefined) {
        return { content: [{ type: "text" as const, text: `Error: "${agent}" is not a crew member of this ship. No task was issued.` }], isError: true };
      }
      const taskId = nextTaskId(assigneeRole);
      // The prompt actually sent is only a short notice — the full instruction is recorded as content in
      // task_started_events, and the delegate reads it with get_task
      // (the single source of truth stays in the DB and is not duplicated into the delivery path).
      const livePrompt = `A new task has arrived (taskId: ${taskId}). Read its content with the get_task tool, passing taskId="${taskId}".`;
      deps.crewRunner.dispatch({ agent: assigneeRole, taskId, missionId, originalName: task_name, content: instruction, livePrompt, dispatchedBy: callerRole, turnId: deps.currentTurnId?.(missionId) });
      return { content: [{ type: "text" as const, text: `Delegated task ${taskId} to ${deps.displayName(assigneeRole)}.` }] };
    }
  );

  server.registerTool(
    "get_task",
    {
      description: "Gets the instruction of the given taskId (and its result, if it is completed). Use it when you read the actual instruction after receiving a dispatch_task notification, or when you refer to a past task (\"about that instruction...\").",
      inputSchema: {
        taskId: z.string(),
      },
    },
    async ({ taskId }) => {
      const started = getTaskStarted(taskId);
      if (!started) {
        return { content: [{ type: "text" as const, text: `taskId=${taskId} was not found. If it was only just issued and is waiting in the queue behind another task, it is recorded when it starts: try again a little later.` }], isError: true };
      }
      const outcome = getTaskOutcome(taskId);
      const text = [
        `## ${started.taskName}`,
        started.instruction,
        ...(outcome ? ["", "### Result", outcome] : ["", "(not completed yet)"]),
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  return server;
}

/**
 * Resolves which mission the MCP caller (`caller`) actually belongs to.
 * Used by both `dispatch_task` and `list_unreported_tasks` (both need to know which mission
 * this MCP call is about).
 *
 * When a crew member calls it while running a task (the mission ID is the task-running scope
 * `__tasks__:{original mission ID}` — see taskSessionScope in crew-runner.ts), the original mission ID embedded there is
 * taken out as is. The task-running sessions themselves are separated per mission, so
 * there is no need to look up the parent task in the DB — there is no room for ambiguity.
 *
 * When there is no `caller` (the identification header is missing — a path that should not occur, such as calling with curl directly),
 * it returns `undefined`. Guessing it from "the one turn that happens to be running now" would
 * mix up the attribution when several missions run in parallel (this showed up on a real machine as reports from tasks issued
 * in different missions from two browsers both appearing in one of them) — going back to the same kind of ambiguous guess
 * in the abnormal case of a missing header would defeat the purpose, so no guess is made and an error is returned to the caller
 * (see each tool handler in mcp-board.ts).
 */
function resolveCallerMission(caller?: CallerIdentity): string | undefined {
  if (!caller) return undefined;
  return missionFromTaskScope(caller.missionId) ?? caller.missionId;
}

/**
 * The Express handler for `POST /mcp`. It is stateless mode (no session ID is issued), so
 * a new McpServer + Transport is created and thrown away per request — there is no shared state even with concurrent calls
 * from several agents.
 *
 * The calling session is determined from the identification header (crew-manager.ts puts it in as that session's
 * own MCP server config when creating the session).
 */
export function createMcpHandler(deps: McpBoardDeps): (req: Request, res: Response) => Promise<void> {
  return async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    const agent = req.headers[MCP_AGENT_HEADER];
    const missionId = req.headers[MCP_MISSION_HEADER];
    const caller = typeof agent === "string" && typeof missionId === "string"
      ? { agent, missionId }
      : undefined;
    const server = createBoardServer(deps, caller);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
