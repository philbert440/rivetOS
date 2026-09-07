# Codex integration followups — rivet-gpt, 2026-09-07

Companion to `/rivet-shared/plans/codex-node-parity-2026-09-07.md`.
Implementation is in the local `/home/rivet/rivetos` checkout, uncommitted.

## Completed and verified

- Den includes `~/.local/bin` in the inherited spawn PATH, preserving existing
  path precedence and explicit roster/entry PATH overrides. PATH is propagated
  into existing tmux servers as well as direct PTYs and herdr workspaces.
  The 113 term-manager tests pass, including a stripped service PATH regression.
- Codex setup discovers the checkout and uses `codex mcp add` to register the
  launcher in `config.toml`; unrelated settings are preserved. Fixed missing
  executable bits on all three integration scripts. Live `rivetos` registration
  is enabled and an isolated Codex session successfully called `memory_stats`
  via MCP without a shell fallback.
- Updated the live `~/.rivetos/workspace/MEMORY.md`, repo template, and Codex
  discipline/README with all six recall tools: `memory_search`, `memory_browse`,
  `memory_get_full`, `memory_stats`, `wiki_search`, `wiki_read`.
- All six recall tools returned real data through stdio MCP. Search modes hybrid,
  FTS, regex, and vector returned matches for Codex. Full-message expansion
  recovered the complete original user request; wiki read recovered the slug
  returned by wiki search. Capture includes this conversation.
- Captured Codex CLI 0.153.4 command approval dialog. Live `y` approved the test
  command and created `/tmp/rivetos-codex-approval-smoke`; Esc canceled the first
  attempt. Parser now captures reason/command and translates these shortcuts.
  The persistent prefix-rule choice is deliberately not offered as a session
  approval. Unsupported choices fail without clearing the pending card; empty
  key arrays no longer emit a false approval-resolved event.
- Codex driver tests include blocked-screen → approval-request → deny/allow
  injection and rejection of unavailable session approval (42 tests pass).
  Parser/key/adapter regression checks pass. Den and web typechecks/builds pass.
- Live memory integration suite: 10/10 pass. Capture and backfill standalone
  smoke suites pass; full-payload unit coverage passes. Sandbox EPERM failures
  were rerun with the required socket/database permissions and are not product
  failures.
- Per Phil's explicit request, live `~/.rivetos/den-term.json` now launches
  `["codex", "--dangerously-bypass-approvals-and-sandbox"]`. This affects new
  den spawns; existing sessions retain their launch policy. The repo default
  remains unchanged.

## Open gaps and acceptance checks

1. **Leading `/` on the first chat message — reported, not reproduced.** Static
   inspection found no slash prefix in web `injectOne`, shared system-prompt
   wrapping, or den bracketed-paste submission. A new regression proves a fresh
   Codex prompt reaches the PTY byte-for-byte without a slash. Still reproduce
   through an actual fresh RivetHub chat and capture the outbound request,
   terminal draft, herdr startup state, and first rollout user message. Check
   a leftover TUI draft/slash menu and input arriving before readiness. Do not
   strip legitimate slash commands or erase terminal drafts speculatively.
   **18:46 followup:** a disposable terminal spawned through live `POST /term`
   accepted its first prompt via `POST /term/inject` byte-for-byte, with no
   leading slash, and returned `RIVET_GPT_FIRST_PROMPT_OK` through the room's
   transcript endpoint. The test terminal was deleted afterward. This covers
   the live backend path; a browser composer reproduction remains outstanding.
2. **Approval cards need live hub/den acceptance after backend restart.** Parser,
   driver, and live TUI shortcuts are verified independently. Exercise the actual
   web card and Android client through herdr `blocked` → screen → decision after
   deploying the rebuilt den. Current default bypasses approvals; use a separate
   test roster with on-request approval for this check. File-edit, network, and
   other Codex approval panel variants remain unsupported until captured.
3. **Activation on the running service.** Phil authorized a restart, completed
   at 17:58 EDT, and confirmed chat activity now arrives. Fresh Codex launch
   through the running den was verified again at 18:46. All six recall tools
   are now callable directly from the agent. A subsequent writable-rollout
   guard (see below) is built but awaits the next den restart. The corresponding
   `function_call` full-payload reader support is built and takes effect in
   newly started MCP processes; existing processes retain their loaded module.
