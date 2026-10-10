import {
  HarnessError,
  type ApprovalDecision,
  type HarnessEvent,
  type HarnessId,
  type SessionId,
} from '@rivetos/types'
import { record } from './codex-rpc.js'
import type { AcpFrame, AcpRpc } from './acp-rpc.js'

/**
 * The harness-independent half of an ACP-driven session: load, prompt,
 * cancel, permission requests, and the `session/update` → `HarnessEvent`
 * mapping. A driver owns one host and decides per send whether ACP or its
 * PTY path carries the turn (see `acp-drivers.ts`).
 *
 * ACP session ids are the harness's own native ids — Grok's UUIDv7 and
 * OpenCode's `ses_…` land in the same on-disk stores the TUIs use — so the
 * transcript readers, session list and memory capture need no binding file.
 */
export interface AcpSessionHostDeps {
  rpc: AcpRpc
  harnessId: HarnessId
  productName: string
  sid(native: string): SessionId
  emit(native: string, event: HarnessEvent): void
  turnStarted(native: string): void
  turnEnded(native: string, stopReason: string): void
  /** Any update for a running turn — re-arms the driver's quiet window. */
  activity(native: string): void
  log(msg: string): void
}

interface ConfigOption {
  id: string
  category?: string
  currentValue?: string
  values: string[]
}

interface SessionState {
  cwd: string
  generation?: number
  loading?: Promise<void>
  /** Suppress replayed history while `session/load` runs. */
  replaying?: boolean
  /** The TUI wrote to this session since the agent last loaded it. */
  stale?: boolean
  prompting?: boolean
  configOptions: ConfigOption[]
  tools: Map<string, { name: string; done: boolean }>
}

interface PendingPermission {
  native: string
  rpcId: number | string
  options: { optionId: string; kind: string }[]
  event: Extract<HarnessEvent, { type: 'approval-request' }>
}

/** ACP permission option kinds → the hub's approval keys. `reject_always` has
 *  no hub equivalent and is not offered. */
const OPTION_KEYS: Partial<Record<string, ApprovalDecision>> = {
  allow_once: 'allow',
  allow_always: 'allow-session',
  reject_once: 'deny',
}

const STOP_REASONS: Record<string, string> = {
  end_turn: 'end-turn',
  cancelled: 'interrupted',
}

export class AcpSessionHost {
  private readonly sessions = new Map<string, SessionState>()
  private readonly permissions = new Map<string, PendingPermission>()
  private readonly off: () => void

  constructor(private readonly deps: AcpSessionHostDeps) {
    this.off = deps.rpc.subscribe((frame) => this.onFrame(frame))
  }

  /** Has this host loaded or created the session since den started? */
  knows(native: string): boolean {
    return this.sessions.has(native)
  }

  prompting(native: string): boolean {
    return this.sessions.get(native)?.prompting === true
  }

  /** The TUI took a turn; the agent's in-memory copy is out of date. */
  markStale(native: string): void {
    const state = this.sessions.get(native)
    if (state) state.stale = true
  }

  hasPermission(requestId: string): boolean {
    return this.permissions.has(requestId)
  }

  async newSession(cwd: string): Promise<string> {
    const result = await this.deps.rpc.request('session/new', { cwd, mcpServers: [] })
    const native = result.sessionId
    if (typeof native !== 'string' || !native)
      throw new Error(`${this.deps.productName} returned no session id`)
    this.sessions.set(native, {
      cwd,
      generation: this.deps.rpc.generation,
      configOptions: configOptions(result.configOptions),
      tools: new Map(),
    })
    return native
  }

