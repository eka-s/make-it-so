import type { BuiltinSkill } from "./skills.js";

// The skill that teaches the crew to use the ship's Memory. It is built into the app, so every crew member has it and the captain
// cannot remove or rewrite it by accident. It is plain text in the code (not a file) because it must reach crew on a remote host too,
// which read it with `get_skill`.

export const MEMORY_SKILL: BuiltinSkill = {
  name: "memory",
  description: "The ship's Memory, where the crew keeps what is worth remembering. Read it before you write to it or when the captain asks you to remember, note, look up or summarize the Memory's history; also to find what the crew already decided or learned before you start work that may have been done before.",
  body: `# The ship's Memory

The Memory is the ship's shared notebook: Markdown memos that every crew member can search, read and write, and that the captain reads in the Memory pane. It outlives conversations and missions, so keep in it what a crew member (you, later, or another) would otherwise have to find out again.

## Tools

- \`search_memory\`: list and search. Look here before work that may already be known.
- \`read_memory\`: read one memo. It returns \`version\`.
- \`write_memory\`: create or update a memo. To update, pass the \`version\` you read as \`base\`; if someone changed the memo meanwhile you get the current text back: merge your change into it and try again.
- \`deprecate_memory\`: keep a memo but mark it no longer to be followed (say what replaces it in \`superseded_by\`).
- \`delete_memory\`: remove a memo (the history keeps it).
- \`get_memory_history\`: who changed what and why; with \`path\` and \`diff: true\`, what each change did.

## When to write

- At the end of a task, when you learned something that was not obvious and the next person would need it: how something really works, a pitfall, a command that works, where things are.
- When a decision is made (by the captain or by you with their agreement): what was decided, and why. The why is what is lost first.
- When the captain asks you to remember something.
- A rough thought worth keeping while you talk with the captain: write it with \`status: draft\`; a draft may be incomplete and is shown as such.

Do not write what the code, the task result or the conversation history already says, secrets (passwords, tokens), or a log of what you did. One memo, one subject. Search before you create, and update the memo that exists instead of adding a second one.

## How to write a memo

- \`path\`: you choose it. Group by directory in a way another crew member can guess, such as \`procedures/deploy.md\`, \`decisions/use-sqlite.md\`, \`notes/2026-11-26-meeting.md\`. Use a name that says the subject. Never use \`index.md\` or \`log.md\`; the server writes the index.md files itself. The directory is the only way a memo is classified: there is no type and there are no tags, so choose the directory with care.
- \`title\` and \`description\` and \`body\`: in your language. The \`description\` is one line saying what the memo is and when it helps; it is what a search result shows, so write it for someone deciding whether to open the memo.
- \`body\`: Markdown. Link to other memos with Markdown links to their path (\`[Deploy](/procedures/deploy.md)\`); do not use wiki-style links.
- \`message\`: the change in a sentence, written for the history ("Add the rollback step", "Correct the port"). It is required.

## Keeping it true

- When a memo turns out wrong or out of date, fix it. When it was true once and something replaced it, \`deprecate_memory\` with \`superseded_by\`. When it should never have been kept, \`delete_memory\`.
- A write that passes a limit still succeeds and returns a warning; when you get one, tell the captain.
- If you are asked to undo a change or to summarize recent changes, read the history with \`get_memory_history\`, and for an undo read the old text from the diff and write it back as a new update.
`,
};