4. **Trigram recall quality.** `memory_search(query="Codex", mode="trigram")`
   returned no results while FTS/regex/vector/hybrid found matches. This is a
   quality gap, not a transport error. Investigate whole-document similarity
   thresholds versus word similarity for short tokens before changing defaults.
   **Confirmed cause:** `search.ts` uses whole-document `similarity() > 0.3`.
   A real PostgreSQL probe of a long message containing `Codex` scored 0.0845;
   `word_similarity('Codex', message)` scored 1.0. Wiki search already uses
   indexed `$query <% search_text` with word-similarity ranking. No shared
   search thresholds or fleet services were changed in this pass.
5. **Memory queue health.** Live `memory_stats` reported 74 dead compaction jobs
   (truncated LLM output), 14 dead embedding jobs (null embeddings), 4 dead
   tool-synthesis jobs (empty responses), and 1 dead ct117 task (DB connection
   exhaustion). At that snapshot, 65 embeddings and 4,112 wiki extractions were
   pending; pending counts alone do not prove stalled workers. Repair causes,
   then selectively retry and verify drainage; no bulk retries were performed.
   **18:35 recheck:** 73 compaction, 12 embedding, 4 tool-synthesis, and 1 task
   jobs remained dead. Wiki pending work had decreased to 4,083. These remain
   separate fleet-worker issues; no failed tasks were replayed.
6. **Full capture-pointer recall across nodes.** Full stored-row expansion and
   Codex parser unit tests passed. **Local >16K acceptance now passes:** direct
   agent-facing `memory_get_full` recovered a 158,854-character tool result for
   row `0225407c-81aa-4855-abb2-ffea0a382de3` from its rollout pointer, versus
   16,015 stored characters. A remote-node disk pointer still needs end-to-end
   validation. Local success does not establish remote transcript availability.

## Resumed improvements — 18:35–18:50 EDT

- **Capture repaired and activated.** The live watcher repeatedly failed with
  `invalid input syntax for type json`: free-form `exec` code was sent directly
  into `tool_args` (jsonb), and capped object arguments could also become invalid
  JSON. Strings and truncated previews are now encoded as JSON strings;
  complete objects/arrays keep their JSON types and truncation pointers remain.
- **Rollback recovery repaired.** Dedup additions publish only after a successful
  commit. A failed watch restores its file cursor, so a retry recovers the whole
  transaction even if the rollout stops growing. Regression tests enforce JSON
  input validation, rollback semantics, and retry without another append.
- **History recovered.** Restarted only the user `codex-memory-capture.service`
  at 18:40:20 EDT. Initial replay recovered 363 missing rows across 12 rollouts.
  Subsequent comparison of disk event IDs to stored rows found all 433 stable
  rows present and zero duplicate event IDs (excluding the newest five seconds).
  Agent-facing `memory_browse` now returns this conversation's recent updates.
- **Tool format parity.** Capture, backfill, and full-payload reading now accept
  `function_call`/`function_call_output` as well as custom calls. Capture and
  backfill pair tools by `call_id`, retaining the item ID for storage dedup.
- **Startup transcript guard.** One live fresh-terminal probe briefly returned
  an older transcript during startup. The room resolver accepted any open
  rollout descriptor, including read-only history scans. It now requires a
  writable descriptor via `/proc/<pid>/fdinfo`; regression coverage checks that
  history alone resolves nothing and cannot obscure a writable active rollout.
  This guard is built, **not loaded by the running den yet**. No second main
  service restart was performed because its control-group shutdown closes
  active terminal sessions.
- **Verification:** capture and backfill standalone suites pass; 203 backend
  tests plus 60 room/watcher/store tests pass; all 10 live memory MCP integration
  tests pass. Capture, backfill, memory-postgres, and den builds pass. Lint has
  no errors in the changed production files (existing warnings remain).
  All six agent-facing recall tools returned real data; explicit trigram search
  still returns no `Codex` matches, as documented above. The live web/Android
  approval-card click path remains unverified; no browser/device driver is
  available in this session. Parser, driver, and key-injection coverage passes.

## Verification commands

- `npx vitest run services/den-server/src/term/manager.test.ts`
- `npx vitest run services/den-server/src/harness/codex-driver.test.ts services/den-server/src/harness/adapters/codex.test.ts services/den-server/src/term/permission-prompt.test.ts services/den-server/src/harness/prompt-keys.test.ts`
- `npx vitest run services/mcp-sidecar/src/memory.test.ts` (requires test DB/socket access)
- `npm test --workspace=@rivetos/codex-rivet-memory-capture`
- `npm test --workspace=@rivetos/codex-rivet-memory-backfill`
- `npm run typecheck --workspace=@rivetos/den-server`
- `npm run typecheck --workspace=@rivetos/rivethub-web`
- `npm run build --workspace=@rivetos/den-server`
- `npm run build --workspace=@rivetos/rivethub-web`
- `codex mcp list`
