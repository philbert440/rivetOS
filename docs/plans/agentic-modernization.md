# RivetOS Agentic Modernization — Architecture Findings & Phased Plan

_v2, 2026-07-05. Drafted from a full repo survey + memory review, refined in
discussion with Phil, incorporating the useful parts of the ultraplan Phase 1
draft. Supersedes v1 (same file, earlier today)._

## Direction (decided)

RivetOS consolidates around third-party harnesses as execution engines and
**RivetOS becomes the substrate**: memory, durable task orchestration, the
node gateway + RivetHub interfaces, observability (den), identity/config
across models and machines.

- **Three flagship harness executors:** `claude-cli`, `grok-cli`, and
  `hermes-cli`. Hermes is strategically load-bearing — the executor that
  works offline / private / local-only, backed by the local model fleet
  (vllm / llama-server / ollama plugins survive as its serving layer).
- **The gateway is the primary channel.** RivetHub (desktop app + web UI
  served from each node at :80/:443) becomes the main interface — den mode,
  chat UI, and terminal mode as three views over the same primitives
  (session, task, event stream).
- **Telegram + Discord (incl. voice) stay for now**, deprecated only when
  RivetHub reaches capability parity on the full loop Phil uses them for:
  voice channels, chat on the go / AFK (push + lock-screen reply), and
  organizing/searching agent conversation history. Parity checklist gates
  removal, not a date.
- End-state provider surface: 3 harness executors + 1 API chat model +
  1 local chat model (openai-compat → local rigs). The rest of the
  8-provider zoo goes.

## Current-state findings (repo survey, 2026-07-05)

- ~55k LOC monorepo. Core runtime `packages/core` (11.3k, incl. the 963-line
  Vercel-AI-SDK `loop.ts`), CLI monolith `packages/cli` (9.7k), Postgres
  memory plugin (4.3k) + graphile compaction/embedding services, den stack
  (den-app PixiJS viewer, den-server WS+PTY, den-protocol), 8 provider
  plugins, 4 channels (voice-discord heaviest at 2.1k).
- **Five orchestration mechanisms**, each building its own AgentLoop:
  per-session turn queue; graphile heartbeat; durable subagents
  (`ros_subagent_sessions` + embedded worker); in-process `delegate_task`
  (`ros_delegation_runs`); mesh delegation (mTLS HTTP, `/rivet-shared/mesh.json`,
  load-bearing undici pin).
- **Three MCP implementations**: mcp-server transport, mcp-client tool,
  claude-cli per-spawn `mcp-bridge.ts`.
- **Two memory-consolidation systems**: graphile compaction pipeline vs.
  in-plugin `review-loop.ts`.
- Deprecated-but-retained: `coding-pipeline` (498 LOC), mesh `secret` auth,
  `createPlugin()` shims. Hygiene: `.d.ts` leak into `src/`, squashed
  migration baseline after out-of-band drift, 31 TODO/FIXME.
- Harness integration in embryo: `plugins/providers/claude-cli`
  (harness-as-LanguageModelV3 + MCP bridge) and
  `integrations/{claude-code,grok,hermes}` hooks feeding memory + den.
- `CliResult.total_cost_usd` is parsed and dropped — budget tracking gap.

## Kept from the ultraplan Phase 1 draft

(Full draft archived in the ultraplan session; these carry forward.)

1. **Mesh over shared Postgres**: cross-node work = `ros_tasks` rows with
   `node_affinity`, claimed by the target node's runner
   (`run-task:<nodeId>` graphile task names), completion via
   `LISTEN ros_task_done` + poll fallback. Deletes the undici/mTLS
   delegation path; `mesh.json` demoted to liveness gating; HTTP
   `AgentChannelServer` stays only for synchronous chat.
2. **den-protocol as event lingua franca**: `TaskEvent` wraps den
   `AgentEventBody`; one stable den session per task (`task:<taskId>`),
   fixing per-spawn fragmentation. Runner-side `DenSink` owns emission;
   hook script disabled via env for task-spawned sessions.
3. **`session_key = task:<taskId>` join**: hook-captured transcripts attach
   to the task's conversations without moving memory capture into executors
   (capture stays hook-based; result stays executor-provided).
4. **Wrap, don't shrink the chat loop**: `ChatLoopExecutor` implements
   `HarnessExecutor` over the existing AgentLoop; the loop thins by losing
   non-chat callers, not by editing it. Synchronous `delegate_task` fast
   path stays (latency-critical; caller holds the turn open) — recorder
   writes terminal `ros_tasks` rows; optional `async:true` creates a queued
   task.
