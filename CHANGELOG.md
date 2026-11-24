# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - Unreleased

First public release (alpha). Expect rough edges and breaking changes before 1.0.

### Features
- `npm run build && npm start` serves the built UI and the API from one port (`npm run dev` is for development).
- A web console where you talk to an AI crew (kiro-cli / Claude Code through the Agent Client Protocol).
  The first officer delegates tasks to the other crew members; their reports come back into the chat.
- Missions: separate conversations, each with its own sessions. Pins, history and per-mission model choice.
- Per-crew model and permission mode. Permission requests are approved in the chat.
- Remote crew members over SSH (reverse tunnel to the board). Linux hosts with bash.
- Stop always works, and startup can no longer hang a mission: stopping aborts a starting session (and force-stops a provider that ignores cancel after 15 s); a session that has not started within 3 minutes, or does not answer its briefing within 90 s, fails with a clear error instead of leaving the mission busy.
- Task authority by crew rank (`rank` in `ship.yml`: commander / chief / crew). The code no longer special-cases any role name: the default talking target, who may delegate tasks (enforced by the server), and whose reports a crew member can read all follow from the rank. One endpoint talks to any crew member.
- A personnel record popup per crew member (click the icon): upload an icon image, change the model, restart, and read the persona. Crew without an icon get an initial-and-color avatar.
- Task cards stay cards after they finish (no more shrinking into badges) and collapse at half the height of a normal message. Pins, crew-status history items and search results all scroll to the message when clicked, and show a hover button that opens it in a popup (new popup for ordinary messages, with a "go to conversation" button). A task card's header also shows the popup button on hover, and its "Instruction" link now sits inside the card, above the text. The task popup also has a "Go to conversation" button.
- Jumps to a message (search, pins, crew-status history, popups) and the scroll-to-top/bottom buttons now use our own scroll animation, about 2x faster than the browser's smooth scrolling (at most 0.5 s), stopping as soon as you scroll yourself. The message you jump to glows once it has arrived and then fades out slowly.
- Floating "scroll to top / bottom" buttons at the bottom right of the conversation (faint until hovered; only the button that can still move is shown).
- Conversation search (Ctrl+Shift+F): words (AND), date range, what to include (captain's messages, crew replies, task instructions and reports), which missions (default: the current one), and results grouped by mission / crew / mission × crew. Click a result to jump to it. When a jump switches missions, the mission's row in the left pane glows (and is scrolled into view if the list is open). Groups can be collapsed, alternate in background shade, and a sticky index at the top links to each mission / crew group.
- Provider slash commands (`/context`, `/compact`, skills, ...) from the input box: type `/` to pick from what the current crew member offers. Verified with Claude only.
- A button bar to choose who you talk to (drag to reorder, overflow menu); `@` is a keyboard shortcut to it. Shift+click (or Shift+Enter in the `@` picker) targets only the next message; after sending, the conversation returns to the base crew member.
- Credits (usage) per account: the left pane groups crew by the account they are logged in with (Claude: identified with `claude auth status`). kiro and remote crew are shown as "account unknown" / "not tracked".
- Input-box buttons: send (left), and "Make it so", "Engage!", "Report" and "Menu" in a column on its right. The custom menu keeps favorite messages and slash commands (`~/.make-it-so/quick-actions.yml`): each item is sent at once or only put in the input box. A ship edits its own items from the menu ("Settings…"); the settings screen edits every item and chooses the ships each one is enabled on.
- `↑` on the first row of the input box lists your last 20 messages in the mission to pick one from (Enter or click to use, Esc or a click outside to cancel).
- The header is quieter: the two language switches are behind one small label (click to change), and the ship name is shown at the right end.
- Two independent languages: the UI (English / Japanese) and the language the crew speaks.
- `npm run init` creates a minimal working configuration. `examples/fleet/` is a sample fleet.
- A settings screen (`npm start -- --settings`, port 3938): edit `config.yml`, `hosts.yml`, the custom menu, the roster (personas and icons) and ships with forms; start, stop and delete ships. "From a project" drafts a ship from an existing project (`.claude/agents`, `.kiro/agents`) and saves it in one step; agent definitions stay in the project and are referred to by name.
- `npm start -- --all` starts every ship that is not running, each as its own process.
- A desktop app (Electron; built and tried on macOS only, not signed): opening it runs the only ship, or lists the ships when there are several; a ship opens in a window of its own and stops with it. The ship's screen is served without a port, the settings open from the list or the menu, and the header is the title bar (the classic frame keeps room for the window buttons at both ends). `npm run start:electron` runs it from the build; `npm run pack` and `npm run dist` make the app and a dmg. The same ship cannot be open in the browser version and the desktop app at once.
- Everything lives in `~/.make-it-so`; the ship to run is chosen with `--ship <id>`. The server reads no environment variables.
- Local servers refuse requests addressed to a non-local host name (DNS rebinding) and cross-origin requests, send a Content-Security-Policy, and never load images from agent output.
- The bulletin board (`/mcp`) has a listener of its own, loopback only, on a port the OS picks at each start, and needs a secret generated at each start that only the sessions the ship starts are given. A remote host reaches nothing but the board through the reverse tunnel.
- A server that stops in the middle of a turn or task records it as interrupted at the next start (with the text written so far, shown above the notice). It does so only once it is the only process holding the ship (after it has bound its port; in the desktop app, after its single-instance lock and a look at the ship's port), so starting a ship that is already running never touches that ship's live turns.
- Waiting for the captain to answer a permission request is not treated as a hang (turns, tasks and session start).

### Configuration format (stable from 1.0)
- `~/.make-it-so/config.yml`, `roster.yml`, `hosts.yml`, `quick-actions.yml`, `personnel/` and `ships/{ship}/ship.yml`.
- `cwd` is where a crew member works; `agent` names the provider's agent definition used as its persona
  (without it, `personnel/{member}.md` is injected).

### Notes
- The database schema is versioned (`PRAGMA user_version`); the file is backed up before a migration.
- `claude-agent-acp` is pinned to a tested version (`config.yml`: `acp.claude.args`).
- Tested only on Linux with Claude Code. The kiro side is built to the documented formats but unverified on a real kiro-cli. See "制約と動作確認の範囲" in the README. No warranty.
- The screens are for desktop browsers, and the desktop app. Only macOS (Apple silicon) has been built and run; the app is not signed or notarized.
- Node.js 22.13 or later; `node:sqlite` prints an experimental-feature warning at start.
