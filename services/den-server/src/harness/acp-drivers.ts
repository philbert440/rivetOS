import { homedir } from 'node:os'
import { validateDirectory } from '@rivetos/agent-registry'
import {
  HarnessError,
  type ApprovalDecision,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessSessionSummary,
  type SessionId,
  type SendUserTurnResult,
  type StartSessionOpts,
  type UserTurn,
} from '@rivetos/types'
import type { AcpRpc } from './acp-rpc.js'
import { AcpSessionHost } from './acp-session-host.js'
import { GrokBuildDriver, type GrokDriverDeps } from './grok-driver.js'
import { OpencodeDriver, type OpencodeDriverDeps } from './opencode-driver.js'
import {
  harnessTurnText,
  type DenAgentEventLike,
  type HarnessPtyHost,
  type LiveState,
} from './pty-harness-driver.js'

/**
 * Grok Build and OpenCode driven over ACP when no terminal is open.
 *
 * One owner per session at a time. With no live TUI pane, a chat turn goes to
 * the harness's ACP agent (`grok agent stdio`, `opencode acp`): typed
 * permission requests, real interrupt, a definite end of turn, no screen
 * reads. With a pane open, the turn takes the PTY path exactly as before, and
 * the agent's copy is marked stale so the next ACP turn reloads it. A
 * terminal cannot open while an ACP turn runs (`chatTurnRunning`, checked by
 * the spawn route). Sessions started in a terminal are driven the same way
 * once their pane is gone.
 *
 * Den hooks still fire inside the ACP agent. With no pane open, every den
 * event for a session this driver has driven over ACP came from the agent and
 * is dropped: the ACP stream already carried it.
 */
export interface AcpDriverOptions {
  rpc: AcpRpc
}

/** Protected driver members the routing needs, passed in by each subclass. */
interface DriverAccess {
  harnessId: GrokBuildDriver['harnessId']
  productName: string
  rosterCommand: string
  sid(native: string): SessionId
  native(sessionId: SessionId): string
  room(native: string): string
  cwd(): string | undefined
  emit(native: string, event: HarnessEvent): void
  beginTurn(native: string): void
  endTurn(native: string, stopReason: string): void
  armQuietWindow(native: string): void
  ensureLive(native: string): LiveState
  liveSummary(native: string, status: 'idle'): HarnessSessionSummary
  announce(native: string, summary: HarnessSessionSummary): void
  pty(): Promise<HarnessPtyHost | null> | undefined
  sessionCwd(native: string): string | undefined
  recordSessionCwd(native: string, cwd: string): void
  log(msg: string): void
}

class AcpRouting {
  readonly host: AcpSessionHost
  private ptyHost: HarnessPtyHost | null | undefined

  constructor(
    private readonly d: DriverAccess,
    opts: AcpDriverOptions,
  ) {
    this.host = new AcpSessionHost({
      rpc: opts.rpc,
      harnessId: d.harnessId,
      productName: d.productName,
      sid: (native) => d.sid(native),
      emit: (native, event) => d.emit(native, event),
      turnStarted: (native) => d.beginTurn(native),
      turnEnded: (native, reason) => d.endTurn(native, reason),
      activity: (native) => d.armQuietWindow(native),
      log: (msg) => d.log(msg),
    })
    void d.pty()?.then(
      (host) => (this.ptyHost = host),
      () => (this.ptyHost = null),
    )
  }

  capabilities(base: HarnessCapabilities): HarnessCapabilities {
    return {
      ...base,
      interrupt: true,
      resume: true,
      approvals: true,
      liveStream: true,
      turnOptions: true,
      protocolStart: true,
    }
  }

  private paneOpen(native: string): boolean {
    return Boolean(this.ptyHost?.ptyForSession(this.d.room(native)))
  }

  /** True when a send should take the ACP path. */
  async acpOwns(native: string): Promise<boolean> {
    if (this.ptyHost === undefined) {
      this.ptyHost = (await this.d.pty()?.catch(() => null)) ?? null
    }
    if (this.paneOpen(native)) {
      this.host.markStale(native)
      return false
    }
    return true
  }

  chatTurnRunning(native: string): boolean {
    return this.host.prompting(native)
  }

