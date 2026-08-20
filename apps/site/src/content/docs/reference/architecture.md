---
title: Architecture
sidebar:
  order: 2
description: RivetOS as a harness-first per-node control plane
---
> **Harness-first node OS.** RivetOS is a per-node control plane for coding harnesses.
> The harness owns the coding loop. Rivet owns sessions, identity, capture/memory,
> den, mesh, tasks, and the gateway contract.
>
> Last updated: 2026-08-09 (Phase 5 docs rewrite: harness control plane as product frame;
> preserves accuracy from the #453 staleness sweep).
>
> Product plan: [plans/harness-control-plane.md](https://github.com/philbert440/rivetOS/blob/main/docs/plans/harness-control-plane.md).
> Engineering file map: [CODEBASE-REFERENCE.md](https://github.com/philbert440/rivetOS/blob/main/docs/CODEBASE-REFERENCE.md).
> Hub operator guide: [HUB-SETUP.md](/guides/hub-setup/).

---

## Product thesis

```
Web / Desktop / Android
        │  same gateway contract
        ▼
   Node (den-server + rivetos)
        │  HarnessDriver registry
        ├── claude-code   (reference)
        ├── grok-build
        ├── kimi-code
        └── hermes
        │
   capture → memory     den events → hub dens / chat
```

| Who | Owns |
|-----|------|
| **Harness** (Claude Code, Grok Build, Kimi Code, Hermes) | Coding loop: tools, model turns, approvals UI inside the TUI, interrupt, native session store |
| **Rivet** (this node) | Sessions identity, capture/memory, den, mesh, tasks, gateway HTTP+WS, Hub/Android/desktop clients |
| **Clients** (Hub web, desktop, Android) | Full clients of the **same** gateway, not separate agent runtimes |

**Out of product scope (Phase 0 freeze):** social channels as first-class UX (Telegram, Discord, voice-discord, **removed** in Phase 5); AI-SDK chat as the interactive product loop (AI SDK remains for non-harness / headless / provider plugins only until an optional later ProviderPort extract).

**Not Rivet's job:** re-implementing a coding tool loop that competes with the harnesses.

---

## Design principles

1. **Harness owns the loop**: Interactive coding is the host harness. Rivet adapts, does not replace.
2. **One SessionId, four drivers**: Canonical `<harness-id>:<native-session-id>` everywhere (capture, den, hub, tasks, gateway). No dual key schemes.
3. **Honest capability flags**: Drivers advertise what is actually wired. Unsupported methods return typed `capability_unsupported` (HTTP 501). UIs gate on flags.
4. **Domain-Driven Design**: Core domain is pure business logic. No framework dependencies, no I/O, no platform specifics. Plugins adapt the outside world to the domain.
5. **Clean Architecture**: Dependencies point inward. Core knows nothing about Telegram, Discord, PostgreSQL, or Anthropic. Plugins know about core, never the reverse.
6. **Stability over features**: LTS releases. A working version stays working.
7. **Own every line**: Apache 2.0 licensed. No CLA, no dual-licensing. Fork-friendly. Patent grant included.
8. **Boring technology**: TypeScript, Node.js, Nx. No experiments in the foundation.
9. **Example-driven extensibility**: Core plugins and the Claude harness driver are the reference. Adding a driver or plugin should be obvious from reading an existing one.
10. **Container-first deployment**: The container IS the product. Security via isolation, not sandboxing.
11. **Source-based updates**: Pull source → rebuild from source tree (plugins included) → restart. Forks and custom plugins are first-class citizens.

---

## System overview: control plane

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         RivetOS Node                                     │
│                                                                          │
│  Clients: RivetHub web · RivetHub desktop · Android                      │
│       │ gateway HTTP + WS  (bearer)                                      │
│       ▼                                                                  │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  den-server gateway                                                │  │
│  │  GET  /api/harnesses                                               │  │
│  │  WS   /api/harnesses/ws[?harness=…]                                │  │
│  │  POST /api/harnesses/:id/sessions  ·  GET …/sessions               │  │
│  │  GET|POST /api/harness-sessions/:enc … turns/interrupt/approvals   │  │
│  │  WS   /api/harness-sessions/ws?session=<enc>                       │  │
│  │  POST /api/uploads                                                 │  │
│  │  + den, term, files, wiki, tasks, mesh surfaces                    │  │
│  └────────────────────────────┬───────────────────────────────────────┘  │
│                               │ HarnessDriver registry                   │
│       ┌───────────┬───────────┼───────────┬───────────┐                  │
│       ▼           ▼           ▼           ▼           │                  │
│  claude-code  grok-build  kimi-code    hermes        │                  │
│  (reference)  PtyHarnessDriver subclasses            │                  │
│       │           │           │           │           │                  │
│       └───────────┴─────┬─────┴───────────┘           │                  │
│                         ▼                             │                  │
│              term manager + on-disk stores            │                  │
│              den AgentEvent ingest                    │                  │
│                         │                             │                  │
│       ┌─────────────────┼─────────────────┐           │                  │
│       ▼                 ▼                 ▼           │                  │
│   capture hooks    memory (postgres)   den rooms      │                  │
│   SessionId keys   task_id join        hub dens/chat  │                  │
│                                                       │                  │
│  Boot (rivetos)  — config, plugins, tasks, mesh,      │                  │
│                    gateway registration, workers      │                  │
│                                                       │                  │
│  Secondary path (non-product interactive):            │                  │
│    AI-SDK providers · headless tools · agent channel  │                  │
│    Removed (Phase 5): Telegram / Discord / voice     │                  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Ownership split

### What the harness does

- Run the model and tool loop inside its own process (TUI or headless `-p`).
- Mint and persist native session ids in its own store (`~/.claude/projects`, `~/.grok/sessions`, `~/.hermes/state.db`, `~/.kimi-code/sessions`).
- Surface permission prompts inside its own TUI (none of the four PTY drivers expose approvals on the den wire today).
- Honor interrupt (Esc through the term manager) and resume flags when the binary supports them.

### What Rivet does

| Concern | Mechanism |
|---------|-----------|
| **Sessions** | `HarnessDriver` registry; list / start / resume / get; room ↔ native maps where needed |
| **Identity** | `SessionId` parse/format; alias store for rotation; gateway path encoding (`enc` = unpadded base64url) |
| **Capture / memory** | Per-harness capture plugins → postgres under canonical `SessionId`; task association via `task_id` |
| **Den** | AgentEvent ingest, room state, viewer, mesh den discovery |
| **Mesh** | `mesh.json` registry, heartbeat, cross-node delegation |
| **Tasks** | `harness-session` executors keyed by harness id; catalog honesty |
| **Gateway** | HTTP+WS surface all clients share; uploads staging |

### What clients do

RivetHub (web + Tauri desktop) and Android are **remote faces of the node**. They bind per session: if a registered driver claims the row, chat streams and sends through the harness control plane; otherwise a legacy path may still apply for unclaimed rows. No client runs an on-device agent loop for the product path.

---

## Four harness drivers

Contract types live in `@rivetos/types` (`harness.ts`, `harness-session-id.ts`).
Implementations live under `services/den-server/src/harness/`. All four are thin
subclasses of `PtyHarnessDriver`. Claude (`claude-code`) is the **reference**
driver; the others match the same interface.

| HarnessId | Store | startSession | Rotation | Live stream notes | Task executor |
|-----------|-------|--------------|----------|-------------------|---------------|
| `claude-code` | `~/.claude/projects` | yes (pins via `--session-id`) | no | den events; thinking as spinner status lines | yes (`@rivetos/provider-claude-cli`, target `claude-code`) |
| `grok-build` | `~/.grok/sessions` | yes | no | real `agent_thought_chunk` → `reasoning-delta` | explicit rejection (ACP path recorded, not wired node-side) |
| `hermes` | `~/.hermes/state.db` | **unsupported** (no pin flag) | **yes** (first rotating driver) | full den mapping | explicit rejection |
| `kimi-code` | `~/.kimi-code/sessions` | **unsupported** (no pin flag) | room re-spawn only; native id does not rename | lifecycle + tools + turn boundaries; **no** assistant/reasoning deltas (hooks carry none) — text from `transcript()` | yes (`@rivetos/harness-kimi-code`, headless `kimi -p`) |

### Capability flags (as wired)

Flags reflect what is actually available on the node, not aspirations:

| Flag | All four when den terminals + event tap present | Notes |
|------|--------------------------------------------------|-------|
| `interrupt` | true if terminals enabled | Esc via term manager inject |
| `resume` | true if terminals enabled | `--resume` / `--session` through spawn-or-get |
| `approvals` | **false** for all four | TUI-local only; `resolveApproval` → 501 |
| `liveStream` | true if den event tap present | kimi stream is thinner (see above) |
| `listSessions` | true | store scan |

All four reject `cwd`/`model` on `startSession` (roster-owned) and attachments on
`sendUserTurn` with `capability_unsupported`. A PTY paste cannot hand a file to
a TUI. Upload staging (`POST /api/uploads`) exists for clients; no PTY driver
consumes staged URIs yet.

**Adoption vs start:** `hermes` and `kimi-code` cannot pin a new native id, so
`startSession` is unsupported. Sessions enter the plane by roster/term spawn or
`resume`, and the driver **adopts** them when hooks announce a native id
(`harnessSession` on den events). That is a harness limitation, not a contract gap.

### Session identity

```
SessionId = <harness-id> ":" <native-session-id>
```

- Split on the **first** colon only; native may contain `:` and `/`.
- Examples: `claude-code:a1b2…`, `grok-build:<uuid>`, `kimi-code:session_<uuid>`, `hermes:YYYYMMDD_HHMMSS_<hex>`.
- Gateway path params use `enc(SessionId)` = **unpadded base64url** of the UTF-8 SessionId.
- Capture key: `ros_conversations.session_key` = exact `SessionId` (with `agent`).
- Legacy shapes (bare uuid, Claude path-fallback) resolve as **aliases** on the read path; write-side full canonicalization is still landing (see plan).
- **Rotation:** driver emits `session-updated` with `previousSessionId`; control plane stores alias, re-keys live subscriptions, retires old id from `listSessions`. Hermes is the real rotating customer; capture writes a durable breadcrumb (`metadata.kind='session-rotation'`). Registry aliases are in-memory; the breadcrumb is the durable link across restarts.
- **Tasks:** harness spawns write under canonical SessionId + `ros_conversations.task_id`; `Memory.getTaskHistory` unions by `task_id` **or** legacy `session_key = 'task:<id>'`. `RIVETOS_SESSION_KEY=task:<id>` write override is deprecated (still honored for in-flight deploys).

Full normative rules: [plans/harness-control-plane.md](https://github.com/philbert440/rivetOS/blob/main/docs/plans/harness-control-plane.md) § Session identity.

### Gateway surface (as built)

den dispatches by literal path prefixes (no dynamic segments). Contract names map as:

| Contract name | As built |
|---------------|----------|
| `GET /harnesses` | `GET /api/harnesses` |
| (one driver) | `GET /api/harnesses/:harnessId` |
| `GET /harnesses/:id/events` | `WS /api/harnesses/ws[?harness=<id>]` |
| `POST /harnesses/:id/sessions` | `POST /api/harnesses/:harnessId/sessions` |
| `GET /harnesses/:id/sessions` | `GET /api/harnesses/:harnessId/sessions` |
| `GET /sessions/:sessionId` | `GET /api/harness-sessions/:enc` |
| `POST …/resume` | `POST /api/harness-sessions/:enc/resume` |
| `POST …/turns` | `POST /api/harness-sessions/:enc/turns` |
| `POST …/interrupt` | `POST /api/harness-sessions/:enc/interrupt` |
| `POST …/approvals/:requestId` | `POST /api/harness-sessions/:enc/approvals/:requestId` |
| `GET …/transcript` | `GET /api/harness-sessions/:enc/transcript` |
| `GET …/events` | `WS /api/harness-sessions/ws?session=<enc>` |
| `POST /uploads` | `POST /api/uploads?name=<filename>[&mime=<type>]` |

**Why `/api/harness-sessions` not `/api/sessions`:** `/api/sessions` is owned by the gateway chat channel handler. **Why WS on query string:** upgrade mounts match exact paths.

**Stream continuity:** `subscribe` is an at-most-once live tail from attach time, no replay. Clients hard-resync from transcript on every (re)connect.

### Clients on the plane

- **Hub chat** (`apps/rivethub-web`): per-session bind via `@rivetos/gateway-client`; harness rows stream on harness WS; unclaimed rows keep legacy gateway chat. Capability-gated Stop; approvals false today. See [HUB-SETUP.md](/guides/hub-setup/).
- **Desktop**: Tauri v2 shell over the same Hub dist.
- **Android**: Kotlin re-implementation of the same semantics (`HarnessControlPlaneClient`, etc.); no on-device agent loop. Uploads UI and `session-created` fast path deferred.

---

## Clean architecture layers

The plugin/domain split remains the internal structure of the runtime. The **product** path no longer bottoms out at "channel → provider → AgentLoop" for interactive coding; that stack is the secondary / headless path.

```
┌────────────────────────────────────────────────────────┐
│  Clients (Hub web · desktop · Android)                 │
│  gateway-client / Kotlin harness client                │
├────────────────────────────────────────────────────────┤
│  Node gateway + HarnessDriver registry (den-server)    │
│  sessions · identity · uploads · den · term · files    │
├────────────────────────────────────────────────────────┤
│  Host harnesses (external processes)                   │
│  claude · grok · kimi · hermes                         │
├────────────────────────────────────────────────────────┤
│                    Plugins (Adapters)                  │
│                                                        │
│  Providers (headless / AI SDK)   Memory    Tools       │
│  Anthropic  Google  xAI …        Postgres  Shell …     │
│  claude-cli (also task executor)           MCP Client  │
│                                                        │
│  Channels (see Deprecation below)                      │
│  Agent (mesh, kept) · Telegram · Discord · Voice       │
│                                                        │
│  Transports — mcp-server                               │
│                                                        │
│  All plugins implement core interfaces.                │
│  All plugins are replaceable.                          │
│  None are imported by core.                            │
├────────────────────────────────────────────────────────┤
│                  Application Layer                     │
│                                                        │
│  Boot         — composition root, YAML config,         │
│                  manifest.register(ctx) per plugin     │
│  Runtime      — compositor, registration, lifecycle    │
│  TurnHandler  — AI-SDK / channel message turns         │
│                  (secondary path)                      │
│  CLI          — rivetos start/stop/status/doctor/…     │
│  Tasks        — harness-session + chat-loop executors  │
│                                                        │
│  This layer composes domain + plugins.                 │
│  It is the only layer that knows concrete types.       │
├────────────────────────────────────────────────────────┤
│                    Domain Layer                        │
│                                                        │
│  Agent Loop   — secondary path: message → LLM → tools  │
│  Router       — inbound message → agent → provider     │
│  Workspace    — load/inject workspace files            │
│  Queue        — message ordering, command intercept    │
│  Hooks        — composable pipeline (before/after)     │
│  Delegation   — intra-instance agent-to-agent          │
│  Mesh Deleg.  — cross-instance delegation via HTTP     │
│  Subagent     — child session management               │
│  Skills       — skill discovery and matching           │
│  Heartbeat    — periodic scheduling                    │
│  Safety       — shell danger, workspace fence, audit   │
│  Reconnect    — exponential backoff (channels)         │
│  Auto-Actions — post-tool automation (format, lint)    │
│  Sessions     — session lifecycle and history          │
│  Mesh         — multi-agent mesh registry + discovery  │
│  Tasks        — task engine, executor registry         │
│                                                        │
│  Pure logic. No I/O. Depends only on interfaces        │
│  defined in @rivetos/types.                            │
├────────────────────────────────────────────────────────┤
│                     Types Layer                        │
│                                                        │
│  HarnessDriver, HarnessEvent, SessionId, HarnessId     │
│  Provider, Channel, Tool, Memory, Workspace            │
│  Message, ToolCall, InboundMessage, OutboundMessage    │
│  AgentConfig, RuntimeConfig, StreamEvent, HookConfig   │
│  DeploymentConfig, MeshNode, MeshRegistry              │
│  GatewayRoute, gateway-api wire types                  │
│  Task records, wiki, skills, subagent, errors          │
│                                                        │
│  Interfaces + error classes. One workspace dep:        │
│  @rivetos/den-protocol (the den event contract).       │
│  Every other package depends on this.                  │
└────────────────────────────────────────────────────────┘
```

**Dependency Rule:** Every arrow points inward. Plugins depend on types. Domain depends on types. Application depends on domain + types. **No plugin depends on `@rivetos/core`.** Providers reach the shared AI SDK adapter through `@rivetos/aisdk`.

**What `boot` declares in `package.json`.** Five workspace packages (beyond `types`/`core`) are listed as direct dependencies of `boot`: `@rivetos/provider-claude-cli`, `@rivetos/memory-postgres`, `@rivetos/den-server`, `@rivetos/workflows`, and `@rivetos/harness-kimi-code` (the kimi task executor). A default install therefore always materializes them. That declaration is about *installation*, not registration: `boot` imports specific symbols from them (the workflow engine, `WikiIndex`, the claude-cli task executor, the den server), while the claude-cli provider and the memory-postgres backend, which are also plugins, are still registered the same way as every other plugin, through discovery and `manifest.register()`.

---

## Domain model

### Core concepts

```
Harness      — external coding host (claude-code | grok-build | kimi-code | hermes)
SessionId    — canonical <harness-id>:<native-session-id>
Driver       — per-node HarnessDriver adapting store + den + term to the contract
Agent        — named identity with provider/workspace (secondary path + mesh identity)
Turn         — one user message → one assistant response (harness-native or AgentLoop)
Session      — sequence of turns under one SessionId (or channel session key on legacy path)
Workspace    — markdown files defining personality and context
               Core: CORE.md, USER.md, WORKSPACE.md, MEMORY.md
               Extended: CAPABILITIES.md
Transcript   — permanent, append-only record (postgres + harness on-disk stores)
Mesh         — fleet of RivetOS instances that discover and delegate
Task         — scheduled/on-demand work unit; harness-session executor spawns a host CLI
Den          — live room visualization of harness activity via AgentEvent protocol
```

### Value objects

```
Message      — { role, content, toolCalls?, toolCallId? }
ToolCall     — { id, name, arguments }
ContentPart  — TextPart | ImagePart (multimodal support)
InboundMessage  — platform-normalized incoming message (channel path)
OutboundMessage — platform-normalized outgoing message (channel path)
EditResult   — { primary, overflow[] } for multi-message edits
HarnessEvent — assistant-delta | reasoning-delta | tool-use | tool-result |
               approval-request | approval-resolved | session-created |
               turn-complete | error | session-updated
```

### Aggregates

```
HarnessDriver registry — owns drivers, alias store, live subscription re-key
AgentLoop    — owns a single secondary-path turn. Created per turn, not shared.
               Holds: abort controller, steer queue, iteration count.
               Pure: takes interfaces, returns result. No I/O of its own.

Router       — owns agent→provider mapping. Stateless lookup.

Workspace    — owns file loading and system prompt construction.
               Cacheable. Invalidated on file change or explicit clear.

FileMeshRegistry — owns mesh node registration, heartbeat, pruning.
               File-based (mesh.json), syncs across peers.
```

---

## Interactive lifecycle (primary: harness)

```
1. Client (Hub / Android / desktop) opens or resumes a SessionId
2. Gateway resolves harness-id → driver; alias-resolves superseded ids
3. Client subscribes: WS /api/harness-sessions/ws?session=<enc>
4. Client hard-resyncs: GET …/transcript (source of truth after any gap)
5. User turn: POST …/turns { text, attachments? }
   a. Driver rejects if turn_in_flight or capability_unsupported
   b. Term manager injects into harness PTY (or executor spawns headless -p)
6. Harness runs its own loop (tools, model, TUI approvals)
7. Den hooks emit AgentEvents → driver maps to HarnessEvent → WS fanout
8. Capture plugin appends under SessionId (and task_id if set)
9. Interrupt: POST …/interrupt → Esc inject (when capability true)
10. On rotation (hermes / room re-spawn): session-updated + alias; subscription follows
```

Notice: Rivet never runs the coding tool loop for these sessions. It routes, identifies, captures, and fans out.

---

## Message lifecycle (secondary: channel + AI SDK)

> Used for headless provider turns, mesh agent channel, heartbeats, and
> **deprecated** social channels. Not the product interactive path.

```
1. Channel (plugin) receives inbound message
2. Runtime (application) passes to Router (domain)
3. Router determines: which agent? which provider?
4. Turn Handler creates a turn:
   a. Execute turn:before hooks
   b. Build system prompt from Workspace (domain)
      — Loads CORE.md, USER.md, WORKSPACE.md, MEMORY.md
      — Optionally CAPABILITIES.md for extended context
   c. Resolve attachments via Media module
   d. Create AgentLoop (domain) for this turn:
      i.   Send messages + tools to Provider (plugin) via chatStream()
      ii.  Stream text chunks to channel as they arrive
      iii. If tool calls → execute via Tool (plugin) → append results → go to (i)
      iv.  Check AbortSignal between iterations (/stop)
      v.   Check steer queue between iterations (/steer)
      vi.  Max iteration limit prevents runaway (safety cap)
   e. Execute turn:after hooks
5. Turn Handler sends response back via Channel (plugin)
6. Turn Handler appends user message + response to Memory (plugin)
```

The domain layer never touches I/O. It works with interfaces. The application layer (Turn Handler) wires real plugins to domain logic.

---

## Monorepo structure

```
rivetOS/
  README.md
  CHANGELOG.md
  CONTRIBUTING.md
  .env.example
  docs/
    ARCHITECTURE.md              ← this file (design-oriented, for contributors)
    HUB-SETUP.md                 ← RivetHub + gateway operator guide
    CODEBASE-REFERENCE.md        ← engineering reference (file-by-file)
    MEMORY-DESIGN.md
    DEN.md
    plans/
      harness-control-plane.md   ← product + as-built control plane
  infra/
    containers/
      rivetos/                   ← Unified runtime image — built once, dispatched via `--role`
      DATA-PERSISTENCE.md
    docker/
      rivetos/                   ← canonical stack (datahub + migrate + agent + 2 workers)
      mcp-stack/
    scripts/
    templates/
  .github/workflows/
    pipeline.yml                 ← secrets-scan → ci → (publish-npm, containers) → notify-ops
  packages/
    types/                       ← interfaces; one workspace dep (den-protocol)
      src/
        harness.ts               ← HarnessDriver, HarnessEvent, HARNESS_IDS
        harness-session-id.ts    ← parse/format/enc/dec SessionId
        gateway.ts · gateway-api.ts
        provider.ts · channel.ts · tool.ts · memory.ts · …
        task.ts · mesh.ts · wiki.ts · skill.ts · subagent.ts
    core/                        ← domain + application layer
    boot/                        ← composition root
      src/
        registrars/
          plugins.ts             ← manifest-driven loader
          hooks.ts
          agents.ts              ← delegation / subagent / skills / mesh
          gateway.ts             ← embedded den/gateway + harness registry wiring
    cli/
    aisdk/                       ← AI SDK ↔ RivetOS adapter (secondary path)
    workflows/
    wiki-core/
    den-protocol/
    den-packs/
    gateway-client/              ← typed HTTP+WS client (Hub)
    harness-kimi-code/           ← headless kimi-code task executor
    mcp/ · mcp-v2/
    nx-plugin/
  plugins/
    channels/
      agent/                     ← mesh agent-to-agent (social channels removed Phase 5)
    providers/                   ← headless / AI-SDK interactive demotion
      anthropic/ google/ xai/ ollama/ vllm/ llama-server/
      claude-cli/                ← provider + claude-code task executor
    memory/postgres/
    tools/   shell/ file/ search/ web-search/ interaction/ mcp-client/
    transports/mcp-server/
  services/
    den-server/
      src/harness/               ← registry, PtyHarnessDriver, four drivers, routes, uploads
    embedding-worker/            ← graphile-worker daemon (GPU embeddings)
    compaction-worker/           ← graphile-worker daemon (summarization + wiki)
    mcp-sidecar/
  apps/
    rivethub-web/                ← RivetHub (primary UI)
    rivethub-desktop/            ← Tauri shell over hub dist
    rivet-android/               ← remote client
    den/                         ← den viewer SPA
    site/                        ← Astro docs site
  integrations/                  ← capture + den hooks per harness (claude-code, grok, kimi, hermes)
```

Every plugin directory includes a README.md that serves as documentation AND a guide for writing your own. The reference plugins ARE the documentation.

Skills are not part of the source tree. They are user-managed and live under the runtime workspace (default `~/.rivetos/workspace/skills/`). See [Skills](/guides/skills/).

**Container roles:** the unified `rivetos` image accepts `--role agent | migrate` only. Datahub is upstream `pgvector/pgvector:pg16`; there is no custom datahub image. Flag `--role` wins over env `RIVETOS_ROLE` (env seeds; flag overwrites). An invalid `RIVETOS_ROLE` is rejected at startup, failing loudly (`unknown role`, exit 1) rather than silently booting an agent.

**Workers** are separate long-running processes (Compose profile `workers` or systemd), not "Datahub services". They pull jobs from a Postgres-backed graphile-worker queue (INSERT triggers + crons), not LISTEN/NOTIFY.

---

## Plugin interfaces

### HarnessDriver: control-plane contract (primary)

```typescript
export const HARNESS_IDS = ['claude-code', 'grok-build', 'kimi-code', 'hermes'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export type SessionId = `${HarnessId}:${string}`;

export interface HarnessDriver {
  readonly harnessId: HarnessId;
  readonly capabilities: HarnessCapabilities;

  startSession(opts?: StartSessionOpts): Promise<SessionSummary>;
  resumeSession(sessionId: SessionId): Promise<SessionSummary>;
  interrupt(sessionId: SessionId): Promise<void>;
  sendUserTurn(sessionId: SessionId, turn: UserTurn): Promise<void>;
  resolveApproval(
    sessionId: SessionId,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  subscribe(sessionId: SessionId, sink: (e: HarnessEvent) => void): () => void;
  subscribeEvents(sink: (e: HarnessEvent) => void): () => void;
  listSessions(): Promise<SessionSummary[]>;
  getSession(sessionId: SessionId): Promise<SessionSummary | null>;
}
```

Gateway and Hub never talk to harness binaries directly, only through drivers.
Reference implementation: `services/den-server/src/harness/claude-driver.ts`.
Shared suite: `harness/test/driver-conformance.ts` (rotation).

### Provider: talks to an LLM (secondary / headless)

```typescript
interface Provider {
  id: string;
  name: string;
  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk>;
  chat?(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
  getModel(): string;
  setModel(model: string): void;
}
```

The primary method is `chatStream()`. Providers power the AI-SDK AgentLoop path,
heartbeats, and some task/chat-loop executors, **not** Hub interactive coding
sessions (those are harness-owned).

Reference implementation: `plugins/providers/anthropic/`

### Channel: receives and sends messages

> **Deprecated for product interactive UX (Phase 0).** Telegram, Discord, and
> Social channel plugins were removed in Phase 5; Hub is the human UX path.
> installs keep working, but they are not first-class product surface. Do not
> invest in feature parity. Removal is a Phase 5 prune item.
>
> **Exception:** the **agent** channel (`@rivetos/channel-agent`) stays; it is
> the mesh / inter-agent HTTP surface, not a social bot.

```typescript
interface Channel {
  id: string;
  platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<string | null>;
  edit?(channelId: string, messageId: string, text: string, overflowIds?: string[]): Promise<EditResult | null>;
  react?(messageId: string, emoji: string, channelId: string): Promise<void>;
  startTyping?(channelId: string): void;
  stopTyping?(channelId: string): void;
  onMessage(handler: MessageHandler): void;
  onCommand(handler: CommandHandler): void;
}
```

Key details:
- `send()` takes a full `OutboundMessage` object
- `edit()` supports overflow: returns `EditResult` with primary + overflow message IDs
- Message splitting, typing indicators, and platform limits are the channel's responsibility

Reference implementation: `plugins/channels/agent/` (mesh). Social channels removed in Phase 5.

### Tool: an action the agent can take

```typescript
interface Tool extends ToolDefinition {
  execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolContext,
  ): Promise<ToolResult>;
}
```

Tools extend `ToolDefinition` (name, description, parameters JSON schema). The
`signal` parameter enables abort propagation. `context` provides workspace path,
agent name, etc.

Reference implementation: `plugins/tools/shell/`

### Memory: persistent storage and retrieval

```typescript
interface Memory {
  append(entry: MemoryEntry): Promise<string>;
  search(query: string, options?: { agent?: string; limit?: number; scope?: 'messages' | 'summaries' | 'both' }): Promise<MemorySearchResult[]>;
  getContextForTurn(query: string, agent: string, options?: { maxTokens?: number }): Promise<string>;
  getSessionHistory(sessionId: string, options?: { limit?: number }): Promise<Message[]>;
  getTaskHistory?(taskId: string, options?: { limit?: number }): Promise<Message[]>;
  saveSessionSettings?(sessionId: string, settings: Record<string, unknown>): Promise<void>;
  loadSessionSettings?(sessionId: string): Promise<Record<string, unknown> | null>;
}
```

`getContextForTurn()` builds a context window within a token budget.
`getTaskHistory` (where implemented) unions conversations by `task_id` or legacy
`task:<id>` session keys. Session settings persistence is optional.

Reference implementation: `plugins/memory/postgres/`
Schema: `plugins/memory/postgres/src/schema/migrations/` (source of truth).
Workers: `services/embedding-worker/`, `services/compaction-worker/`.

### Transport: exposes RivetOS over an inbound protocol

Transports have no `core` interface; each opens its own listening surface.
`manifest.register(ctx)` binds the surface and registers shutdown via
`ctx.registerShutdown()`. Use `ctx.onRegistrationComplete()` to enumerate tools
after every other plugin has registered.

Reference implementation: `plugins/transports/mcp-server/`

### Plugin manifest contract

Every plugin's `index.ts` exports a `manifest: PluginManifest`:

```typescript
export const manifest: PluginManifest = {
  type: 'provider',           // 'provider' | 'channel' | 'tool' | 'memory' | 'transport'
  name: 'anthropic',          // must match `package.json#rivetos.name`
  async register(ctx) {
    // ctx.config, ctx.pluginConfig, ctx.env, ctx.workspaceDir, ctx.logger
    // ctx.registerProvider | registerChannel | registerTool | registerMemory
    // ctx.registerHook | ctx.registerShutdown
    // ctx.lateBindTool(name) · ctx.onRegistrationComplete(snapshot => ...)
  },
}
```

Boot's `registrars/plugins.ts` walks every discovered `package.json#rivetos`
descriptor, dynamic-imports the package, validates `manifest.type/name`, and
calls `manifest.register(ctx)`. One manifest-driven loader handles every plugin type.

---

## Routing model

### Primary: harness routing

Client or task supplies `SessionId` (or bare native id on legacy UI keys) →
gateway / registry resolves harness → driver method. Hub badges harness id on
drawer rows. Bare UUIDs are probed across uuid-shaped stores (claude, then
grok, …); kimi natives are `session_<uuid>` and **must** be sent canonical;
the bare-uuid probe never claims them.

### Secondary: social channel binding, removed in Phase 5

Telegram / Discord / voice-discord plugins are gone. Human messages arrive via
the gateway (Hub clients), not social bots. Stale `channels.discord:` keys in
config warn as unknown channel types and are not registered.

### Inter-agent messaging (local)

Agent channel plugin (`@rivetos/channel-agent`) exposes an HTTP endpoint. Agents
send messages to peers via `delegate_task` or `subagent_spawn`. Incoming agent
messages go through the full secondary pipeline.

### Inter-agent messaging (mesh)

`MeshDelegationEngine` extends delegation across instances. When a
`delegate_task` targets an agent not available locally, the mesh registry finds
the remote node. Delegation is transparent via HTTP to the remote agent channel.

---

## Interrupt model

### Harness path

- Client: `POST /api/harness-sessions/:enc/interrupt` when `capabilities.interrupt`
- Implementation: term manager `inject(..., interrupt)` → Esc into the TUI
- `sendUserTurn` while a turn is in flight rejects with `turn_in_flight` (no silent server queue in v1; Hub may client-queue with backoff)

### Secondary path (AgentLoop)

#### /stop: abort current turn
- Each turn creates an `AbortController`
- `/stop` calls `abort()` on it
- `AbortSignal` passed to Provider `chatStream()`, Tool `execute()`, checked between iterations
- Response: immediate

#### /steer: inject mid-turn context
- Pushes onto the AgentLoop's steer queue
- Seen as a system message on the next tool iteration

#### /new: fresh session
- Aborts active turn (if any)
- Clears in-memory conversation history
- Transcript in postgres is unaffected

#### Why this works
AbortController is synchronous signal propagation. When you say stop, the fetch
call is cancelled mid-flight.

---

## Hook system

Composable async pipeline with priority ordering (0-99):

**Lifecycle events:** `provider:before`, `provider:after`, `provider:error`,
`tool:before`, `tool:after`, `turn:before`, `turn:after`, `turn:reflect`,
`skill:before`, `skill:after`, `session:start`, `session:end`, `compact:before`,
`compact:after`, `delegation:before`, `delegation:after`

**Built-in hooks (wired via boot registrars):**
- **Safety hooks**: Shell danger blocker (P10), workspace fence (P15), custom rules (P20), audit logger (P90)
  - Audit logger appends to `<workspace>/.data/audit/<date>.jsonl`. No rotation or retention:
    audit logs accumulate indefinitely; operators prune manually.
- **Auto-actions**: Post-tool format/lint/test/git-check (opt-in)
- **Session hooks**: Daily context loading, session summaries, auto-commit, pre/post-compact

Harness-side hooks (claude/grok/kimi/hermes den + memory integrations) are
**outside** this pipeline; they feed den AgentEvents and capture, not the AI-SDK hook bus.

---

## Tasks

The task engine's `harness-session` registry is keyed by **harness id**
(`claude-code | grok-build | kimi-code | hermes`).

| Target | Status |
|--------|--------|
| `claude-code` | Implemented (headless `claude -p`); `claude-cli` accepted as **deprecated alias** for one deploy window |
| `kimi-code` | Implemented (`@rivetos/harness-kimi-code`, stream-json + wire usage reconcile) |
| `grok-build` | Explicit rejecting executor (`capability_unsupported` + reason); ACP noted as future path |
| `hermes` | Explicit rejecting executor (cannot pin session for spawn-for-task) |

`GET /api/catalog` exposes `harnessId` + `implemented` so UIs grey traps.
Env contract for real executors: `RIVETOS_TASK_ID` set, inherited
`RIVETOS_SESSION_KEY` **deleted**, capture stamps `task_id` at conversation create.

---

## Memory and capture

- Capture plugins (under `integrations/*/rivet-memory`) write under canonical `SessionId` where possible.
- Mesh-shared DB: disambiguate by `agent` column; native id entropy is the collision defense.
- Hermes rotation: alias + breadcrumb (not close+new). Predecessor stays open until true session end.
- Compaction / embedding: graphile-worker jobs from SQL triggers and crons in the worker packages, not LISTEN/NOTIFY.
- Wiki extraction lives on the compaction-worker task set.

See [MEMORY-DESIGN.md](/reference/memory-design/).

---

## Den

rivet-den is the live pixel-art diorama of a harness session. Lifecycle hooks
translate agent activity into the den-protocol; den-server reduces events into
room state; the viewer (and Hub dens page) renders the room.

- Protocol: `packages/den-protocol`
- Server: `services/den-server`
- Packs: `packages/den-packs`
- Product overview: [DEN.md](https://github.com/philbert440/rivetOS/blob/main/docs/DEN.md)

Default bind is loopback; set host + token for LAN. Mesh discovery via
`GET /mesh.json` projects den-enabled roster entries (`capabilities` includes
`den`, or `metadata.denPort` / `metadata.denUrl`).

---

## Configuration

YAML with `${ENV_VAR}` resolution. API keys always via environment variables.

```yaml
runtime:
  workspace: ~/.rivetos/workspace
  default_agent: opus
  max_tool_iterations: 75

agents:
  opus:
    provider: anthropic
    default_thinking: medium
  grok:
    provider: xai

providers:
  anthropic:
    model: claude-sonnet-4-6
  xai:
    model: grok-4-1-fast-reasoning

# Social channels removed Phase 5. Human UX: RivetHub / gateway.
# Optional agent mesh channel (not social UX):
channels:
  agent:
    port: 3100
    secret: ${RIVETOS_AGENT_SECRET}

memory:
  postgres:
    connection_string: ${RIVETOS_PG_URL}

# Optional: containerized deployment
# Only `target` is consumed at runtime — nested datahub/image/docker keys
# are rejected as unknown by validation.
deployment:
  target: docker                    # or proxmox, kubernetes, manual

# Headless harness executors without a provider plugin (e.g. kimi-code)
# tasks:
#   harnesses:
#     kimi-code:
#       binary: kimi
#       cwd: /path/to/work
```

`target` is the only key consumed at runtime under `deployment:`; provisioning
is driven by Compose under `infra/docker/` and scripts under `infra/scripts/`.

Den / gateway env (selection): `RIVETOS_DEN_HOST`, `RIVETOS_DEN_TOKEN`,
`RIVETOS_DEN_STATIC_DIR` (hub-first when hub dist is built), upload caps/TTL.

---

## Deployment model

### Container-first architecture

RivetOS ships as container images built from source. The container IS the
security boundary; agents can only touch what is inside their container.

**Data persistence:** Containers are stateless. All persistent data lives on the host via bind mounts and named volumes:
- `./workspace/` or `~/.rivetos/workspace/` → agent workspace files
- `rivetos-pgdata` → PostgreSQL data
- `rivetos-shared` → shared storage (`/rivet-shared/`)
- `.env` → API keys and secrets
- `~/.rivetos/config.yaml` → runtime configuration
- Host harness home dirs (`~/.claude`, `~/.grok`, `~/.hermes`, `~/.kimi-code`) → native session stores

**Update model:** Pull source → rebuild containers from source tree → restart.
Plugins live in the source tree and survive updates automatically.

### Deployment targets

| Target | Implementation | Use Case |
|--------|---------------|----------|
| Docker | Docker Compose (`infra/docker/`) | Desktop, single-server, getting started |
| Proxmox | LXC + `infra/scripts/provision-ct.sh` | Homelab, multi-node |
| Manual | systemd + `npm install` | Bare-metal, custom setups |

Compose stack: `datahub` (upstream pgvector) + `migrate` + `agent` + optional
`workers` profile (embedding + compaction). Only migrate waits on datahub
healthy; agent and workers wait on migrate success.

---

## Multi-agent mesh

Multiple RivetOS instances form a mesh for cross-instance collaboration:

- **Registry:** File-based `mesh.json` with heartbeat and pruning
- **Discovery:** Seed nodes or mDNS-based auto-discovery
- **Delegation:** transparent routing; `delegate_task` checks local agents first, then mesh peers
- **Join flow:** `rivetos init --join <host>` discovers existing datahub and registers with the mesh
- **Fleet updates:** `rivetos update --mesh` rolls updates across mesh nodes with health checks
- **Den mesh:** den-enabled nodes advertise den port/url for multi-node dens

Sessions remain **node-local** uniqueness (`SessionId` on one node). Mesh
addresses sessions as `{nodeId, sessionId}` only if needed later, not required today.

When documenting mesh peers, use hostnames or documentation address space
(e.g. `192.0.2.0/24`), never lab private inventory IPs in committed docs.

---

## Deprecated surfaces (Phase 0 → Phase 5)

| Surface | Status | Guidance |
|---------|--------|----------|
| Telegram channel | **Deprecated** | Keep section/config for existing installs; no new features; remove when prune lands |
| Discord channel | **Deprecated** | Same |
| voice-discord | **Removed (Phase 5)** | Package deleted |
| AI-SDK interactive as product loop | Demoted | Headless / provider plugins only |
| `claude-cli` task executor target name | Deprecated alias | Prefer `claude-code` |
| `RIVETOS_SESSION_KEY=task:<id>` write override | Deprecated | Use `RIVETOS_TASK_ID` + capture association |
| Provider plugins for Hub coding UX | Demoted | Harness drivers own interactive coding |

**Still first-class:** agent channel (mesh), memory, MCP, den, gateway, four harness drivers, Hub/Android/desktop, tasks.

---

## LTS strategy

- **main** branch: current development
- **lts/X.Y** branches: frozen releases
  - Security patches and bug fixes only
  - No new features, no breaking changes
  - Maintained for 12 months minimum
- Semantic versioning: MAJOR.MINOR.PATCH

---

## Related docs

| Doc | Role |
|-----|------|
| [plans/harness-control-plane.md](https://github.com/philbert440/rivetOS/blob/main/docs/plans/harness-control-plane.md) | Product plan + full As-built driver notes |
| [HUB-SETUP.md](/guides/hub-setup/) | Build and point RivetHub at a node |
| [CODEBASE-REFERENCE.md](https://github.com/philbert440/rivetOS/blob/main/docs/CODEBASE-REFERENCE.md) | File-level map (#453 accuracy baseline) |
| [DEN.md](https://github.com/philbert440/rivetOS/blob/main/docs/DEN.md) | Den product / protocol entry |
| [GETTING-STARTED.md](/guides/getting-started/) | Install paths |
| [DEPLOYMENT.md](/guides/deployment/) | Docker / Proxmox / bare-metal |
| [MEMORY-DESIGN.md](/reference/memory-design/) | Memory system design |
| [CONFIG-REFERENCE.md](/reference/config/) | Config keys |
