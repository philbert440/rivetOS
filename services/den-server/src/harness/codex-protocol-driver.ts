import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  HarnessError,
  formatSessionId,
  type ApprovalDecision,
  type HarnessEvent,
  type HarnessTranscriptTurn,
  type SessionId,
  type HarnessSessionSummary as SessionSummary,
  type StartSessionOpts,
  type UserTurn,
  type HarnessCapabilities,
} from '@rivetos/types'
import { CODEX_NATIVE_RE, CodexDriver, type CodexDriverDeps } from './codex-driver.js'
import { record, type CodexFrame, type CodexRpc } from './codex-rpc.js'

interface Binding {
  id: string
  threadId: string
  cwd: string
  createdAt: string
  model?: string
  updatedAt?: string
  systemPromptApplied?: boolean
  fresh?: boolean
}
interface Runtime {
  generation?: number
  turnId?: string
  sending?: boolean
  completedTurnId?: string
  recoveryBlocked?: boolean
  outageReported?: boolean
  rev: number
  approvals: Map<
    string,
    { rpcId: string | number; event: Extract<HarnessEvent, { type: 'approval-request' }> }
  >
}

export interface CodexProtocolDeps extends CodexDriverDeps {
  rpc: CodexRpc
  endpoint: string
  bindingsFile: string
  /** Node-owned defaults; never supplied by a remote chat request. */
  threadDefaults?: () => Record<string, unknown>
}

/** App-server manages new sessions; existing standalone TUI sessions retain
 * their PTY driver. Bindings preserve a client-minted Rivet id independently
 * of Codex's thread id. No process scan, cwd guess, or transient alias is used.
 */
export class CodexProtocolDriver extends CodexDriver {
  private readonly bindings = new Map<string, Binding>()
  private readonly byThread = new Map<string, Binding>()
  private readonly runtime = new Map<string, Runtime>()
  private readonly creating = new Set<string>()
  private readonly fresh = new Set<string>()
  private readonly loading = new Map<string, Promise<void>>()
  private readonly sinks = new Map<string, Set<(event: HarnessEvent) => void>>()
  private protocolCaps?: HarnessCapabilities
  override get capabilities(): HarnessCapabilities {
    return this.protocolCaps ?? super.capabilities
  }
  private readonly rpcOff: () => void