  /**
   * `false` → let the PTY driver handle the den event. Reads the event's own
   * id fields rather than `nativeFor`, which binds rooms as a side effect.
   */
  dropDenEvent(ev: DenAgentEventLike): boolean {
    const native = [ev.session, ev.harnessSession].find(
      (id): id is string => typeof id === 'string' && this.host.knows(id),
    )
    if (!native) return false
    if (this.paneOpen(native)) {
      this.host.markStale(native)
      return false
    }
    return true
  }

  async startSession(opts: StartSessionOpts & { effort?: string }): Promise<HarnessSessionSummary> {
    let cwd = this.d.cwd() ?? homedir()
    if (opts.cwd !== undefined) {
      const validated = validateDirectory(opts.cwd)
      if (!validated)
        throw new HarnessError('bad_request', `${this.d.harnessId}: cwd must be an absolute path`)
      cwd = validated
    }
    const native = await this.host.newSession(cwd)
    if (opts.model && opts.model !== 'default')
      await this.host.setConfig(native, 'model', opts.model)
    if (opts.effort) await this.host.setConfig(native, 'thought_level', opts.effort)
    try {
      this.d.recordSessionCwd(native, cwd)
    } catch (error) {
      this.d.log(`[den-server] acp: could not record cwd for ${native}: ${String(error)}`)
    }
    this.d.ensureLive(native).status = 'idle'
    const summary = this.d.liveSummary(native, 'idle')
    this.d.announce(native, summary)
    return summary
  }

  async send(native: string, turn: UserTurn): Promise<SendUserTurnResult | undefined> {
    if (turn.attachments?.length)
      throw new HarnessError(
        'capability_unsupported',
        `${this.d.harnessId}: attachments over ACP are not supported yet`,
      )
    const state = this.d.ensureLive(native)
    const text = harnessTurnText(turn, !state.systemPromptApplied)
    const cwd = this.d.sessionCwd(native) ?? this.d.cwd() ?? homedir()
    await this.host.prompt(native, cwd, text, {
      ...(turn.model && turn.model !== 'default' ? { model: turn.model } : {}),
      ...(turn.effort ? { effort: turn.effort } : {}),
    })
    if (text !== turn.text) state.systemPromptApplied = true
    return undefined
  }

  replay(native: string, sink: (event: HarnessEvent) => void): void {
    this.host.replay(native, sink)
  }
}

export class GrokAcpDriver extends GrokBuildDriver {
  private readonly acp: AcpRouting

  constructor(deps: GrokDriverDeps & { acp: AcpDriverOptions }) {
    super(deps)
    this.acp = new AcpRouting(this.access(), deps.acp)
  }

  private access(): DriverAccess {
    return {
      harnessId: this.harnessId,
      productName: this.productName,
      rosterCommand: this.rosterCommand,
      sid: (n) => this.sid(n),
      native: (s) => this.native(s),
      room: (n) => this.room(n),
      cwd: () => this.cwd(),
      emit: (n, e) => this.emit(n, e),
      beginTurn: (n) => this.beginTurn(n),
      endTurn: (n, r) => this.endTurn(n, r),
      armQuietWindow: (n) => this.armQuietWindow(n),
      ensureLive: (n) => this.ensureLive(n),
      liveSummary: (n, s) => this.liveSummary(n, s),
      announce: (n, s) => this.announce(n, s),
      pty: () => this.deps.pty?.(),
      sessionCwd: (n) => this.deps.sessionCwd?.(this.rosterCommand, n),
      recordSessionCwd: (n, c) => this.deps.recordSessionCwd?.(this.rosterCommand, n, c),
      log: (m) => this.log(m),
    }
  }

  override get capabilities(): HarnessCapabilities {
    // The base constructor reads capabilities before `acp` is assigned.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return this.acp ? this.acp.capabilities(super.capabilities) : super.capabilities
  }

  chatTurnRunning(native: string): boolean {
    return this.acp.chatTurnRunning(native)
  }

  override async startSession(
    opts: StartSessionOpts & { effort?: string } = {},
  ): Promise<HarnessSessionSummary> {
    // A caller-minted id must be pinned, which only the TUI's --session-id can do.
    return opts.nativeSessionId || opts.sessionId
      ? super.startSession(opts)
      : this.acp.startSession(opts)
  }

