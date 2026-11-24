[日本語](security.ja.md)

# Security

make-it-so is a tool that lets AI agents run commands and write files. This document explains what it trusts, what it does not protect, and what users should watch out for.

## Contents

- [Assumptions](#assumptions)
- [Trust boundaries](#trust-boundaries)
- [What is not protected](#what-is-not-protected)
- [What is protected](#what-is-protected)
- [What users should watch out for](#what-users-should-watch-out-for)
- [Reporting vulnerabilities](#reporting-vulnerabilities)

## Assumptions

- It assumes **you use it on your own machine, by yourself**. Use by several people, exposure to a network, and **use on a shared machine with other users** are not supported (`127.0.0.1` is reachable by other users on the same machine too).
- Crew members (AI agents) run **with your user's privileges**. make-it-so does not restrict those privileges.

## Trust boundaries

```
 Browser ──HTTP──▶ Server ──stdin/stdout──▶ Agent (crew member)
 (captain)         127.0.0.1                 runs with your privileges
                      │ SSH
                      ▼
               Agent on a remote host
```

| Boundary | How it is trusted |
|---|---|
| Browser → server | **No authentication.** Anyone who can reach the host it listens on can operate as the captain. Calls from browsers are narrowed to pages of the same origin by checking `Host` and `Origin` (see below) |
| Browser → settings server (`--settings`, default 3938) | **No authentication.** It can start, stop and **delete** ships, rewrite `config.yml` (**including changing the command that starts an agent**), and read any directory ("From a project"). It is in the same trust boundary as a ship's server and performs the same checks |
| Server → agent | The agent acts on the captain's instructions and on the task instructions of other crew members. Its privileges follow the provider's permission mode |
| Agent → MCP board (`/mcp`) | A secret generated at each start (`x-makeitso-token`) that only the sessions this server starts are given. A call without it is refused with `401`. The caller's role and mission are told apart by identification headers, but this is **not per-caller authentication** |
| Server → remote host | SSH (the user's `~/.ssh/config` and keys). Connection details are not kept in make-it-so's configuration files |
| Server → provider | The content of conversations is sent to the provider (Anthropic, kiro) |

## What is not protected

The following are **intentionally not protected**, or **have no technical enforcement**.

- **There is no authentication or authorization.** If you set `server.host` to anything other than `127.0.0.1` (such as `0.0.0.0`), anyone on the network can give instructions to the crew. Crew members can write files. Do not expose it outside a trusted network.
- **Calls from other users or other processes on the same machine cannot be prevented.** The `Host` and `Origin` checks only protect against attacks from **web pages opened in a browser**.
- **An agent can answer its own permission requests.** The permission API (`/api/permissions/…/respond`) also has no authentication and can be called with commands an agent can run (such as `curl`). Instructions planted in repository files or the like (prompt injection) could be used to bypass the permission prompt. `permission_mode: default` **only shows a confirmation screen** and does not stop a malicious agent.
- **Through `/mcp`, a process that holds the secret can delegate tasks as `commander`.** The secret is not written to any file, but it is part of the MCP configuration handed to each agent process, so a process on the same machine that can read that (for example, an agent's own commands) can use it. With the secret and the identification headers, a call results in an instruction to a crew member (running a prompt).
- **Rule and skill files (`rules`, `skills`) can also point to absolute paths or `../`.** Any file you can read goes into the crew's prompt and is sent to the provider. You write the configuration, so this is expected, but do not use someone else's configuration file as is.
- **The usage display runs `claude` and `kiro-cli` found on `PATH`** (separate from the `acp.*.command` settings).
- **In the browser UI, links in an agent's output can be opened in a new tab.** The destination is whatever the agent wrote. Check the destination before you click.
- **The custom menu (`~/.make-it-so/quick-actions.yml`) can be rewritten by any local process, including a crew member.** An item's label and the text it sends are separate, and an item set to send at once is sent as the captain's own message when you click it. Each item shows its text under the name; read it before clicking. The same holds for the other configuration files (`config.yml`, personas, rules).
- **You decide the crew's privileges.** Do not make an untrusted repository the `cwd` or `targets` of a crew member.
- **`claude-agent-acp` is fetched with `npx --yes` on every start.** The version is pinned, but the content hash is not. The fetched code runs with your privileges. This assumes you trust the npm registry.
- **The area of responsibility (`targets`, `access`) is an agreement in the prompt.** It only sends the crew member a notice saying "anything outside this directory is off-limits". **It is not technical access control.** A crew member can reach files outside `cwd`. This is because the project's policy is not to support each provider's own permission mechanism individually.
- **A crew member's privileges are left to the provider's permission mode.** With claude, the default when no permission mode is specified (`auto`) lets state-changing commands such as `touch` through without approval. For a crew member that should ask before acting, specify `permission_mode: default` ([Changing the permission mode](guides/change-permission-mode.md)). Even with `default`, tools on the provider's allowlist do not ask for confirmation.
- **The MCP board (`/mcp`) is protected only by that one secret.** Crew members on remote hosts reach the MCP board from the remote `127.0.0.1` through the reverse tunnel, and the secret is handed to the agent process running there. **Other users sharing that host who can read it can also call the MCP board.** Use only trusted hosts.
- **All conversation content is stored in plain text in the local DB (`{ship}/data/bridge.db`).** It is not encrypted.
- **Account information such as email addresses is shown on screen as is.**
- **A form a crew member shows (`render_ui`) is made by the crew member.** What the captain sees on a button and what is sent when it is pressed are separate things: the action name and the values are the crew member's. The captain does not see the text that was sent. A crew member that follows instructions planted in a repository can draw a misleading form. Read what the form asks before answering.
- **`POST /api/a2ui/:itemId/answer` and `/dismiss` have no authentication.** A crew member can answer or close its own form with a command such as `curl`, as it can answer its own approval request (above). What it writes in the comment field then appears as the captain's comment.
- **Links in a form's text go where the crew member decides.** They open in a new tab. The `openUrl` function of the basic catalog opens only `http`, `https`, `mailto` and `tel` addresses, and only on a click.
- **Images in a form, including `data:` images, are shown.** Loading from outside is stopped by the `Content-Security-Policy` alone. A form can use a picture to look like something it is not.
- **The A2UI libraries bring a known advisory.** `@a2ui/react` and `@a2ui/web_core` carry their own `zod` 3 (an advisory about memory use when a very large collection is validated). The server validates a form with it; the request body is limited to 1 MB, and only a local caller can reach `/mcp`.

## What is protected

- **By default, it listens on this machine only (`127.0.0.1`).**
- **Calls from browsers are narrowed to pages of the same origin.**
  - If the `Host` header is not an IP address or `localhost`, it returns `403` (a countermeasure against **DNS rebinding**, where a malicious web page points its own domain at `127.0.0.1` to pose as the same origin).
  - If an `Origin` header is present and differs from the server's own origin, it returns `403` (a countermeasure against **cross-site calls**, including body-less `POST`s from other sites).
  - Calls whose `Sec-Fetch-Site` is anything other than `same-origin` or `none` (`cross-site`, `same-site`) also get `403`. This is because `<img>` and `<script>` tags can send a GET without an `Origin` (the page cannot read the response, but this avoids side effects caused by the GET).
  - Calls without an `Origin` (`curl`, agents, the CLI) are not browser pages, so they are let through.
  - CORS is not allowed. The UI calls only same-origin relative paths (`/api`).
  - Limitation: using `server.host` with a **name** other than `localhost` or an IP address is rejected by this check (v0.1 does not support exposure by name).
- **External images are not loaded into the UI.** Images in an agent's output (Markdown) are not shown; only the alt text is shown (to prevent information from being sent out in an image's address). In addition, a `Content-Security-Policy` is set so that the UI does not connect to or load from anything other than its own server. (A form shown with `render_ui` can show an image, but it still cannot load one from outside: the same policy applies.)
- **Storage directories are readable only by the owner** (`~/.make-it-so` and the ship's directory; mode 0700). The conversation DB and logs are plain text but cannot be read by other users (except on Windows).
- **Checks on remote destinations.** A `destination` in `hosts.yml` that is empty, contains whitespace, or starts with `-` is rejected (to prevent ssh option injection). Connection details (key, port, user) are designed so that they cannot be written in `hosts.yml`.
- **The reverse tunnel is opened only on the remote `127.0.0.1`**, and if it cannot be opened, the connection fails.
- **Only raster images are accepted as icons.** SVG is not accepted because it can contain scripts. The format is determined from the first bytes of the content, not from the extension or the declared type. Delivery carries `X-Content-Type-Options: nosniff`. There is a size limit.
- **There is a limit on request body size.**
- **Identifiers used in paths, such as task IDs, accept only alphanumerics, `_` and `-`** (anything else gets `400`).
- **The MCP board tells callers apart from the identification headers the server embeds.** It does not rely on the model's self-report. Calls without the headers are rejected with an error rather than guessed, and calls without the secret are refused before any tool runs. However, this is not per-caller authentication (see above).
- **Debug routes are available only when enabled in the configuration** (disabled by default).
- **Agent processes are started so that they do not outlive an abnormal server exit** (confirmed on Linux + claude, both local and remote).

## What users should watch out for

- Do not change `server.host`. If you do, limit it to a trusted range of the network.
- For crew members that need confirmation, specify `permission_mode: default`.
- Make the `cwd` you hand to a crew member **somewhere you could afford to lose**. Do not use a directory with important data as `cwd` as is.
- Use a remote host that is not shared with other users.
- Understand that conversation content is sent to the provider and also remains locally. Handle content that includes secrets with care.
- When you change Claude Code's workspace trust settings (`~/.claude.json`), check its contents ([Core Concepts](concepts.md#provider-differences)).
- kiro-cli has an intermittent bug where the turn ends without a tool call being executed. No error or permission request appears, and it looks as if it silently stopped. For a crew member where it happens often, restart the session.

## Reporting vulnerabilities

If you find a vulnerability, please contact us through GitHub's **private vulnerability reporting** (the repository's "Security" tab → "Report a vulnerability") instead of a public issue. For details, see [`SECURITY.md`](../SECURITY.md) at the top level of the repository.