  /**
   * Make the agent hold a current copy of the session. Prefers `session/resume`
   * (no history replay) and falls back to `session/load`, whose replayed
   * updates are swallowed — the transcript reader already has that history.
   */
  private async ensureLoaded(native: string, cwd: string): Promise<SessionState> {
    let state = this.sessions.get(native)
    if (!state) {
      state = { cwd, configOptions: [], tools: new Map() }
      this.sessions.set(native, state)
    }
    const current = state
    if (current.generation === this.deps.rpc.generation && !current.stale) return current
    current.loading ??= (async () => {
      await this.deps.rpc.connect()
      const caps = record(this.deps.rpc.agent?.agentCapabilities)
      const sessionCaps = record(caps.sessionCapabilities)
      const sessionId = native
      if (current.stale && current.generation === this.deps.rpc.generation && sessionCaps.close) {
        await this.deps.rpc.request('session/close', { sessionId }).catch(() => undefined)
      }
      const params = { sessionId, cwd: current.cwd, mcpServers: [] }
      let result: Record<string, unknown>
      if (sessionCaps.resume) {
        result = await this.deps.rpc.request('session/resume', params)
      } else if (caps.loadSession === true) {
        current.replaying = true
        try {
          result = await this.deps.rpc.request('session/load', params)
        } finally {
          current.replaying = false
        }
      } else {
        throw new HarnessError(
          'capability_unsupported',
          `${this.deps.productName} cannot reopen a session over ACP`,
        )
      }
      if (Array.isArray(result.configOptions))
        current.configOptions = configOptions(result.configOptions)
      current.generation = this.deps.rpc.generation
      current.stale = false
    })().finally(() => {
      current.loading = undefined
    })
    await current.loading
    return current
  }

  /**
   * Start a turn. Resolves once the prompt is written to the agent; the turn
   * itself completes later through `turnEnded`. Rejects `turn_in_flight`
   * synchronously-before-any-await so two sends cannot both pass.
   */
  async prompt(
    native: string,
    cwd: string,
    text: string,
    opts: { model?: string; effort?: string } = {},
  ): Promise<void> {
    const existing = this.sessions.get(native)
    if (existing?.prompting)
      throw new HarnessError('turn_in_flight', `${this.deps.harnessId} ${native} is mid-turn`)
    const claim: SessionState = existing ?? { cwd, configOptions: [], tools: new Map() }
    this.sessions.set(native, claim)
    claim.prompting = true
    let state: SessionState
    try {
      state = await this.ensureLoaded(native, cwd)
      if (opts.model) await this.setConfig(native, 'model', opts.model)
      if (opts.effort) await this.setConfig(native, 'thought_level', opts.effort)
    } catch (error) {
      claim.prompting = false
      throw error
    }
    state.tools.clear()
    this.deps.turnStarted(native)
    this.deps.rpc
      .request(
        'session/prompt',
        { sessionId: native, prompt: [{ type: 'text', text }] },
        { timeoutMs: 0 },
      )
      .then(
        (result) => {
          const reason = typeof result.stopReason === 'string' ? result.stopReason : 'end_turn'
          this.finish(native, STOP_REASONS[reason] ?? reason)
        },
        (error: unknown) => {
          this.deps.emit(native, {
            type: 'error',
            sessionId: this.deps.sid(native),
            code: 'harness_error',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          })
          this.finish(native, 'error')
        },
      )
  }

  private finish(native: string, stopReason: string): void {
    const state = this.sessions.get(native)
    if (!state?.prompting) return
    state.prompting = false
    this.clearPermissions(native, 'external')
    // An approval leaves a protocol status of blocked or working behind; the
    // turn's end has to replace it, or the session reads busy from then on.
    this.status(native)
    this.deps.turnEnded(native, stopReason)
  }

  /** `category` is ACP's config category: `model` or `thought_level`. */
  async setConfig(native: string, category: string, value: string): Promise<void> {
    const state = this.sessions.get(native)
    const option = state?.configOptions.find((o) => o.category === category)
    // Effort is advisory: OpenCode's agent offers no thought_level option, and
    // a picked effort must not fail the whole turn there.
    if (state && !option && category === 'thought_level') {
      this.deps.log(
        `[den-server] acp: ${this.deps.productName} has no effort setting; ignoring ${value}`,
      )
      return
    }
    if (!state || !option)
      throw new HarnessError(
        'capability_unsupported',
        `${this.deps.productName} does not offer a ${category === 'model' ? 'model' : 'effort'} setting`,
      )
    if (option.currentValue === value) return
    if (option.values.length && !option.values.includes(value))
      throw new HarnessError('bad_request', `${value} is not offered by ${this.deps.productName}`)
    const result = await this.deps.rpc.request('session/set_config_option', {
      sessionId: native,
      configId: option.id,
      value,
    })
    if (Array.isArray(result.configOptions))
      state.configOptions = configOptions(result.configOptions)
    else option.currentValue = value
  }

