[日本語](concepts.ja.md)

# Core Concepts

The ideas behind make-it-so, and an overview of how it works. For step-by-step instructions, see the [guides](guides/). For lists of fields, see the [reference](reference/).

## Contents

- [Glossary](#glossary)
- [Overview](#overview)
- [Ranks](#ranks)
- [Missions](#missions)
- [Sessions](#sessions)
- [Turn flow](#turn-flow)
- [Task flow](#task-flow)
- [Persona, rules, and skills](#persona-rules-and-skills)
- [How the model is chosen](#how-the-model-is-chosen)
- [Permissions](#permissions)
- [Provider differences](#provider-differences)
- [Design principles](#design-principles)

## Glossary

| Term | Meaning |
|---|---|
| captain | The user. The one who makes decisions. Not an agent, and has no session |
| crew, crew member | An AI agent that talks with the captain and does the work. It has a role on each ship |
| role | The name of a crew member, defined in `ship.yml` (such as `first_officer`; letters, digits, `_` and `-`; the name is up to you). The code never looks at role names |
| rank | One of three values: `commander`, `chief`, `crew`. Determines authority over tasks |
| the commander | The crew member whose rank is `commander`. The first one the captain talks to. At most one per ship |
| ship | A unit made up of a crew lineup, its configuration, and its DB. One ship runs as one process and has its own port |
| fleet | The directory outside the ships that holds the ships and the roster |
| roster | The list of crew candidates in the fleet (`roster.yml`). Members of the roster are assigned to a ship's roles |
| member | One person on the roster. Has a name, provider, persona, and personal rules. Can be assigned to several ships |
| mission | A container for conversation. A named set of conversations. `bridge` is the default |
| turn | One crew member's whole reply to a single message from the captain |
| task | A unit of work that a crew member delegates to another crew member |
| session | One connection (ACP) to a provider's AI agent. There are sessions for conversation and sessions for tasks |
| provider | The AI runtime that runs a crew member (`claude` = Claude Code, `kiro` = kiro-cli) |
| ACP | Agent Client Protocol. The standard mechanism make-it-so uses to talk to agents (JSON-RPC over standard input/output) |
| MCP board | A built-in MCP server (`/mcp`) that crew members use to delegate, fetch, and report tasks |
| report | An instruction from the captain to the commander. Has the commander report the results of unreported tasks all at once |
| permission | A crew member asking for permission to run a tool. The captain allows or denies it |
| persona | The prompt that defines a crew member's tone and character |
| briefing | The full text sent to a crew member when a session starts (persona, rules, skills, and system guidance) |
| timeline | The conversation history and in-progress items, arranged in the units the UI renders (`TimelineItem`) |

## Overview

```
Browser (Web UI)
   │  HTTP / SSE
   ▼
make-it-so server (1 ship = 1 process, 1 port)
   ├─ DB (SQLite, one file per ship)
   ├─ MCP board (MCP, /mcp)
   └─ ACP (standard input/output)
        ├─ Crew A (claude / kiro process)
        ├─ Crew B
        └─ … (including crew on remote hosts over SSH)
```

- **1 process = 1 ship.** Each ship has its own independent server (its own port and DB). To run several ships at the same time, use one process and one browser tab per ship ([guides](guides/)).
- A crew member is a provider's agent, started as a child process of the server process. The server itself has no model; it bridges to the agents and records and delivers the conversation.
- The UI only renders what the server returns. The conversation history lives in one place in the DB, and both the UI and the other crew members read it from there.
- **There is no authentication.** It is meant to be used on your own machine ([Security](security.md)).

## Ranks

A rank determines **authority over tasks**.

| Rank | Issue tasks | Tasks handled by report |
|---|---|---|
| `commander` | Yes | All on the ship |
| `chief` | Yes | Those it issued itself |
| `crew` | No | None |

- Role names are up to each ship. Crew members with the same rank have the same authority, whatever their role names.
- The default first one the captain talks to is the `commander`. If there is none, it is the crew member written first in `ship.yml`.
- The captain is not the only one who can give instructions to crew members. A `commander` and a `chief` can delegate tasks to other crew members through the MCP board.

## Missions

- A mission is a **container for conversation**. The captain uses separate missions for separate topics.
- **Crew members are always present in every mission** (there is no concept of "mission participants"). The captain can talk to any crew member in any mission.
- Conversation, pins, permissions, and model overrides are kept per mission. Crew sessions are also separate for each mission.
- Several missions can run in parallel. Within one mission, only one turn can run at a time.
- Archiving is a setting that hides a mission from the list, not a deletion. The conversation is not lost.
- **A mission's conversation is shared among crew members.** What you said to crew member A is passed on to crew member B as a preamble the next time you talk to B ([Turn flow](#turn-flow)).

## Sessions

Each crew member has a separate session for each mission.

| Kind | Purpose | Lifetime |
|---|---|---|
| Conversation | Conversation with the captain | Created the first time the captain talks to the crew member, and used until the process ends |
| Task | Running a delegated task | Disposable. Created for each task |

- A conversation session starts in this order: start the process, initialize, create the session, send the briefing.
- A crew member whose process has died is brought back up through the same path as the first start, the next time the captain talks to it. It does not rely on the crew member's own memory: **the mission's conversation record is rebuilt from the DB** and handed over.
- From the UI, the captain can recreate a crew member's session (restart).

## Turn flow

1. The captain sends a message to a crew member (`POST /api/crew/:role/message`).
2. The server records the captain's message in the DB and starts the turn.
3. Before the prompt sent to the crew member, the server adds **the mission's conversation preamble**. The preamble is the messages in the mission that this crew member has not seen yet (including conversations with other crew members). Right after a session is created, the most recent part is passed; while a session continues, only the difference since last time.
4. The crew member's reply arrives in fragments (chunks). The server delivers the text to the UI as a `TimelineItem` (`status: streaming`).
5. When it finishes, the reply is recorded in the DB and finalized as `done`.
   - If the captain stopped it, the text received so far is kept and recorded as "aborted".
   - If it failed, it is recorded as "error".
6. A transient failure (an internal RPC error) is retried once automatically, after recreating the session (recovery). A failure after the captain has stopped the turn is neither recorded as an error nor retried.

Provider slash commands (such as `/context`) are sent as they are, without a preamble ([Screen Behavior](reference/behavior.md#slash-commands)).

## Task flow

A task is work that a `commander` or `chief` delegates to another crew member with the MCP board's `dispatch_task`.

1. **Issue:** The issuer's session calls `dispatch_task(agent, task_name, instruction)`. The server assigns a task ID, records the instruction in the DB, and shows a card in the UI. Only a short notification is sent to the assignee.
2. **Execute:** The assigned crew member reads the instruction text with `get_task` and works in a task session. The text in progress streams into the card in the UI.
3. **Finish:** Completion or failure is recorded in the DB, and the card is finalized.
4. **Report:** When the captain gives the commander a `report`, the commander reads the results of unreported tasks with `list_unreported_tasks` and reports them to the captain all at once. **When that turn ends normally**, the tasks it read become "reported" (if the report fails midway, they remain unreported).

- Who called, and from which mission, is determined by an identifying header the server embeds in each session. It does not rely on the model's self-report. This is why tasks issued to the same crew member are never mixed up even when several missions run in parallel.
- "Unreported" is derived from a fact in the DB (the absence of a report record). There is no dedicated "clear" operation.
- **Cancel:** A cancel is sent to the assignee's session. The task **ends with the output up to the abort kept, and is marked "aborted"** (treated the same as aborting a conversation turn). It remains as an unreported task, and the report to the commander carries a note: "the captain aborted it; the output is partial".

## Persona, rules, and skills

What a crew member is told, and how it is made to behave, is determined by these four elements.

| Element | Contents | How it is injected |
|---|---|---|
| Persona | Tone and character | Inject `personnel/{ID}.md`, or leave it to the provider's own agent definition (`agent`) (one or the other) |
| Rules | What to follow | Inject the full text of the files. Concatenated in this order: the member's personal rules, then the ship's rules |
| Skills | Procedures to read when needed | Only the name and description are announced; the model reads the body when it needs to |
| System guidance | Common operating rules, the list of skills, (for ranks that can issue tasks) an explanation of `dispatch_task` plus the crew lineup table, and the area of responsibility | Always injected |

- For each crew member, the persona comes from **either the persona file or `agent`, only one of them**. If `agent` is specified, the persona file is not injected. Rules, skills, and system guidance are injected either way.
- The provider's own settings in the working directory (`cwd`), such as `CLAUDE.md` and `.kiro/`, take effect separately from make-it-so's injection. Do not duplicate the same content in the rules.
- **The area of responsibility (`targets` / `access`) is an agreement made in the prompt.** It only sends the crew member guidance such as "anything outside this directory is off-limits", and nothing is technically enforced ([Security](security.md)). This is because the project's policy is not to support provider-specific permission mechanisms individually.

## How the model is chosen

The model a crew member uses is decided in this order (higher takes precedence).

1. Per-mission override (changed in the UI; not carried over to new missions)
2. `crew.<role>.model` in `ship.yml`
3. `crew.<member>.model` in `roster.yml`
4. Not specified (the provider's default)

- It is applied right after a session is created. It is also reflected in a running session at the moment it is changed (from the next turn if a turn is in progress). Clearing the override returns to the original model.
- The list of selectable models is not known until a session is created. The last known list is kept for each provider, so a model can be chosen even right after a restart. **Right after installation, the list is empty until a session for that provider has been created once.**
- kiro does not return model choices, so its model cannot be changed.

## Permissions

- When a crew member asks for permission to run a tool, the server records it as pending and shows it in the UI. When the captain chooses allow or deny, the answer is returned to the crew member.
- A permission carries which mission and which crew member it belongs to. The UI shows only the permissions of the currently open mission in the tray ([Screen Behavior](reference/behavior.md#pending-permissions)).
- The permission mode (`permission_mode`) changes which operations ask for permission. Its values are provider settings ([Configuration](reference/configuration.md)).

## Provider differences

Differences are confined to each provider's client, and no provider branching is written in any other code.

| | claude | kiro |
|---|---|---|
| Unit of usage | Estimated cost (USD). The per-turn difference is computed from ACP's cumulative value | Its own credits |
| Context usage | From ACP's usage notifications | From kiro's own notifications |
| Model selection | Possible | Not possible |
| How `agent` is passed | Set after the session is created | Startup argument |
| Registering the MCP board | Injected dynamically when the session is created (verified to work) | Same method (see the README for the extent of verification) |

- Claude Code does not show a workspace trust prompt in headless mode. In an untrusted directory, the allow rules in `.claude/settings.json` are ignored. If the allow list has no effect, you need to mark that directory as trusted in `~/.claude.json` in your home directory (check the contents before changing it).
- kiro-cli has an intermittent bug where a tool call leaks into the body text without being executed. If it happens often, restart that crew member's session.

## Design principles

- **Move logic to the server; keep the UI thin.** Put complex logic on the server, and have the UI only render what the server returns. If the UI ever has to infer, convert, or rebuild from the server's values, treat that as a sign of a design flaw on the server side and solve it on the server. Previously, things were assembled separately from several paths, which repeatedly caused split displays and duplicated messages.
- **A single data source.** The conversation screen is built from one snapshot (`GET /api/timeline`) and three generic events (`upsert`, `append`, `remove`). For a new feature, first consider whether this existing data can be extended.
- **History is append-only.** The conversation history only has events added to it and is never rewritten. A change of state is also added as a new fact ([Data Model](reference/data-model.md)).
- **Provider independence.** Provider-specific features (such as enforcing permissions) are not supported individually. Differences are confined to the client boundary.
- **Pass dependencies in.** Configuration, external commands, the clock, and so on are passed as arguments. Modules are not built so that merely importing them causes side effects ([Architecture](architecture.md)).
