---
name: share-sessions
description: 'This skill should be used when the user wants to share captured sessions with another person or a team memory server, for example "share my sessions about X with Alex", "send these sessions to the team server", "give the team my sessions on Y", "export and sanitize my sessions about Z", or /share-sessions <topic>. It finds the sessions, bundles and sanitizes them, walks every review flag with the user, and prints the command or file to send. It never sends anything itself.'
argument-hint: "<topic>"
version: 0.1.0
---

# Share sessions

Turn the user's captured sessions on a topic into one sanitized bundle with no open flags, then print what the user runs or sends. The tools are `session_find`, `session_export`, `session_sanitize` and `session_import` on the `rivetos` MCP server.

## Hard rules

- Never send, push, upload or ingest a bundle to another node or person, even when the user asks. No tool here can, and no shell command may. Print the command, say the user runs it, and stop.
- Never read, quote or summarize flagged text. Do not open the report's flag sections or the `.review.local.json` file. This session is captured, so anything read here lands in memory.
- Share only the sanitized bundle. The `.report.md` and `.review.local.json` files stay on this machine. Never attach them, send them or suggest sending them.
- Stop when a step fails. Do not retry without the decision pass or with other arguments to get past a refusal.

## 1. Find

Call `session_find` with `query` set to the topic's keywords (from `$ARGUMENTS` for `/share-sessions`). Drop filler such as "the", "my", "work", "stuff" or "sessions about", because the search needs every word to match. Add `since`, `before`, `agent` or `tag` only when the user named them.

- Reply starts `No sessions match`: try once more with the two or three most specific words. If that also matches nothing, say nothing matched that topic and stop. Do not export anything.
- Otherwise show the numbered list as returned. Ask which numbers to include, and where the bundle goes (the team server or a named person) unless the user already said. Wait for the answer.

## 2. Export

Call `session_export` with the chosen conversation ids and `out` set to `<slug>-<UTC yyyymmdd-hhmm>.json`, where the slug is the topic in lowercase letters, digits and hyphens, at most 40 characters. On an "exists" refusal, add `-2` before `.json`. This bundle is raw: never offer it for sharing.

## 3. Sanitize with the decision pass

Call `session_sanitize` with `in` set to the export name, `out` set to the same name with `.clean.json` in place of `.json`, and `decide: true`.

If it fails (the decision endpoint is unreachable, or `memory.sanitize.decide` is not configured), stop. Quote the error, say no sanitized bundle exists and nothing can be shared yet, and say the raw bundle at its path must not leave this machine. Name the fix the error points to, such as starting the decision model or setting `memory.sanitize.decide.url`.

## 4. Show the report summary

Show the totals, the changes by rule, the not-scanned and best-effort lines, and the decision-pass line. Give the report path and say it stays local and is the place to read each flag.

## 5. Walk each flag

For each flag line, highest score first, show its number, score, place, length and report line, for example `Flag 2: score 0.95, session 1 message 3 content, 11 chars, report line 48`. Ask the user to read that line of the report in their own editor and answer one of:

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

In both cases, print the report path and the `.review.local.json` path as files that stay on this machine.

If the user asks you to push, send or ingest it for them, decline. Print the same command and say they run it.
