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

> **Phase 3 breaking change:** hermes capture today handles rotation as "close old key, open new conversation" with no alias. The hermes driver MUST adopt alias semantics — do not ship the old close+new behavior under the new interface.

### Legacy keys → SessionId (migration aliases)

The repo already holds several key shapes for one interactive session. Phase 2 defines this table as **mandatory alias precedence** — without it, migration mints duplicate conversations:

| Legacy shape | Where | Disposition |
|--------------|-------|-------------|
| `claude-code:<session-uuid>` | Capture (preferred path) | Already canonical — wins over all others |
| `claude-code:<project-slug>/<uuid>` | Capture path-fallback (`deriveSessionKey`) | Alias → `claude-code:<uuid>` once the session uuid is known; uuid form is canonical |
| Bare native uuid | Den drawer, hub chat conversation id | Alias → `<harness-id>:<uuid>` during Phase 2 migration; hub external key updated in place |
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

`services/den-server/src/harness/` — the registry, the `claude-code` and
`grok-build` drivers, and the routes all live in den-server because that is
where the machinery they formalize already is (term manager, the harnesses'
on-disk stores, den AgentEvent ingest). Boot registers both built-ins by
starting the gateway; the remaining Phase 3 drivers pass through
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

| Flag | `claude-code` | `grok-build` | Why |
|------|---------------|--------------|-----|
| `interrupt` | den terminals enabled | den terminals enabled | Esc through the term manager's `inject(..., interrupt)`; no PTY, no interrupt |
| `resume` | den terminals enabled | den terminals enabled | `--resume <id>` through the term manager's spawn-or-get |
| `approvals` | **false** | **false** | Both surface permission prompts inside their own TUI; the den wire carries neither a request nor a decision channel. `resolveApproval` → 501 |
| `liveStream` | den event tap present | den event tap present | The driver's only live source is den AgentEvent ingest |
| `listSessions` | true | true | A store scan: `~/.claude/projects` / `~/.grok/sessions` |

Both reject `cwd`/`model` on `startSession` (roster-owned) and attachments on
`sendUserTurn`, with `capability_unsupported` rather than ignoring them
silently. The attachment rejection stands even now that staging exists — a PTY
paste has no way to hand a file to a TUI; see below.

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

**Follow-ups, deliberately not taken here:**

- The two PTY drivers now share most of a state machine (live map,
  quiet-window failsafe, LIFO tool pairing, den event mapping). Extracting a
  common base is the right move at driver three — `kimi-code` or `hermes`,
  whichever lands next — when there is a third data point to shape it. Doing it
  on the second would be guessing at the abstraction while also destabilizing
  the reference driver. `DenAgentEventLike` lives in `claude-driver.ts` and
  `grok-driver.ts` imports it from there; that is fine at two drivers and moves
  to the shared base at the same time.
- **`claude-store.ts:23` still reads through the first-hit-wins
  `readHarnessTranscript`** (`term/harness-sessions.ts:782`, claude → grok →
  hermes), so a `claude-code` id whose `.jsonl` has been deleted or rotated
  away can be served a *grok* transcript. Pre-existing, and the exact
  asymmetry `readGrokTranscript` now fixes on the grok side; give Claude the
  same store-scoped reader.

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

- Capability flags are **declared at construction, not runtime-probed**.
  `claude-code` reads `interrupt`/`resume` off whether den terminals are
  *enabled*; if `node-pty` then fails to load, `GET /api/harnesses` keeps
  advertising `true` while the methods answer 501. The rejection is honest;
  the advertisement is optimistic.
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
against a fake.

---

## Phase 3 — Multi-harness parity + hub binding

- [x] **Grok Build driver:** promote hooks/capture → gateway stream (`grok-build:…`) — see As built (grok-build) below
- [ ] **Hermes driver:** same; memory/den already exist (`hermes:…`)
- [x] **Kimi den hooks:** `integrations/kimi/rivet-den` streams kimi-code sessions into a den under the canonical `kimi-code:<native>` — the same key capture writes, so room and conversation join on one identity
- [ ] **Kimi driver:** the gateway half is still to come; it also has to supply what the hooks cannot — kimi's `Stop` payload carries no assistant reply, so a hook-only kimi den shows prompts, tools and plan but no agent messages. Capture stays as-is (`kimi-code:…`)
- [x] Tasks: `harness-session` executors per harness id — includes renaming/aliasing the existing executor agent id `claude-cli` → `claude-code`; grok-build/kimi-code/hermes register as explicit rejections, not absences — see As built (per-harness task executors) below
- [ ] Hermes rotation migrated from close+new-conversation to alias semantics (breaking, see Session identity § Rotation)
- [x] **Hub chat** binds the harness API (`apps/rivethub-web`) — see below
- [ ] **Hub:** tasks / dens bind multi-harness API (not Claude-only)
- [ ] Den: list all harness types under one naming scheme
- [ ] **Android:** same gateway APIs — full remote parity (no on-device agent loop)

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

**Registrations are honest, not aspirational.** Only `claude-code` has
node-side headless spawn machinery in this repo: the grok integration here
drives an interactive PTY (term manager `--session-id`/`--resume`, hook-fed
capture) and kimi is hooks plus capture with a `Stop` payload that carries no
assistant reply. Rather than invent headless drivers, every harness id without
one registers an explicit rejecting executor — including `claude-code` itself
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
through `sendUserTurn`; the drawer badges its harness id. Rows no driver claims
— hermes and kimi, until their Phase 3 drivers land — keep the existing gateway
chat channel binding verbatim, so nothing disappears from the drawer. The chat
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

- **Hub chat's key is still the bare native id**, not the canonical
  `SessionId` the identity table asks for. It is the den join key that the PTY,
  the den viewer's `?session=`, the transcript watch and the memory
  conversation key all share; moving it is a den-server change, not a client
  one. The canonical id rides alongside and is what every control-plane call
  and the chat header use.
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

1. **Node control plane:** four harnesses via `HarnessDriver`, one `SessionId` model, gateway list/start/resume/turn/interrupt/approvals/stream.
2. **Clients:** web + desktop + Android full per-node harness UX on that contract.
3. **Capture/memory:** all four hosts keyed by canonical `SessionId` (aliases for rotations/legacy).
4. **Channels:** deprecated in product docs; removed or inert per Phase 5.
5. **Repo:** CI trustworthy (real tests + typecheck); docs describe harness-first node OS; Claude is the reference driver others match.

**Risk:** capture/den code that assumes Rivet-minted `session_key` shapes without harness prefix — migrate with aliases; do not dual-write forever. Capture stays harness-adjacent (hooks/transcript/plugins), not AI-SDK-adjacent.

**PR sequence:** Phase 1 hygiene → Phase 2 contract + Claude + gateway → Phase 3 other drivers + hub/Android → Phase 4 polish → Phase 5 prune/docs.
