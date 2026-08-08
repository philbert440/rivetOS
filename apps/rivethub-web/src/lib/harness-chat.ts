/**
 * Chat drawer ↔ harness control plane binding (pure logic).
 *
 * The drawer used to be one list: the node's on-disk harness stores, read
 * through the legacy `/api/terminal/harness-sessions` scan. The control plane
 * (`GET /api/harnesses/:id/sessions`) is the surface that replaces it, but
 * only for harnesses that actually have a registered driver — `claude-code`
 * today. The legacy scan still reads every roster harness (grok, hermes), so
 * dropping it now would delete those conversations from the drawer.
 *
 * So the drawer unions the two, keyed by native session id, with the control
 * plane winning: a driver-owned row carries a canonical `SessionId`, a harness
 * badge and a real status, and the hub then talks to it through
 * `/api/harness-sessions/*` instead of the PTY inject path. Rows the plane
 * does not claim keep the legacy binding verbatim until their driver lands
 * (Phase 3) — no user-facing toggle, no legacy mode to pick.
 *
 * Chat keys stay the BARE NATIVE id, not the canonical `SessionId`: it is the
 * den join key that the PTY, the den viewer (`?session=`), the transcript
 * watch and the memory conversation key are all filed under. The canonical id
 * rides alongside on the item and is what every control-plane call uses.
 */

import {
  parseSessionId,
  type HarnessCapabilities,
  type HarnessDescriptor,
  type HarnessId,
  type HarnessSession,
  type HarnessSessionSummary,
  type SessionId,
} from '@rivetos/types'

/** How a chat row is driven. */
export type ChatItemKind =
  /** Local uuid with no store file yet — legacy spawn pins it on first send. */
  | 'draft'
  /** Claimed by a registered driver: control-plane send / stream / resync. */
  | 'harness'
  /** On disk but no driver owns it yet (grok, hermes) — legacy PTY binding. */
  | 'legacy'

export interface ChatItem {
  /** Den join key = bare native session id. Chat state is filed under this. */
  key: string
  kind: ChatItemKind
  title: string
  /** Canonical `<harness-id>:<native>` — set for `harness` rows only. */
  sessionId?: SessionId
  harnessId?: HarnessId
  /** Den roster command ('claude', 'grok', …) — PTY spawn + accent color. */
  command?: string
  status?: HarnessSessionSummary['status']
  /** epoch ms, for ordering */
  updatedAt: number
}

/**
 * Den roster keys per harness id. Only a fallback: the on-disk row's own
 * `command` wins whenever the legacy scan also saw the session, which is the
 * normal case (both surfaces read the same store). Roster tokens are UI/spawn
 * labels — never key material (harness-control-plane.md § Legacy keys).
 */
const ROSTER_COMMAND: Record<HarnessId, string> = {
  'claude-code': 'claude',
  'grok-build': 'grok',
  'kimi-code': 'kimi',
  hermes: 'hermes',
}

/** Native half of a canonical id; undefined when it doesn't parse. */
export function nativeIdOf(sessionId: string): string | undefined {
  try {
    return parseSessionId(sessionId).nativeSessionId
  } catch {
    return undefined
  }
}

/** Drawer badge suffix — enough of the native id to tell two rows apart. */
export function shortNativeId(key: string): string {
  const tail = key.slice(-6)
  return tail.length < key.length ? `…${tail}` : key
}

/**
 * Merge drafts + control-plane sessions + legacy store rows into one drawer
 * list. Drafts stay pinned on top (they have no activity timestamp yet);
 * everything else is newest-first.
 */
