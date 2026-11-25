[日本語](behavior.ja.md)

# Screen Behavior

These are the behavior guarantees the Web UI keeps. **Appearance (colors, dimensions, timings, typefaces) is not included.** Appearance may change; for the behavior described here, if it changes, this document is updated along with it.

## Contents

- [Principles](#principles)
- [What Is Stored in the Browser](#what-is-stored-in-the-browser)
- [Screen Layout](#screen-layout)
- [Conversation Display](#conversation-display)
- [Split View](#split-view)
- [Choosing Who to Talk To](#choosing-who-to-talk-to)
- [Input Box and Slash Commands](#input-box-and-slash-commands)
- [Crew Status](#crew-status)
- [Pending Permissions](#pending-permissions)
- [Mission List](#mission-list)
- [PINs and Jumping to Old Messages](#pins-and-jumping-to-old-messages)
- [Search](#search)
- [Crew Personnel Records](#crew-personnel-records)
- [Stop and Startup Watchdogs](#stop-and-startup-watchdogs)
- [Usage Display](#usage-display)
- [Keyboard Controls](#keyboard-controls)

## Principles

- The client renders what the server returns, as is. It does not guess, convert, or synthesize values to rebuild them ([Concepts](../concepts.md)).
- The conversation display is built only from the `GET /api/timeline` snapshot and the SSE events `timeline:upsert` / `append` / `remove` ([HTTP API](http-api.md#sse-server-sent-events)).
- SSE carries the events of all missions on the same channel. The client **does not use events from a mission other than the one currently open for the conversation display.** Only the signal to update crew status is accepted regardless of mission.
- Dates and times are shown in the browser's local time.

## What Is Stored in the Browser

Only the following are stored in the browser's `localStorage` (personal display settings; they are not sent to the server).

| Key | Content |
|---|---|
| `active-mission-id` | The selected mission |
| `chat-default-target:<mission ID>` | The default conversation target, per mission |
| `chat-target-order` | The order of the target buttons |
| `search-group-mode` | How search results are grouped |
| `left-panel-width` | The width of the left pane |
| `chat-split-enabled` | Whether the split conversation view is enabled |
| `chat-split-ratio` | The height ratio of the top view when split |
| `left-section-height-mission`, `-crew`, `-accounts`, `-pin`, `-settings` | The height of each section of the left pane |
| `left-pane-open` | Whether the left pane is shown (in a wide window; the drawer of a narrow window is not saved) |
| `theme-choice` | The theme chosen in this browser (it wins over the default in `config.yml`) |
| `language-cache` | The UI language (a copy of the server's value, so the language does not flicker on the first render) |
| `settings-language-choice` | The language of the settings screen (what was chosen in the settings screen; not sent to the server) |

- When a stored value does not exist in the current ship's configuration or lists (the crew lineup was changed, the DB was recreated, and so on), it falls back to the following.
  - Conversation target: the ship's default target (the commander if there is one, otherwise the first crew member)
  - Mission: the default mission (`bridge`)
- Even if `localStorage` is unavailable, things still work; values just cannot be saved.

## Screen Layout

- It consists of the left pane, the conversation, the input box, and the header.
- The header shows, from the left: the button that shows or hides the left pane (three lines), the title, the search button, the split button, and **the ship's name at the right end** (so you can tell which ship a tab belongs to when several are open). In a narrow window the ship's name gives way first, then the end of the title.
- The theme and the languages are chosen in the "SETTINGS" section at the bottom of the left pane (radio buttons; [Switching the Language](../guides/switch-language.md)), and in the desktop app also in the View menu.
- The button at the left of the header hides the left pane (the choice is saved) and shows it again.
- **A narrow window (860 px wide or less):** the left pane is a drawer over the conversation. It is closed at first; the same button opens it. It closes with a press outside it, with Esc, or when you pick a mission, a crew member's task or a pin. While it is open the conversation takes no keys or clicks, and when it closes the focus goes back to the button. What was chosen for a wide window is kept for when the window is wide again.
- The width of the left pane can be changed by dragging its right edge. The sections inside can each be opened and closed independently (several can stay open at the same time). An opened section can be resized by dragging its bottom edge, but **it cannot be made taller than the height at which all its contents are visible.**
- The sections of the left pane (from the top):

| Section | Default | Content |
|---|---|---|
| MISSIONS | Closed (only the one selected item is visible) | [Mission List](#mission-list) |
| CREW STATUS | Open | [Crew Status](#crew-status) |
| PINS | Closed | The PINs of the current mission |
| ACCOUNTS | Open | [Usage Display](#usage-display) |
| SETTINGS | Open | Radio buttons for the theme, the UI language and the crew language |

## Conversation Display

### Message display

- Messages are arranged in chronological order. The captain's messages and the crew's replies are distinguished visually.
- Replies are displayed as Markdown. The captain's messages are displayed with line breaks exactly as written.
- A reply in progress (`streaming`) has its body grow as it arrives. Completed, failed, and aborted replies are each shown in their own state. An aborted reply keeps the body written so far and indicates that it was aborted.

### Collapsing long messages

- When the body exceeds a certain number of lines, only the beginning is shown, with a "Show full text" button. Pressing it expands the message, and "Collapse" returns it.
- The expanded state is kept across SSE updates. A page reload or a recreation of the component returns it to collapsed.
- When the size of the display area changes (for example, when the window width changes), whether the body exceeds the limit is measured again.
- **A reply in progress** scrolls its body, following the end, inside a window of fixed height. When it completes, it returns to the collapsed display.
- The collapse position of a task card is half that of a regular message.

### Crew tasks

- Tasks issued in the same turn are gathered into a single "Crew reports" card.
- For each crew member that is running, the same display as in a regular conversation (a thinking indicator and a message card) is shown nested inside the card. If several crew members are working, that many are lined up.
- The body of a message card scrolls inside a window of fixed height.
- The **instructions** can be opened and closed with "Instruction" in the card.
- Even when completed, the card does not shrink into a badge; it stays as the same card.
- A task is canceled with the stop button on the message card.
- When the mouse is placed over the heading, a button to open the task report popup appears.

### Loading history

- First, a fixed number of the newest items are loaded. When there is older history at the top, a "▲ Load older messages" button is shown.
- While at the very bottom, the view scrolls down automatically as new messages arrive or bodies grow.
- At the bottom right of the conversation, "Scroll to the top" and "Scroll to the bottom" buttons are shown. **At the very bottom only the top button is shown, and at the very top only the bottom button is shown.** In the middle both are shown, and when the content fits and cannot scroll neither is shown. Being within a small margin of an edge counts as being at that edge. The "top" is the start of the loaded history.

### Common operations for list items

Items in PINs, in a crew member's status history, and in search results all behave as follows.

- **Clicking** scrolls to the corresponding message in the conversation (the card, for a task) and highlights it. For an item in a different mission, it switches to that mission first and then moves.
- When the move starts, the "at the very bottom" state is released. This is so that the view is not pulled back by the automatic scrolling for new messages.
- When the mouse is placed over an item, an "Open in a popup" button appears. Pressing it opens that message in a popup.
  - Task: a popup with report and instructions tabs.
  - Regular message: a popup with the sender, date and time, body, copy, and close.
  - Both have a "Go to conversation" button.
- Even when a popup is opened from a search result, the search palette stays open. Closing the popup returns to the results.

### Scrolling and highlighting

- The scroll for a move is an animation that finishes in a short time even for long distances. It starts fast and eases toward the end.
- The highlight starts **after the move has finished**, flashes once, and fades slowly.
- If the user scrolls, clicks, or presses a key, the animation stops at that point (and no highlight is shown).
- When the OS "reduce motion" setting is on, there is no animation and the move is immediate.
- For a move that switches to a different mission, the corresponding mission row in the left pane is also flashed. When the mission list is open and that row is out of view, it is scrolled into view before being flashed.

## Split View

- The header button can **split the conversation into top and bottom** (disabled by default). You can type in the bottom view while keeping an earlier part of the conversation displayed in the top view.
- The top view shows the **same loaded messages** as the bottom view, in a separate scroll area. Loading and SSE updates are both drawn from the same state, so they change together.
- **A message in progress (`streaming`) is not shown in the top view** (only in the bottom view). When it completes, it also appears in the top view.
- Right after enabling the split, and right after switching missions, the top view is aligned to the most recent history (the very bottom). The top view also has a "▲ Load older messages" button.
- Moves from [PINs, search results, a crew member's status history, and task cards](#common-operations-for-list-items) are performed in the **top view** when the split is enabled. However, a move to a message in progress is performed in the bottom view.
- The default height of the top view is 1/4 of the whole. It can be changed by dragging the boundary (1/10 to 8/10 of the whole).
- Even if the boundary is moved, if the bottom view was at the very bottom, it stays at the very bottom.
- The to-the-top and to-the-bottom buttons also appear in the top view (at the bottom right of each view, moving only that view).

## Choosing Who to Talk To

The conversation target is chosen with the bar above the input box.

### Two states

| State | Meaning | Saved |
|---|---|---|
| Default target | The one you keep talking to | Saved per mission |
| Target for the next message only | The one who receives just the next message sent | No |

### Operations

| Operation | Result |
|---|---|
| Click / Enter on an `@` selection | Switch the default target (cancels the one-message target) |
| Shift+click / Shift+Enter on an `@` selection | Make the one-message target (the default does not change) |
| Select the same crew member again with Shift / Esc in the input box | Cancel the one-message target before sending |
| Sending a message, a report, a button message, or a custom menu item that sends at once | Cancels the one-message target and returns to the default (it returns even if sending fails) |
| Switching missions | Cancels the one-message target |

- The one-message target is indicated with a mark distinct from the default, and the default target it will return to is also marked.
- The `/` command suggestions and the input box guidance are those of **the one who will actually receive the message** (the one-message target, if there is one).
- The buttons can be reordered by drag and drop. The order is saved in the browser.
- Buttons that do not fit in the width are gathered under "»" at the right end. Pressing it opens the rest as a list. While you are selecting inside "»" with the keyboard, the list opens automatically.

### The `@` shortcut

- Pressing `@` at the start of a line or right after a space in the input box does not enter the character; focus moves to the row of buttons.
- Select with ←→, confirm with Enter, cancel with Esc. In both cases, focus returns to the input box when done.
- An `@` right after a character, as in an email address, is entered as a plain character.
- While composing (IME), the shortcut is not applied.

## Input Box and Slash Commands

- **Ctrl+Enter** sends. Enter is a line break.
- You can type while waiting for a reply. Sending is not possible until the reply is finished (it is not sent automatically).
- Only one turn can run at a time per mission. Sending while one is in progress returns `429` ([HTTP API](http-api.md#error-codes)).

### Earlier messages (↑ history)

- **↑ on the first row of the input box** (the caret on the top row, nothing selected) opens a list of **your earlier messages in the open mission**, up to 20: the newest at the bottom (next to the input box), older ones above. Inside a line that wraps, ↑ still moves the caret up as usual.
- A text appears once (its latest use). The fixed messages that the buttons and the custom menu send (`report`, `engage`, `make it so`, and menu items that send at once) are not listed.
- The newest message is selected first. ↑ goes to an older one, ↓ to a newer one (hovering chooses too). **Enter or a click replaces the whole content of the input box** with that message and puts the caret at the end. **Esc**, or a click outside the list, closes it and leaves the box as it was. Any other key (typing, Backspace, Ctrl+Enter to send) also puts it away. It does not open while a reply is in progress.
- While the slash command suggestions are open, ↑ belongs to them. The list is read from the server each time it opens, and switching missions closes it.

### Buttons beside the input box

The send button (▶) is on the left. To its right, from the top, four buttons are lined up:

| Button | What it does |
|---|---|
| Make it so | Sends `make it so` to the current target |
| Engage! | Sends `engage` |
| Report | Sends `report` (the commander or chief summarizes the unreported tasks) |
| Menu | Opens the custom menu |

- The first three send at once, to the current target (the one-message target, if there is one). They, and the Menu button, are disabled while a reply is in progress.
- **A phone's width (600 px wide or less):** the message box takes the whole width, and the buttons are in a row under it. The send button is at the right end and the Menu button (three lines) to its left. "Make it so", "Engage!" and "Report" run from the left end of the row; those that do not fit slide under the Menu and send buttons (they can still be pressed where they show). The same three buttons are also at the top of the Menu's list, which is where the keyboard goes: the list is a plain group of buttons that opens with the Menu button and closes with Esc or a choice, and the focus goes back to the Menu button.
- **The custom menu** lists the items enabled on this ship, in the order of [`quick-actions.yml`](configuration.md#quick-actionsyml). Each item shows its name and, below it, the text it sends. Clicking an item sends that text (a message, or a slash command) **or** puts it in the input box, as the item was set up. An item that only fills the box is marked with "…". The list is read from the server each time the menu opens.
- "Settings…" at the bottom of the list opens an editor for **this ship's** items: add, rename, change the kind (message / slash command) and the text, choose "send at once" or "put in the message box only", reorder, and remove. A new item is enabled on this ship only. An item that other ships use too says so, and changing it changes it for them as well; removing it only takes it off this ship (an item enabled on "All ships" is switched off for this ship only; ships made later still get it).
- The settings screen has a "Custom menu" tab that edits every item and the ships each one is enabled on.

### Slash commands

The slash commands the provider has (Claude Code's `/context`, `/compact`, `/clear`, skills, and so on) can be used as commands **the current target can execute**.

- The list arrives from the agent when a conversation session starts. It is held per session and disappears when the session ends. Sessions for running tasks are not tracked.
- Only when the body starts with `/name` and **that name is in the target's list** is it sent as a command. A `/`-prefixed text that is not in the list (such as a file path) is a regular message.
- A command is sent as is, without the mission conversation preamble (the summary of other participants' messages). With a preamble, the text would no longer start with `/`.
- The result remains in the conversation as a regular reply.
- Commands that change the session state (such as `/clear`) are passed through as they are. They may diverge from the conversation history.
- **Suggestions in the input box:** While you type a string without spaces following a leading `/`, suggestions (name, hint, description) are shown. They are filtered by prefix match on the name, then by partial match. Select with ↑↓, complete to `/name ` with Tab or Enter, and close with Esc (they are not shown again until the body changes). They do not appear for text that does not match the list (such as a path).
- **Suggestions before startup:** Because the list arrives after the session starts, the last known list is kept in the database for each provider, and it is shown before startup ([Data Model](data-model.md#settings-and-caches)). In that case, a note at the end of the suggestions says that it is the last known list. If that provider has never been started, instead of suggestions, a message explains that "sending will start it and run the command". A command typed by hand is also executed on the first message before startup.
- kiro works only when the list arrives through the standard ACP notification (see the README for the scope of verified behavior).

## Crew Status

### The four states

| State | Meaning | Priority |
|---|---|---|
| `restarting` | While the session is being recreated by the captain's action | 1 (highest) |
| `starting` | While a conversation session is starting up (from process launch until the injection of the persona and the like is finished) | 2 |
| `working` | During a conversation turn, or while a task is running | 3 |
| `idle` | Otherwise | 4 |

- State names are displayed in English regardless of the language setting (as is `approval`, the status for a pending permission).
- The display for starting and restarting has a distinct appearance that can be told apart from pending permissions.
- A crew member that is starting or restarting cannot be restarted (`409`).
- The startup stage is a per-session state. A query that specifies a mission looks at that mission's session, and one that does not looks at all missions.
- **A session for running a task is disposable, so it is not shown as `starting`.**
- A crew member whose process has died is displayed as `idle`. The next time it is called, it comes up through the same path as the first startup (process launch, persona injection, rebuilding the prompt from the conversation record in the DB). If it died in the middle of processing, it appears in the conversation as an error card. If the server itself stopped in the middle of processing, it also appears in the conversation as an "interrupted" error at the next startup (for turns, only those whose reply output had started; for tasks, all of them). The body written up to that point is kept above the card. The recording is done after the port is secured (starting an already running ship a second time does not record that ship's turns as interrupted).
- The success or failure of a task is an attribute of the task itself, not the state of the crew member.

### How it is updated

- Status is fetched again in step with timeline updates and with signals that starting or restarting has changed. **There is no periodic polling.**
- When SSE reconnects, it is fetched again together with the conversation snapshot.
- The state of remote host tunnels is included in the same response, but is not fetched again when only a tunnel has changed. It may remain stale until the next activity or a screen refresh.

### Row display

- A crew row shows the icon, name, status, context usage, and the number of unreported tasks. A crew member on a remote host gets a host mark.
- **Context usage** is the value of that crew member's conversation session in the currently open mission. If there is no session, it is shown empty. The value exists only in the server's memory and disappears when the session ends.
- **The number of unreported tasks** is the number of tasks that were completed or failed but have not yet been reported to the commander. It increases when a task ends, and returns to 0 automatically when a report is made (there is no dedicated clearing operation).
- The crew member's history (the list of tasks that crew member handled) can be opened. Operations on items are as in [Common operations for list items](#common-operations-for-list-items).
- Clicking the icon opens the [personnel record](#crew-personnel-records).

## Pending Permissions

While a crew member is asking for permission to run a tool (a pending permission), it is shown in the following places so that it is not missed.

| Place | Display |
|---|---|
| Tray above the input box | Shows **only those of the currently open mission**, so that a permission of another mission is not granted here without context |
| Crew row | Makes the row of the crew member awaiting permission stand out and sets the status to `approval`. Adds a count to the "CREW STATUS" heading |
| Mission row | Adds a count. The "MISSIONS" heading shows **the total across all missions** (so it is noticed even when closed) |
| Browser tab | Indicated by the title and icon while the total across all missions is 1 or more |

- Which mission and which crew member a pending permission belongs to uses the value the server attached, as is. The client does not re-parse identifier strings.
- In the tray, you can choose to allow or deny ([HTTP API](http-api.md#pending-permissions-permission)).
- There are no browser notifications (OS notifications) and no notification sound.

## Mission List

- The heading is the fixed "MISSIONS". When collapsed, only the one selected item is shown.
- When opened, the following appear.
  - Search box: AND of space-separated terms. It narrows to only those whose name contains all the terms.
  - List: selecting and switching.
  - A "Show archived" checkbox (off by default).
  - A "＋ New mission" button.
- Selecting or creating does not close the list automatically.
- The list stays in the natural order of `missions`. The selected mission is not pulled to the top.
- **The selected mission always stays in the list, regardless of the search or the filter that hides archived missions.**
- Each row has an archive / restore button. Archiving is not deletion; it is a toggle for whether the mission appears in the list. **The selected mission cannot be archived** (if an archived one is selected, it can be restored).
- A row with pending permissions shows a count.

## PINs and Jumping to Old Messages

- A PIN is attached or removed with the PIN button on the message itself. The list shows **only the PINs of the currently open mission**. To remove the PIN of a message that is not on screen, jump to it from the list and then toggle it.
- A PIN is a snapshot of the message at the time it was pinned. Even if the original message changes, the PIN's content does not change.

### Jumping to an old message that has not been loaded yet

1. If it is in the loaded history, scroll to it and highlight it.
2. If not, fetch **one page starting with that message** with `GET /api/timeline/range`, add it to the history, and then scroll to that message.
3. Between the added chunk and the original history, there is a **"gap" where the messages in between are not loaded.** A row with two buttons is shown at the gap.
   - "▼ Load the next messages": one page toward newer messages, from the bottom edge of the upper chunk.
   - "▲ Load the previous messages": one page toward older messages, from the top edge of the lower history.
   - When everything in between has been read, the row disappears and the history becomes continuous.
4. Groupings such as the crew report card are split at each gap.
5. When missions are switched, all loaded messages and gaps are discarded and fetched again from the most recent history. After an SSE reconnect, only the gaps whose surrounding messages are still adjacent to the gap are kept.

## Search

- The header's search button, or **Ctrl+Shift+F**, opens the search palette (a popup in the center of the screen), or closes it if it is open. Esc closes it. Even when closed, the search terms, conditions, and results remain.
- When the conditions change, it searches automatically after a short wait.

| Condition | Content | Default |
|---|---|---|
| Search terms | AND of space-separated terms (full-width spaces also work) | — |
| Period | Start date and end date (local dates; the end date is inclusive). Either may be omitted | Not specified |
| Types to include | The captain's messages / the crew's replies / task instructions and reports | All |
| Target missions | Can be chosen individually. There is also "All". Archived ones can be chosen separately too | Current mission only |

- Matching is by partial match (Japanese can also be searched). It is case-insensitive. `%` and `_` are searched as the literal characters.
- A task matches **if each term is contained in either the report or the instructions.**
- Errors, aborts, and system notices are not searched.
- Results are in newest-first order. When the limit is exceeded, it indicates that results were truncated ([HTTP API](http-api.md#search)). Each result shows an excerpt around the match, with the matched range highlighted.
- The way results are grouped can be chosen from **by mission / by crew member / mission × crew member** (the chosen form is saved). The order of groups is the order of the newest result in each group. Because results from several missions are mixed when grouped by crew member, each result shows its mission name.
- Clicking a group heading collapses / expands it (there is also "Collapse all" / "Expand all"). Results of a collapsed group are excluded from selection with ↑↓. When new results arrive or the grouping is changed, everything is opened.
- At the top of the results, the count, "Collapse all" / "Expand all", and a table of contents (links to the groups) are shown fixed. Only the list of results below scrolls. Clicking a link scrolls to that group, and opens it if it is collapsed.
- Clicking a result (or ↑↓ and Enter) closes the palette and [moves to the corresponding message in the conversation](#common-operations-for-list-items).

## Crew Personnel Records

Clicking a crew member's icon opens a popup with that crew member's personnel record.

- **Content:** a summary of the configuration (name, ID, provider, permission mode, working directory, host), the persona, and the briefing.
- **What you can do:** change the icon, change the model, restart the session, view the persona. The persona cannot be edited (edit the file directly).
- **Persona:** what you can see is **only the contents** of the persona file (or the provider's agent definition file). The final prompt the provider actually uses (the combination of `CLAUDE.md`, skills, plugins, and user settings) cannot be obtained. The persona of a crew member on a remote host cannot be read because it is on another machine.
- **Briefing:** the full text sent at session start (persona, rules, skills, system guidance) is assembled each time it is opened, **in the same way as when it is actually sent.** If the files were edited afterward, it may differ from what was sent to an already running session. When it cannot be assembled (for example, the rules file cannot be read), it is left empty and the reason is shown.
- **Icon:** only raster images (PNG, JPEG, WebP, GIF) are accepted. **SVG is not accepted, because it can contain scripts.** The format is determined by the leading bytes of the content, not by the extension or the declared type. There is a size limit. There is one file per crew member, and uploading again in a different format deletes the old file. A crew member without an icon gets an avatar generated from the name (initial and color).

## Stop and Startup Watchdogs

Even when a provider does not respond (login expired, network outage, trouble with a remote host, and so on), the following guarantees ensure that **a mission does not get stuck in processing.**

- **Stop always works, at any stage.**
  - If there is a session, a cancel is sent.
  - If the session is starting up, the startup is aborted (the process being launched is stopped).
  - In either case, if the turn has not ended after the grace period, the session is forcibly terminated and the pending processing is cut off.
  - A failure after stop was requested (startup abort, forced termination, process exit) is recorded as **"cancelled"**, not as an "error", and no automatic recovery is performed.
  - If there is no turn in progress, `409` is returned. The screen fetches the server state again and aligns with it.
  - On screen, pressing stop turns the stop button into a "Stopping…" display and it can no longer be pressed. It returns when the turn ends.
- **Session startup has a limit.** When exceeded, the process being launched is stopped and it is treated as a "startup timed out" failure (the mission is released). A startup that finishes late is not registered as a session, and its client is stopped. The same limit applies to launching a task run.
- **If there is no response for a long time to the briefing that sends the persona and the like, it is treated as a startup failure.** Other failures to send the briefing continue with only a warning.
- **If there is no activity for a long time in the middle of a turn, it is treated as a hang and automatic recovery is attempted.** However, **while waiting for the captain to answer a permission request, it is not treated as a hang** (even if you step away, it does not time out; once you answer, it resumes). The same applies to crew tasks, and the session of a hung task is discarded (the next task starts with a new session).

These durations are constants in the code (they cannot be changed in the configuration file).

## Usage Display

- The reply and task cards show the consumption of that turn. The unit differs by provider.
  - claude: estimated cost (USD). It is computed as the **difference from the start of the turn**, from the cumulative value of the ACP usage notification. It is not the actual billed amount.
  - kiro: its own credits.
- The **ACCOUNTS** section shows the usage rate for each authenticated account and the crew members running on that account.
  - The usage-rate frame is determined per account, not per crew member or per provider. The frames the server assembled are lined up as they are.
  - Local crew members are grouped by provider. For claude, the account (including the organization) is identified with `claude auth status`.
  - What cannot be identified (kiro, API key authentication, not logged in) is not bundled by guesswork; it goes in an "(account unknown)" frame.
  - Crew members on remote hosts run under a different login on a different machine, so they are not aggregated. They are shown in a "Not tracked" frame.
  - Fetching has a minimum interval and a cache. It is fetched again with the refresh button and when SSE connects.
  - **Email addresses are shown on screen as they are** (because it is a personal screen for running on your own machine).

## Keyboard Controls

| Operation | Where | Action |
|---|---|---|
| Ctrl+Enter | Input box | Send |
| `@` (at line start or right after a space) | Input box | Go to target selection |
| `/` (at line start) | Input box | Command suggestions. ↑↓, Tab, Enter, Esc |
| ↑ (on the first row) | Input box | Earlier messages of the mission. ↑↓, Enter, Esc |
| Esc | Input box | Cancel the one-message target |
| Ctrl+Shift+F | Anywhere | Open / close the search palette |
| ↑↓, Enter, Esc | Search palette | Select, move to, and close results |
