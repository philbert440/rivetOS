# Cowork memory capture

Claude Desktop Cowork sessions are a `cowork` harness. This plugin captures them. Capture is always on: there is no harness allow-list and no on/off switch. `den.allowed_harnesses` still only gates new launches.

## What works in each sandbox

Full-VM mode keeps the transcript on a disk image the host cannot read. Plugin MCP servers run on the host, and the bundled CLI can call them from `{ "type": "mcp_tool" }` hooks. That is the path that works with the sandbox on. Hooks carry the prompt, the final text, tool calls and results, and subagent stops. They do not carry reasoning or model usage.

With the sandbox off, task metadata is `local-agent-mode-sessions/**/local_<task>.json`. The transcript is `<task-dir>/.claude/projects/<slug>/<cliSessionId>.jsonl`. Older builds name the task directory `local_<task>`. Desktop 2.19675.1 names it the first 8 hex of the task uuid (no `local_` prefix) and sets metadata `cwd` to `<that dir>/outputs`. `rivet-cowork-capture.sh --backfill` imports those files once. It is not a resident poll. The den runs that same pass once at startup when the bundle exists, and drains the capture spool. A byte cursor per transcript skips a partial last line.

## Install

1. `rivetos plugins install cowork` writes `capture/dist/cli.js`, a single file. The target machine needs node, not npm.
2. Install this directory as a Claude Desktop plugin (`integrations/cowork/rivet-memory`). `.mcp.json` points at `bin/rivet-cowork-capture.sh`, which execs the bundle.
3. The den must be reachable. `RIVETOS_CAPTURE_URL` overrides the den URL. If the den is down, the batch is spooled and delivered on the next drain. Loopback capture uses the den's normal local path.

## Event ids

Text with a uuid is `cowork:<session>:<uuid>`. A tool is `cowork:<session>:tool:<tool_use_id>`. A transcript line with neither is `cowork:<session>:occ:<sha256>:<n>`.

Hook `session_id` is `cliSessionId`: the CLI writes that id into the transcript filename, every transcript line's `sessionId`, and the hook payload. The task file's own `sessionId` (`local_<task-uuid>`) is a different value and is never the session key.

Every hook passes `transcript_path`. When that file is readable, the hook does not store its own text. It ingests the transcript, so prompt and reply rows use transcript ids on both paths. A line not flushed yet waits for the next hook or for backfill. Hook-only text (`cowork:<session>:hook:<hash>`) happens only when the host cannot read the file. Once the transcript is readable, the store rewrites that hook row's event id to the transcript id, so a later pass stores nothing new. `tool_use_id` still matches tool rows on both paths.

## Timestamps and the project tag

Backfill sets the conversation's `created_at` from metadata `createdAt` and `updated_at` from `lastActivityAt`, so old tasks do not jump to the top of the session list. A tool row stays pending until its result arrives, including across backfill runs, and the result updates the same event id.

`settings.cwd` is recorded for display. It is not a project: the task cwd is the sandbox outputs directory, and the CLI cwd is `/private/var/empty`. Attached repos are metadata `userSelectedFolders`, stored as `settings.folders`, and those are what the project rule uses.

## Titles

Metadata `title`, then a transcript `ai-title` / `summary` line, then the first prompt.
