/**
 * `cursor` — HarnessDriver for the Cursor agent CLI (`agent`).
 *
 * Adopting, same shape as opencode / hermes: `agent` mints its own chat id.
 * `--resume <chatId>` reopens an existing one. There is no `--session-id`,
 * so `startSession` is refused. A den roster spawn is `agent --force --trust`;
 * the driver adopts the uuid once the transcript appears under
 * `~/.cursor/projects/<slug>/agent-transcripts/`, or when a den hook stamps it.
 *
 *   | Contract method | Existing machinery it wraps                                      |
 *   |-----------------|------------------------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['cursor'])`                                |
 *   | getSession      | `describeCursorSession`                                          |
 *   | startSession    | **refused** — no pin flag                                        |
 *   | resumeSession   | term manager spawn-or-get → `agent --resume <id>`                |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`                         |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)` (Esc)           |
 *   | subscribe       | den AgentEvent ingest tap (when a hook stamps an id)             |
 *   | transcript      | `readCursorTranscript`                                           |
 *
 * **Identity.** Native ids are uuids. Canonical form is `cursor:<uuid>`.
 *
 * **This driver does not rotate.** A new chat is a new transcript file.
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

export const CURSOR_HARNESS_ID = 'cursor' as const
/** Roster key the den term manager spawns Cursor under. */
export const CURSOR_ROSTER_COMMAND = 'cursor'

export type CursorPtyHost = HarnessPtyHost

/**
 * The slice of the Cursor transcript store this driver needs. `exists` is
 * required: a `<uuid>/<uuid>.jsonl` file is existence.
 */
export interface CursorStoreHost extends HarnessStoreHost {
  exists(nativeId: string): boolean
  /**
   * Newest transcript id for `cwd` modified at or after `sinceMs`. Fresh
   * roster spawns learn their native id from this when no hook stamped
   * `harnessSession`.
   */
  newestAfter?(cwd: string, sinceMs: number): string | undefined
}

export type CursorDriverDeps = PtyHarnessDriverDeps<CursorStoreHost>

/** Cursor chat ids are uuids (the agent-transcripts directory name). */
const CURSOR_NATIVE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class CursorDriver extends AdoptingPtyHarnessDriver<CursorStoreHost> {
  constructor(deps: CursorDriverDeps) {
    super(
      {
        harnessId: CURSOR_HARNESS_ID,
        rosterCommand: CURSOR_ROSTER_COMMAND,
        productName: 'Cursor',
        noPinReason:
          'cursor: starting a session through the control plane is not supported — the Cursor ' +
          'agent CLI has no flag to pin a new chat id (`agent` mints the uuid itself; ' +
          '`--resume <chatId>` only reopens an existing one), so the control plane cannot name ' +
          'the session it would be creating. Spawn Cursor from the den roster; the driver ' +
          'adopts the chat when its transcript appears.',
      },
      deps,
    )
  }

  /** `cursor:<native>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(CURSOR_HARNESS_ID, nativeId)
  }

  /**
   * Cursor's own chat id off a den event, or undefined when the hook did not
   * report one. Only a uuid is accepted — the translator's `unknown-<hex>`
   * fallback is a room key, never a store id.
   */
  protected override announcedNative(ev: DenAgentEventLike): string | undefined {
    const raw = ev.harnessSession
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    if (!trimmed || !CURSOR_NATIVE_RE.test(trimmed)) return undefined
    return trimmed
  }

  /**
   * A Cursor running outside den would post under its canonical id as the
   * room key (`cursor:<uuid>`). Recover the native id from that shape.
   */
  protected override canonicalRoomNative(room: string): string | undefined {
    const prefix = `${CURSOR_HARNESS_ID}:`
    if (!room.startsWith(prefix)) return undefined
    const native = room.slice(prefix.length)
    return CURSOR_NATIVE_RE.test(native) ? native : undefined
  }

  /**
   * Fresh roster spawn: den emits a synthetic `rivetos` session.start with
   * no `harnessSession`. Learn the native id from the newest transcript for
   * the room's cwd modified after spawn, then bind as if the hook had
   * stamped it.
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
    const recorded = this.deps.sessionCwd?.(this.rosterCommand, room)
    const rosterCwd = this.deps.cwd?.() ?? ''
    const since = (this.pendingSpawn.get(room) ?? this.now()) - 2_000
    const tried = new Set<string>()
    for (const cwd of [recorded, rosterCwd]) {
      if (cwd === undefined || tried.has(cwd)) continue
      tried.add(cwd)
      const id = this.deps.store.newestAfter?.(cwd, since)
      if (id && CURSOR_NATIVE_RE.test(id)) return id
    }
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
