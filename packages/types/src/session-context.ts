/**
 * SessionContext — first-class envelope that travels with every tool call.
 *
 * Today, tools reach "the current conversation" via closure-captured state.
 * That works in-process but cannot survive a network hop (MCP server → runtime,
 * or third-party client → collective). SessionContext formalizes the shape so:
 *
 *   1. In-process paths construct a local SessionContext per turn.
 *   2. MCP-served paths receive one from the handshake, signed by the server.
 *   3. Runtime-plane proxy hops forward the context verbatim.
 *
 * Every tool's `execute` signature becomes `(args, ctx: SessionContext) => Promise<Result>`.
 *
 * Related: /rivet-shared/plans/mcp-architecture-overhaul.md §4.3
 */

/**
 * Identifies a single "live" tool-calling session.
 *
 * - For in-process agents: one SessionContext per conversation turn.
 * - For MCP clients: minted by `rivetos/session.attach`, lives until disconnect.
 * - For subagents: inherits parent_session_id from its spawner.
 */
export interface SessionContext {
  /** Opaque identifier minted by whichever side owns the session. */
  sessionToken: string

  /** 'opus' | 'grok' | 'gemini' | 'local' | ... */
  agentId: string

  /** The runtime node this session belongs to (where runtime-plane calls land). */
  nodeId: string

  /** Conversation this session is attached to. Used by memory + context-compaction tools. */
  conversationId: string

  /** The human the agent is acting on behalf of. */
  userId: string

  /** Channel bindings — drive `ask_user`, Discord/Telegram routing. */
  discordChannelId?: string
  telegramChatId?: string

  /** For subagent_spawn — the parent session that spawned this one. */
  parentSessionId?: string

  /** Tool names this session is allowed to invoke. `['*']` = all. Enforced server-side. */
  allowlist: string[]

  /** Epoch ms. */
  issuedAt: number

  /** Epoch ms. Default: conversation lifetime. */
  expiresAt: number

  /** Optional working directory hint for node-local tools (shell, file_*). */
  workingDir?: string

  /**
   * Trace id propagated from the session handshake through every tool call
   * including proxy hops. Present in structured logs and audit records.
   */
  traceId?: string
}

/**
 * Helper — build a best-effort in-process context when no MCP handshake has
 * happened. Used by the shim layer during Phase 0 so existing call sites can
 * upgrade incrementally.
 */
export function buildLocalSessionContext(partial: {
  agentId: string
  nodeId: string
  conversationId: string
  userId: string
  discordChannelId?: string
  telegramChatId?: string
  parentSessionId?: string
  workingDir?: string
  traceId?: string
  allowlist?: string[]
  ttlMs?: number
}): SessionContext {
  const now = Date.now()
  return {
    sessionToken: `local-${String(now)}-${Math.random().toString(36).slice(2, 10)}`,
    agentId: partial.agentId,
    nodeId: partial.nodeId,
    conversationId: partial.conversationId,
    userId: partial.userId,
    discordChannelId: partial.discordChannelId,
    telegramChatId: partial.telegramChatId,
    parentSessionId: partial.parentSessionId,
    workingDir: partial.workingDir,
    traceId: partial.traceId,
    allowlist: partial.allowlist ?? ['*'],
    issuedAt: now,
    expiresAt: now + (partial.ttlMs ?? 24 * 60 * 60 * 1000),
  }
}

/** Type guard — useful when a tool receives `unknown` from a proxy hop. */
export function isSessionContext(value: unknown): value is SessionContext {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<SessionContext>
  return (
    typeof v.sessionToken === 'string' &&
    typeof v.agentId === 'string' &&
    typeof v.nodeId === 'string' &&
    typeof v.conversationId === 'string' &&
    typeof v.userId === 'string' &&
    Array.isArray(v.allowlist) &&
    typeof v.issuedAt === 'number' &&
    typeof v.expiresAt === 'number'
  )
}
