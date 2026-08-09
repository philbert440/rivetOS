---
title: Harness Control Plane
status: proposed
date: 2026-08-08
owner: rivet
audience: implementers
---

# Harness Control Plane

**RivetOS is a per-node control plane for coding harnesses.** Each node (den-server + rivetos) hosts drivers for Claude Code, Grok Build, Kimi, and Hermes. The harness owns the coding loop (tools, model turns, approvals, interrupt). Rivet owns sessions, identity, capture/memory, den, mesh, tasks, and the gateway contract. Web, desktop, and Android are full clients of that same gateway—not separate agent runtimes. Social channels are out of product scope; the AI SDK remains for non-harness paths only until a later ProviderPort extract.

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

---

## Phase 0 — Product freeze

| Decision | In scope | Out of scope |
|----------|----------|--------------|
| Primary interactive agents | Host harnesses: `claude-code`, `grok-build`, `kimi-code`, `hermes` | AI-SDK chat as product loop |
| Primary UIs | Hub web, desktop, Android → per-node gateway | Channel bots as first-class UX |
| Loop ownership | Harness owns coding loop | Rivet re-implementing harness tool loop |
| Rivet ownership | Sessions, identity, memory/capture, den, mesh, tasks, gateway | Harness-internal model routing |
| AI SDK | Non-harness / headless / provider plugins only | Driving interactive harness UX |
| Channels (Telegram, Discord, voice-discord) | Deprecate now; remove in Phase 5 | Feature parity or new channel work |
| Memory + MCP + capture | First-class for all four harnesses | Rewriting capture onto AI SDK |
| Provider plugins | Optional / headless | Interactive product path |
| Architecture | Incremental god-file splits as touched | Full DDD core split before harness plane works |

---

## HarnessDriver interface (contract)

**This is the control-plane contract.** All harnesses implement it. **Claude (`claude-code`) is the reference implementation**—formalize existing `claude-cli` + den `harness-sessions` against this interface; other drivers match it.

```typescript
/** Left half of SessionId. Fixed product tokens. */
export const HARNESS_IDS = ['claude-code', 'grok-build', 'kimi-code', 'hermes'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/** Canonical identity: `<harness-id>:<native-session-id>` */
export type SessionId = `${HarnessId}:${string}`;

export type HarnessCapabilities = {
  interrupt: boolean;
  resume: boolean;
  approvals: boolean;
  liveStream: boolean;
  listSessions: boolean;
};

export type ApprovalDecision = 'allow' | 'deny' | 'allow-session';

export type HarnessEvent =
  | { type: 'assistant-delta'; sessionId: SessionId; text: string; turnId?: string }
  | {
      /** Thinking text for the turn in flight — text only, because what a
       *  harness can observe of its own thinking varies (spinner status lines
       *  vs. real thinking blocks). Presentation is the client's call. */
      type: 'reasoning-delta';
      sessionId: SessionId;
      text: string;
      turnId?: string;
    }
  | {
      type: 'tool-use';
      sessionId: SessionId;
      toolCallId: string;
      name: string;
      input: unknown;
      turnId?: string;
    }
  | {
      type: 'tool-result';
      sessionId: SessionId;
      toolCallId: string;
      name: string;
      output: unknown;
      isError?: boolean;
      turnId?: string;
    }
  | {
      type: 'approval-request';
      sessionId: SessionId;
      requestId: string;
      toolCallId?: string;
      name: string;
      input: unknown;
      reason?: string;
    }
  | {
      /** Broadcast to ALL subscribers so multi-client UIs clear stale prompts. */
      type: 'approval-resolved';
      sessionId: SessionId;
      requestId: string;
      decision: ApprovalDecision;
    }
  | {
      /** Emitted on the driver-level registry stream for any new/discovered session. */
      type: 'session-created';
      sessionId: SessionId;
      summary: SessionSummary;
    }
  | {
      type: 'turn-complete';
      sessionId: SessionId;
      turnId?: string;
      /** 'end-turn' | 'interrupted' | 'error' | harness-specific string */
      stopReason?: string;
    }
  | {
      type: 'error';
      sessionId: SessionId;
      code: string;
      message: string;
      retryable?: boolean;
    }
  | {
      type: 'session-updated';
      sessionId: SessionId;
      /** Set when native id rotates; see Session identity § Rotation. */
      previousSessionId?: SessionId;
      status: 'active' | 'idle' | 'ended' | 'error';
    };

export type SessionSummary = {
  sessionId: SessionId;
  harnessId: HarnessId;
  title?: string;
  cwd?: string;
  createdAt: string; // ISO
  updatedAt: string;
  status: 'active' | 'idle' | 'ended' | 'error';
};

export type StartSessionOpts = {
  cwd?: string;
  model?: string;
  /**
   * Pin a pre-minted native id for a BRAND-NEW session (e.g. task executors
   * that mint the id before spawning). Never attaches to an existing session:
   * if the native id already exists in the harness store, fail with
   * `session_id_collision`. Attaching to an existing session is
   * `resumeSession` only.
   */
  nativeSessionId?: string;
  metadata?: Record<string, string>;
};

export type UserTurn = {
  text: string;
  attachments?: Array<{ mime: string; pathOrUri: string; name?: string }>;
};

/** Per-node driver. Gateway/hub never talk to harness binaries directly. */
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
  /** Live stream; return unsubscribe. Gateway may fan-out. */
  subscribe(sessionId: SessionId, sink: (e: HarnessEvent) => void): () => void;
  /**
   * Driver-level registry stream (`session-created` / `session-updated` across
   * ALL of this driver's sessions) — backs `GET /harnesses/:id/events`.
   */
  subscribeEvents(sink: (e: HarnessEvent) => void): () => void;
  listSessions(): Promise<SessionSummary[]>;
  getSession(sessionId: SessionId): Promise<SessionSummary | null>;
}
```

**Gateway surface (Phase 2)** — names are the contract; HTTP vs den RPC follows existing den-server patterns:

