# AGENT.md — RivetHub (web + desktop)

> Continuity for any Rivet picking this up. Desktop is a thin Electron shell over this app.

## What this is

**RivetHub** = the node’s face. React (Vite) UI in `rivethub-web`; **Electron** shell in `rivethub-electron` bundles the same dist (tray, shortcuts, notifications, loopback mTLS pipe). Replaced the Tauri shell 2026-08-28 — shell detection is `window.rivetShell` first (`src/lib/shell-bridge.ts`), legacy `__TAURI__` shapes kept for the Android WebView shim.

- Served by den-server as static root when `static_dir` points here; den viewer nested at `/den/` (`scripts/copy-den.mjs`).
- Talks to RivetOS gateway (`@rivetos/gateway-client`, `@rivetos/types`).
- Seamless modes: chat inject → harness PTY → den events → `bridgeAgentEvent` → sessions WS.

## Status (2026-07-10)

### Sidebar pages (2026-07-10)
Rail: Conversations (`/`), Terminal, Den — separator — Memory, Files, Tasks, Workflows — Settings. "Conversations" is the rail label only — the per-conversation toggle stays [Terminal | Chat | Den].

- **Terminal** (`/terminal`) lands on the node's open-PTY list (click to attach); the tab bar remains the quick switcher.
- **Den** (`/dens`) lists the node's live den sessions (`GET /api/events/sessions` → `gateway.denSessions()`), embedded viewer iframe on pick. Replaced the old `/den/` link-out.
- **Memory** (`/memory`, `/memory?tab=wiki|browse|stats`, `/memory/$slug`) = hub: **Search / Wiki / Browse / Stats**. Wiki tab is the existing encyclopedia over datahub `GET /api/wiki`. Search/Browse/Stats hit datahub `GET /api/memory/*` (same origin resolution). Hits deep-link Conversations via `/?session=`. Datahub origin in Settings (`rivethub.wikiUrl`); blank → mesh-discover datahub. Stored `http://lan-host` (no port) is rewritten to `https://lan-host:5174` — implicit `:443` made the desktop mTLS pipe connection-refused.
- **Dropdowns** use `Select` (Radix Popover) — not native `<select>` (WebKitGTK paints OS menus). Matches Model/Effort/Node pickers.
- **Tasks** (`/tasks`, `/tasks/$taskId`) = list/filter, detail (steer/kill), and **in-UI create** (goal + agent from catalog local+mesh + optional criteria lines → `POST /api/tasks`; navigates to detail). Create is no longer chat-only.
- **Workflows** (`/workflows`, `/workflows/$workflowId`) = defs list + trigger form. When the def is under the files root (`editPath`), Run mode is a flows **authoring** workbench: palette (Agent / Script / Gate / Parallel / Call / Done), wire ports, Save compiles to `workflow.yaml` + `run.ts` + `agents/` + `scripts/` + `flows.json`. Script nodes are `step.run` (deterministic, no tokens). File editor remains under Edit. Run detail Graph uses the same canvas (`flows.json` layout when present) with a journal status overlay (pending dim, running/gate pulse, failed red). Call nodes with a journaled `childRunId` drill into the child run (double-click or inspector).

### Flows canvas compile semantics

- **Agent Instructions** (`node.prompt`) write to `agents/<stem>.md` — that markdown body is the engine **system prompt** (`AgentDef.prompt` in `packages/workflows/src/loader.ts` / `types.ts`). The same text is also emitted as `step.agent({ prompt })`, the per-invocation **user/task message**. The host executor concatenates system + user into the task goal (`packages/core/src/domain/workflows/agent-executor.ts`). Label is only the fallback when Instructions are empty.
- **`step.done`** takes explicit output. Compile accumulates each step result onto `__rivetOutputs` (seeded from `ctx.input`) and reads declared output fields from that record — matching hand-authored recipes (`workflows/hello-world/run.ts`, `packages/workflows/src/scaffold.ts`).
- **`flows.json.owned`** lists canvas-owned `agents/` and `scripts/` paths. Save prunes only those previously owned paths that the new compile no longer emits (never a full directory wipe). Skip prune when `run.ts` lacks the `@generated` marker.
- First save of a def that already has a non-trivial outline (no `flows.json` yet) warns: the canvas linearizes that outline into `run.ts`.
- **Workflows IR v2** (`src/lib/workflows/v2/`) = nested DAG types + `validateWorkflowV2` (no reach-through, Map quorum, Loop maxIterations, gate predicates). Rules: `v2/VALIDATION.md`. Export: `workflowsV2` from `lib/workflows`. No executor yet.
- **Files** (`/files`) = full browser for the node's files root (`/rivet-shared` default): list/filter/sort, multi-select, text/image preview, mkdir/rename/delete, copy path/URL, DnD upload (current dir or onto a folder), drag row onto folder to move. Server: den-server `src/files.ts` (`list|download|upload|mkdir|rename|delete`, path+symlink fenced, 1 GiB upload cap, no-clobber unless `overwrite=1`, recursive delete opt-in); config `den.files_root` / `RIVETOS_DEN_FILES_ROOT` ('' disables).
- **Node-switch den trap fixed in boot**: default den static_dir is hub-first (`apps/rivethub-web/dist` when built, else den viewer) — peers without an explicit `static_dir` used to serve full-screen den at `/` with no way back.

