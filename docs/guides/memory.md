[日本語](memory.ja.md)

# Use the Memory

The Memory is the ship's shared notebook: short Markdown memos the crew writes when they learn or decide something, and that you (and every crew member, in later conversations and missions) can find again. It belongs to the ship, not to a mission.

## Read it

Click "Memory" in the header. The pane opens at the right and takes half of the window (drag its left edge to change that; the choice is remembered).

- The upper part is the list: directories (click to open) and memos, each with its type and, for a draft or a deprecated memo, a mark. Type in the search box to search titles, descriptions, tags and bodies instead (every word must match, up to the first 32 words, and the first four of one or two characters; Japanese works).
- The lower part shows the memo you pick: its type, tags, who wrote it and when, its description, then its text. "Frontmatter" opens the header of the file as it is. A link to another memo moves inside the pane; a web link opens in a new tab.
- The button at the top right of the pane switches between the list above the memo and the list beside it.
- "Drafts" and "Deprecated" switch those memos on and off in the list.
- In a window 860 px wide or less, the pane covers the whole page (Escape or × closes it).

The pane changes by itself when the crew writes. You cannot edit a memo in the pane: ask a crew member to change it.

## What the crew does

Every crew member has a built-in skill, `memory`, that tells them when to write (the end of a task that taught something, a decision and its reason, something you ask them to remember), how to name and describe a memo, and to look in the Memory before work that may already be known. They use these tools of the [MCP board](../reference/http-api.md#mcp-board), also from a remote host:

| Tool | What it does |
|---|---|
| `search_memory`, `read_memory` | Find and read memos |
| `write_memory` | Create or update a memo. Every write carries a one-sentence message |
| `deprecate_memory` | Keep a memo, but mark it as no longer to be followed (and say what replaces it) |
| `delete_memory` | Remove a memo (its history stays) |
| `get_memory_history` | Who changed what, when and why; ask a crew member to summarize recent changes |

- A memo has a `type` (`note`, `procedure`, `decision`, `reference`, `issue`, `glossary`, or another word), a one-line `description`, and a `status`: `draft` for a rough note, `stable`, or `deprecated`. The keys are English; the title, the description and the text are in the language the crew speaks.
- Two crew members cannot overwrite each other: to update a memo a crew member passes the version they read, and a stale one is refused with the memo as it is now.
- There is no hard limit. A write that makes a memo bigger than 1 MB, or the Memory more than 50,000 memos, still succeeds and returns a warning, which the crew member is told to pass on to you.
- To undo a change, ask a crew member: they read the old text from the history and write it back.

## Where it is

`ships/<ship>/knowledge/` is an [Open Knowledge Format](https://github.com/open-knowledge-format/open-knowledge-format) (v0.3) bundle: ordinary Markdown files with a YAML header, and a git repository of its own (every change is one commit; the author is the crew member and the message is theirs). You can read and copy it with any tool, and open it in any editor.

- The server writes the `index.md` files (the table of contents of each directory) after every change. Do not edit them.
- A file you edit by hand is picked up at the next start of the ship. It is committed with the next change to that same memo, under that crew member's name; a file you delete by hand stays in the git history's tree.
- The search index lives in the ship's DB and is rebuilt from the files at every start ([Data model](../reference/data-model.md#memory-index)); you can delete it without losing anything.