  constructor(private readonly protocol: CodexProtocolDeps) {
    super(protocol)
    try {
      const data = record(JSON.parse(readFileSync(protocol.bindingsFile, 'utf8')))
      if (data.version !== 1 || !Array.isArray(data.bindings))
        throw new Error('Invalid Codex bindings file')
      for (const raw of data.bindings) {
        const b = record(raw)
        if (
          typeof b.id !== 'string' ||
          typeof b.threadId !== 'string' ||
          typeof b.cwd !== 'string' ||
          typeof b.createdAt !== 'string' ||
          !CODEX_NATIVE_RE.test(b.id) ||
          !/^[\w-]+$/.test(b.threadId)
        ) {
          throw new Error('Invalid Codex session binding')
        }
        this.bindings.set(b.id, b as unknown as Binding)
        this.byThread.set(b.threadId, b as unknown as Binding)
        if (b.fresh === true) this.fresh.add(b.id)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.rpcOff = protocol.rpc.subscribe((frame) => this.onFrame(frame))
    this.protocolCaps = {
      ...super.capabilities,
      resume: true,
      interrupt: true,
      liveStream: true,
      approvals: true,
    }
  }

  override verifyCapabilities() {
    return Promise.resolve(this.capabilities)
  }

  manages(id: string): boolean {
    return this.bindings.has(id.startsWith('codex:') ? id.slice(6) : id)
  }

  ownsNativeThread(id: string): boolean {
    return this.byThread.has(id)
  }

  terminalArgv(id: string, binary: string): string[] | undefined {
    const binding = this.bindings.get(id)
    return binding
      ? [binary, '--remote', this.protocol.endpoint, 'resume', binding.threadId]
      : undefined
  }

  private state(id: string): Runtime {
    let state = this.runtime.get(id)
    if (!state) {
      state = { rev: 0, approvals: new Map() }
      this.runtime.set(id, state)
    }
    return state
  }

  private save(): void {
    const file = this.protocol.bindingsFile
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, bindings: [...this.bindings.values()] }), {
      mode: 0o600,
    })
    renameSync(temp, file)
  }

  private summary(binding: Binding): SessionSummary {
    const state = this.state(binding.id)
    return {
      sessionId: formatSessionId('codex', binding.id),
      harnessId: 'codex',
      cwd: binding.cwd,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt ?? binding.createdAt,
      status: state.turnId || state.sending ? 'active' : 'idle',
      model: binding.model,
    }
  }

  private publish(id: string, event: HarnessEvent): void {
    for (const sink of this.sinks.get(id) ?? []) {
      try {
        sink(event)
      } catch {
        /* isolate clients */
      }
    }
    if (event.type === 'session-created' || event.type === 'session-updated')
      this.emitRegistry(event)
  }

  private failure(id: string, error: unknown): void {
    const state = this.state(id)
    if (state.outageReported) return
    state.outageReported = true
    this.publish(id, {
      type: 'error',
      sessionId: this.sid(id),
      code: 'codex_unavailable',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    })
  }

  override async startSession(
    opts: StartSessionOpts & { effort?: string } = {},
  ): Promise<SessionSummary> {
    const id = opts.sessionId ? this.native(opts.sessionId) : (opts.nativeSessionId ?? randomUUID())
    if (!CODEX_NATIVE_RE.test(id))
      throw new HarnessError('invalid_session_id', 'Codex requires a UUID session id')
    if (this.bindings.has(id) || this.creating.has(id)) {
      throw new HarnessError('session_id_collision', 'Codex session id is already in use')
    }
    this.creating.add(id)
    try {
      if (await super.getSession(this.sid(id)))
        throw new HarnessError('session_id_collision', 'Codex session already exists')
      const defaults = this.protocol.threadDefaults?.()
      const result = await this.protocol.rpc.request('thread/start', {
        ...defaults,
        ...(opts.effort
          ? { config: { ...record(defaults?.config), model_reasoning_effort: opts.effort } }
          : {}),
        cwd: opts.cwd ?? this.protocol.cwd?.(),
        ...(opts.model && opts.model !== 'default' ? { model: opts.model } : {}),
      })
      const thread = record(result.thread)
      if (typeof thread.id !== 'string' || !/^[\w-]+$/.test(thread.id))
        throw new Error('Codex returned no thread id')
      const binding: Binding = {
        id,
        threadId: thread.id,
        cwd: stringValue(result.cwd) || stringValue(thread.cwd) || opts.cwd || '',
        createdAt: new Date().toISOString(),
        fresh: true,
        ...(typeof result.model === 'string' ? { model: result.model } : {}),
      }
      this.bindings.set(id, binding)
      this.byThread.set(binding.threadId, binding)
      try {
        this.save()
      } catch (error) {
        this.bindings.delete(id)
        this.byThread.delete(binding.threadId)
        await this.protocol.rpc
          .request('thread/archive', { threadId: thread.id })
          .catch(() => undefined)
        throw error
      }
      this.fresh.add(id)
      this.state(id).generation = this.protocol.rpc.generation
      const summary = this.summary(binding)
      this.publish(id, { type: 'session-created', sessionId: summary.sessionId, summary })
      return summary
    } finally {
      this.creating.delete(id)
    }
  }

  private async ensureLoaded(binding: Binding): Promise<void> {
    if (this.state(binding.id).generation === this.protocol.rpc.generation) return
    let promise = this.loading.get(binding.id)
    if (!promise) {
      promise = this.protocol.rpc
        .request('thread/resume', {
          ...this.protocol.threadDefaults?.(),
          threadId: binding.threadId,
        })
        .then((result) => {
          this.state(binding.id).generation = this.protocol.rpc.generation
          this.observeThread(binding.id, record(result.thread))
          const state = this.state(binding.id)
          state.recoveryBlocked = Boolean(state.turnId && !state.approvals.size)
          if (state.recoveryBlocked) {
            this.publish(binding.id, {
              type: 'error',
              sessionId: this.sid(binding.id),
              code: 'approval_recovery_required',
              retryable: true,
              message:
                'Recovered an active Codex turn; approvals may need recovery. Attach a terminal or interrupt the turn.',
            })
          }
          this.publishStatus(binding.id)
        })
        .finally(() => {
          this.loading.delete(binding.id)
        })
      this.loading.set(binding.id, promise)
    }
    await promise
  }

  override async resumeSession(sessionId: SessionId): Promise<SessionSummary> {
    const b = this.bindings.get(this.native(sessionId))
    if (!b) return super.resumeSession(sessionId)
    await this.ensureLoaded(b)
    return this.summary(b)
  }

  override async getSession(sessionId: SessionId): Promise<SessionSummary | null> {
    const b = this.bindings.get(this.native(sessionId))
    return b ? this.summary(b) : super.getSession(sessionId)
  }

  override async listSessions(): Promise<SessionSummary[]> {
    const nativeIds = new Set([...this.bindings.values()].map((b) => this.sid(b.threadId)))
    const legacy = (await super.listSessions()).filter(
      (s) => !nativeIds.has(s.sessionId) && !this.manages(s.sessionId),
    )
    return [...this.bindings.values()].map((b) => this.summary(b)).concat(legacy)
  }

  protected turnParams(turn: UserTurn): Promise<Record<string, unknown>> {
    if (turn.attachments?.length)
      throw new HarnessError('capability_unsupported', 'Attachments are not supported')
    return Promise.resolve({ input: [{ type: 'text', text: turn.text }] })
  }

  override async sendUserTurn(sessionId: SessionId, turn: UserTurn): Promise<void> {
    const id = this.native(sessionId),
      b = this.bindings.get(id)
    if (!b) return super.sendUserTurn(sessionId, turn)
    const state = this.state(id)
    if (state.sending || (state.generation === this.protocol.rpc.generation && state.turnId))
      throw new HarnessError('turn_in_flight', 'A Codex turn is already running')
    state.sending = true
    try {
      await this.ensureLoaded(b)
      if (state.turnId) throw new HarnessError('turn_in_flight', 'A Codex turn is already running')
      const params = await this.turnParams(turn)
      const includePrompt = Boolean(turn.systemPrompt && !b.systemPromptApplied)
      if (includePrompt) {
        // Loaded threads can silently ignore resume overrides. Deliver context
        // in the first input, like the PTY path, and mark only after acceptance.
        params.input = [
          { type: 'text', text: turn.systemPrompt!.slice(0, 16_384) },
          ...(Array.isArray(params.input) ? (params.input as unknown[]) : []),
        ]
      }
      const result = await this.protocol.rpc.request('turn/start', {
        threadId: b.threadId,
        ...params,
      })
      this.fresh.delete(id)
      b.fresh = false
      if (includePrompt) b.systemPromptApplied = true
      this.save()
      const remoteTurn = record(result.turn)
      if (
        typeof remoteTurn.id === 'string' &&
        remoteTurn.status === 'inProgress' &&
        remoteTurn.id !== state.completedTurnId
      )
        state.turnId = remoteTurn.id
    } catch (error) {
      // The outcome may be unknown after a disconnect/timeout. Re-read before
      // accepting another send; never replay a possibly accepted user turn.
      state.generation = undefined
      throw error
    } finally {
      state.sending = false
    }
  }

  override async interrupt(sessionId: SessionId): Promise<void> {
    const id = this.native(sessionId),
      b = this.bindings.get(id)
    if (!b) return super.interrupt(sessionId)
    const state = this.state(id)
    const deadline = Date.now() + 5000
    while (state.sending) {
      if (Date.now() >= deadline)
        throw new HarnessError('turn_in_flight', 'Timed out waiting for the Codex turn to start')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await this.ensureLoaded(b)
    const turnId = state.turnId
    if (turnId) {
      await this.protocol.rpc.request('turn/interrupt', { threadId: b.threadId, turnId })
      // Release on the acknowledged interrupt, not the later notification.
      if (state.turnId === turnId) state.turnId = undefined
      state.completedTurnId = turnId
      state.recoveryBlocked = false
      this.clearApprovals(id)
      this.publishStatus(id)
    }
  }

  private observeThread(id: string, thread: Record<string, unknown>): void {
    const binding = this.bindings.get(id)
    if (binding && typeof thread.updatedAt === 'number')
      binding.updatedAt = new Date(thread.updatedAt * 1000).toISOString()
    const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : []
    const active = turns.find((t) => t.status === 'inProgress')
    const state = this.state(id)
    state.turnId = typeof active?.id === 'string' ? active.id : undefined
    if (!state.turnId) state.recoveryBlocked = false
    if (turns.length && binding?.fresh) {
      binding.fresh = false
      this.fresh.delete(id)
      this.save()
    }
  }

  override async transcript(sessionId: SessionId): Promise<{ turns: HarnessTranscriptTurn[] }> {
    const id = this.native(sessionId),
      b = this.bindings.get(id)
    if (!b) return super.transcript(sessionId)
    await this.ensureLoaded(b)
    // Codex has no persisted turn history until its first turn; includeTurns
    // is not available for that known-empty thread yet.
    if (this.fresh.has(id)) return { turns: [] }
    const response = await this.protocol.rpc.request('thread/read', {
      threadId: b.threadId,
      includeTurns: true,
    })
    const thread = record(response.thread)
    this.observeThread(id, thread)
    return { turns: codexThreadTurns(thread) }
  }

  private async snapshot(id: string): Promise<void> {
    const { turns } = await this.transcript(this.sid(id))
    this.publish(id, {
      type: 'transcript',
      sessionId: this.sid(id),
      rev: ++this.state(id).rev,
      from: 0,
      total: turns.length,
      turns,
      command: 'codex',
    })
    this.publishStatus(id)
  }

  override syncTranscript(sessionId: SessionId): void {
    const id = this.native(sessionId)
    if (!this.bindings.has(id)) return super.syncTranscript(sessionId)
    void this.snapshot(id).catch((error: unknown) => this.failure(id, error))
  }

  override subscribe(sessionId: SessionId, sink: (event: HarnessEvent) => void): () => void {
    const id = this.native(sessionId)
    if (!this.bindings.has(id)) return super.subscribe(sessionId, sink)
    let set = this.sinks.get(id)
    if (!set) {
      set = new Set()
      this.sinks.set(id, set)
    }
    set.add(sink)
    this.syncTranscript(sessionId)
    for (const pending of this.state(id).approvals.values()) sink(pending.event)
    return () => {
      set.delete(sink)
      if (!set.size) this.sinks.delete(id)
    }
  }

  private publishStatus(id: string): void {
    const state = this.state(id)
    const active = Boolean(state.turnId || state.sending)
    this.publish(id, {
      type: 'status',
      sessionId: this.sid(id),
      status:
        state.approvals.size || state.recoveryBlocked ? 'blocked' : active ? 'working' : 'idle',
      since: Date.now(),
      source: 'protocol',
    })
    this.publish(id, {
      type: 'session-updated',
      sessionId: this.sid(id),
      status: active ? 'active' : 'idle',
      ...(state.approvals.size || state.recoveryBlocked ? { blocked: true } : {}),
    })
  }

  protected handleRequest(id: string, frame: CodexFrame): void {
    if (frame.id === undefined) return
    if (
      frame.method === 'item/commandExecution/requestApproval' ||
      frame.method === 'item/fileChange/requestApproval'
    ) {
      const requestId = `${typeof frame.id}:${String(frame.id)}`
      const p = frame.params
      const event: Extract<HarnessEvent, { type: 'approval-request' }> = {
        type: 'approval-request',
        sessionId: this.sid(id),
        requestId,
        toolCallId: typeof p.itemId === 'string' ? p.itemId : undefined,
        name: frame.method.includes('fileChange') ? 'fileChange' : 'commandExecution',
        input: p,
        ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
        options: [
          { key: 'allow', label: 'Allow' },
          { key: 'deny', label: 'Deny' },
        ],
      }
      this.state(id).approvals.set(requestId, { rpcId: frame.id, event })
      this.publish(id, event)
      this.publishStatus(id)
    } else this.protocol.rpc.reject(frame.id, `RivetHub does not support ${frame.method}`)
  }

  override async resolveApproval(
    sessionId: SessionId,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const id = this.native(sessionId)
    if (!this.bindings.has(id)) return super.resolveApproval(sessionId, requestId, decision)
    const pending = this.state(id).approvals.get(requestId)
    if (!pending) throw new HarnessError('unknown_approval', 'This approval is no longer pending')
    // Rivet's allow-session means every invocation of a tool name; Codex's
    // command-scoped acceptForSession is narrower. Do not equate the scopes.
    if (decision === 'allow-session')
      throw new HarnessError('bad_request', 'Session-wide tool approval is not supported')
    this.protocol.rpc.respond(pending.rpcId, {
      decision: decision === 'allow' ? 'accept' : 'decline',
    })
    this.state(id).approvals.delete(requestId)
    this.publish(id, { type: 'approval-resolved', sessionId, requestId, decision })
    this.publishStatus(id)
  }

  protected onFrame(frame: CodexFrame): void {
    if (frame.method === '$connected') {
      for (const state of this.runtime.values()) state.outageReported = false
      for (const id of this.sinks.keys()) this.syncTranscript(this.sid(id))
      return
    }
    if (frame.method === '$disconnected') {
      for (const [id, state] of this.runtime) {
        state.generation = undefined
        state.recoveryBlocked = Boolean(state.turnId || state.approvals.size)
        state.turnId = undefined
        this.clearApprovals(id)
        if (!state.outageReported) {
          this.failure(id, new Error('Codex disconnected; reconnecting without replaying the turn'))
        }
        this.publishStatus(id)
      }
      return
    }
    const p = frame.params
    const threadId = p.threadId ?? record(p.thread).id
    const binding = typeof threadId === 'string' ? this.byThread.get(threadId) : undefined
    if (!binding) {
      if (frame.id !== undefined)
        this.protocol.rpc.reject(frame.id, 'No managed thread for request')
      return
    }
    const id = binding.id,
      sessionId = this.sid(id),
      state = this.state(id)
    if (frame.id !== undefined) {
      this.handleRequest(id, frame)
      return
    }
    switch (frame.method) {
      case 'turn/started':
        this.fresh.delete(id)
        if (String(record(p.turn).id) === state.completedTurnId) break
        state.turnId = String(record(p.turn).id)
        this.publishStatus(id)
        break
      case 'turn/completed':
        this.fresh.delete(id)
        state.completedTurnId = String(record(p.turn).id)
        if (state.turnId === state.completedTurnId) state.turnId = undefined
        state.recoveryBlocked = false
        this.clearApprovals(id)
        this.publish(id, {
          type: 'turn-complete',
          sessionId,
          turnId: String(record(p.turn).id),
          stopReason:
            record(p.turn).status === 'interrupted'
              ? 'interrupted'
              : record(p.turn).status === 'failed'
                ? 'error'
                : 'end-turn',
        })
        this.syncTranscript(sessionId)
        break
      case 'item/agentMessage/delta':
        if (typeof p.delta === 'string')
          this.publish(id, { type: 'assistant-delta', sessionId, text: p.delta })
        break
      case 'item/reasoning/summaryTextDelta':
        if (typeof p.delta === 'string')
          this.publish(id, { type: 'reasoning-delta', sessionId, text: p.delta })
        break
      case 'item/started':
      case 'item/completed': {
        const item = record(p.item)
        if (
          ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(
            String(item.type),
          )
        ) {
          const name = String(item.tool ?? item.type),
            toolCallId = String(item.id)
          this.publish(
            id,
            frame.method === 'item/started'
              ? {
                  type: 'tool-use',
                  sessionId,
                  toolCallId,
                  name,
                  input: item.arguments ?? item.command ?? item.changes,
                }
              : {
                  type: 'tool-result',
                  sessionId,
                  toolCallId,
                  name,
                  output: item.aggregatedOutput ?? item.result ?? item,
                  isError: item.status === 'failed' || item.status === 'declined',
                },
          )
        }
        break
      }
      case 'serverRequest/resolved': {
        const key = `${typeof p.requestId}:${String(p.requestId)}`
        if (state.approvals.delete(key))
          this.publish(id, {
            type: 'approval-resolved',
            sessionId,
            requestId: key,
            decision: 'external',
          })
        this.publishStatus(id)
        break
      }
    }
  }

  private clearApprovals(id: string): void {
    for (const requestId of this.state(id).approvals.keys()) {
      this.publish(id, {
        type: 'approval-resolved',
        sessionId: this.sid(id),
        requestId,
        decision: 'external',
      })
    }
    this.state(id).approvals.clear()
  }

  override close(): void {
    this.rpcOff()
    this.protocol.rpc.close()
    super.close()
  }
}