export function chatItems(input: {
  drafts: string[]
  harnessSessions: HarnessSessionSummary[]
  legacySessions: HarnessSession[]
}): ChatItem[] {
  const legacyByKey = new Map(input.legacySessions.map((s) => [s.id, s] as const))
  const items = new Map<string, ChatItem>()

  for (const summary of input.harnessSessions) {
    const key = nativeIdOf(summary.sessionId)
    if (key === undefined) continue // a malformed id is the node's bug, not a row
    const legacy = legacyByKey.get(key)
    items.set(key, {
      key,
      kind: 'harness',
      title: summary.title ?? legacy?.title ?? key,
      sessionId: summary.sessionId,
      harnessId: summary.harnessId,
      command: legacy?.command ?? ROSTER_COMMAND[summary.harnessId],
      status: summary.status,
      updatedAt: Date.parse(summary.updatedAt) || legacy?.updatedAt || 0,
    })
  }

  for (const row of input.legacySessions) {
    if (items.has(row.id)) continue // the control plane owns this one
    items.set(row.id, {
      key: row.id,
      kind: 'legacy',
      title: row.title,
      command: row.command,
      updatedAt: row.updatedAt,
    })
  }

  const listed = [...items.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const drafts: ChatItem[] = input.drafts
    .filter((id) => !items.has(id))
    .map((id) => ({ key: id, kind: 'draft', title: 'new conversation', updatedAt: 0 }))
  return [...drafts, ...listed]
}

/**
 * What the UI may offer for a row. Capability flags are the contract's gate:
 * a method whose flag is false answers 501 `capability_unsupported`, so the
 * affordance is hidden rather than shown-and-failing.
 */
export interface HarnessGate {
  /** Driver-owned: turns go through `sendUserTurn`, not the PTY inject path. */
  bound: boolean
  /** Tail `WS /api/harness-sessions/ws` + hard-resync instead of the legacy
   *  server-pushed transcript watch. */
  stream: boolean
  canInterrupt: boolean
  canApprove: boolean
  canResume: boolean
}

const CLOSED: HarnessGate = {
  bound: false,
  stream: false,
  canInterrupt: false,
  canApprove: false,
  canResume: false,
}

/**
 * Resolve a row against the node's registry sheet.
 *
 * `liveStream: false` keeps the row on the legacy transcript watch (the
 * server's file watcher still pushes deltas) while turns still go through the
 * control plane — the send path does not need a stream.
 */
export function harnessGate(
  item: Pick<ChatItem, 'kind' | 'harnessId' | 'sessionId'> | undefined,
  descriptors: HarnessDescriptor[] | undefined,
): HarnessGate {
  if (!item || item.kind !== 'harness' || !item.harnessId || !item.sessionId) return CLOSED
  const caps: HarnessCapabilities | undefined = descriptors?.find(
    (d) => d.harnessId === item.harnessId,
  )?.capabilities
  if (!caps) return CLOSED
  return {
    bound: true,
    stream: caps.liveStream,
    canInterrupt: caps.interrupt,
    canApprove: caps.approvals,
    canResume: caps.resume,
  }
}

/** Harnesses whose sessions the hub should ask for (`listSessions` gated). */
export function listableHarnesses(descriptors: HarnessDescriptor[] | undefined): HarnessId[] {
  return (descriptors ?? []).filter((d) => d.capabilities.listSessions).map((d) => d.harnessId)
}

/**
 * `turn_in_flight` (HTTP 409) — the driver is mid-turn. v1 drivers MUST NOT
 * silently queue, so this is the caller's cue to keep the turn queued and
 * retry, not to fail it. Matched structurally on the typed wire code (the
 * status alone also covers `session_id_collision`).
 */
export function isTurnInFlight(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { status, body } = err as { status?: unknown; body?: unknown }
  if (status !== 409) return false
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'turn_in_flight'
  )
}

/** The slice of RivetGateway the drawer's session fetch needs. */
export interface HarnessListGateway {
  harnessSessionList(
    harnessId: HarnessId,
    signal?: AbortSignal,
  ): Promise<{ sessions: HarnessSessionSummary[] }>
}

/**
 * Every driver's sessions, in one list. One driver failing (a store it can't
 * read, a node mid-restart) must not blank the whole drawer, so failures are
 * dropped rather than rejected — the legacy scan still backs those rows.
 */
export async function fetchHarnessPlaneSessions(
  gateway: HarnessListGateway,
  descriptors: HarnessDescriptor[] | undefined,
  signal?: AbortSignal,
): Promise<HarnessSessionSummary[]> {
  const ids = listableHarnesses(descriptors)
  const settled = await Promise.allSettled(ids.map((id) => gateway.harnessSessionList(id, signal)))
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value.sessions : []))
}