  cancel(native: string): void {
    if (!this.prompting(native)) return
    // ACP: the client answers its own pending permission requests with
    // `cancelled` when it cancels the turn.
    this.clearPermissions(native, 'external')
    try {
      this.deps.rpc.notify('session/cancel', { sessionId: native })
    } catch {
      // The agent is gone; its exit already ends the turn.
    }
  }

  resolvePermission(requestId: string, decision: ApprovalDecision): void {
    const pending = this.permissions.get(requestId)
    if (!pending) throw new HarnessError('unknown_approval', `unknown approval ${requestId}`)
    const kind = Object.entries(OPTION_KEYS).find(([, key]) => key === decision)?.[0]
    const option = pending.options.find((o) => o.kind === kind)
    if (!option)
      throw new HarnessError('bad_request', `${this.deps.productName} did not offer ${decision}`)
    this.deps.rpc.respond(pending.rpcId, {
      outcome: { outcome: 'selected', optionId: option.optionId },
    })
    this.permissions.delete(requestId)
    this.deps.emit(pending.native, {
      type: 'approval-resolved',
      sessionId: this.deps.sid(pending.native),
      requestId,
      decision,
    })
    this.status(pending.native)
  }

  /** Pending permission cards for a newly attached subscriber. */
  replay(native: string, sink: (event: HarnessEvent) => void): void {
    for (const pending of this.permissions.values()) {
      if (pending.native === native) sink(pending.event)
    }
  }

  close(): void {
    this.off()
    this.deps.rpc.close()
  }

  private clearPermissions(native: string, decision: 'external'): void {
    for (const [requestId, pending] of this.permissions) {
      if (pending.native !== native) continue
      this.permissions.delete(requestId)
      try {
        this.deps.rpc.respond(pending.rpcId, { outcome: { outcome: 'cancelled' } })
      } catch {
        /* the agent is gone */
      }
      this.deps.emit(native, {
        type: 'approval-resolved',
        sessionId: this.deps.sid(native),
        requestId,
        decision,
      })
    }
  }

  private status(native: string): void {
    const blocked = [...this.permissions.values()].some((p) => p.native === native)
    this.deps.emit(native, {
      type: 'status',
      sessionId: this.deps.sid(native),
      status: blocked ? 'blocked' : this.prompting(native) ? 'working' : 'idle',
      since: Date.now(),
      source: 'protocol',
    })
  }

  private onFrame(frame: AcpFrame): void {
    if (frame.method === '$disconnected') {
      for (const [native, state] of this.sessions) {
        state.generation = undefined
        if (!state.prompting) continue
        this.deps.emit(native, {
          type: 'error',
          sessionId: this.deps.sid(native),
          code: 'harness_unavailable',
          message: `${this.deps.productName} exited during the turn; it was not replayed`,
          retryable: true,
        })
        this.finish(native, 'error')
      }
      for (const pending of this.permissions.values())
        this.clearPermissions(pending.native, 'external')
      return
    }
    const native = typeof frame.params.sessionId === 'string' ? frame.params.sessionId : undefined
    const state = native ? this.sessions.get(native) : undefined
    if (frame.id !== undefined) {
      if (frame.method === 'session/request_permission' && native && state?.prompting) {
        this.onPermission(native, frame.id, frame.params)
      } else {
        this.deps.rpc.reject(frame.id, `RivetHub does not support ${frame.method}`)
      }
      return
    }
    if (frame.method !== 'session/update' || !native || !state || state.replaying) return
    this.onUpdate(native, state, record(frame.params.update))
  }