| Endpoint (conceptual) | Behavior |
|-----------------------|----------|
| `GET /harnesses` | Drivers + capability flags |
| `GET /harnesses/:id/events` (WS upgrade) | Driver-level registry stream (`session-created` / `session-updated`) so hub session lists live-update instead of polling |
| `POST /harnesses/:id/sessions` | `startSession` |
| `GET /harnesses/:id/sessions` | `listSessions` |
| `POST /sessions/:sessionId/resume` | `resumeSession` |
| `POST /sessions/:sessionId/turns` | `sendUserTurn` |
| `POST /sessions/:sessionId/interrupt` | `interrupt` |
| `POST /sessions/:sessionId/approvals/:requestId` | `resolveApproval` |
| `GET /sessions/:sessionId` | `getSession` |
| `GET /sessions/:sessionId/events` (WS upgrade) | `subscribe` stream |
| `GET /sessions/:sessionId/transcript` | Hard-resync source (generalizes den's `/term/harness-sessions/:id/transcript`) |
| `POST /uploads` | Stage a remote client attachment; returns a node-local URI for `UserTurn.attachments` |

This table is the Phase 2 sketch — names are the contract; transports and any end/delete route follow existing den-server patterns when implemented.

### Contract semantics (normative)

- **Capability flags gate methods.** Calling a method whose capability flag is `false` MUST reject with typed error code `capability_unsupported`; the gateway maps it to HTTP 501. UIs gate on flags and treat the rejection as non-fatal.
- **`resolveApproval` with an unknown/expired `requestId`** rejects with `unknown_approval`.
- **`sendUserTurn` while a turn is in flight** rejects with `turn_in_flight` (drivers MUST NOT silently queue in v1).
- **`session_id_collision`** is a typed error code (see collision rules), not just prose.
- **Stream continuity:** `subscribe` is an **at-most-once live tail from attach time** — no replay buffer and no sequence numbers in v1. After a WS drop, clients re-`subscribe` and MUST hard-resync missed history from the transcript source of truth — den already exposes this today (`GET /term/harness-sessions/:id/transcript`); the gateway generalizes it per harness. Mid-turn deltas lost during the gap are recovered from the transcript, never re-emitted live.
- **Alias resolution is control-plane-owned.** The gateway/control plane resolves superseded ids to canonical BEFORE dispatch, for every driver method and for `subscribe`. Drivers only ever see canonical ids and never consult the alias store.
- **Subscriptions survive rotation.** An active subscription follows the alias chain: the rotation `session-updated` is delivered on the existing subscription and subsequent events simply carry the new `sessionId`. Clients never need to re-subscribe on rotation.
- **`listSessions` returns canonical ids only.** Superseded ids never appear; rotation ends the old id's lifecycle (the control plane records the old id as ended when it stores the alias).
- **`allow-session` scope:** all future invocations of the same tool `name` within that session. Nothing broader.
- **Session status `idle`** = session alive, no turn in flight; drivers emit `session-updated` on active↔idle transitions.
- **Remote attachments:** `UserTurn.attachments[].pathOrUri` must be node-resolvable. Remote clients (web/desktop/Android) stage files through a gateway upload endpoint that returns a node-local URI — attachments are never client filesystem paths.
- **Canonical segment encoding:** `enc(SessionId)` = **unpadded base64url of the UTF-8 SessionId**. Used for den resource names AND gateway path params — percent-encoded `/` inside path segments is unreliable across routers/proxies, and legacy Claude keys contain `/`.

---

## Session identity standard

**One canonical format for all four harnesses. Not four conventions.**

### Format

```
SessionId = <harness-id> ":" <native-session-id>
```

| Part | Rules |
|------|--------|
| `harness-id` | Exact enum: `claude-code` \| `grok-build` \| `kimi-code` \| `hermes` |
| Separator | Single `:` between harness id and native id only |
| `native-session-id` | Opaque host string. **May contain `:`** — split only on the **first** colon |
| Encoding | UTF-8. Validate as-is (no silent trimming): leading/trailing whitespace ⇒ invalid; empty native id ⇒ invalid |
| Case | `harness-id` fixed lowercase; native id preserved as emitted |

**Examples:** `claude-code:a1b2c3d4-…`, `grok-build:sess_01HZX…`, `kimi-code:c7f2…-uuid`, `hermes:9b41…-uuid`.

**Native ids MUST be collision-resistant (UUID-class entropy).** The capture store is mesh-shared — multiple nodes write one memory DB, disambiguated by the `agent` column — so key entropy is the cross-node collision defense. Sequential or low-entropy native ids (`thread-42`) are forbidden; ULID/UUIDv7-class k-sortable ids with adequate entropy qualify. A driver wrapping a harness that mints low-entropy ids must namespace them (e.g. suffix a mint-time UUID).

```typescript
function parseSessionId(id: string): { harnessId: HarnessId; nativeSessionId: string } {
  if (id !== id.trim()) throw new Error('invalid SessionId: whitespace');
  const i = id.indexOf(':');
  if (i <= 0 || i === id.length - 1) throw new Error('invalid SessionId');
  const harnessId = id.slice(0, i);
  if (!HARNESS_IDS.includes(harnessId as HarnessId)) throw new Error('unknown harness id');
  return { harnessId: harnessId as HarnessId, nativeSessionId: id.slice(i + 1) };
}
```

### Mapping (single standard → all surfaces)

| Surface | Field | Value |
|---------|-------|--------|
| Canonical | `SessionId` | `<harness-id>:<native-session-id>` |
| Capture (memory DB) | `ros_conversations.session_key` (natural key, with `agent`) | **Exactly** `SessionId`. NOTE: `ros_messages.conversation_id` is an internal UUID FK to `ros_conversations(id)` — never the SessionId |
| Capture plugins | Host label in JSONL | Normalize to `SessionId` before write (no bare native ids) |
| Den harness-session | Resource name | `harness-session/<enc(SessionId)>` where `enc` single-segment-encodes the **full** SessionId (`:` and `/` included — Claude's path-fallback native ids contain `/`); **round-trip recovers the same SessionId**, with tests covering both `:` and `/` |
| Hub chat | Thread external key | `SessionId` (UI may badge harness + short native suffix) |
| Tasks | Executor payload | type `harness-session` + `sessionId: SessionId` |
| Gateway | `:sessionId` param | `enc(SessionId)` — unpadded base64url (see Contract semantics; raw/percent-encoded `/` in path segments is unreliable) |

**Forbidden:** bare native ids in memory/den/hub; alternate prefixes (`claude:`, `cc:`, agent nicknames); dual keys that disagree between capture and den.

### Collision rules

1. **Uniqueness domain:** one node. Mesh addresses sessions as `{nodeId, sessionId}` only if needed later.
2. **Cross-harness:** different `harness-id` ⇒ different sessions even if native ids match.
3. **Same harness:** native ids unique per harness store; on collision return `session_id_collision` — never overwrite. **Requires a real DB constraint:** capture today has no unique index on `(session_key, agent)` and select-then-insert races — the Phase 2 migration adds the constraint and switches the adapter to upsert.
   - **Alias chains occupy the namespace:** a `startSession` native id matching ANY id in an existing alias chain (including rotated-away ids) ⇒ `session_id_collision`. Reused ids never silently merge two sessions into one chain.
4. **Rehydrate:** if capture and den resolve to the same `SessionId` **after alias resolution** (exact string OR legacy-key alias, see Legacy keys below), one session. If only one side exists, create the missing mapping without minting a second id.
5. **No silent remap:** never change `harness-id` on an existing row.

### Resume semantics

| Case | Behavior |
|------|----------|
| `resumeSession(sessionId)` | Parse → driver for `harness-id` → attach to native id. Fail if unregistered/unknown. |
| Client reconnect (WS drop) | Same `SessionId`; re-`subscribe`; no new native session. |
| Hub opens existing chat | Bind by `SessionId`; `resumeSession` if not live-attached. |
| `startSession` | New session, never attach. Without `nativeSessionId`: harness mints a fresh native id. With caller-pinned `nativeSessionId`: id must be fresh; existing ⇒ reject `session_id_collision`. |
| Task executor | Payload carries `SessionId`; resume before send. |

Resume does **not** create a new conversation id. Capture continues under the same `SessionId`.

### Native session id rotation

When a harness rotates/replaces its native id (compact, fork, crash recovery):

1. Driver emits `session-updated` with `sessionId` = **new** canonical id and `previousSessionId` = old.
2. Control plane stores **alias** `previousSessionId → sessionId`. Latest id is canonical.
3. **Memory:** new events write under the **new** `SessionId`; queries resolve alias chain and union transcript history (prefer this over rewriting historical rows).
4. **Hub:** keep chat row; update external key to new id; store previous for deep links.
5. **Den:** rename or symlink `harness-session/<old>` → `harness-session/<new>`.
6. **Gateway:** superseded id redirects (`redirectedTo` / equivalent) to canonical. **Aliases never expire** for reads/redirects/dispatch — "grace period" bounds only how long a driver may legitimately still EMIT under the old id after rotation (at most the in-flight turn); ingest rewrite (rule 10) is permanent behavior.
7. **Never** invent a Rivet-only third id not derived from harness native ids.
8. **Same-harness only:** `previousSessionId` and `sessionId` MUST share the same `harness-id`; drivers never emit cross-harness aliases and the control plane rejects them.
9. **Chain hygiene:** alias resolution always terminates at the newest id; cycle detection required; max chain depth 32 (reject beyond — something is broken).
10. **Ingest rewrite (permanent):** events arriving under a superseded id are rewritten to the canonical id at ingest (single write — no dual-writing); events for an unknown alias are dropped with a logged warning.

> **Phase 3 breaking change (shipped):** hermes capture used to handle rotation as "close old key, open new conversation" with no alias. It now records an alias instead — the predecessor conversation stays open, a durable breadcrumb links it to the successor, and no history is rewritten. See As built (hermes) § Rotation migration story.

### Legacy keys → SessionId (migration aliases)

The repo already holds several key shapes for one interactive session. Phase 2 defines this table as **mandatory alias precedence** — without it, migration mints duplicate conversations:

| Legacy shape | Where | Disposition |
|--------------|-------|-------------|
| `claude-code:<session-uuid>` | Capture (preferred path) | Already canonical — wins over all others |
| `claude-code:<project-slug>/<uuid>` | Capture path-fallback (`deriveSessionKey`) | Alias → `claude-code:<uuid>` once the session uuid is known; uuid form is canonical |
| Bare native uuid | Den drawer, hub chat conversation id | Alias → `<harness-id>:<uuid>`; hub external key updated in place (**done** — see As built (canonical hub keying)) |
| Roster tokens `claude` / `grok` / `hermes` | Den command roster | UI labels only — map to `HarnessId` enum for storage; NEVER stored as key material |
| `task:<taskId>` | Task executors (chat-loop appends; harness spawns, pre-0011) | **Stays a parallel, non-harness conversation-key namespace.** Never parsed as a `SessionId`. No longer a write key for harness spawns — those write canonical and carry `ros_conversations.task_id`; the key remains readable forever through the union (`task_id = <id> OR session_key = 'task:<id>'`) |

Precedence: canonical `<harness-id>:<native-session-id>` > path-fallback alias > bare-uuid alias. Alias resolution applies everywhere rehydrate/merge decisions are made (rule 4 above).

> The `task:<taskId>` mapping is a **bidirectional secondary join key** (two views over one transcript), NOT a rotation-style alias — it does not participate in alias chains, and the legacy→canonical direction convention and chain-hygiene rules do not apply to it.
>
> **Write direction (normative):** harness sessions ALWAYS write capture under their canonical `SessionId` — including task-spawned ones. `task:<taskId>` becomes a query-time join (task association stored per conversation) that unions all of a task's spawned sessions into one transcript view. This replaces today's `RIVETOS_SESSION_KEY=task:<id>` write-key override — a Phase 2 migration item; multi-spawn transcript unity is preserved by the join, not by a shared write key.
>
> **As built:** migration `0011` adds nullable `ros_conversations.task_id`; the claude-cli executor passes `RIVETOS_TASK_ID=<taskId>` (and explicitly clears any inherited `RIVETOS_SESSION_KEY`, which a surrounding den PTY would otherwise leak into the spawn); capture stamps the association at conversation-create time; `Memory.getTaskHistory(taskId)` is the union read, ordered by time and NOT filtered on `active` (a task's finished spawns are exactly what a resume needs). Old rows were not migrated — the union's `session_key = 'task:<id>'` leg covers them, and it also covers the chat-loop executor, which has no harness session of its own and still appends under `task:<id>`. **Deprecation window:** capture still honors a `RIVETOS_SESSION_KEY=task:<id>` override verbatim (logging a deprecation line to `~/.rivetos/claude-capture.log`) so a task in flight across a rolling deploy does not split its transcript. Remove `resolveTaskContext`'s `legacyTaskKey` branch and that log line once no in-flight task predates the change; reads keep working, permanently.

### Reference behavior (Claude)

Existing cli + den `harness-sessions` is the gold standard for attach/stream/interrupt. Phase 2 names those keys `claude-code:<native>` (alias legacy keys) and exposes them only through `HarnessDriver`.

---

## Phase 1 — Hygiene (CI honesty, dead exports)

- [ ] Fix `packages/cli` `"test": "echo no tests yet"` → real `vitest run` (no false-green)
- [ ] Add root `typecheck` to the `ci` pipeline
- [x] Delete or wire dead exports (`rotateAuditLogs`, unused circuit-breaker reset) after verify — both deleted; the core circuit-breaker module went with them (registry was never populated)
- [ ] Drop unused deps after verify — candidates, not pre-verified: `enquirer` (packages/nx-plugin), `sharp` (root override), `@types/pg` (may pair with live `pg` usage — check before dropping)
- [ ] Refresh stale `CODEBASE-REFERENCE` / `ARCHITECTURE` claims
- [ ] CLI `showHelp()` completeness vs actual commands

**PR order:** (1) CI honesty → (2) dead exports/deps → (3) docs/help as needed.

---

## Phase 2 — Gateway harness API + Claude reference

- [x] Land `HarnessDriver`, `HarnessEvent`, `SessionId` in shared package
- [x] Parse/format helpers, alias store, `enc()`/`dec()` base64url segment codec
- [ ] Capture migration: UNIQUE index on `ros_conversations (session_key, agent)` + adapter upsert (collision rule 3 is unimplementable on today's select-then-insert)
- [x] Task-key migration: replace `RIVETOS_SESSION_KEY=task:<id>` write-override with per-conversation task association + query-time join (see Legacy keys) — 0011 + `RIVETOS_TASK_ID` + `Memory.getTaskHistory`; claude-cli harness-session executor only. Follow-ups: the chat-loop executor keeps appending under `task:<id>` (in-process turns have no harness session of their own — the union reads it), and the `mesh` executor kind has no implementation registered yet; whichever one lands must pass `RIVETOS_TASK_ID` rather than a write-key override
- [x] **`reasoningText` accumulates unbounded in the hub live store** — RESOLVED: capped at REASONING_TEXT_MAX 4096 (sliding window in the shared nextReasoningText hook, den THOUGHT_MAX semantics; live tail only, committed thinking untouched). Original finding: neither `foldStream` nor `foldHarnessEvent` caps thinking accumulation, unlike the den reducer's `THOUGHT_MAX` sliding window (`packages/den-protocol/src/reducer.ts:92-95`). Pre-existing on the legacy path, but `reasoning-delta` now carries the claude-cli executor's real thinking token-streams, so a long turn grows the store without bound. Apply the same sliding-window cap in the shared `nextReasoningText` hook
- [ ] **Interactive path leaks an inherited session key** — `plugins/providers/claude-cli/src/claude-cli-model.ts:448` calls `spawnClaudeTurn(flags, cliContent)` with no env opts, so a core launched inside a den PTY passes that terminal's `RIVETOS_SESSION_KEY` into every interactive `claude -p` turn and capture files them into the den chat's conversation. Same class as the task-executor leak fixed alongside 0011 (there the executor explicitly deletes the inherited key); this path has no task id to substitute, so the fix is to decide per call whether the den session is genuinely the conversation or the key should be dropped
- [x] Gateway upload endpoint for remote attachments (returns node-local URI) — `POST /api/uploads`; no driver consumes a staged URI yet (see Attachment staging)
- [x] Driver-level registry stream (`session-created`) wired to `GET /harnesses/:id/events`
- [x] Driver registry on node boot
- [x] **Claude reference driver** over claude-cli + den harness-sessions
- [x] Migrate Claude keys to `claude-code:<native>` — **read side only**: the gateway resolves legacy shapes (bare uuid, `claude-code:<slug>/<uuid>`) to canonical before dispatch
- [ ] Migrate Claude keys to `claude-code:<native>` — **write side**: capture still writes the legacy shapes; pairs with the two capture rows above
- [x] Gateway: list harnesses, open/list/resume, turns, interrupt, approvals, event stream
- [ ] Capture writes canonical `SessionId` only
- [x] Tests: first-colon parse, resume, alias redirect, `enc()`/`dec()` round-trip (ids containing `:` and `/`), typed `invalid_session_id` → HTTP 400 at the gateway

### As built (node control plane)

`services/den-server/src/harness/` — the registry, the `claude-code`,
`grok-build` and `hermes` drivers, the `PtyHarnessDriver` base they share, and
the routes all live in den-server because that is where the machinery they
formalize already is (term manager, the harnesses' on-disk stores, den
AgentEvent ingest). Boot registers all three built-ins by starting the gateway;
the remaining Phase 3 driver passes through
`registerGateway(..., harnessDrivers)`.

Mounted paths — this table is authoritative for what shipped:

| Contract name | As built |
|---------------|----------|
| `GET /harnesses` | `GET /api/harnesses` |
| — (added) | `GET /api/harnesses/:harnessId` — one driver's capability sheet |
| `GET /harnesses/:id/events` | `WS /api/harnesses/ws[?harness=<id>]` |
| `POST /harnesses/:id/sessions` | `POST /api/harnesses/:harnessId/sessions` |
| `GET /harnesses/:id/sessions` | `GET /api/harnesses/:harnessId/sessions` |
| `GET /sessions/:sessionId` | `GET /api/harness-sessions/:enc` |
| `POST /sessions/:sessionId/resume` | `POST /api/harness-sessions/:enc/resume` |
| `POST /sessions/:sessionId/turns` | `POST /api/harness-sessions/:enc/turns` |
| `POST /sessions/:sessionId/interrupt` | `POST /api/harness-sessions/:enc/interrupt` |
| `POST /sessions/:sessionId/approvals/:requestId` | `POST /api/harness-sessions/:enc/approvals/:requestId` (501 for `claude-code`) |
| `GET /sessions/:sessionId/transcript` | `GET /api/harness-sessions/:enc/transcript` |
| `GET /sessions/:sessionId/events` | `WS /api/harness-sessions/ws?session=<enc>` |
| `POST /uploads` | `POST /api/uploads?name=<filename>[&mime=<type>]` — raw body |

Two deviations, both because den has no path router to deviate from:

- **`/api/harness-sessions`, not `/api/sessions`.** den dispatches HTTP by
  matching a request path against a set of literal prefixes, longest first
  (`server.ts`, the `extraRoutes` loop) — there are no dynamic segments
  anywhere. `/api/sessions` is one such opaque prefix, owned entirely by the
  gateway chat channel, which splits sub-paths by hand inside its own handler.
  A second family under that prefix would mean editing the chat channel's
  handler, not registering a route.
- **WS resources ride the query string.** den's upgrade mounts are matched by
  exact path (`/ws`, `/term?id=`, `/api/sessions/ws`,
  `/api/notifications/ws`), so a dynamic `:sessionId` segment has nothing to
  match against.

Capability flags of the built-in drivers, honestly — each is what is ACTUALLY
wired on the node, never an aspiration:

| Flag | `claude-code` | `grok-build` | `hermes` | `kimi-code` | Why |
|------|---------------|--------------|----------|-------------|-----|
| `interrupt` | PTY host resolves | PTY host resolves | PTY host resolves | PTY host resolves | Esc through the term manager's `inject(..., interrupt)`; no PTY, no interrupt. Esc is each TUI's own cancel key — kimi documents it as "Close dialogs / interrupt streaming". **Runtime-truthed**, not read off the config flag: see below |
| `resume` | PTY host resolves | PTY host resolves | PTY host resolves | PTY host resolves | The harness's resume flag through the term manager's spawn-or-get: `--resume <id>` for the first three, `--session <id>` for kimi. Runtime-truthed with `interrupt` — they stand or fall on the same PTY host |
| `approvals` | **false** | **false** | **false** | **false** | All four surface permission prompts inside their own TUI; the den wire carries neither a request nor a decision channel. `resolveApproval` → 501. (A hermes shell hook *can* block a tool call, but that is a policy verdict computed on the node, not a request for a human decision. kimi's `PermissionRequest`/`PermissionResult` hooks are deliberately unmapped for the same reason) |
| `liveStream` | den event tap present | den event tap present | den event tap present | den event tap present | The driver's only live source is den AgentEvent ingest. Honest but uneven in what it can carry: kimi's hooks give it no assistant text and no thinking, so its stream is lifecycle + tools + turn boundaries (see As built (kimi-code)) |
| `listSessions` | true | true | true | true | A store scan: `~/.claude/projects` / `~/.grok/sessions` / `~/.hermes/state.db` / `~/.kimi-code/sessions` |

**Capability runtime truthing (as built).** `interrupt`/`resume` used to be
`!!deps.pty`, which answers a CONFIG question ("are den terminals enabled")
where the contract asks a RUNTIME one ("can this node open a PTY"). A node whose
`node-pty` import failed advertised `true` on `GET /api/harnesses` and answered
501 from the method — the rejection honest, the advertisement optimistic. Now
the declaration is only the starting point and the flags follow the machinery,
in three places (`services/den-server/src/harness/capabilities.ts`):

- **Probe before advertising.** Both capability reads
  (`GET /api/harnesses`, `GET /api/harnesses/:harnessId`) `await
  registry.verifyCapabilities()` first. The driver resolves its PTY host once
  and latches the verdict; `loadRealPtySpawn` memoizes one import attempt and
  returns null forever after, so one probe per process is the whole cost, and
  it is paid at the first moment an optimistic flag could have misled anyone.
- **Lazy-verify for free.** `requirePty` records what every real call observes,
  so the sheet corrects itself on the first method that needed a PTY even on a
  node nobody ever asked for the sheet.
- **Flips surface on the registry stream** as a `harness-capabilities` frame
  (full sheet + the flags that moved + a reason), and attaching to
  `WS /api/harnesses/ws` kicks a probe so a client that only watches the stream
  still learns the truth.

**Contract limit hit, deliberately not crossed:** every member of `HarnessEvent`
carries a `sessionId` — the union is session-scoped by construction, and a
driver-level capability flip has no session to name (fabricating one would be a
worse lie than the flag was). So the flip is a **den-level frame on den's
registry socket**, which already carries non-union frames (the attach error
frame), and the truthing surface itself (`verifyCapabilities` /
`subscribeCapabilities`) is **feature-detected off the driver exactly like
`transcript`** rather than added to `HarnessDriver`. Nothing in
`@rivetos/types` changed. Clients ignore frame types they do not know (the
Android parser maps them to `Unknown`, the web fold has a default case).
Promoting the flip to a `capabilities-changed` member of the union is the
follow-up if another transport ever needs it — and that is a real contract
change, with the version bump it implies.

`liveStream` and `listSessions` are not probed, deliberately: the den tap is a
closure over an in-process Set (`!!deps.events` IS the answer, not a proxy for
it), and `listSessions` is a store scan that reports an empty list rather than
failing. `approvals` is false unconditionally.

All four reject `cwd`/`model` on `startSession` (roster-owned) and attachments
on `sendUserTurn`, with `capability_unsupported` rather than ignoring them
silently. The attachment rejection stands even now that staging exists — a PTY
paste has no way to hand a file to a TUI; see below. `hermes` and `kimi-code`
additionally reject `startSession` outright — neither has a flag to pin a new
session's id, so the control plane cannot name the session it would be
starting.

### As built (`grok-build` driver)

`services/den-server/src/harness/grok-driver.ts` + `grok-store.ts`, registered
at boot next to `claude-code` behind the same gating (`termEnabled` for the PTY
host, the shared den event tap for the stream). It is the same shape as the
reference driver because it wraps the same machinery — the term manager, an
on-disk store, den ingest — and deviates in exactly four places:

- **Store existence is a directory.** grok writes `~/.grok/sessions/<enc-cwd>/
  <uuid>/` before `summary.json`, so a describe miss does not mean the id is
  free and `grok --session-id` refuses an id whose dir exists. The driver has an
  `exists` port over `harnessSessionExists('grok', id)` — the same ground truth
  the term manager uses to pick `--resume` — and uses it for the collision
  check, the resume check, and the re-spawn decision. `describe` stays the
  summary read, and now carries `created_at`, so a list row and a `getSession`
  cannot disagree about `createdAt`.
- **Reasoning is real.** The shared hook translator tails grok's ACP
  `agent_thought_chunk`s out of `updates.jsonl`, so `thinking.delta` carries the
  actual thought tail rather than Claude's spinner status line. Both map onto
  `reasoning-delta`; grok's is the higher-fidelity stream of the two.
- **No legacy key shape.** grok's capture plugin already derives
  `grok-build:<uuid>` — the canonical form — so unlike Claude there is nothing
  to collapse. Native ids are UUIDv7 minted by grok (and required by
  `--session-id`), so nothing needs namespacing either. The bare-uuid shape the
  den drawer and hub chat use is resolved by the registry's probe, which asks
  every registered driver in turn.
- **Its own transcript reader.** `readGrokTranscript` instead of the drawer's
  id-only `readHarnessTranscript`, which probes claude → grok → hermes and
  returns the first hit. A driver already knows which harness owns the id and
  must not serve another store's transcript for it.

Also worth knowing about a two-driver node: a **bare native uuid carries no
harness**, so `registry.resolve` asks each registered driver in turn and
memoizes the first that claims it (`registry.ts`, `bareOwner`). Claude is
probed first, and the memo is permanent for the life of the process. With two
uuid-keyed stores now coexisting, a wrong answer is possible in principle;
with 128 bits of id it is not possible in practice, and the canonical
`<harness>:<uuid>` form — which every client that knows the harness should
send — never goes near the probe.

`grok-build` **does not rotate**. grok can mint a new native id
(`--fork-session`), but nothing on the den wire carries a previous→new pair —
the `PreCompact` hook the rivet-den integration wires emits `thinking.end` +
`activity` and names no ids. So the driver never emits `session-updated` with
`previousSessionId`, and the shared rotation conformance suite
(`harness/test/driver-conformance.ts`) has no `rotate()` to drive, exactly as
for `claude-code`. `grok-driver.test.ts` pins the non-rotation explicitly
instead, and exercises the non-rotating half of the suite's assertions —
canonical dispatch, canonical-only listings, a live tail through
`registry.subscribeSession` — against a real registry. If grok ever surfaces a
fork/compact signal, the suite is the acceptance test for wiring it and nothing
else about the driver has to change: the registry owns re-keying.

Two things the den wire cannot express, recorded rather than faked:
`tool-result.output` is always `null` and `isError` is never set, because den's
`tool.end` carries no result body and collapses `PostToolUse` with
`PostToolUseFailure`; and tool names pass through as grok emits them
(`run_terminal_cmd`, `search_replace`) rather than being renamed to Claude's.

**Follow-ups, both taken at driver three (`hermes`) — see below:**

- ~~The two PTY drivers now share most of a state machine.~~ **Done:**
  `harness/pty-harness-driver.ts`. The third data point arrived and confirmed
  the shape rather than complicating it, so the base was extracted and all
  three drivers are thin subclasses of it. `DenAgentEventLike` moved there and
  `claude-driver.ts` re-exports it.
- ~~`claude-store.ts` still reads through the first-hit-wins
  `readHarnessTranscript`.~~ **Done:** `readClaudeTranscript`, the same
  store-scoping `readGrokTranscript` and `readHermesTranscript` have.

### As built (`hermes` driver) — the first rotating driver

`services/den-server/src/harness/hermes-driver.ts` + `hermes-store.ts`,
registered at boot beside the other two behind the same gating. It is the
acceptance test the rotation gate was built for: `hermes-driver.test.ts` runs
`runHarnessRotationConformance('hermes', …)` against the real driver and a real
registry, and the suite needed **no changes** to accommodate it.

Everything hermes does differently follows from one fact: **it cannot be told
what to call a new session.** `hermes --resume <id>` and `--continue [name]`
both reference an EXISTING session and there is no new-session-with-this-id
flag (`--pass-session-id` only injects the id into the system prompt). So:

- **The den room key is not the native id.** Claude and grok are spawned with
  `--session-id <den session key>`, which is why their two ids are one string
  and why the base's room↔native mapping is the identity function. A hermes
  spawned from the drawer or hub chat runs in a room key den chose while hermes
  mints `20260802_225647_6ad0b9` for itself. The driver keeps a room ↔ native
  map, learned from the den stream: `hermes-den-hook.mjs` now stamps hermes's
  own `session_id` on every event as `harnessSession` (a new optional field on
  `AgentEventMeta` — the room key stays `session`, so nothing that joins on it
  moves). A session the driver resumes itself is spawned into a room *named*
  after the native id, so for those the two coincide again.
- **`startSession` answers `capability_unsupported`.** The alternative — mint a
  uuid, return it, and hope — is a Rivet-only third id the harness never
  adopts, which § Rotation rule 7 forbids. Hermes sessions enter the control
  plane by **adoption**: spawn from the den roster (or `POST .../resume` an
  existing one) and the driver picks the session up the moment its hooks
  announce an id. This is also why the per-harness task executor for `hermes`
  stays an explicit rejection now that the driver exists: a task needs a session
  spawned FOR it, and that is the one thing this harness cannot be asked to do. Everything else on the contract works normally.
- **It rotates.** `/new`, `/branch`, a mid-chat `/resume`, a rewind, and a
  compaction that forks a child session each replace hermes's session id inside
  one running process (hermes fires its own `on_session_switch` for all five).
  On the den wire that is the room's `harnessSession` changing, and the driver
  answers with `session-updated` + `previousSessionId`. That is its entire part:
  the control plane records the alias, moves live tails, retires the old id and
  keeps `listSessions` canonical-only. The driver deliberately does **not**
  re-key its own sinks — `hermes-driver.test.ts` pins that, because a driver
  that did would double every post-rotation event.
- **Rotation is reported at the boundary, not a turn late.** The hooks config
  gains `on_session_reset`, which hermes fires right after a switch; without it
  the rotation would still be seen (every payload carries `session_id`) but only
  on the next turn's first hook.
- **A turn survives the rotation.** A compaction can fork mid-turn, so the
  in-flight lock and the open tool calls move to the new id rather than wedging
  the old one on `turn_in_flight` forever.

The driver cannot distinguish a user's `/new` from a compaction fork on the den
wire, and does not try: every cause — including a den room re-spawned into a
fresh hermes, since the room is the conversation — is "this room's session id
was replaced", which is exactly what `previousSessionId` means. The *reason* is
preserved where it is observable — capture stamps hermes's own `reason` on its
breadcrumb (below).

**Identity.** `hermes:<native>` — exactly what the capture plugin already
writes and what `~/.hermes/state.db` keys on, so den, capture and the control
plane join on one string. Those natives are `YYYYMMDD_HHMMSS_<6 hex>`:
k-sortable, but second-resolution plus 24 bits rather than the uuid-class
entropy § Session identity requires. Namespacing them (the rule's remedy) is
deliberately NOT done — it would fork the key away from capture and from
hermes's own store, a worse failure than the residual risk of two sessions
starting in the same second, on one node, under one agent tag, drawing the same
24 bits. **Ruled in review** (PR #477): accept and record, do not namespace —
so this note, not a fix, is the disposition of the entropy rule for hermes. It also means a bare hermes id
never goes near the registry's bare-*uuid* probe: hermes ids do not have that
shape, so they must arrive canonical.

**Store.** sqlite (`~/.hermes/state.db`) rather than files, read through
`term/harness-sessions.ts` as usual: `listHermesSessions`, a new
`describeHermesSession` (the list query narrowed to one row, so a drawer row and
a `getSession` cannot disagree — and hermes is the one harness whose store
records when a session began, so `createdAt` is the harness's own answer rather
than a file birthtime), `harnessSessionExists` for the `--resume` ground truth,
and a new store-scoped `readHermesTranscript`.

#### Rotation migration story (breaking, capture side)

`integrations/hermes/rivet-memory` used to treat a switch as **close + new**:
on `reset=True` it marked the old conversation inactive and let the next write
open a fresh one; on `reset=False` it moved the write key with no record at
all. Either way one continuing thread became two unrelated conversations with
nothing linking them.

Now `on_session_switch` records an **alias**: subsequent writes go under the new
`SessionId` (unchanged), the predecessor conversation stays **open and
untouched**, and one `role=system` breadcrumb is written under the new key
carrying `metadata.kind='session-rotation'`, `previous_session_key`, hermes's
`reason` (`new_session` / `branch` / `resume` / `compression`), `reset` and
`rewound`. `on_session_end` still closes — an ending is still an ending.

Why a breadcrumb row and not just the control-plane alias: the registry's alias
store is in-memory and per-node, so it covers live reads and dies with the
process. The breadcrumb is the durable record of the link, in the memory DB,
with no schema migration.

**What that means after a den-server restart, plainly:** the in-memory aliases
are gone. Without a reader, a superseded id stops resolving to canonical — a
`subscribe` under the old id no longer follows the chain, and a chain-union read
no longer unions — while `getSession` and `transcript` on that old id keep
working *standalone*, because its store row and its conversation are still
there. The driver only observes a rotation as it happens, so nothing in the
control plane re-links the two halves on its own.

**As built — the reconstructor** (`services/den-server/src/harness/alias-restore.ts`):
at boot, den-server reads those breadcrumbs back and re-records each link, so a
restart mid-chain no longer costs the chain.

- **The query** joins `ros_messages` to `ros_conversations` on
  `role = 'system'` and `metadata->>'kind' = 'session-rotation'`, taking the
  predecessor from `metadata->>'previous_session_key'` and the successor from
  the conversation's own `session_key`. Bounded: newest 30 days,
  ≤5000 rows, `ORDER BY created_at DESC LIMIT` (then reversed to oldest-first,
  because in an over-full window the OLD half is the half nobody is still
  holding an id from). The time bound rides `idx_ros_messages_created`, so the
  scan is a range over recent rows rather than the whole table. Not scoped by
  `agent`: a breadcrumb names BOTH keys, so a link is self-contained, and the
  `agent` tag is per-harness (`rivet-hermes`), not per-node, so filtering on it
  would isolate nothing. Another node's chain resolves harmlessly here — the
  local driver simply does not own those ids.
- **Every link goes in through `registry.alias()`** — the same
  `AliasStore.record` path a live rotation takes — so a rebuilt chain is subject
  to identical hygiene: same-harness only, one successor per id, cycle
  detection, depth 32. A breadcrumb that violates any of them is logged and
  dropped, never forced in. Malformed keys (a bare uuid, a `task:<id>`, an agent
  nickname, whitespace) are rejected by the same `normalizeSessionId` gate
  inbound ids pass through.
- **DB access story: none needed.** den-server already depends on `pg` —
  `devices.ts` mints per-device roles through it, over its own CREATEROLE admin
  URL (`pgAdminUrl`) — and already reads `RIVETOS_PG_URL`, which until now it
  only handed onward inside an enrollment payload rather than connecting to
  itself. Both halves were already here, so the reader owns a short-lived
  `pg.Client` for one query rather than a pool or a gateway-side pre-read
  handed in as initial aliases. `RIVETOS_PG_URL` is lifted to `config.pgUrl` —
  it is no longer a devices-only concern. No URL configured = no memory DB on
  this node = nothing to reconstruct, which is a configuration fact and not a
  failure.
- **Placement: boot, not first-miss.** An alias miss is not observable — an id
  with no alias resolves to itself, indistinguishable from a canonical id that
  never rotated — so a lazy reader would have to query on every unknown id (a
  remote round trip on the dispatch path) or memoize the first one, which is
  boot-time behavior with extra latency. One bounded query at boot answers
  before the first client asks.
- **Failure-soft, never blocking.** The restore is fired and NOT awaited: a
  remote or down memory DB must not delay a node's boot. A miss logs one line
  and the node comes up with an empty alias store — where it was before this
  existed — and the breadcrumbs stay on disk, so the next boot tries again. Any
  outcome is readable on `DenServer.aliasesRestored`
  (`{ ok, read, linked, malformed, selfLinks, rejected }` — a breadcrumb whose
  two keys are the same id is its own bucket, since `record()` no-ops it and
  counting it as a link would report a hop nobody made), and re-running is
  idempotent: `record()` no-ops a link it already holds. The source is released
  in a `finally`, including after a read that gave up, so a failed restore never
  leaves a connection open.

What is still deliberately NOT done: the memory reader does not union a chain's
transcripts at query time. Reads of an old id keep working standalone, the
control plane resolves it to canonical, and the union in the reader remains the
open follow-up — it would consume exactly this same row.

**What existing data needs:** nothing. Conversations already keyed
`hermes:<old-id>` are not rewritten, re-keyed, or merged — § Rotation rule 3
prefers exactly that ("queries resolve alias chain and union transcript
history"). Reads keep working: the control plane resolves superseded ids for
every driver method, `subscribe` included. Rows written before this change
simply have no breadcrumb, which is the state they were already in.

The behavioural change an operator will notice: a hermes conversation is no
longer marked inactive on `/new`. A rotation leaves its predecessor **open**,
deliberately — the thread is still going, under a new id — and `on_session_end`
then closes the **whole chain** the process rotated through, not just the key it
happens to be on. So `active` still means "not finished" rather than
accumulating one stranded conversation per `/new`. A chain broken by a crash
leaves its members open, the same as any other conversation the process never
got to close.

Known gap, recorded: the capture worker resolves its write key at dispatch
time, so a turn enqueued microseconds before a switch can be filed under the
new key. Under alias semantics both keys are one chain, so this is a cosmetic
misordering within one thread — strictly better than the old behaviour, where
the same turn landed in a conversation that had just been closed.

### As built (`kimi-code` driver) — the fourth, and the honest-gap one

`services/den-server/src/harness/kimi-driver.ts` + `kimi-store.ts`, registered
at boot beside the other three behind the same gating. It completes the
four-harness set: `GET /api/harnesses` on a real node now lists `claude-code`,
`grok-build`, `hermes` and `kimi-code`, all four thin subclasses of
`PtyHarnessDriver`.

Structurally it is hermes's twin, because the one fact that shaped hermes is
true of kimi too: **kimi cannot be told what to call a new session.**
`kimi --help` (0.34.0) offers `-S, --session [id]` and `-c, --continue`, both of
which reference an EXISTING session — `--session <unknown-id>` fails with
`Session "…" not found` — and there is no `--session-id`. So `startSession`
answers `capability_unsupported` (§ Rotation rule 7: a Rivet-only third id the
harness never adopts is not an option), the den room key is not the native id,
and the driver adopts sessions off the den stream through a room ↔ native map.
`kimi-den-hook.mjs` now stamps kimi's own id on every event as `harnessSession`
— the same optional `AgentEventMeta` field hermes added, reused rather than
reinvented. Consequently the per-harness task executor for `kimi-code` stays an
explicit rejection: a task needs a session spawned FOR it.

Where it is NOT hermes:

- **Its natives are `session_<uuid>`.** uuid-class entropy behind a fixed
  prefix, which is what capture already writes, so namespacing satisfies
  § Session identity without touching the key. The prefix does mean
  `isBareNativeUuid` never matches a kimi id, so the registry's bare-uuid probe
  cannot resolve one and clients must send the canonical form — the right trade
  at four drivers, where an unprefixed probe would be guessing.
- **A kimi outside den announces itself through the room key.** With no
  `RIVET_DEN_SESSION` to pin a room, its hook posts under
  `kimi-code:session_<uuid>` — the canonical id — so the driver recovers the
  native from the room itself and adopts the session even from a hook too old to
  send `harnessSession`. Only that exact shape is read as an id; a room key that
  merely contains a colon is not.
- **Two on-disk state shapes, both live.** kimi ≥0.34 writes
  `state.json` with `"version": 2`, epoch-ms timestamps, an `id` and a `cwd`;
  an older install writes ISO strings, `workDir`, `title` and `lastPrompt` — and
  a node with both installed has both in one store (observed on ct116, which
  runs a 0.34 npm install alongside a 0.26 standalone binary). The reader parses
  either, takes the session id from the DIRECTORY NAME (the only field both
  shapes have), and falls back to the transcript's opening human turn for a
  title, because the v2 shape carries none. That fallback scans up to 1 MiB
  with an early exit rather than the fixed 64K head the Claude reader uses:
  kimi's transcript opens with a `config.update` carrying the whole system
  prompt, so measured across a real 55-session store the first human turn is
  inside 64K for only 37 of 54 — a 64K bound would label a third of the drawer
  with the raw session id. Early exit keeps those 37 at one 64K read, and a
  full list of that store reads 5.0 MB against 23 MB of files.
- **A real `isError` on the transcript.** `readKimiTranscript` folds
  `agents/main/wire.jsonl` — kimi's agent-loop event log — into turns:
  `context.append_message` with `origin.kind: 'user'` is a human turn,
  `content.part` grows the assistant message (`text`) and its thinking
  (`think`), `tool.call`/`tool.result` pair by `toolCallId`, and `step.end`
  carries usage. `tool.result.isError` is recorded, so a resynced kimi
  transcript reports a failed tool honestly where no den live stream can.

**The gap this driver does not paper over.** kimi's `Stop` hook payload is
`{ stop_hook_active }` — no reply text — and no kimi hook is given thinking
text at all, so its den translator emits neither `message.agent` nor
`thinking.delta`. The driver therefore emits **no `assistant-delta` and no
`reasoning-delta`**. It could have manufactured a spinner line, as the Claude
hook does for thinking; it does not, because the node genuinely observed
nothing. `liveStream` stays honestly true for what the stream does carry —
session lifecycle, tool calls, turn boundaries — and the assistant/thinking text
is served by `transcript()`, which reads it out of kimi's own store. The base's
mapping for both events is unconditional, so the day kimi's hooks learn to send
them the driver needs no change; `kimi-driver.test.ts` pins both halves of that.
Streaming the deltas off a transcript watch is the documented follow-up.

**Rotation: kimi never renames its own session.** Verified against 0.34.0
rather than assumed, because the question was open going in:

| Path | What it actually does | Rotates? |
|------|-----------------------|----------|
| `/clear` | `clearContext({ sessionId })` — an RPC scoped to the RUNNING session, appending a `context.clear` record to the same `wire.jsonl` | no |
| compaction | appends `context.apply_compaction` in place, same transcript | no |
| `kimi --session <id>` | replays the same session dir under the same id | no |
| anything else | a native id is minted in exactly one place, `createSession` at process start | no |

What CAN change is which session a den ROOM is running: a room whose PTY was
reaped and re-spawned fresh holds a different kimi, and the room is the
conversation every attached client is watching. The driver reports that as a
rotation — the native id behind this session id has been replaced, which is
precisely what `previousSessionId` means and precisely what wants an alias, a
moved tail and a retired predecessor. So `kimi-code` runs
`runHarnessRotationConformance('kimi-code', …)` against the real driver and a
real registry (its `emitActivity` is a `tool.start`, not a `message.agent` — the
suite should be driven by an event this harness really produces), AND pins the
non-rotation of kimi's own id explicitly, the way `grok-driver.test.ts` does:
a compaction emits no `previousSessionId`, a restated id is a status update
rather than a rotation, and a resume keeps the id it was asked for.

**Roster.** `kimi: { label: 'Kimi Code', cmd: ['kimi', '--yolo'], room: true }`,
and `HARNESS_FLAGS.kimi = { resumeFlag: '--session' }` with no `sessionFlag`.
`--yolo` auto-approves regular tool calls; kimi's stricter `--auto` is fully
autonomous and will not ask questions at all. `--yolo` is the default here for
the same reason hermes uses it — the operator can trade up in `den-term.json`,
and the shipped roster should not be where a node quietly loses its last "are
you sure".

### Attachment staging (`POST /api/uploads`)

`services/den-server/src/harness/uploads.ts`. The contract requires
`UserTurn.attachments[].pathOrUri` to be **node-resolvable**; a browser,
desktop or Android client has no path this node can open, so it streams the
bytes here and puts the returned `uri` in the turn.

```
POST /api/uploads?name=<client-filename>[&mime=<type>]
Authorization: Bearer <token>
<raw body>

201 { "uri": "/home/rivet/.rivetos/den/uploads/<uuid>.png",
      "name": "shot.png", "mime": "image/png", "size": 20481,
      "expiresAt": "2026-08-08T06:00:00.000Z" }
```

- **Raw body, metadata in the query string.** Same shape as `POST
  /files/upload`. den has no body parser; `multipart/form-data` would mean a
  new runtime dependency for one endpoint. A filename *header* was rejected
  separately: den's CORS allow-list is a fixed set (`content-type`,
  `authorization`, `x-rivet-conversation`, `x-rivet-title`), so a custom
  header fails preflight for exactly the browser clients this exists for.
- **Auth** is the den bearer gate, identical to `/api/harnesses` and
  `/api/harness-sessions` — no separate tokenless opt-out like `term` /
  `files` / `audio`. Anyone who can reach this route can already reach `POST
  .../turns`, which spawns and drives a harness; uploads are not the weak
  link. Disk exposure is bounded **per upload** by the cap and **in
  aggregate** by the TTL — there is no total-bytes ceiling, so a bearer client
  can hold up to (request rate × cap × TTL) on the state volume. Same posture
  as `POST /files/upload`, which has a 1 GiB per-file cap and no aggregate at
  all, so this is not a regression; a staging quota is future work if a node
  ever exposes its bearer beyond the mesh.
- **Client filenames are metadata, never paths.** The on-disk name is always
  `<uuid><ext>`; the extension is honored only when it is 1–12 alphanumerics.
  The client's name survives as the sanitized single-segment `name` in the
  response, for display. `?name=../../etc/passwd` stages a uuid in the
  staging dir and reports `name: "passwd"`.
- **`uri` is an absolute node-local filesystem path**, not a `file://` URL —
  every consumer of `pathOrUri` is a driver that will `open()` it. This
  deliberately discloses the node's `stateDir` layout to an authenticated
  client, which is fine: the client hands the path straight back to the node
  that minted it, and a `file://` URL would disclose exactly the same string.
- **Cap:** 25 MiB per upload, `RIVETOS_DEN_UPLOAD_MAX_BYTES`. Enforced twice —
  a `Content-Length` pre-check that refuses before the staging dir is even
  created, and a running total on the data path for chunked bodies. The
  response is flushed before the socket is torn down, so an oversize client
  sees a 413 rather than a connection reset.
- **Retention:** staged files are transient. A sweep unlinks anything older
  than 6h (`RIVETOS_DEN_UPLOAD_TTL_MS`, `0` disables), running once at server
  start — so a node that was down past the TTL boots clean — and then on a
  derived interval (the TTL, clamped to 1–30 min). The staging dir is
  `<stateDir>/uploads` (`RIVETOS_DEN_UPLOAD_DIR`), mode 0700, files 0600. It
  is deliberately **flat**: uuid names need no per-session disambiguation, and
  a flat directory lets the sweep never recurse and only ever `unlink` entries
  that `lstat` as regular files — a symlink planted in the staging dir is
  neither followed nor removed. Orphaned `.part` files from dropped
  connections age out on the same rule.

**What this enables today:** any client can turn its own bytes into a path
this node can open, and the turn API already accepts and forwards
`attachments`. **What it does not enable:** `claude-code` still answers
`capability_unsupported` for a turn with attachments, staged URI or not. Its
only channel into Claude is a PTY paste, which carries text — there is no wire
for "here is a file" into the TUI, and pasting the path as prose would be a
different thing wearing the contract's name. The first driver that speaks a
real protocol (SDK / ACP) consumes the staged URI directly, with no change to
this endpoint.

Known gaps in the shipped slice (recorded, not fixed):

- ~~Capability flags are **declared at construction, not runtime-probed**.~~
  **Closed.** Flags are probed before they are advertised, corrected lazily by
  the first PTY call, and a post-advertisement flip surfaces on the registry
  stream — see § As built (node control plane), *Capability runtime truthing*.
- Session **status for out-of-den harnesses**. Liveness comes from the driver's
  own map, fed by `startSession`/`resumeSession` and by den events (including
  the term manager's synthetic `session.start`, so a `/term` drawer spawn is
  adopted immediately). A Claude process started outside den entirely emits
  nothing observable and reads as `ended` until its hooks speak.

### Rotation gate — subscriptions follow rotation (closed)

This was the blocker on landing a rotating driver (hermes is the first). The
three requirements below are normative and unchanged; all three now ship.

1. **Re-key live sinks on alias record.** When the registry records
   `previous → canonical`, every sink subscribed under `previous` moves to
   `canonical`. Registry-side wrapping rather than per-driver re-keying: alias
   resolution is control-plane-owned, and every driver would otherwise
   reimplement it.
2. **End the superseded id's lifecycle.** The control plane records the old id
   as ended when it stores the alias, and `listSessions` returns canonical ids
   only.
3. **A contract test for subscription-follows-rotation** — subscribe under the
   old id, rotate, assert the next event arrives on the *same* subscription
   carrying the new `sessionId`, and that the client never re-subscribed. In a
   shared driver-contract suite, not one driver's tests.

**As built.** `registry.subscribeSession(sessionId, sink)` is now the only
per-session subscribe the gateway calls (`routes.ts`, `WS
/api/harness-sessions/ws`). It resolves the chain, attaches the sink to the
driver under the canonical id, and keeps the subscription in a live set. When
the registry tails a driver `session-updated` carrying `previousSessionId` it
records the alias and then, **before** the registry-stream fanout, `rekey()`
moves every tail whose id now resolves elsewhere: detach at the old id,
`driver.subscribe(canonical, …)` at the new one, and hand the client the
rotation event on the sink it already holds. Drivers keep pinning sinks to the
one id they were handed — `ClaudeCodeDriver.subscribe` is unchanged, and a
rotating driver needs nothing beyond emitting the event.

Delivery is **exactly once regardless of driver ordering**. A driver may emit
the rotation to its session sinks before the registry stream, after it, under
the new id, or not at all; the control plane tracks `previous→next` per
subscription and drops the second copy whichever way it arrives. All four
orderings are conformant and all four are covered.

Three ordering invariants the re-key holds, in the order it does them:
**deliver, then attach, then detach.** Delivering first means a driver that
emits its *next* rotation synchronously from inside `subscribe` cannot overtake
the current one on the wire. Attaching before detaching leaves the sink briefly
on both ids — deliberate and unobservable, since JS runs the handler to
completion, and the opposite order would open a real gap for that same driver.
And because that driver re-enters the re-key through the registry stream, every
frame re-checks the tail after `subscribe` returns and yields to whichever
frame got further down the chain; an outer frame writing back stale locals
would strand the client on an abandoned id.

Driver misbehavior is contained rather than trusted: a rotation restating its
own id is a status update, not a rotation (no retirement, no re-key); a
repeated rotation records an idempotent alias and retires the old id only once;
a second, different successor for an id that already rotated is refused by the
alias store with `session_id_collision` rather than overwritten (overwriting
strands tails on the abandoned branch); and if the driver refuses the
post-rotation `subscribe`, the tail gets a retryable `error` event telling it to
re-subscribe and hard-resync, because a silently dead socket looks like a quiet
session.

The superseded id is retired at the same moment: `registry.isSuperseded()`
reports it, a single `session-updated { sessionId: <old>, status: 'ended' }`
follows the rotation event on the registry stream (after it, so a client has
already moved its row and reads this as "old key retired", not "session died"),
and `registry.listSessions(harnessId)` — which `GET
/api/harnesses/:harnessId/sessions` now calls instead of the driver directly —
is canonical-only: a row a driver still keys on a rotated-away id is rewritten
to canonical and collapsed into the canonical row rather than dropped, so
nothing disappears from a drawer. `assertPinnable` moved the alias-chain
collision rule off the route and into the registry, so it holds for every
caller and not just HTTP.

**Nothing changed for clients** — that is the point. A hub socket opened under
an id that later rotates keeps streaming, and `routes.test.ts` proves it over
a real den server end to end.

**Shared conformance suite:**
`services/den-server/src/harness/test/driver-conformance.ts` exports
`runHarnessRotationConformance(name, setup)`; a driver hands it a registry with
the driver registered, a live session id, a `rotate(from)` that makes the
harness rotate, and an `emitActivity(id)`. It asserts the rotation arrives once
on the existing sink, later events carry the new id, chains follow without a
re-subscribe, unsubscribe still detaches, the superseded id resolves everywhere
(`resolve` / `getSession` / turns / interrupt / transcript), the old id is
retired and absent from `listSessions`, and any id in the chain collides on a
pinned `startSession`. Post-rotation events are asserted as an **exact
sequence**, not "every event carries the new id": a driver that re-keys its own
sinks leaves the tail attached twice, and doubling every later event is exactly
the failure the suite exists to catch — `rotation.test.ts` runs a deliberately
self-rekeying fake to prove the assertion has teeth.
`test/fake-rotating-driver.ts` is the reference target —
also the shape a real rotating driver should copy. Both sit under `test/`
(importable helper, not a collected suite) beside the drivers they serve,
matching `packages/core/src/domain/task/test/executor-conformance.ts`; they are
not exported from the package barrel because every planned driver lands in this
same directory and the suite imports `vitest`. `rotation.test.ts` runs it across
all four emit orderings plus the stale-list-row case, then covers the
control-plane-only edges: nested rotation from inside `subscribe`, self-rekeying
driver, repeated and self-restating rotations, a refused post-rotation tail, a
second successor, and a chain rotated to its depth cap.

**Phase 3 driver PRs:** add one `runHarnessRotationConformance('<harness>', …)`
block to the driver's test file. `claude-code` has none — its native id never
rotates, so there is nothing to exercise; that is exactly why the suite runs
against a fake. **`hermes` is the suite's first real customer** and passed it
unmodified: its `rotate()` is one den event carrying a new `harnessSession` for
the same room, and its `emitActivity()` is a `message.agent` in that room.

---

## Phase 3 — Multi-harness parity + hub binding

- [x] **Grok Build driver:** promote hooks/capture → gateway stream (`grok-build:…`) — see As built (grok-build) below
- [x] **Hermes driver:** same; memory/den already exist (`hermes:…`) — see As built (hermes) below
- [x] **Kimi den hooks:** `integrations/kimi/rivet-den` streams kimi-code sessions into a den under the canonical `kimi-code:<native>` — the same key capture writes, so room and conversation join on one identity
- [x] **Kimi driver:** the gateway half, completing the four-harness control plane — see As built (kimi-code) below. It supplies what the hooks cannot, but through the store rather than the stream: kimi's `Stop` payload carries no assistant reply and no hook sees thinking, so the driver emits no `assistant-delta`/`reasoning-delta` and serves both out of `transcript()` (`wire.jsonl` `content.part`) instead of inventing them. Capture stays as-is (`kimi-code:…`)
- [x] Tasks: `harness-session` executors per harness id — includes renaming/aliasing the existing executor agent id `claude-cli` → `claude-code`; grok-build/hermes register as explicit rejections, not absences — see As built (per-harness task executors) below
- [x] **Kimi task executor:** `kimi-code` graduated from rejection to a real executor over headless `kimi -p` (`@rivetos/harness-kimi-code`) — see As built (kimi-code task executor) below
- [x] Hermes rotation migrated from close+new-conversation to alias semantics (breaking, see Session identity § Rotation) — driver side and capture side both, see As built (hermes)
- [x] **Hub chat** binds the harness API (`apps/rivethub-web`) — see below
- [ ] **Hub:** tasks / dens bind multi-harness API (not Claude-only)
- [ ] Den: list all harness types under one naming scheme
- [x] **Android:** same gateway APIs — full remote parity (no on-device agent loop) — see As built (Android binding) below; uploads staging UI deferred

### As built (per-harness task executors)

The task engine's `harness-session` registry is keyed by **harness id**, the
same `claude-code | grok-build | kimi-code | hermes` vocabulary `SessionId`,
the driver registry and the gateway already speak. Before this the one CLI
executor registered under the PROVIDER name `claude-cli`, so a task row and a
session id disagreed about what to call the same harness.

**The rename.** `ClaudeCliExecutor.name` and its registry target are
`claude-code`; the plugin, the package (`@rivetos/provider-claude-cli`), the
config key `providers.claude-cli` and the binary probe are untouched — the
provider really is "the claude-cli provider", and only the harness it executes
was misnamed. `claude-cli` stays accepted as a **deprecated executor target**
for one window, canonicalized on both `register` and `resolve` with a
warn-once-per-target log, exactly the treatment legacy session keys get: rows
queued before the rename still resolve, nothing writes it, and the alias comes
out once no queued task names it. Aliasing is scoped to `harness-session` —
`chat-loop` and `mesh` targets are free-form and pass through untouched.

**Registrations are honest, not aspirational.** At this slice only
`claude-code` had node-side headless spawn machinery in this repo: the grok
integration here drives an interactive PTY (term manager
`--session-id`/`--resume`, hook-fed capture) and kimi was hooks plus capture
with a `Stop` payload that carries no assistant reply. (`kimi-code` has since
graduated — the CLI's own `--output-format stream-json` turned out to be enough
to build on; see As built (kimi-code task executor) below.) Rather than invent
headless drivers, every harness id without one registers an explicit rejecting
executor — including `claude-code` itself
when the `claude` binary probe fails, in which case the reason is the probe's
own ("binary not resolvable", "provider package did not load") rather than the
generic recorded gap. A task aimed at one resolves (never rejects) with verdict
`failed` and the typed `capability_unsupported` code plus that reason, where
before it hit the runner's anonymous `executor_not_registered` and told an
operator nothing about whether the harness is unsupported, uninstalled or
misspelled. `steer` is the one method that throws the typed error: steering
something that never started is a caller bug.

**Where a real grok executor should start.** Not the PTY, and not grok's
headless streaming-json (thought/text/end only): **ACP — `grok agent stdio`**,
which streams `tool_call`/`tool_call_update` and thought chunks and returns
real token usage on the prompt response, i.e. everything a `HarnessExecutor`
has to translate into `TaskEvent`s. The one in-repo driver of it today lives in
the Android bridge rootfs, so ACP is deliberately not wired node-side here; the
recorded gap names it so the next implementer does not re-derive the choice.

**Discovery.** `TaskExecutorRegistry.harnesses()` returns one row per harness
id (`registered` / `implemented`) using exact lookups — `resolve`'s kind-level
fallback would otherwise report every harness as covered the moment one of them
registered. `GET /api/catalog` carries the same truth per entry: `harness-session`
rows gain `harnessId` and `implemented`, so a client can grey an option instead
of offering a trap. Non-harness executors carry neither field.

**Session identity.** The executor now surfaces `claude-code:<native>` on
`turn.end` rather than the bare uuid, so a task row's `harness_session_ids` are
canonical `SessionId`s. It adopts rather than pins: there is no `--session-id`
on this path (every spawn is a one-shot `-p` with `--no-session-persistence`),
the CLI mints the id and reports it on `system/init`. An id the codec rejects
passes through verbatim — a non-canonical breadcrumb beats none, and claiming
canonical form for a malformed id is the lie the codec exists to prevent.
\#467's task association is unchanged and still carries: `RIVETOS_TASK_ID` on
the child env, the inherited `RIVETOS_SESSION_KEY` explicitly deleted, no
write-key override.

The shared executor-conformance suite runs against the renamed executor
(`runExecutorConformance('claude-code', …)`). The not-implemented executors
deliberately do not run it — it opens with a success path they can never have —
so they are pinned by their own tests instead: typed code, resolve-never-reject,
one error log then a completed iterable, and a runner-level test that a
`kimi-code` row goes terminal with the reason rather than the anonymous miss.

### As built (kimi-code task executor)

`kimi-code` was one of #476's honest rejections: *"the Kimi Code integration is
hooks + capture only — nothing in this repo spawns the kimi binary, and its
Stop hook carries no assistant reply to parse a result from."* True of the
integration; not true of the CLI. kimi 0.34.0 ships `--output-format
stream-json`, and every session writes a transcript that carries what the
stream does not. `@rivetos/harness-kimi-code` is the executor built on those
two facts, and it passes the shared conformance suite as
`runExecutorConformance('kimi-code', …)`.

**Where it lives, and why not `plugins/providers/`.** The claude executor rides
inside the claude-cli PROVIDER plugin because that plugin already owns the
`claude` binary (model wrapper, capture hooks, executor). kimi has no RivetOS
provider: no `LanguageModel`, no `providers.kimi-code` slice, nothing for the
plugin loader to register. Filing it under `plugins/providers/` would mean
declaring `rivetos.type: "provider"` for a package that registers no provider —
a category the discovery layer would then report. `integrations/kimi/` was the
other candidate and is where the kimi capture and wire-backfill packages live,
but everything there is `private: true`, and `@rivetos/boot` is published: a
published package cannot depend on an unpublished one. So it is a published
`packages/*` library, tagged `scope:adapter` like the plugins it is a sibling
of in spirit — an adapter to an external CLI that boot composes.

**The turn.** One `kimi -p` per turn in a fixed cwd, prompt on argv. There is
no `--append-system-prompt`, so the task scaffold — context, acceptance
criteria, the `TASK_RESULT` fence contract, byte-for-byte the text claude gets
in its system append — is PREPENDED to the prompt every turn. `--agent-file`
was considered and rejected: it replaces the agent definition wholesale, tool
instructions included. Scaffold-first is also a safety property: `kimi -p`
intercepts a prompt STARTING with `/goal` and runs goal mode instead of a turn,
and a scaffold in front means a task goal that opens with a slash command can
never hijack the spawn.

**Result and usage: post-hoc, not tailed.** stream-json carries assistant text,
`tool_calls[]`, correlated `role:"tool"` results and — as the last line of a
successful turn — `session.resume_hint` with the native session id. It carries
no usage, no result event and no error event. Usage comes from the session's
own `agents/*/wire.jsonl` AFTER the child exits: `usage.record` per LLM request
(`usageScope:"turn"`; the `"session"` rollups are excluded or they would
double-count), summed from the spawn clock forward, subagent slots included.
Reading a finished file has no races to handle — no fsync-batch lag, no
new-session-dir attribution guess, no inode swap mid-read — and a reconcile
that finds nothing degrades to zero usage plus a warning. It can never fail a
turn. There are no `cost` events: kimi reports tokens, not money.

**Finding the transcript.** `session_index.jsonl` at the CLI home maps session
id → absolute session dir and is tried first; the fallback is kimi's own bucket
naming, `wd_<slug>_<sha256(cwd)[:12]>` (the hash formula was checked against
every bucket on the rivet-kimi node and matched), matched on the hash suffix so
a change to the slug rules cannot break it. One case needs more than the hint:
a turn that THROWS never reaches the resume-hint line, so a failed first turn
prints no session id at all. The executor snapshots the ids for its cwd before
spawning and diffs after — exactly one new id is the spawn's, more than one
means concurrent same-cwd spawns and it declines to guess rather than bill
another task's tokens to this one.

**Multi-turn is native, which claude's still is not.** Steered turns spawn
`kimi -S <native-id> -p`, so the whole task shares ONE kimi session, its
context and its id — `harnessSessionId` is the same `kimi-code:session_<uuid>`
on every `turn.end`. The resume is cwd-scoped (kimi refuses a session created
under a different directory), so every turn spawns with the same cwd. When kimi
refuses the resume anyway — pruned session, moved directory — the turn retries
once on a fresh session seeded with the task's rendered transcript, the same
rehydration a cross-process resume-from-awaiting-input uses, and adopts the new
id from there.

**Kill.** SIGTERM then SIGKILL, but on a 10s grace rather than claude's 2s:
kimi's termination cleanup is bounded by `PROMPT_CLEANUP_TIMEOUT_MS = 8_000`
and the turn's last wire batch — its `usage.record`s and `turn.ended` — is only
durable if that cleanup runs. A killed turn's usage may still be partial, and a
SIGKILLed one's certainly is; the reconcile tolerates a torn final line the way
kimi's own reader does.

**Identity and association.** `formatSessionId('kimi-code', native)` — the same
key the den hooks and the memory capture already write, so room, conversation
and task row join on one id. Adoption, not pinning: kimi has no `--session-id`.
#467's env contract is claude's verbatim — `RIVETOS_TASK_ID` set,
`RIVETOS_SESSION_KEY` explicitly deleted, `RIVETOS_DEN_HOOK_DISABLED=1` — and
kimi reads none of them. The consumer is the hook launcher it spawns, which
inherits the env, which is how capture stamps the task onto the conversation.
Two more vars are scrubbed. `KIMI_CODE_LEGACY_FLAG` selects the retired v1
print runner, whose stream vocabulary is not the one parsed here, and has no
flag in front of it — scrubbing it is load-bearing. `KIMI_MODEL_OUTPUT_FORMAT`
is only the FALLBACK for `--output-format` (kimi reads the explicit flag first
and the env solely when the flag is absent), so with the flag always passed it
cannot win today; it is scrubbed belt-and-braces because it is the one
inherited value that could silently change the output PROTOCOL if a future path
ever dropped the flag.

**Registration.** `tasks.harnesses.kimi-code.{binary,model,effort,cwd,home}` —
a new config section, keyed by harness id, for executors whose harness has no
provider plugin to borrow settings from. Boot probes `kimi --version` and, on
failure, registers the rejecting executor with the probe's own reason. The
recorded gap for `kimi-code` is therefore GONE from `HARNESS_EXECUTOR_GAPS`,
the same treatment `claude-code` gets: a harness with an executor has no
standing gap, only a probe that can fail.

**One shared defect fixed on the way through.** The `waitExit()` this
executor's spawn layer inherited from the claude-cli one could never settle on
two real terminal paths: a child that closed before the first call (the `close`
listener is attached on demand, and a spent event does not re-fire) and a child
killed by a signal (`proc.exitCode` stays null, so the "already exited"
shortcut misses too). Both halves miss at once on a signalled child whose close
has landed — exactly what the kill path produces. Exit is now latched from a
listener attached at spawn time and every caller reads the latch, in BOTH
copies, each with a regression test that hangs against the old code.

**What the first live run still has to confirm** (fakes cover the contract, not
the CLI): that stream-json lines arrive incrementally over a pipe during a long
turn rather than at exit; that a SIGTERMed turn really does flush its last wire
batch within the cleanup budget; that `KIMI_MODEL_THINKING_EFFORT` is honored
in `-p` (the override bypasses `support_efforts`, so an unsupported value
surfaces as a provider error); and that `mcp.json` servers load in headless
prompt mode at all.

**Upstream asks recorded for Moonshot.** One event would delete most of this
machinery: a terminal `turn.result` on stdout carrying stop reason, per-turn
usage, `is_error` and duration. After that, in order: the session id in the
FIRST line rather than the last (a failed turn would stop being a
disk-forensics exercise), a `--session-id` flag to pin rather than adopt, a
machine-readable error line instead of stderr prose, `--append-system-prompt`,
`--json-schema`, `--mcp-config`, and a documented exit-code contract.

### As built (hub chat binding)

`@rivetos/gateway-client` carries the typed surface (`harnesses`,
`harnessSessionList`, `startHarnessSession`, `getHarnessSession`,
`resumeHarnessSession`, `sendHarnessTurn`, `interruptHarnessSession`,
`resolveHarnessApproval`, `harnessSessionTranscript`, `watchHarnessSession`,
`watchHarnesses`); path params go through `encodeSessionIdSegment`, and a bare
native id rides as a plain segment for the documented legacy shape.

Hub chat binds **per session, not per app**: a row a registered driver claims
streams on `WS /api/harness-sessions/ws`, hard-resyncs its transcript on every
`open` (first connect and reconnect alike — the tail has no replay), and sends
through `sendUserTurn`; the drawer badges its harness id. Rows no driver claims keep the
existing gateway chat channel binding verbatim, so nothing disappears from the
drawer. (As of the `kimi-code` driver every harness row on a node is claimed;
the fallback remains for a node whose drivers are disabled.) The chat
store marks bound sessions so the all-sessions socket stops writing them: the
same den events reach both surfaces and folding twice would double every delta.
Interrupt and approvals render only when the driver's flags say so, which for
`claude-code` and `grok-build` alike means a Stop button and never an approval
card.

Live thinking streams on this path too: `reasoning-delta` was added to the
contract after this slice, both PTY drivers fold den `thinking.delta`
frames onto it, and the hub folds it into the same `reasoning`/`reasoningText`
fields the legacy den-bridge path fills — so a bound session shows thinking
live instead of waiting for the transcript at turn end.

Gaps this slice records rather than fixes:

- ~~**Hub chat's key is still the bare native id.**~~ Closed — see As built
  (canonical hub keying) below.
- **No `session-created` fast path.** The registry stream invalidates the
  drawer's session queries rather than merging the summary it already carries.
- **No attachments and no `startSession` from the hub.** `POST /uploads` does
  not exist (Phase 2 checklist), and "+ new" stays a local draft so clicking it
  does not spawn a harness; the draft's first turn pins its id through the
  existing PTY path and the control plane adopts it from there.
- **`turn_in_flight` is client-queued.** The hub requeues and retries on a
  bounded exponential backoff (6 attempts, 30s cap) and then leaves the turn
  queued for the user's inject button. There is no server-side queue, and no
  ready signal to wait on — a harness parked on its own TUI permission prompt
  is legitimately mid-turn for as long as a human takes.
- **Approval state is not recoverable.** `approval-request` exists only as a
  live event: a client that attaches after one was emitted, or that reloads,
  has no way to learn the harness is blocked (the tail has no replay and the
  transcript does not carry pending approvals). **Phase 3 driver requirement:**
  the first driver reporting `approvals: true` must also make pending
  approvals readable — a `GET` on the session, or approvals carried on the
  transcript — or every reconnect silently strands the harness.

### As built (canonical hub keying)

Closes the gap above: hub chat's thread external key is now the canonical
`SessionId` for every row a registered driver claims, which is the identity
table's "Hub chat → `SessionId`".

**Two key spaces, one direction of resolution.** The den keeps its own: the
ROOM key a PTY runs under (`RIVET_DEN_SESSION`), that v1 AgentEvents carry as
`session`, that the viewer joins with `?session=`, and that the on-disk stores
file transcripts under. For every session the hub opens, that key IS the
harness's native id — the term manager pins it at spawn. So the migration is
not "rename the room", it is "canonicalize the layer above and resolve down at
the edge": `denSessionRef()`
(`services/den-server/src/harness/session-key.ts`) maps canonical → room,
leaves a bare id alone, and passes a non-session string (`den-pty-…`, an
operator's room, `task:<id>`) through untouched. `denJoinKey()` is the
room-only shorthand for edges with no store to pick.

**A canonical id names its store.** `denSessionRef` returns the roster token
alongside the room key whenever the inbound id was canonical, and the two store
readers (`readHarnessTranscript`, `resolveHarnessStore`) then read that store
and only that store. The claude → grok → hermes → kimi
probe-and-take-the-first order stays, but for BARE ids alone, where it is the
documented legacy behavior. Probing on a canonical id would let a uuid present
in two stores answer `claude-code:<uuid>` out of grok's — the cross-store
fall-through § Collision rules rule 2 forbids, and the same rule the driver
layer enforces on its own reads. An empty answer is the correct answer there.
It matters twice over for `resolveHarnessStore`: the watcher caches that ref
for the life of the watch, so a wrong store would feed a wrong transcript on
every subsequent change, not just once.

Surfaces that now take either shape — bare ids keep working as aliases, and
nothing is dual-written:

| Surface | Resolution |
|---|---|
| `POST /term` (`session`, `resume`) | canonical → room; the spawned `denSession`, the store filename and `--resume` all stay native |
| `POST /term/inject` | canonical → the same PTY as the bare key |
| `WS /term?session=` | same |
| `WS /ws?session=` | canonical → room (a subscription filter, nothing echoed) |
| `DELETE /session` | canonical → room. Its `session.removed` broadcast necessarily carries the ROOM key, not the asked id: it addresses den viewers, which key on rooms |
| `GET /state` | canonical → room, **echoes the requested id** |
| `GET /term/harness-sessions/:id/transcript` | reads the named store, **echoes the requested id** so the client can match it to its thread |
| Transcript watch (`watch`/`unwatch`/`sync` on `WS /api/sessions/ws`) | subscription key is the client's id verbatim; only the store lookup resolves. Frames come back under the key that was watched |
| `GET /api/sessions/:id/messages` | alias read: a canonical id with no ring of its own falls back to the native half rather than minting an empty session |
| `GET /api/conversations/:key/messages` | alias read: capture files a den-spawned harness under the bare key it inherited via `RIVETOS_SESSION_KEY`, so a canonical ask with no rows retries native. No rewrite — the alias covers the read forever |

**What stays bare, and why (precedence).** A `draft` has no harness yet: its id
is a locally minted uuid the first spawn pins, and there is nothing to
canonicalize with until the plane adopts it. A `legacy` row is one no
registered driver claimed, which by construction carries a roster token
(`claude`, `grok`) and not a `HarnessId` — and roster tokens are never key
material. With all four drivers registered every on-disk row IS claimed, so
`legacy` is the degraded path (drivers disabled, a plane fetch that failed),
not the normal one. The drawer union still joins on the NATIVE id, because
that is the only field the two lists share.

**Back-compat.** `findChatItem` matches a selection by key first and by native
half second, so a pre-canonical selection, a draft the plane just adopted, and
a rotation all still land on their row. `useChat.rekey(from, to)` then moves
the thread's state — transcript, inject queue, live turn, approvals, the
transcript subscription — onto the new key rather than stranding it, which
also fixes rotation, where the drawer key used to change under a live
conversation with nothing following it. When the destination already holds a
transcript `rekey` leaves both sets of records alone rather than merge them —
but it still moves `active` and `opened`, because the send path keys on the
active id and the effect that called it does not re-fire, so a selection left
on the retired key would queue every later turn under an id no row carries.
Persisted client state (`sessionNames`, `chatSettings`) migrates lazily: the
read falls back to the pre-canonical key and the next write lands on the new
one.

**The one projection.** The den viewer iframe's `?session=` is the only
hub→id handoff that does not pass through a den-server edge — the viewer
bundle matches it against the room keys in its own snapshot — so the hub
projects it with `denRoomKey()`. Documented rather than hidden: it is a
boundary onto the den's key space, not a second key for the thread.

Deferred, precisely:

- **Capture still writes the bare key for a den-spawned harness.** `manager.ts`
  sets `RIVETOS_SESSION_KEY = <den join key>`, so `ros_conversations.session_key`
  is the native id for those sessions while a harness left to its own hooks
  writes canonical — the identity table wants canonical for both. Flipping the
  write is a capture-side migration with its own deprecation window (the same
  shape the `task:<id>` flip needed), so this slice ships the alias READ
  instead: correct today, and the precondition for the write flip.
- **`GET /term/harness-sessions` still returns bare ids** with a roster
  command and no `harnessId`. It is the degraded-path source by definition, and
  canonicalizing it would need the driver→roster map inside `term/`, which is
  a dependency inversion. The plane list is the canonical source.
- **Android** (`apps/rivet-android`) is untouched: it keys its own drawer and
  reaches the same endpoints, which now accept both shapes, so it keeps
  working bare. Moving it is the same client-side change made twice.

### As built (Android binding)

`apps/rivet-android/app/src/main/java/dev/rivet/app/data/harness/` carries the
Kotlin half of the contract — there is no shared client to reuse, because the
app is Gradle/Kotlin and `@rivetos/gateway-client` is a TypeScript workspace
member. It is a re-implementation of the same semantics, not a port of the
code: `HarnessSessionIds` (parse on the first colon, `enc`/`dec` as unpadded
base64url with round-trip tests over ids containing `:` and `/`),
`HarnessUrls` (every path shape, pure so the "As built" table above is
unit-tested), `HarnessControlPlaneClient` (OkHttp; bearer header on HTTP,
`?token=` on the socket; one `HarnessHttpException` carrying the typed wire
`code`), `HarnessFold`, `HarnessAttachment`, `HarnessPlane` and
`HarnessTurnPolicy`.

**Per session, not per app** — the same rule the hub follows. The drawer unions
`GET /api/harnesses/:id/sessions` with the legacy `/api/terminal/harness-sessions`
scan, keyed by bare native id with the control plane winning
(`HarnessPlaneRepository`). A driver-owned row sends through `sendUserTurn`,
tails `WS /api/harness-sessions/ws` and hard-resyncs its transcript on every
open; every other row — a harness whose driver has not landed (`kimi-code`
today), phone drafts, the local node — keeps the existing `/v1` provider
binding byte for byte. Which harnesses those are is read off `GET
/api/harnesses` at runtime, so `hermes` moved from one side to the other when
#477 landed without a line of app code changing. A node with no driver
registry answers 404, the descriptor list comes back empty, and the app behaves
exactly as it did before. No toggle, no legacy mode to pick.

The chat key stays the bare native id for the same reason it does on the hub,
plus one more: on Android it is also the Room conversation UUID
(`ChatService.parseHarnessSessionUuid`) and the Terminal escalate join key.

Two things the app had to grow that the hub gets for free:

- **The 15s transcript poll is off on a *streaming* thread.** `ChatVM` polled
  `syncTranscriptToConversation` because Android had no push. A thread whose
  driver reports `liveStream` has one, and the poll would fight the same rows —
  so the poll skips on `gate.stream`, not on `bound`: a driver bound for send
  but with no live tail still needs the poll. The gate is read off a flow, so a
  stream that dies terminally un-binds the thread and the poll resumes by
  itself. The legacy import and hard resync are guarded on
  `harnessBinder.isBound` separately.
- **A bound thread renders `transcript + pending user turns + live turn`**
  (`HarnessChatBinder`, `ChatService.applyHarnessRender`). The transcript is
  replaced wholesale on every resync — that is what hard resync means — so a
  turn typed here that the store has not committed yet is carried alongside and
  retired when it appears in the committed turns. Live `reasoning-delta` folds
  into `UIMessagePart.Reasoning` with `finishedAt = null`, which is what makes
  the existing chain-of-thought card render as still thinking; no new UI.

Capability gating is the driver's flags, not a preference: Stop renders only
when `interrupt` is true (with no interrupt the composer keeps its send button
and further turns queue behind the one in flight), and no approval card exists
because both PTY drivers report `approvals: false`.

Gaps this slice records rather than fixes:

- **No uploads staging UI.** `POST /api/uploads` is implemented in the client
  (`HarnessControlPlaneClient.upload`) and turns accept `attachments`, but a
  turn carrying files is refused with a message rather than silently sent as
  its caption alone — `claude-code` and `grok-build` both answer
  `capability_unsupported` for attachments regardless of staging, since a PTY
  paste cannot hand a file to a TUI. The picker stays wired to the `/v1` path
  it already had. First driver that speaks a real protocol unblocks both ends.
- **No `session-created` fast path — the hub has one now and Android does
  not.** #478 merges the registry stream's summary straight into the hub's
  drawer cache; here `watchHarnesses` exists on the client and nothing
  subscribes to it, so the drawer still re-reads on its 30s poll and a session
  started elsewhere shows up late. Straight port, deliberately not bundled with
  the binding itself.
- **No `startSession` from the app.** "+ new" stays a local draft whose first
  turn pins its id through the existing path; the control plane adopts it.
- **Approval state is still unrecoverable**, and the app therefore logs
  approval frames rather than rendering a card — the same Phase 3 driver
  requirement recorded for the hub applies before any of this is worth
  building.
- **No rotation re-key on the drawer.** A rotation follows the bound thread's
  own socket (the registry re-keys live sinks), but the drawer's cached
  snapshot only picks up the new canonical id on its next poll.
- **CI never builds Android.** The suites below run locally only; see the
  app's `AGENT.md` for the build host.

**Closed since:** the tokenless roster — see "As built (Android per-node
bearers)" below.

Tests: `app/src/test/java/dev/rivet/app/data/harness/` — codec round-trips,
URL shapes, wire parsing, plane selection and the error→behavior mapping, the
fold, the attachment's resync/fatal ordering, the reconnect/terminal-handshake
rules, and the bounded retry — plus
`app/src/test/java/dev/rivet/app/service/HarnessChatBinderTest.kt` for the
binder's own invariants: one sender at a time, one commit retires exactly one
queued turn, an accepted-but-never-committed turn is reaped rather than left as
a phantom bubble, and a fatal stream clears the gate and the live turn so the
composer frees and the legacy poll resumes. `./gradlew :app:testPhilDebugUnitTest`.

### As built (Android per-node bearers)

The roster shipped tokenless, so every control-plane call against a node with
`den.token` set came back 401, the descriptor list came back empty, and the app
silently resolved every row to the legacy surface. The degrade was correct and
is unchanged; what was missing was any way to *not* need it.

**Where the bearer comes from: the operator, per node.** That is the RivetHub
web mechanism, not a new one. `apps/rivethub-web/src/pages/settings.tsx` has a
password field labelled "Bearer token (only if the node gates its gateway)";
the value is read off the node itself with `rivetos gateway token` and pasted
in. Android now has the same field in the same place a node is defined — the
drawer's node switcher — on the Add-node form and behind a key button on every
remote row. Mesh enrollment was considered and rejected as the transport:
`POST /api/devices/enroll` is the one route deliberately *outside* the bearer
gate (the enrolling device has no bearer yet), so handing out the gateway
credential in exchange for a one-time enroll token would let a scanned QR
escalate into full node access. The hub does not do it, and neither does this.

**Where it is kept: not in the roster.** `RosterNode` still has exactly `name`
and `denUrl`, and there is no DataStore migration, because `Settings` is
serialized whole into `settings.json` and uploaded by the WebDAV/S3 backup sync
(`app/src/main/java/dev/rivet/app/data/sync/`) — a bearer stored on the roster
would leave the phone for a third-party server. Web splits the same way and for
a related reason (roster in `localStorage`, tokens in `sessionStorage` keyed per
node). The Kotlin split is `dev.rivet.app.data.node.NodeTokenStore`: an
app-private prefs file of its own, keyed by the normalized den URL, excluded
from Android cloud backup and device transfer, never logged, and dropped when
its node leaves the roster. It is not keystore-encrypted; every provider API key
and the mesh `pgUrl` password already sit in the plain settings DataStore beside
it, so wrapping one value would be theatre. Encrypting that whole surface at
once is the honest follow-up and is recorded below.

**Where it is supplied:** `HarnessPlaneRepository.tokenFor`, the seam #479 left
open. One lambda now feeds the control-plane client, the legacy
`/api/terminal/harness-sessions` scan it unions with, and the remote terminal's
`DenTermClient`. A tokenless node behaves exactly as before.

**On every transport the bearer is a header, including the sockets.** den's gate
reads `Authorization` on an upgrade request exactly as it does on a GET
(`services/den-server/src/server.ts`); `?token=` exists because a browser's
`WebSocket` constructor cannot set headers, which is not a constraint OkHttp
has. So no Android URL — control-plane tail, registry watch, or remote terminal
— ever carries a credential, and none can end up in a proxy or access log. A
unit test asserts each of those URLs is credential-free, so a regression that
puts the token back in the query string fails the build.

**Rotation.** `rivetos gateway token --rotate` writes a new token file and tells
the operator to restart rivetos — the running gateway holds the old value until
then (`packages/cli/src/commands/gateway.ts`). So the refusal does not arrive at
mint time; it arrives at the next node restart, by which point the phone's
stored bearer is simply wrong and nothing on the device knows why. A 401 is
therefore not one condition, and the app says which:
with no bearer stored it reads "gateway is token-gated — add a token", with a
bearer this node has never accepted "token rejected", and with a bearer it *has*
accepted "the node rotated it; paste the new one". The acceptance bit lives next
to the credential, so the distinction survives a process restart rather than
only holding within one app run. Only an explicit 401/403 counts as an auth
answer — a 404 from a node with no control plane, or a phone with no route, is
`INDETERMINATE` and never downgrades a known verdict. The probe is the snapshot
read the drawer already polls, so a node that starts gating surfaces within one
poll instead of waiting for a chat thread to fail. All of it is reporting only:
the legacy degrade runs underneath the whole time, unconditional and unchanged.

Gaps this slice records rather than fixes:

- **The credential surface is not encrypted at rest.** This file is app-private
  and out of every backup, which is strictly more than the settings DataStore
  gets, but the provider API keys and `MeshConfig.pgUrl` next door are still
  plaintext. Wrapping all of them in one keystore-backed store is a single
  follow-up; wrapping only the newest one is not worth a dependency.
- **No probe button.** Web's Settings page tests the credential against
  `/healthz` + `/api/catalog` before saving. Here the verdict arrives on the
  next drawer poll instead.
- **Auth state is fed only by the snapshot read.** A 401 that kills a bound
  thread's socket still surfaces as that thread's error bubble (unchanged), not
  as a roster-level verdict.

Tests: `app/src/test/java/dev/rivet/app/data/node/` for the store's keying,
blank/clear handling and the acceptance bit's reset on replacement, plus the
state machine and registry; `app/src/test/java/dev/rivet/app/data/harness/HarnessPlaneTokenTest.kt`
answers OkHttp in-process so the assertions are on the `Authorization` header
the production client actually emits, and covers the 401 degrade, per-node
precedence, and 404/unreachable staying silent about auth.

---

## Phase 4 — Client product polish

- [ ] RivetHub web: chat = harness transcript + live events; dens all harness types
- [ ] Desktop: thin shell over hub/gateway
- [ ] Android: thin remote client (sessions / stream / approvals parity with web)
- [ ] Capability-aware UI (hide interrupt/approvals when flags false)

---

## Phase 5 — Docs, channel deprecation, prune

- [ ] Docs: `ARCHITECTURE` + hub setup = harness-first node OS
- [ ] Finalize Telegram / Discord / voice-discord deprecation in docs and config examples (decision announced at Phase 0; executed here)
- [ ] Remove channel plugins when no longer required for install
- [ ] Demote provider plugins for interactive use (docs + defaults)
- [ ] God-file splits **as touched**: task/store, den devices/server, boot agents
- [ ] AI SDK stays until optional ProviderPort extract
- [ ] Prune Claude-only gateway branches and legacy session key formats

**Optional later (not required for done):** extract `ProviderPort` / drop core `ai` import for non-harness paths; fuller DDD split after harness path is stable.

---

## Non-goals (for now)

- Big-bang rewrite off the AI SDK
- Adopting Mastra / Buzz / T3 (or similar) as dependencies
- Telegram / Discord / voice feature parity or new social-channel investment
- Full clean-architecture core split before the harness control plane works
- Rivet-owned coding tool loop competing with harnesses
- Per-harness session identity schemes or hub-only session ids
- Mesh-global session uniqueness (node-local is enough)
- Replacing capture/memory/MCP with an SDK-centric stack

---

## Definition of done

1. **Node control plane:** four harnesses via `HarnessDriver`, one `SessionId` model, gateway list/start/resume/turn/interrupt/approvals/stream. **Driver work complete** as of `kimi-code`: `GET /api/harnesses` lists all four on a real node, each a thin `PtyHarnessDriver` subclass, each with honest flags. Two of the four (`hermes`, `kimi-code`) refuse `start` because their harness has no flag to pin a new session's id — recorded as a harness limitation, not a contract gap.
2. **Clients:** web + desktop + Android full per-node harness UX on that contract.
3. **Capture/memory:** all four hosts keyed by canonical `SessionId` (aliases for rotations/legacy).
4. **Channels:** deprecated in product docs; removed or inert per Phase 5.
5. **Repo:** CI trustworthy (real tests + typecheck); docs describe harness-first node OS; Claude is the reference driver others match.

**Risk:** capture/den code that assumes Rivet-minted `session_key` shapes without harness prefix — migrate with aliases; do not dual-write forever. Capture stays harness-adjacent (hooks/transcript/plugins), not AI-SDK-adjacent.

**PR sequence:** Phase 1 hygiene → Phase 2 contract + Claude + gateway → Phase 3 other drivers + hub/Android → Phase 4 polish → Phase 5 prune/docs.