5. **Migration discipline**: additive `0002_ros_tasks.sql`; one revertable
   cutover PR per mechanism (subagents → delegation-recorder → heartbeat →
   mesh); legacy tables dropped only in a final `0003` with backfill
   (`ros_subagent_sessions` → tasks, `ros_delegation_runs` archived); no
   dual-write. Behavior-equivalence tests ported before deleting old engines.
6. **Budget model**: executors report (wire `total_cost_usd`), the runner
   enforces between turns; harness owns intra-turn limits. Budgets in JSONB
   ({maxUsd, maxTokens, maxTurns, maxWallClockMs}).
7. **Runner mechanics**: embedded in core (needs live Router/Workspace/
   Tools/Hooks — subagent-worker precedent); insert+addJob in one txn;
   CAS claim; `awaiting-input`/`pending_message` steer model; startup crash
   sweep; concurrency 4 / poll 2s with env knobs.
8. **`ros_tasks` schema** as drafted (goal, context_refs, acceptance_criteria,
   spec, executor/executor_target, agent_id, origin, parent/chain_depth,
   node_affinity, budget/usage JSONB, status lifecycle, result JSONB,
   session linkage, timestamps), with trims to be settled in the phase 1
   design review (notably the `history` JSONB column's exact contract).
9. **Testing shape**: shared HarnessExecutor conformance suite run against
   every executor; PG-gated integration tests (repo convention); live smoke
   script with a $0.10 budget cap.

Discarded from the draft: the assumption that tools + heartbeat are the only
task consumers (no gateway/RivetHub awareness), and its executor list
(claude-cli only; we need grok + hermes as first-class peers).

## The Node Gateway (new, phase 1)

Grow `services/den-server` (already WS fanout + PTY + static) into the
single authenticated per-node surface, serving RivetHub web at :80/:443:

- **Events** — den-protocol WS stream, filterable by session/task/agent.
- **Sessions** — chat: create/send/stream. Desktop/web chat goes through the
  normal channel→turn pipeline (a `gateway` channel), so memory capture,
  routing, and streaming behave exactly like Telegram — RivetHub is *in*
  RivetOS, not beside it.
- **Tasks** — create/list/steer/kill over `ros_tasks`, incl. acceptance
  criteria and budgets; proxied creation with `node_affinity` for any mesh
  node (shared Postgres makes any gateway a dispatch point for all nodes).
- **Terminal** — existing PTY endpoint + "escalate to terminal"
  (`claude --resume <session>`, generalizing the Android Termux trick).
- **Catalog** — this node's agents, harness×model×effort matrix (incl. the
  local fleet via hermes), skills, MCP servers — read from boot discovery so
  the UI can't drift from runtime reality. Effort selection is new (not in
  the Android app); it rides the task spec's `effort` field.
- **Mesh** — node inventory + health.
- **Harness commands** — passthrough + discovery. Any `/`-prefixed chat
  input not claimed by RivetOS's explicit command list passes verbatim to
  the harness session and executes there (claude-cli supports slash
  commands in `-p`; verify grok/hermes in the executor audit).
  `HarnessExecutor` grows `listCommands()` returning a manifest (name,
  description, arg hints, source); the catalog serves the merged
  RivetOS+harness manifest per agent, so RivetHub's slash-menu
  autocomplete always reflects what the bound harness actually supports.
  Live argument completion (paths, PR numbers) is full-fidelity in
  terminal mode via the PTY; chat mode gets manifest-driven completion
  with escalate-to-terminal as the bridge.
- Auth: per-gateway token (Android ControlServer X-Rivet-Token pattern);
  WireGuard assumed for transport.

## RivetHub Desktop / Web (new phase)

Tauri shell around a web UI the gateway also serves plain (phone browser
included — ends the APK sideload treadmill for the interface layer; the
Android app remains for device-node duties). Three modes, one data model:

- **den mode** — embed `apps/den` (PixiJS) as-is.
- **chat UI** — the new surface; multi-agent, per-conversation
  harness/model/effort picker fed by the catalog (Assistants-style
  per-agent bindings ported from the Android fork).
- **terminal mode** — xterm.js over the gateway PTY; any chat/task
  escalates into it carrying its session.

Seamless switching = all modes render the same (session, task, event
stream) IDs. Node switcher across gateways. Later: conversation history
browse/search view (backed by memory + phase 3 wiki), then voice (WebRTC)
— the last two items on the channel-deprecation parity checklist.

## Architecture principles (apply to every phase)

Domain-driven, boundary-enforced monorepo. Bounded contexts:

- **tasks** — engine, `ros_tasks`, executors (HarnessExecutor implementations)
- **memory** — store, search, compaction, topic wiki
- **interfaces** — gateway API + RivetHub clients (web/desktop/android)
- **mesh** — node registry, identity, liveness
- **chat runtime** — loop, sessions, channels (thin, shrinking)

Rules:

1. Contracts live in `@rivetos/types` (and `den-protocol` for events);
   `HarnessExecutor`, `TaskSpec`, gateway API types all land there.
2. Domain packages never import runtime, plugins, or each other's
   internals — they communicate through contracts and the (session, task,
   event) primitives.
3. UIs speak only the gateway API. No RivetHub client imports a RivetOS
   runtime package; a shared `packages/gateway-client` (typed client over
   the gateway contract + den-protocol) is the sole bridge. This is what
   keeps web/desktop/android honest as three clients of one surface.
4. Enforced in CI via Nx `enforce-module-boundaries` tags (set up in
   phase 0 while the deletion pass touches everything), not convention.

## Monorepo consolidation

RivetHub moves into this repo:

- `apps/rivethub-web` — the UI the gateway serves at :80/:443
- `apps/rivethub-desktop` — thin Tauri shell around rivethub-web
- `apps/rivethub-android` — the existing Kotlin/Compose fork imported from
  `philbert440/rivet-android`; Gradle-built, colocated for versioning and
  atomic protocol changes rather than Nx integration
- `packages/gateway-client` — shared typed API client (web+desktop; the
  Android app implements the same contract in Kotlin)

**License boundary:** rivethub-android is a RikkaHub fork → **AGPL-v3**.
Mixed licenses per-package are fine in a monorepo, but the boundary must be
explicit: `LICENSE` at the app root, no code flows from the AGPL subtree
into permissively-licensed packages (our packages → android is fine).
Relevant to the open-source-LTS goal; document in the root README.

## Phases

- **Phase 0 — deletion pass** (~a week, mechanical): remove `review-loop.ts`
  (intent → phase 3), `coding-pipeline`, mesh secret auth, plugin shims;
  fix `.d.ts`-in-src; unify the three MCP implementations into one library
  with thin mounts; add Nx module-boundary tags per the architecture
  principles above.
- **Phase 1 — task engine + gateway**: `ros_tasks` + runner + executors
  (`chat-loop`, `claude-cli`, then `grok-cli`/`hermes-cli` on the same
  conformance suite) per the kept ultraplan sequence; den-server → Gateway
  with auth, catalog, session (gateway channel), task, and mesh endpoints.
  One design doc first — this migrates the working May-2026 graphile
  cutover and deserves review before code.
- **Phase 2 — evaluation**: acceptance criteria required at creation;
  adversarial verifier pass on completion (refute-then-retry-then-escalate;
  escalation goes to Telegram until RivetHub push exists); structured
  outcomes scoreboard as a gateway endpoint + RivetHub panel.
- **Phase 3 — memory wiki** (parallelizable with 2): compaction stage
  extracts topic pages (current state + dated history + provenance links),
  git-backed in `/rivet-shared`, served via the gateway; wired into context
  injection and task creation; hybrid search stays as fallback.
- **Phase 4 — RivetHub Desktop/Web**: `apps/rivethub-web` + Tauri shell,
  chat UI, den embed, terminal mode, catalog-driven settings, node
  switcher; `packages/gateway-client`; import `rivet-android` into the
  monorepo (license boundary documented); then history search and push
  notifications; voice last.
- **Phase 5 — slim the shell**: delete providers superseded by the three
  executors (keep anthropic-API + openai-compat-local for the chat loop,
  vllm/llama-server/ollama as hermes backends); CLI diet; deprecate
  telegram/discord/voice-discord **only when** the RivetHub parity
  checklist (voice, mobile/AFK chat with push, history organize+search) is
  green.

## Open questions (for the phase 1 design doc)

- `ros_tasks.history` contract for steerable multi-turn tasks — keep, or
  lean entirely on `session_key` conversations?
- Gateway channel vs. `AgentChannelServer` — merge the HTTP agent channel
  into the gateway, or keep separate ports/certs?
- grok-cli and hermes-cli executor capability gaps vs. claude-cli
  (session resume? stream-json? cost reporting?) — audit before committing
  the conformance suite.
- Gateway auth story beyond a static token (per-device tokens? mTLS reuse
  from the mesh CA?).
- :80/:443 binding — gateway runs as unprivileged user today; capability
  grant, reverse proxy, or high port + WireGuard DNS?