  private onPermission(
    native: string,
    rpcId: number | string,
    params: Record<string, unknown>,
  ): void {
    const toolCall = record(params.toolCall)
    const options = (Array.isArray(params.options) ? params.options : [])
      .map(record)
      .filter((o) => typeof o.optionId === 'string' && typeof o.kind === 'string')
      .map((o) => ({ optionId: String(o.optionId), kind: String(o.kind), name: o.name }))
    const requestId = `acp:${typeof rpcId}:${String(rpcId)}`
    const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined
    const event: Extract<HarnessEvent, { type: 'approval-request' }> = {
      type: 'approval-request',
      sessionId: this.deps.sid(native),
      requestId,
      ...(toolCallId ? { toolCallId } : {}),
      name:
        (toolCallId && this.sessions.get(native)?.tools.get(toolCallId)?.name) ||
        (typeof toolCall.title === 'string' ? toolCall.title : 'tool'),
      input: toolCall.rawInput ?? toolCall,
      ...(typeof toolCall.title === 'string' ? { reason: toolCall.title } : {}),
      options: options.flatMap((o) => {
        const key = OPTION_KEYS[o.kind]
        return key ? [{ key, label: typeof o.name === 'string' && o.name ? o.name : key }] : []
      }),
    }
    this.permissions.set(requestId, { native, rpcId, options, event })
    this.deps.emit(native, event)
    this.status(native)
  }

  private onUpdate(native: string, state: SessionState, update: Record<string, unknown>): void {
    if (state.prompting) this.deps.activity(native)
    const sessionId = this.deps.sid(native)
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const content = record(update.content)
        if (content.type !== 'text' || typeof content.text !== 'string' || !content.text) return
        this.deps.emit(native, {
          type:
            update.sessionUpdate === 'agent_message_chunk' ? 'assistant-delta' : 'reasoning-delta',
          sessionId,
          text: content.text,
        })
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined
        if (!toolCallId) return
        let tool = state.tools.get(toolCallId)
        if (!tool) {
          tool = { name: toolName(update), done: false }
          state.tools.set(toolCallId, tool)
          this.deps.emit(native, {
            type: 'tool-use',
            sessionId,
            toolCallId,
            name: tool.name,
            input: update.rawInput ?? {},
          })
        }
        if (!tool.done && (update.status === 'completed' || update.status === 'failed')) {
          tool.done = true
          this.deps.emit(native, {
            type: 'tool-result',
            sessionId,
            toolCallId,
            name: tool.name,
            output: update.rawOutput ?? contentText(update.content),
            ...(update.status === 'failed' ? { isError: true } : {}),
          })
        }
        return
      }
      case 'config_option_update':
        if (Array.isArray(update.configOptions))
          state.configOptions = configOptions(update.configOptions)
        return
    }
  }
}

/** Grok names the tool in `_meta`; other agents put it in `title`, which Grok
 *  instead fills with the command line. */
function toolName(update: Record<string, unknown>): string {
  const meta = record(record(update._meta)['x.ai/tool'])
  if (typeof meta.name === 'string' && meta.name) return meta.name
  if (typeof update.title === 'string' && update.title) return update.title
  return typeof update.kind === 'string' ? update.kind : 'tool'
}

function contentText(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .map((c) => record(record(c).content))
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => String(c.text))
    .join('')
}

function configOptions(raw: unknown): ConfigOption[] {
  return (Array.isArray(raw) ? raw : []).map(record).flatMap((o) => {
    if (typeof o.id !== 'string') return []
    // Options are flat `{ value }` rows or groups with their own `options`.
    const values = (Array.isArray(o.options) ? o.options : [])
      .map(record)
      .flatMap((v) => (Array.isArray(v.options) ? v.options.map(record) : [v]))
      .map((v) => v.value)
      .filter((v): v is string => typeof v === 'string')
    return [
      {
        id: o.id,
        ...(typeof o.category === 'string' ? { category: o.category } : {}),
        ...(typeof o.currentValue === 'string' ? { currentValue: o.currentValue } : {}),
        values,
      },
    ]
  })
}
