/**
 * Chat drawer ↔ harness control plane binding (pure logic).
 *
 * Two session sources feed the drawer: the control plane
 * (`GET /api/harnesses/:id/sessions`) for harnesses with a registered driver
 * (`claude-code` today), and the on-disk store scan
 * (`/api/terminal/harness-sessions`) which still reads every roster harness
 * (grok, hermes) — dropping the scan would delete those conversations.
 *
 * So the drawer unions the two, keyed by native session id, with the control
 * plane winning: a driver-owned row carries a canonical `SessionId`, a harness
 * badge and a real status, and the hub then talks to it through
 * `/api/harness-sessions/*` instead of the PTY inject path. Rows the plane
 * does not claim keep the legacy binding verbatim until their driver lands
 * (Phase 3) — no user-facing toggle, no legacy mode to pick.
 *
 * Chat keys are the canonical `SessionId` for every row the plane claims —
 * the identity table's "Hub chat → thread external key = SessionId". The den
 * keeps its own key space (the room key a PTY runs under, which IS the native
 * id), and den-server resolves a canonical id onto it at every edge, so one
 * key drives the PTY, the transcript watch, the ring and the memory
 * conversation without anything being dual-keyed here.
 *
 * Precedence for what stays bare (§ Legacy keys): a `draft` has no harness yet
 * — its id is a locally minted uuid that the first spawn pins — and a `legacy`
 * row is one no registered driver claimed, which by construction has no
 * harness id to canonicalize with. With all four drivers registered every
 * on-disk row IS claimed, so `legacy` is the degraded path (a node with
 * drivers disabled, a plane fetch that failed), not the normal one.
 *
 * The union itself still joins on the NATIVE id, because that is the only
 * field the two lists share: a legacy row carries a roster token, not a
 * harness id.
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
  /**
   * Thread key. Chat state (store records, persisted name/settings, the
   * drawer's React key, `active`) is filed under this. Canonical
   * `<harness-id>:<native>` for `harness` rows; the bare native id for
   * `draft` and `legacy` rows, which have no harness id to canonicalize with.
   */
  key: string
  kind: ChatItemKind
  title: string
  /** Canonical `<harness-id>:<native>` — set for `harness` rows only, where
   *  it is also `key`. */
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
  'deepseek-harness': 'dsh',
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
  const native = nativeIdOf(key) ?? key
  const tail = native.slice(-6)
  return tail.length < native.length ? `…${tail}` : native
}

/**
 * The den's key for a thread: its room key, which IS the native id.
 *
 * The identity table canonicalizes hub chat's thread key, not the den's room
 * key — a room is a den-v1 concept that predates the harness contract and
 * holds plenty of non-harness strings. den-server accepts either shape on
 * every session-keyed edge, so this only matters where the hub hands an id to
 * something OUTSIDE den-server: the den viewer iframe's `?session=`, which is
 * read by the viewer bundle and matched against the room keys in its own
 * snapshot.
 */
