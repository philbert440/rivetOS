# Cowork memory capture

Claude Desktop Cowork sessions are a `cowork` harness. This plugin captures them. Capture is always on: there is no harness allow-list and no on/off switch. `den.allowed_harnesses` still only gates new launches.

## What works in each sandbox

Full-VM mode keeps the transcript on a disk image the host cannot read. Plugin MCP servers run on the host, and the bundled CLI can call them from `{ "type": "mcp_tool" }` hooks. That is the path that works with the sandbox on. Hooks carry the prompt, the final text, tool calls and results, and subagent stops. They do not carry reasoning or model usage.

With the sandbox off (`lastSeenRequireCoworkFullVmSandbox` null), task metadata is `local-agent-mode-sessions/**/local_<task>.json` and the transcript is the sibling `local_<task>/.claude/projects/<slug>/<cliSessionId>.jsonl`. `rivet-cowork-capture.sh --backfill` imports those files once. It is not a resident poll. A byte cursor per transcript skips a partial last line.

## Install

1. Build the sidecar: `npm run build` in `capture/`.
2. Install this directory as a Claude Desktop plugin (`integrations/cowork/rivet-memory`).
3. The den must be reachable. `RIVETOS_CAPTURE_URL` overrides the den URL. Loopback capture uses the den's normal local path.

## Event ids

Text with a uuid is `cowork:<session>:<uuid>`. A tool is `cowork:<session>:tool:<tool_use_id>`. A transcript line with neither is `cowork:<session>:occ:<sha256>:<n>`.

A hook uses the same id when the payload has `uuid`, `message_id`, `prompt_id`, or `tool_use_id`. Otherwise it stores `cowork:<session>:hook:<hash>`, which does not collide with an occurrence id and also does not dedupe against one. `tool_use_id` is the reliable match between a hook row and a later transcript row.

The session key is `cliSessionId` when the hook carries it, else `session_id`, else `unknown`. It is not verified that the hook payload includes `cliSessionId`. The hook templates send `session_id`. If that is the bundled CLI's session id, it matches the transcript's `cliSessionId`.

## Timestamps and the project tag

Backfill sets the conversation's `created_at` from metadata `createdAt` and `updated_at` from `lastActivityAt`, so old tasks do not jump to the top of the session list. A tool row stays pending until its result arrives, including across backfill runs, and the result updates the same event id.

`settings.cwd` is recorded. Cowork's cwd is the task sandbox (`…/local_<task>/outputs`), and the project rule skips those paths.

## Titles

Metadata `title`, then a transcript `ai-title` / `summary` line, then the first prompt.