/** Fold documented thread items into the shared transcript format. Only the
 * reasoning summary is rendered; hidden/raw reasoning is not a UI contract.
 */
export function codexThreadTurns(thread: Record<string, unknown>): HarnessTranscriptTurn[] {
  const result: HarnessTranscriptTurn[] = []
  for (const rawTurn of Array.isArray(thread.turns) ? thread.turns : []) {
    const turn = record(rawTurn)
    const assistant: HarnessTranscriptTurn = { role: 'assistant', text: '', tools: [] }
    for (const rawItem of Array.isArray(turn.items) ? turn.items : []) {
      const item = record(rawItem)
      if (item.type === 'userMessage') {
        const text = (Array.isArray(item.content) ? item.content : [])
          .map(record)
          .filter((part) => part.type === 'text')
          .map((part) => String(part.text))
          .join('\n')
        if (text) result.push({ role: 'user', text })
      } else if (item.type === 'agentMessage') {
        assistant.text += (assistant.text ? '\n\n' : '') + stringValue(item.text)
        assistant.lastBlock = 'text'
      } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        assistant.thinking =
          (assistant.thinking ?? '') + item.summary.filter((s) => typeof s === 'string').join('\n')
        assistant.lastBlock = 'thinking'
      } else if (
        ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(
          String(item.type),
        )
      ) {
        assistant.tools?.push({
          id: String(item.id),
          name: String(item.tool ?? item.type),
          status:
            item.status === 'inProgress'
              ? 'running'
              : item.status === 'failed' || item.status === 'declined'
                ? 'error'
                : 'done',
        })
        assistant.lastBlock = item.status === 'inProgress' ? 'tool_use' : 'tool_result'
      }
    }
    if (!assistant.tools?.length) delete assistant.tools
    if (turn.status !== 'inProgress') assistant.complete = true
    if (assistant.text || assistant.thinking || assistant.tools) result.push(assistant)
  }
  return result
}

/** Translate only documented roster policy flags. Unknown options fail closed
 * instead of silently dropping operator configuration during the transition. */
export function codexThreadDefaults(argv: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--dangerously-bypass-approvals-and-sandbox' || flag === '--yolo') {
      params.approvalPolicy = 'never'
      params.sandbox = 'danger-full-access'
    } else if (flag === '--full-auto') {
      params.approvalPolicy = 'on-request'
      params.sandbox = 'workspace-write'
    } else if (['--ask-for-approval', '-a', '--sandbox', '-s', '--model', '-m'].includes(flag)) {
      const value = argv[++i]
      if (!value) throw new Error(`Missing Codex roster value for ${flag}`)
      if (flag === '-a' || flag === '--ask-for-approval') {
        if (!['untrusted', 'on-request', 'never'].includes(value))
          throw new Error('Unsupported Codex approval policy')
        params.approvalPolicy = value
      } else if (flag === '-s' || flag === '--sandbox') {
        if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value))
          throw new Error('Unsupported Codex sandbox')
        params.sandbox = value
      } else params.model = value
    } else
      throw new Error(
        `Codex app-server cannot translate roster option ${flag}; configure it in the dedicated app-server config`,
      )
  }
  return params
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
