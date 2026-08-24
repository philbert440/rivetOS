/**
 * `deepseek-harness` — HarnessDriver for the DeepSeek Harness CLI (`dsh`).
 *
 * Fifth driver. Same adopting shape as hermes and kimi-code: dsh mints its
 * own `session-<uuid>` and has no `--session-id` pin, so `startSession` is
 * refused and the control plane adopts whatever the CLI created.
 *
 *   | Contract method | Existing machinery it wraps                              |
 *   |-----------------|----------------------------------------------------------|
 *   | listSessions    | `listHarnessSessions(['dsh'])` — ~/.dsh/sessions         |
 *   | getSession      | `describeDshSession` (dir lookup)                        |
 *   | startSession    | **refused** — no flag to pin a new session id            |
 *   | resumeSession   | term manager spawn-or-get → `dsh --profile tui --resume` |
 *   | sendUserTurn    | term manager `inject(pty, text, submit)`                 |
 *   | interrupt       | term manager `inject(pty, '', false, interrupt)` (Esc)   |
 *   | subscribe       | none — dsh has no hook-fed den stream                    |
 *   | transcript      | empty for now (session.jsonl.zstd is out-of-band)        |
 *
 * **No hook-fed capture.** Memory capture is the Cordis `session/event`
 * plugin (`integrations/deepseek/rivet-memory`, PR #538). This driver only
 * spawns and manages the interactive PTY. `liveStream` is therefore true
 * only when a den tap is actually wired, and even then the stream carries
 * no assistant/thinking/tool events until something starts stamping them.
 *
 * **Identity.** Native ids are `session-<uuid>` (hyphen, not kimi's
 * `session_`). Canonical form is `deepseek-harness:session-<uuid>`.
 *
 * **No pinning.** `dsh --help` documents `dsh --profile tui --resume
 * <session>` for an EXISTING session. There is no `--session-id`.
 *
 * See docs/plans/harness-control-plane.md.
 */

import { formatSessionId, type HarnessSessionSummary, type SessionId } from '@rivetos/types'
import {
  PtyHarnessDriver,
  type DenAgentEventLike,
  type HarnessPtyHost,
  type HarnessStoreHost,
  type PtyHarnessDriverDeps,
} from './pty-harness-driver.js'

export const DEEPSEEK_HARNESS_ID = 'deepseek-harness' as const
/** Roster key the den term manager spawns DeepSeek Harness under. */
export const DEEPSEEK_ROSTER_COMMAND = 'dsh'

export type DeepseekPtyHost = HarnessPtyHost

export interface DeepseekStoreHost extends HarnessStoreHost {
  /** Does the session DIR exist under any cwd-slug bucket? Sync. */
  exists(nativeId: string): boolean
}

export type DeepseekDriverDeps = PtyHarnessDriverDeps<DeepseekStoreHost>

const DSH_NATIVE_RE =
  /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function announcedNative(ev: DenAgentEventLike): string | undefined {
  const raw = ev.harnessSession
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed || !DSH_NATIVE_RE.test(trimmed)) return undefined
  return trimmed
}

export class DeepseekHarnessDriver extends PtyHarnessDriver<DeepseekStoreHost> {
  /**
   * den room key → the dsh session currently running in it.
   *
   * Copy THREE of the hermes/kimi room map. Extraction of an adopting-driver
   * base is a follow-up, not this PR — keep the new harness shipping.
   */
  private readonly roomNative = new Map<string, string>()
  private readonly nativeRoom = new Map<string, string>()

  constructor(deps: DeepseekDriverDeps) {
    super(
      {
        harnessId: DEEPSEEK_HARNESS_ID,
        rosterCommand: DEEPSEEK_ROSTER_COMMAND,
        productName: 'DeepSeek Harness',
      },
      deps,
    )
  }

  /** `deepseek-harness:<native>` for a native id. @throws `invalid_session_id` */
  static sessionId(nativeId: string): SessionId {
    return formatSessionId(DEEPSEEK_HARNESS_ID, nativeId)
  }

  /**
   * Refused, deliberately — dsh has no flag to pin a new session id. A caller
   * that wants a fresh dsh starts one from the den roster; this driver adopts
   * it if/when something announces the id dsh picked (disk, or a future
   * harnessSession stamp). Resume of an existing store id is the supported
   * control-plane create-a-PTY path.
   */
  startSession(): Promise<HarnessSessionSummary> {
    return Promise.reject(
      this.unsupported(
        'deepseek-harness: starting a session through the control plane is not supported — dsh has ' +
          'no flag to pin a new session id (`--resume` references existing sessions only), so the ' +
          'control plane cannot name the session it would be creating. Spawn dsh from the den ' +
          'roster; the driver adopts the CLI-minted id.',
      ),
    )
  }

  async resumeSession(sessionId: SessionId): Promise<HarnessSessionSummary> {
    const summary = await super.resumeSession(sessionId)
    const native = this.native(sessionId)
    if (!this.nativeRoom.has(native)) this.bindRoom(native, native)
    return summary
  }

  protected override room(native: string): string {
    return this.nativeRoom.get(native) ?? native
  }

  /**
   * dsh native ids are `session-<uuid>`, not bare uuids, so the base's uuid
   * gate would drop every event. Identity comes from `harnessSession` (if a
   * future plugin stamps one) or from a room we already bound (resume).
   */
  protected override nativeFor(ev: DenAgentEventLike): string | undefined {
    const room = ev.session
    if (!room) return undefined
    const announced = announcedNative(ev) ?? canonicalRoomNative(room)
    if (announced !== undefined) {
      if (!this.isDshRoom(room, ev)) return undefined
      this.bindRoom(room, announced)
      return announced
    }
    return this.roomNative.get(room)
  }

  protected override ownsEvent(): boolean {
    return true
  }

  private isDshRoom(room: string, ev: DenAgentEventLike): boolean {
    if (this.roomNative.has(room)) return true
    if (ev.harness === DEEPSEEK_HARNESS_ID) return true
    return (
      ev.harness === 'rivetos' &&
      typeof ev.name === 'string' &&
      ev.name.endsWith(`:${DEEPSEEK_ROSTER_COMMAND}`)
    )
  }

  private bindRoom(room: string, native: string): void {
    const previous = this.roomNative.get(room)
    if (previous === native) return
    this.roomNative.set(room, native)
    this.nativeRoom.set(native, room)
    if (previous === undefined) {
      this.ensureLive(native)
      this.announceIfNew(native)
      return
    }
    this.nativeRoom.delete(previous)
    this.rotate(previous, native)
  }
}

function canonicalRoomNative(room: string): string | undefined {
  const prefix = `${DEEPSEEK_HARNESS_ID}:`
  if (!room.startsWith(prefix)) return undefined
  const native = room.slice(prefix.length)
  return DSH_NATIVE_RE.test(native) ? native : undefined
}
