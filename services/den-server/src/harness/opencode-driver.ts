/**
 * `opencode` — HarnessDriver for the OpenCode CLI (anomalyco/opencode).
 *
 * Same adopting shape as kimi-code / hermes / dsh: OpenCode mints its own
 * session id and (as of the wiring date) has no verified flag to pin a new
 * one from the control plane, so `startSession` is refused and the plane
 * adopts whatever the CLI created.
 *
 *   | Contract method | Existing machinery it wraps                                 |
 *   |-----------------|-------------------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['opencode'])` — opencode.db SQLite     |
 *   | getSession      | `describeOpencodeSession`                                   |
 *   | startSession    | **refused** — see "no pinning" below                        |
 *   | resumeSession   | term manager spawn-or-get → `opencode --session <id>`       |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`                    |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)` (Esc)      |
 *   | subscribe       | den AgentEvent ingest tap (when a hook stamps an id)        |
 *   | transcript      | `readOpencodeTranscript`                                    |
 *
 * **Identity.** Native ids are `ses_` + 20+ alphanumerics (OpenCode 1.18.30).
 * Canonical form is `opencode:ses_…`.
 *
 * **No pinning.** There is no flag to pin a NEW session id (`opencode run`
 * mints `ses_…` itself). A missing `-s/--session` id fails with a non-zero
 * exit — treated as `session_not_found`. Same adopting shape as kimi.
 *
 * See docs/ARCHITECTURE.md.
 */

import { formatSessionId, type SessionId } from '@rivetos/types'
import { AdoptingPtyHarnessDriver } from './adopting-harness-driver.js'
import {
  type DenAgentEventLike,
  type HarnessPtyHost,
  type HarnessStoreHost,
  type PtyHarnessDriverDeps,
} from './pty-harness-driver.js'

export const OPENCODE_HARNESS_ID = 'opencode' as const
/** Roster key the den term manager spawns OpenCode under. */
export const OPENCODE_ROSTER_COMMAND = 'opencode'

export type OpencodePtyHost = HarnessPtyHost

/**
 * The slice of the OpenCode SQLite store this driver needs. `exists` is
 * required like grok's and kimi's: a row in `session` is existence.
 */
export interface OpencodeStoreHost extends HarnessStoreHost {
  /** Does the session row exist in opencode.db? Sync. */
  exists(nativeId: string): boolean
  /**
   * Newest session id for `cwd` created at or after `sinceMs`. Fresh roster
   * spawns learn their native id from this when no hook stamped
   * `harnessSession`. Optional so existing test fakes still typecheck.
   */
  newestAfter?(cwd: string, sinceMs: number): string | undefined
}

export type OpencodeDriverDeps = PtyHarnessDriverDeps<OpencodeStoreHost>

/** OpenCode 1.18.30 session ids are `ses_` + 20+ alphanumerics. */
const OPENCODE_NATIVE_RE = /^ses_[A-Za-z0-9]{20,}$/

export class OpencodeDriver extends AdoptingPtyHarnessDriver<OpencodeStoreHost> {
  constructor(deps: OpencodeDriverDeps) {
    super(
      {
        harnessId: OPENCODE_HARNESS_ID,
        rosterCommand: OPENCODE_ROSTER_COMMAND,
        productName: 'OpenCode',
        noPinReason:
          'opencode: starting a session through the control plane is not supported — opencode has ' +
          'no flag to pin a new session id (`run` mints `ses_…` itself; a missing `-s` id exits ' +
          'non-zero), so the control plane cannot name the session it would be creating. ' +
          'Spawn opencode from the den roster; the driver adopts it when its hooks announce an id.',
      },
      deps,
    )
  }

  /** `opencode:<native>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(OPENCODE_HARNESS_ID, nativeId)
  }

  /**
   * OpenCode's OWN session id off a den event, or undefined when the hook did
   * not report one. Only the `ses_…` shape is accepted — the translator's
   * `unknown-<hex>` fallback is a room key, never a store id.
   */
  protected override announcedNative(ev: DenAgentEventLike): string | undefined {
    const raw = ev.harnessSession
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    if (!trimmed || !OPENCODE_NATIVE_RE.test(trimmed)) return undefined
    return trimmed
  }

  /**
   * An OpenCode running outside den would post under its canonical id as the
   * room key (`opencode:ses_…`). Recover the native id from that shape — and
   * only that shape.
   */
  protected override canonicalRoomNative(room: string): string | undefined {
    const prefix = `${OPENCODE_HARNESS_ID}:`
    if (!room.startsWith(prefix)) return undefined
    const native = room.slice(prefix.length)
    return OPENCODE_NATIVE_RE.test(native) ? native : undefined
  }

  /**
   * Fresh roster spawn: den emits a synthetic `rivetos` session.start with
   * no `harnessSession` (OpenCode has no den hook). Learn the native id from
   * the newest session row for the room's cwd created after spawn, then bind
   * as if the hook had stamped it.
   */
  protected override nativeFor(ev: DenAgentEventLike): string | undefined {
    const existing = super.nativeFor(ev)
    if (existing) return existing
    const room = ev.session
    if (!room) return undefined
    const isRoster =
      ev.harness === 'rivetos' &&
      typeof ev.name === 'string' &&
      ev.name.endsWith(`:${this.rosterCommand}`)
    if (!isRoster) return undefined
    if (ev.type === 'session.start') this.pendingSpawn.set(room, this.now())
    const native = this.adoptFromStore(room)
    if (native) {
      this.bindRoom(room, native)
      return native
    }
    if (ev.type === 'session.start') this.scheduleAdopt(room)
    return undefined
  }

  private readonly pendingSpawn = new Map<string, number>()

  private adoptFromStore(room: string): string | undefined {
    const cwd = this.deps.cwd?.() ?? ''
    const since = (this.pendingSpawn.get(room) ?? this.now()) - 2_000
    const id = this.deps.store.newestAfter?.(cwd, since)
    if (id && OPENCODE_NATIVE_RE.test(id)) return id
    return undefined
  }

  private scheduleAdopt(room: string): void {
    for (const ms of [250, 1_000, 3_000]) {
      const t = setTimeout(() => {
        if (this.roomNative.has(room)) return
        const native = this.adoptFromStore(room)
        if (native) this.bindRoom(room, native)
      }, ms)
      t.unref()
    }
  }
}