export function denRoomKey(chatKey: string): string {
  return nativeIdOf(chatKey) ?? chatKey
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
  // Keyed by NATIVE id: it is the only field both lists carry, so it is what
  // decides "these two rows are one session". The row's own `key` (canonical
  // for a claimed row) is a field on the value, not this map's key — a draft
  // and a legacy row are still deduped against the plane row that adopted
  // them, which is what keeps the drawer from double-rendering a session.
  const items = new Map<string, ChatItem>()

  for (const summary of input.harnessSessions) {
    const native = nativeIdOf(summary.sessionId)
    if (native === undefined) continue // a malformed id is the node's bug, not a row
    const legacy = legacyByKey.get(native)
    items.set(native, {
      key: summary.sessionId,
      kind: 'harness',
      title: summary.title ?? legacy?.title ?? native,
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
 * The row that owns a thread key, tolerating a key that has been canonicalized
 * underneath the selection.
 *
 * A draft is a bare uuid until the plane adopts it, and adoption replaces the
 * row with a canonical-keyed one — leaving `active` on a key no row carries,
 * the same back-compat case a stale selection or a pasted uuid hits. Match on
 * the key first, then on the native half, which survives adoption.
 *
 * It does NOT survive ROTATION: a rotated session replaces the native half
 * outright, so no amount of matching here can connect the old key to the new
 * row. That is why rotation is driven by the registry event, which carries
 * `previousSessionId` — see `useChat.adoptSessionKey`.
 */
export function findChatItem(items: ChatItem[], key: string | undefined): ChatItem | undefined {
  if (key === undefined) return undefined
  const exact = items.find((it) => it.key === key)
  if (exact) return exact
  const native = denRoomKey(key)
  return items.find((it) => it.key !== key && denRoomKey(it.key) === native)
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

/**
 * Fast path for the driver-level registry stream (`session-created`): merge the
 * carried `HarnessSessionSummary` into the plane session list so the drawer
 * paints the new row before the list refetch round-trips. Upserts by
 * `sessionId` — a refetch (or a duplicate event) that lands after the merge
 * must not create a second row. The summary is stored as-is: it is the same
 * shape `listSessions` returns, so a merged row is indistinguishable from a
 * fetched one for plane-selection (`harnessGate` / `chatItems`).
 *
 * Returns a new array; when the id is already present, the carried summary
 * wins field-for-field (status/title/updatedAt from the event are fresher).
 */
export function mergeSessionCreated(
  sessions: HarnessSessionSummary[],
  summary: HarnessSessionSummary,
): HarnessSessionSummary[] {
  const i = sessions.findIndex((s) => s.sessionId === summary.sessionId)
  if (i < 0) return [summary, ...sessions]
  if (sessions[i] === summary) return sessions
  const next = sessions.slice()
  // Prefer the event payload wholesale — it is a full SessionSummary, not a
  // partial patch. Spread-over-existing would keep stale optional fields
  // (title/cwd) the driver deliberately cleared.
  next[i] = summary
  return next
}

/** Trivial `session-updated` fields the registry stream carries. */
export type SessionUpdatedPatch = {
  sessionId: SessionId
  /** Native-id rotation: rewrite the row keyed by the previous id. */
  previousSessionId?: SessionId
  status: HarnessSessionSummary['status']
}

/**
 * Fast path for registry `session-updated`: patch status in place (and rewrite
 * `sessionId` when the native id rotates). Unknown ids are left alone — the
 * caller's invalidation/refetch is the recovery path for a missed
 * `session-created`. Returns the same array reference when nothing matched so
 * callers can skip a cache write.
 */
export function patchSessionUpdated(
  sessions: HarnessSessionSummary[],
  patch: SessionUpdatedPatch,
): HarnessSessionSummary[] {
  const lookFor = patch.previousSessionId ?? patch.sessionId
  const i = sessions.findIndex((s) => s.sessionId === lookFor || s.sessionId === patch.sessionId)
  if (i < 0) return sessions
  const cur = sessions[i]
  if (cur.sessionId === patch.sessionId && cur.status === patch.status) return sessions
  const next = sessions.slice()
  next[i] = { ...cur, sessionId: patch.sessionId, status: patch.status }
  // A rotation can race a create under the new id — keep one row.
  if (patch.previousSessionId && patch.previousSessionId !== patch.sessionId) {
    return next.filter((s, idx) => idx === i || s.sessionId !== patch.sessionId)
  }
  return next
}

/**
 * Apply a registry-stream event to a plane session list. Pure; the React
 * layer feeds this into `queryClient.setQueryData` and still invalidates as
 * reconciliation. Non-registry event types (turn-*, approval-*, …) are no-ops.
 *
 * `prev === undefined` (query never resolved) seeds from a `session-created`
 * so the drawer is not blank while the first fetch is in flight; other events
 * leave the cache empty and rely on invalidation.
 */
export function applyRegistryEventToPlaneSessions(
  prev: HarnessSessionSummary[] | undefined,
  event: {
    type: string
    sessionId: SessionId
    summary?: HarnessSessionSummary
    previousSessionId?: SessionId
    status?: HarnessSessionSummary['status']
  },
): HarnessSessionSummary[] | undefined {
  if (event.type === 'session-created') {
    if (!event.summary) return prev
    return mergeSessionCreated(prev ?? [], event.summary)
  }
  if (event.type === 'session-updated') {
    if (!prev || event.status === undefined) return prev
    return patchSessionUpdated(prev, {
      sessionId: event.sessionId,
      previousSessionId: event.previousSessionId,
      status: event.status,
    })
  }
  return prev
}
