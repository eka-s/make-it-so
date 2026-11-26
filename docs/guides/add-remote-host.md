[日本語](add-remote-host.ja.md)

# Adding a Crew Member on a Remote Host

Run a crew member on another machine (such as a server you can reach over SSH).

## Prerequisites

- The remote has the agent (`claude-agent-acp` for claude, `kiro-cli` for kiro) and `bash`. Nothing specific to make-it-so is needed. Only Unix-like systems are supported for the remote.
- You can run `ssh <host name>` with key authentication, without a password.

## Steps

1. On each machine, write the connection details (key, port, user, etc.) in `~/.ssh/config`. These cannot be written in `hosts.yml` (so that they do not end up in shared configuration).

2. In `~/.make-it-so/hosts.yml`, write the destination.

   ```yaml
   hosts:
     dev-server:
       destination: dev-server   # a Host name in ~/.ssh/config, or user@host
   ```

3. For the crew member in `ship.yml`, write `host:` and **a `cwd:` that is an absolute path on the remote side**.

   ```yaml
   crew:
     remote_engineer:
       member: sam
       host: dev-server
       cwd: /home/me/project
   ```

4. Restart the server and talk to that crew member.

make-it-so automatically sets up the route from the agent to the main board (MCP) with an SSH reverse tunnel, per host.

## Limitations

- `access` (the area of responsibility) cannot be specified (it is an error). `skills` are announced by name and description only; the crew member reads the body with the `get_skill` tool, since the skill files are on this side.
- When the connection drops, the next time you call the crew member it starts in a new session (it does not resume where it left off).
- Through the reverse tunnel the remote host reaches the board only (a listener of its own, which needs the secret each start generates), not the ship's screen or API. Other users who share that host and can read the secret can call the board. Use this only with trusted hosts ([Security](../security.md)).
- It is not included in the per-account usage totals.