  override async sendUserTurn(
    sessionId: SessionId,
    turn: UserTurn,
  ): Promise<SendUserTurnResult | undefined> {
    const native = this.native(sessionId)
    return (await this.acp.acpOwns(native))
      ? this.acp.send(native, turn)
      : super.sendUserTurn(sessionId, turn)
  }

  override async interrupt(sessionId: SessionId): Promise<void> {
    const native = this.native(sessionId)
    if (this.acp.host.prompting(native)) this.acp.host.cancel(native)
    else await super.interrupt(sessionId)
  }

  override async resolveApproval(
    sessionId: SessionId,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    if (this.acp.host.hasPermission(requestId)) this.acp.host.resolvePermission(requestId, decision)
    else await super.resolveApproval(sessionId, requestId, decision)
  }

  override subscribe(sessionId: SessionId, sink: (e: HarnessEvent) => void): () => void {
    const off = super.subscribe(sessionId, sink)
    this.acp.replay(this.native(sessionId), sink)
    return off
  }

  protected override onDenEvent(ev: DenAgentEventLike): void {
    if (this.acp.dropDenEvent(ev)) return
    super.onDenEvent(ev)
  }

  override close(): void {
    this.acp.host.close()
    super.close()
  }
}

export class OpencodeAcpDriver extends OpencodeDriver {
  private readonly acp: AcpRouting

  constructor(deps: OpencodeDriverDeps & { acp: AcpDriverOptions }) {
    super(deps)
    this.acp = new AcpRouting(this.access(), deps.acp)
  }

  private access(): DriverAccess {
    return {
      harnessId: this.harnessId,
      productName: this.productName,
      rosterCommand: this.rosterCommand,
      sid: (n) => this.sid(n),
      native: (s) => this.native(s),
      room: (n) => this.room(n),
      cwd: () => this.cwd(),
      emit: (n, e) => this.emit(n, e),
      beginTurn: (n) => this.beginTurn(n),
      endTurn: (n, r) => this.endTurn(n, r),
      armQuietWindow: (n) => this.armQuietWindow(n),
      ensureLive: (n) => this.ensureLive(n),
      liveSummary: (n, s) => this.liveSummary(n, s),
      announce: (n, s) => this.announce(n, s),
      pty: () => this.deps.pty?.(),
      sessionCwd: (n) => this.deps.sessionCwd?.(this.rosterCommand, n),
      recordSessionCwd: (n, c) => this.deps.recordSessionCwd?.(this.rosterCommand, n, c),
      log: (m) => this.log(m),
    }
  }

  override get capabilities(): HarnessCapabilities {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see GrokAcpDriver
    return this.acp ? this.acp.capabilities(super.capabilities) : super.capabilities
  }

  chatTurnRunning(native: string): boolean {
    return this.acp.chatTurnRunning(native)
  }

  /** OpenCode cannot pin an id in the TUI either, so ACP is the only start path. */
  override async startSession(
    opts: StartSessionOpts & { effort?: string } = {},
  ): Promise<HarnessSessionSummary> {
    return this.acp.startSession(opts)
  }

  override async sendUserTurn(
    sessionId: SessionId,
    turn: UserTurn,
  ): Promise<SendUserTurnResult | undefined> {
    const native = this.native(sessionId)
    return (await this.acp.acpOwns(native))
      ? this.acp.send(native, turn)
      : super.sendUserTurn(sessionId, turn)
  }

  override async interrupt(sessionId: SessionId): Promise<void> {
    const native = this.native(sessionId)
    if (this.acp.host.prompting(native)) this.acp.host.cancel(native)
    else await super.interrupt(sessionId)
  }

  override async resolveApproval(
    sessionId: SessionId,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    if (this.acp.host.hasPermission(requestId)) this.acp.host.resolvePermission(requestId, decision)
    else await super.resolveApproval(sessionId, requestId, decision)
  }

  override subscribe(sessionId: SessionId, sink: (e: HarnessEvent) => void): () => void {
    const off = super.subscribe(sessionId, sink)
    this.acp.replay(this.native(sessionId), sink)
    return off
  }

  protected override onDenEvent(ev: DenAgentEventLike): void {
    if (this.acp.dropDenEvent(ev)) return
    super.onDenEvent(ev)
  }

  override close(): void {
    this.acp.host.close()
    super.close()
  }
}