### Harness control plane binding (2026-08-08)

Chat now speaks the node's harness control plane
(`docs/ARCHITECTURE.md`) for sessions a registered driver owns —
`claude-code` today. Two bindings, one surface, chosen per session:

| | control plane | legacy (unclaimed harnesses) |
|---|---|---|
| list | `GET /api/harnesses/:id/sessions` | `/api/terminal/harness-sessions` scan |
| stream | `WS /api/harness-sessions/ws?session=<enc>` | all-sessions WS bridge frames |
| history | transcript hard-resync on every (re)connect | server-pushed transcript deltas |
| send | `POST …/turns` (`sendUserTurn`) | `POST /term/inject` into the PTY |

The drawer unions both lists keyed by native id (plane wins) and badges the
harness id. `useChat.harnessBound` is the mutex: a bound session is ignored by
the all-sessions socket, because the same den events reach both surfaces.

Key files: `lib/harness-chat.ts` (merge + capability gate + `turn_in_flight`),
`lib/harness-attach.ts` (subscribe + resync lifecycle), `lib/harness-fold.ts`
(HarnessEvent → LiveTurn), `components/harness-approval-card.tsx`.

Gotchas: the live tail is **at-most-once from attach time** — every
`onStatus('open')` must be followed by a transcript resync, never a resume of
folding. `claude-code` reports `approvals: false` always, so the approval card
never shows there; `interrupt` follows whether den terminals are enabled. Chat
keys stay the bare native id (the den join key); the canonical `SessionId`
rides on the drawer item and is what the control-plane calls use.

### Chat resync from TUI (Android parity)
**Auto on open:** opening a conversation (and returning Chat←Terminal/Den) pulls
`GET /api/terminal/harness-sessions/:id/transcript` and hard-replaces the chat
transcript from the on-disk store (claude/grok/hermes). Skips while a live turn
is streaming. Ring/memory backfill only if the store is empty.
**Manual:** header ↻ → confirm → same path, forces refetch even mid-live.
Store: `useChat.replace`.

### Track 1 — Rich chat — **shipped** (PR #329)

| Area | State |
|------|--------|
| Transcript | react-markdown + GFM; fenced code copy; assistant full-width + nerd line |
| Live turn | multi-entry tool stack + reasoningText + human titles |
| Bridge tools | optional summarized `args` on tool.start; key-name + value-pattern redact |
| Ask chips | stick through `done` until live clear / user pick (headless ask path) |
| Tests | pure unit tests under `src/lib/*.test.ts` |

Residual: Hermes/claude-cli adapters may still omit tool args; chips degrade cleanly.

### Track 3 — Working send queue + ask card

