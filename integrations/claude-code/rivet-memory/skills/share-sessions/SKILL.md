---
name: share-sessions
description: 'This skill should be used when the user wants to share captured sessions with another person or a team memory server, for example "share my sessions about X with Alex", "send these sessions to the team server", "give the team my sessions on Y", "sanitize my sessions about Z for sharing", or /share-sessions <topic>. It finds the sessions, asks the user to approve, redact or deny each one, sanitizes the chosen ones, walks every review flag with the user, and prints the command or file to send. It never sends anything itself.'
argument-hint: "<topic>"
version: 0.1.0
---

# Share sessions

Turn the user's captured sessions on a topic into one sanitized bundle with no open flags, then print what the user runs or sends. The tools are `session_find`, `session_sanitize` and `session_import` on the `rivetos` MCP server. No raw bundle is ever written, and a denied session never leaves the store.

## Hard rules

- Never send, push, upload or ingest a bundle to another node or person, even when the user asks. No tool here can, and no shell command may. Print the command, say the user runs it, and stop.
- Never read, quote or summarize flagged text. Do not open the report's flag sections or the `.review.local.json` file. This session is captured, so anything read here lands in memory.
- Share only the sanitized bundle. The `.report.md` and `.review.local.json` files stay on this machine. Never attach them, send them or suggest sending them.
- Do not call `session_sanitize` until the user confirms the decision table.
- Stop when a step fails. Do not retry without the decision pass or with other arguments to get past a refusal.

## 1. Find

Call `session_find` with `query` set to the topic's keywords (from `$ARGUMENTS` for `/share-sessions`). Drop filler such as "the", "my", "work", "stuff" or "sessions about", because the search needs every word to match. Add `since`, `before`, `agent` or `tag` only when the user named them.

- Reply starts `No sessions match`: try once more with the two or three most specific words. If that also matches nothing, say nothing matched that topic and stop.
- Otherwise show the numbered list as returned. Ask where the bundle goes (the team server or a named person) unless the user already said.

## 2. Decide each session

Ask the user to decide every listed session:

- `approve`: share it as the sanitizer leaves it.
- `redact`: share it after scrubbing what the user names in that session. That is one or more exact terms (case-sensitive), `drop tool outputs`, or both.
- `deny`: leave it out. It never leaves the store.

Accept answers in any form, such as `1 approve, 2 redact "Margot Wirt" and drop tool outputs, 3 deny`. A session the user does not mention stays undecided. Ask again until every row has a decision.

Then show the full table, one row per session with its number, title, decision and redact rules, and ask for one explicit confirm. The user may change any row. Show the table again after each change. Continue only on a clear yes. If every session is denied, say there is nothing to share and stop.

## 3. Sanitize with the decision pass

Call `session_sanitize` with:

- `sessions`: one entry per approved or redacted session, `{id, decision: "approve"}` or `{id, decision: "redact", redact: {terms: [...], drop_tool_outputs: true}}`, with only the rules the user named. Leave out denied sessions.
- `out`: `<slug>-<UTC yyyymmdd-hhmm>.json`, where the slug is the topic in lowercase letters, digits and hyphens, at most 40 characters. On an "exists" refusal, add `-2` before `.json`.
- `decide: true`.

If it fails because the decision endpoint is unreachable or `memory.sanitize.decide` is not configured, stop. Quote the error and say nothing was written and nothing can be shared yet. Name the fix the error points to, such as starting the decision model or setting `memory.sanitize.decide.url`. If it refuses a session or a rule, quote the refusal and go back to step 2.

## 4. Show the report summary

Show the totals, the changes by rule (`session_term` and `drop_tool_outputs` count the user's redactions), the not-scanned and best-effort lines, and the decision-pass line. Give the report path and say it stays local and is the place to read each flag.

## 5. Walk each flag

For each flag line, highest score first, show its number, score, place, length and report line, for example `Flag 2: score 0.95, session 1 message 3 content, 11 chars, report line 48`. The session number in a flag counts sessions in the bundle's own order, which differs from the find list. Never guess what a flag holds or question the user's marks from the excerpts. Ask the user to read that line of the report in their own editor and answer one of:

- `keep`
- `redact`
- `map <term> as <placeholder>`

Accept several answers in one reply, such as `1 keep, 2 redact, 3 map Globex as [client]`. When the reply says `and <n> more in the report`, ask the user to mark those in the report themselves.

## 6. Apply the marks

For each answer, print only that report line with `sed -n '<line>p' <report>` and check it is the flag's `Mark: open` line. Then replace that one line with `sed -i '<line>s/.*/Mark: <answer>/' <report>`. Do not print any other part of the report.

Then run `rh memory sanitize --resolve <report>`. If it refuses, quote the refusal and go back to step 5 for the flags it names.

## 7. Check and confirm

Call `session_import` with `path` set to the sanitized bundle and `dry_run: true`. It writes nothing. The bundle is ready only when the reply says `would import` with no `unreviewed` count and no refusal. Otherwise return to step 5 for the open flags.

Say that sanitizing is best effort and ask the user to confirm they read the report and want to share this bundle. Wait for a yes.

## 8. Print the next step

Print the commands. Do not run them.

- Team server. The loaded config's `memory.capture.gateway` (`url`, `ca`, `token`) must point at the `rivet-team` gateway:

  ```bash
  RIVETHUB_CONFIG=<config whose memory.capture.gateway is rivet-team> rh memory ingest-bundle <sanitized bundle path>
  ```

  Drop the `RIVETHUB_CONFIG=` prefix when the default config already points there. `--dry-run` previews without writing.
- Another person. Print the sanitized bundle path as the one file to send. They run `rh memory ingest-bundle <file>` on their node, or ask their agent to run `session_import` on it.

In both cases, print the report path and the `.review.local.json` path as files that stay on this machine, and list the denied sessions by number and title as left out.

If the user asks you to push, send or ingest it for them, decline. Print the same command and say they run it.
