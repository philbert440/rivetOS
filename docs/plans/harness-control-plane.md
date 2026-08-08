---
title: Harness Control Plane
status: accepted
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
export type HarnessId =
  | 'claude-code'
  | 'grok-build'
  | 'kimi-code'
  | 'hermes';

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
      type: 'turn-complete';
      sessionId: SessionId;
      turnId?: string;
      stopReason?: string;
    }
  | {
      type: 'error';
      sessionId: SessionId;
      code: string;
      message: string;
      retriable?: boolean;
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
  listSessions(): Promise<SessionSummary[]>;
  getSession(sessionId: SessionId): Promise<SessionSummary | null>;
}
```

**Gateway surface (Phase 2)** — names are the contract; HTTP vs den RPC follows existing den-server patterns:

| Endpoint (conceptual) | Behavior |
|-----------------------|----------|
| `GET /harnesses` | Drivers + capability flags |
| `POST /harnesses/:id/sessions` | `startSession` |
| `GET /harnesses/:id/sessions` | `listSessions` |
| `POST /sessions/:sessionId/resume` | `resumeSession` |
| `POST /sessions/:sessionId/turns` | `sendUserTurn` |
| `POST /sessions/:sessionId/interrupt` | `interrupt` |
| `POST /sessions/:sessionId/approvals/:requestId` | `resolveApproval` |
| `GET` / `WS /sessions/:sessionId/events` | `subscribe` stream |

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
| Encoding | UTF-8; trim reject; empty native id invalid |
| Case | `harness-id` fixed lowercase; native id preserved as emitted |

**Examples:** `claude-code:a1b2c3d4-…`, `grok-build:sess_01HZX…`, `kimi-code:2026-08-08T12:00:00Z_abc`, `hermes:thread-42`.

```typescript
function parseSessionId(id: string): { harnessId: HarnessId; nativeSessionId: string } {
  const i = id.indexOf(':');
  if (i <= 0 || i === id.length - 1) throw new Error('invalid SessionId');
  const harnessId = id.slice(0, i) as HarnessId;
  const nativeSessionId = id.slice(i + 1);
  // validate harnessId ∈ enum
  return { harnessId, nativeSessionId };
}
```

### Mapping (single standard → all surfaces)

| Surface | Field | Value |
|---------|-------|--------|
| Canonical | `SessionId` | `<harness-id>:<native-session-id>` |
| ros_messages / capture | `conversation_id` / `session_key` (conversation key) | **Exactly** `SessionId` |
| Capture plugins | Host label in JSONL | Normalize to `SessionId` before write (no bare native ids) |
| Den harness-session | Resource name | `harness-session/<SessionId>` (encode if den requires; **round-trip recovers same SessionId**) |
| Hub chat | Thread external key | `SessionId` (UI may badge harness + short native suffix) |
| Tasks | Executor payload | type `harness-session` + `sessionId: SessionId` |
| Gateway | `:sessionId` param | URL-encoded `SessionId` |

**Forbidden:** bare native ids in memory/den/hub; alternate prefixes (`claude:`, `cc:`, agent nicknames); dual keys that disagree between capture and den.

### Collision rules

1. **Uniqueness domain:** one node. Mesh addresses sessions as `{nodeId, sessionId}` only if needed later.
2. **Cross-harness:** different `harness-id` ⇒ different sessions even if native ids match.
3. **Same harness:** native ids unique per harness store; on collision return `session_id_collision` — never overwrite.
4. **Rehydrate:** if capture and den both have the same `SessionId`, one session. If only one side exists, create the missing mapping without minting a second id.
5. **No silent remap:** never change `harness-id` on an existing row.

### Resume semantics

| Case | Behavior |
|------|----------|
| `resumeSession(sessionId)` | Parse → driver for `harness-id` → attach to native id. Fail if unregistered/unknown. |
| Client reconnect (WS drop) | Same `SessionId`; re-`subscribe`; no new native session. |
| Hub opens existing chat | Bind by `SessionId`; `resumeSession` if not live-attached. |
| `startSession` | Always new native id → new `SessionId`. Never reuse. |
| Task executor | Payload carries `SessionId`; resume before send. |

Resume does **not** create a new conversation id. Capture continues under the same `SessionId`.

### Native session id rotation

When a harness rotates/replaces its native id (compact, fork, crash recovery):

1. Driver emits `session-updated` with `sessionId` = **new** canonical id and `previousSessionId` = old.
2. Control plane stores **alias** `previousSessionId → sessionId`. Latest id is canonical.
3. **Memory:** new events write under the **new** `SessionId`; queries resolve alias chain and union transcript history (prefer this over rewriting historical rows).
4. **Hub:** keep chat row; update external key to new id; store previous for deep links.
5. **Den:** rename or symlink `harness-session/<old>` → `harness-session/<new>`.
6. **Gateway:** superseded id redirects (`redirectedTo` / equivalent) to canonical; accept old id via alias for a grace period.
7. **Never** invent a Rivet-only third id not derived from harness native ids.

### Reference behavior (Claude)

Existing cli + den `harness-sessions` is the gold standard for attach/stream/interrupt. Phase 2 names those keys `claude-code:<native>` (alias legacy keys) and exposes them only through `HarnessDriver`.

---

## Phase 1 — Hygiene (CI honesty, dead exports)

- [ ] Fix `packages/cli` `"test": "echo no tests yet"` → real `vitest run` (no false-green)
- [ ] Add root `typecheck` to the `ci` pipeline
- [ ] Delete or wire dead exports (`rotateAuditLogs`, unused circuit-breaker reset) after verify
- [ ] Drop unused deps (`enquirer`, `sharp`, leftover `@types/pg`) after verify
- [ ] Refresh stale `CODEBASE-REFERENCE` / `ARCHITECTURE` claims
- [ ] CLI `showHelp()` completeness vs actual commands

**PR order:** (1) CI honesty → (2) dead exports/deps → (3) docs/help as needed.

---

## Phase 2 — Gateway harness API + Claude reference

- [ ] Land `HarnessDriver`, `HarnessEvent`, `SessionId` in shared package
- [ ] Parse/format helpers, alias store, den name encode/decode
- [ ] Driver registry on node boot
- [ ] **Claude reference driver** over claude-cli + den harness-sessions
- [ ] Migrate Claude keys to `claude-code:<native>` (+ aliases for legacy)
- [ ] Gateway: list harnesses, open/list/resume, turns, interrupt, approvals, event stream
- [ ] Capture writes canonical `SessionId` only
- [ ] Tests: first-colon parse, resume, alias redirect

---

## Phase 3 — Multi-harness parity + hub binding

- [ ] **Grok Build driver:** promote hooks/capture → gateway stream (`grok-build:…`)
- [ ] **Hermes driver:** same; memory/den already exist (`hermes:…`)
- [ ] **Kimi driver:** rivet-den hooks + driver; keep capture (`kimi-code:…`)
- [ ] Tasks: `harness-session` executors per harness id
- [ ] **Hub:** chat / tasks / dens bind multi-harness API (not Claude-only)
- [ ] Den: list all harness types under one naming scheme
- [ ] **Android:** same gateway APIs — full remote parity (no on-device agent loop)

---

## Phase 4 — Client product polish

- [ ] RivetHub web: chat = harness transcript + live events; dens all harness types
- [ ] Desktop: thin shell over hub/gateway
- [ ] Android: thin remote client (sessions / stream / approvals parity with web)
- [ ] Capability-aware UI (hide interrupt/approvals when flags false)

---

## Phase 5 — Docs, channel deprecation, prune

- [ ] Docs: `ARCHITECTURE` + hub setup = harness-first node OS
- [ ] Mark Telegram / Discord / voice-discord deprecated in docs and config examples
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