- **`turn.end` den event (protocol v1 additive):** den-hook emits it at Stop
  (grok's detached `--flush` pass emits it after the late text); the bridge
  flushes the assistant message + emits `done` there. Before this, `done` only
  fired at session.end, so the live bubble never cleared and the queue
  deadlocked after the first streamed reply.
- **Queue pump:** post-inject latch poll (6s) replaces the 400ms settle —
  the next queued turn only auto-injects at a real turn boundary. Stale-turn
  release (120s, no frames, no running tool, content-bearing turns, ONLY when
  something is queued) covers any harness that never bridges done (Hermes now emits turn.end on post_llm_call, so this is a generic backstop) —
  generous because the bridge is block-granular for claude (long no-tool
  generations are silent).
- **inject** on a queued bubble = interrupt-inject: `/term/inject
  {interrupt:true}` writes Esc (behind the paste/CR serialization watermark —
  never between a prior turn's paste and its CR), waits 400ms for the TUI
  cancel redraw, then pastes. **cancel** recalls the text into the composer
  (ComposerHandle.prepend).
- **Ask card** (`ask-user-card.tsx`) replaces suggestion chips: structured
  `extractAskUserQuestions` (question/header/description/multiSelect), stashed
  in `useChat.ask` when the turn ends so it survives the live clear; cleared on
  user echo / send / dismiss / hard resync. Single-select answers on click;
  multi-select / multi-question collects then sends `Header: label` lines.

### Track 2 — Hub-as-node navigation — **shipped** (PR #330, seamless remote in #378)

- All shells (browser, Tauri, Android WebView): `performNodeSwitch` → `switchTo` — **always repoint** the gateway; local/bundled dist stays put (never navigate to a peer’s served UI)
- Android drawer: deep-link `http://127.0.0.1:5174/?node=<denUrl>` → `applyBootNodeParam` (repoint + roster; preserves per-node token when `?token=` absent)
- Wired in sidebar `NodeSwitcher` + composer `NodePicker`
- Den embed at Chat | Terminal | Den and `/den/` preserved

### Theming — light mode

- Preference `rivethub.theme` = `light | dark | system` (default system) in
  localStorage; pure helpers in `src/lib/theme.ts`, zustand binding + DOM
  application (`data-theme` on `<html>`, meta theme-color) in
  `src/stores/theme.ts`. Inline boot script in `index.html` mirrors the
  resolve logic so the first frame is already themed — keep them in sync.
- Token sets live in `src/theme.css`: dark stays the `@theme` default; the
  `html[data-theme='light']` block overrides (unlayered beats `@layer theme`).
  Light is paper/ink, emerald shifted to #059669 for contrast.
- Non-CSS surfaces track the resolved theme: xterm reads live tokens
  (`xterm-attach.tsx`), CodeMirror via `lib/editor-theme.ts` + a Compartment,
  flows canvas via `canvasSceneColors(theme)` in `lib/workflow-runs/flow-overlay.ts`.
  Settings has the Light / Dark / System toggle.

## How to run / build

```sh
# web
npx nx build @rivetos/rivethub-web   # also builds den into dist/den/

# desktop (after web dist)
cd apps/rivethub-electron && npm install && npm run dist   # or: npm run dev
```

## Key files

- `src/pages/chat.tsx` — seamless session, terminal/den modes, queue pump
- `src/memory/` — Search / Browse / Stats hub (TenPAL back-port)
- `src/pages/memory.tsx` — wiki encyclopedia (Wiki tab + `/memory/$slug`)
- `src/pages/tasks.tsx` — list + create form + detail
- `src/lib/task-create.ts` — criteria lines + agent options (local+mesh)
- `src/lib/wiki-base.ts`, `wiki-client.ts` — datahub origin, mesh discovery, `[[slug]]`
- `src/stores/wiki-settings.ts` — datahub origin (not iframe URL)
- `src/components/transcript.tsx`, `composer.tsx`, `ask-user-card.tsx`, `wiki-markdown.tsx`
- `src/lib/fold-stream.ts`, `tool-titles.ts`, `ask-user.ts`, `switch-mode.ts`, `gateway-url.ts`
- `src/stores/chat.ts` — WS fold, LiveTurn
- `src/stores/connection.ts`, `components/node-switcher.tsx`, `pickers/node-picker.tsx`
- Core bridge: `packages/core/src/domain/gateway-channel.ts` (`bridgeAgentEvent`)

## MicBridge (host mic → node)

Design: `docs/MICBRIDGE.md`. den-server opt-in `RIVETOS_DEN_AUDIO=1` exposes
`GET /api/audio` + `WS /api/audio/mic` (s16le PCM). Path A uses a rootless
`pw-record` shim (`services/den-server/scripts/micbridge-phase0/`) so Grok
voice sees a recorder without `/dev/snd`. **Hub capture client is Phase 2**
(global Ctrl+Space → stream to active node). Gateway helper: `audioMicWsUrl()`.

## Gotchas

- Tauri origin is not http(s) — desktop starts unconfigured until a node is set.
- Seamless chat uses harness inject, not only `postMessage` chat-loop.
- Headless CLI ask-tools don’t block; the ask card's pick = next user turn (Android pattern).
- CI secrets scan blocks real lab `10.4.x` IPs in tests — use `192.168.1.x`.
- Tool `args` on sessions WS: `summarizeBridgeArgs` / den-hook `summarizeToolInput` run every string through value-pattern `redact()` (Bearer/sk-/AKIA/gh_/JWT + key=value) then length-cap — not just secret-named keys.
- `isValidGatewayUrl` is origin-only (no userinfo/path/query/hash) to block poisoned roster open-nav.
