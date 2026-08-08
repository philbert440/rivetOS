/**
 * Session Manager — owns session lifecycle, history, and settings.
 *
 * Manages the in-memory session map, creates sessions with restored
 * history and settings from memory, and persists settings changes.
 *
 * Emits session:start when a session is first created and session:end
 * when a session is explicitly ended (/new) or all sessions are ended
 * at runtime shutdown. There is no idle/TTL expiry path today.
 */

import type {
  AgentConfig,
  HookPipeline,
  InboundMessage,
  Memory,
  Message,
  SessionEndContext,
  SessionStartContext,
  SessionState,
  ThinkingLevel,
} from '@rivetos/types'
import type { Router } from '../domain/router.js'
import { logger } from '../logger.js'

const _log = logger('SessionManager')

// ---------------------------------------------------------------------------
// Per-session bookkeeping for session:end ctx (not part of SessionState)
// ---------------------------------------------------------------------------

interface SessionBookkeeping {
  agentId: string
  turnCount: number
  totalTokens: { prompt: number; completion: number }
}

// ---------------------------------------------------------------------------
// Session Manager
// ---------------------------------------------------------------------------

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map()
  private bookkeeping: Map<string, SessionBookkeeping> = new Map()
  private router: Router
  private memory?: Memory
  private hooks?: HookPipeline

  constructor(router: Router, memory?: Memory, hooks?: HookPipeline) {
    this.router = router
    this.memory = memory
    this.hooks = hooks
  }

  setMemory(memory: Memory): void {
    this.memory = memory
  }

  setHooks(hooks: HookPipeline): void {
    this.hooks = hooks
  }

  /**
   * Get existing session or create a new one (restoring history + settings).
   */
  async getOrCreateSession(sessionKey: string, message: InboundMessage): Promise<SessionState> {
    let session = this.sessions.get(sessionKey)
    if (!session) {
      const { agent } = this.router.route(message)
      session = await this.createSession(sessionKey, agent, {
        platform: message.platform,
        userId: message.userId,
      })
      this.sessions.set(sessionKey, session)
    }
    return session
  }

  /**
   * Get an existing session (no creation).
   */
  get(sessionKey: string): SessionState | undefined {
    return this.sessions.get(sessionKey)
  }

  /**
   * Set a session in the map.
   */
  set(sessionKey: string, session: SessionState): void {
    this.sessions.set(sessionKey, session)
  }

  /**
   * End a session: emit session:end (if hooks wired), then remove from the map.
   * Used by /new. Next message creates a truly fresh session.
   */
  async endSession(sessionKey: string): Promise<void> {
    await this.emitSessionEnd(sessionKey)
    this.sessions.delete(sessionKey)
    this.bookkeeping.delete(sessionKey)
  }

  /**
   * Delete a session without emitting session:end.
   * Prefer endSession for lifecycle-aware teardown.
   */
  delete(sessionKey: string): void {
    this.sessions.delete(sessionKey)
    this.bookkeeping.delete(sessionKey)
  }

  /**
   * End every live session (runtime shutdown). Emits session:end per session.
   */
  async endAllSessions(): Promise<void> {
    const keys = [...this.sessions.keys()]
    for (const key of keys) {
      await this.endSession(key)
    }
  }

  /**
   * Check if a session exists.
   */
  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey)
  }

  /**
   * Record a completed turn for session:end stats.
   */
  recordTurn(sessionKey: string, usage?: { promptTokens: number; completionTokens: number }): void {
    const info = this.bookkeeping.get(sessionKey)
    if (!info) return
    info.turnCount += 1
    if (usage) {
      info.totalTokens.prompt += usage.promptTokens
      info.totalTokens.completion += usage.completionTokens
    }
  }

  /**
   * Create a new session, restoring history and settings from memory if available.
   * Emits session:start when hooks are wired.
   */
  async createSession(
    sessionKey: string,
    agent: AgentConfig,
    opts?: { platform?: string; userId?: string },
  ): Promise<SessionState> {
    // Fresh session — empty conversation history.
    // Inject a brief recent activity summary so the agent has context
    // without loading 100 raw messages.
    const history: Message[] = []

    if (this.memory) {
      try {
        // Get a short summary of recent activity (last 2 days, ~500 tokens max)
        const recentContext = await this.memory.getContextForTurn(
          'recent activity summary',
          agent.id,
          { maxTokens: 500 },
        )
        if (recentContext && recentContext.trim()) {
          history.push({
            role: 'system',
            content: `## Recent Activity (last 48h)\n${recentContext}`,
          })
        }
      } catch {
        /* expected */
      }
    }

    // Restore settings
    let thinking: ThinkingLevel = agent.defaultThinking ?? 'medium'
    // Local agents default to visible reasoning — free tokens, nothing to hide
    let reasoningVisible = agent.local === true
    let toolsVisible = false

    if (this.memory?.loadSessionSettings) {
      try {
        const settings = await this.memory.loadSessionSettings(sessionKey)
        if (settings) {
          thinking = (settings.thinking as ThinkingLevel | undefined) ?? thinking
          reasoningVisible = (settings.reasoningVisible as boolean | undefined) ?? reasoningVisible
          toolsVisible = (settings.toolsVisible as boolean | undefined) ?? toolsVisible
        }
      } catch {
        /* expected */
      }
    }

    const session: SessionState = {
      id: sessionKey,
      thinking,
      reasoningVisible,
      toolsVisible,
      history,
      compactionCount: 0,
      nudgesFired: [],
    }

    this.bookkeeping.set(sessionKey, {
      agentId: agent.id,
      turnCount: 0,
      totalTokens: { prompt: 0, completion: 0 },
    })

    // --- Hook: session:start ---
    if (this.hooks) {
      const ctx: SessionStartContext = {
        event: 'session:start',
        agentId: agent.id,
        sessionId: sessionKey,
        platform: opts?.platform,
        userId: opts?.userId,
        timestamp: Date.now(),
        metadata: {},
      }
      // Pipeline is fail-safe (onError: continue default); never blocks creation.
      await this.hooks.run(ctx)
    }

    return session
  }

  /**
   * Persist session settings after a change.
   */
  async saveSessionSettings(session: SessionState): Promise<void> {
    if (!this.memory?.saveSessionSettings) return
    try {
      await this.memory.saveSessionSettings(session.id, {
        thinking: session.thinking,
        reasoningVisible: session.reasoningVisible,
        toolsVisible: session.toolsVisible,
      })
    } catch {
      /* expected */
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async emitSessionEnd(sessionKey: string): Promise<void> {
    if (!this.hooks) return
    if (!this.sessions.has(sessionKey) && !this.bookkeeping.has(sessionKey)) return

    const info = this.bookkeeping.get(sessionKey)
    const ctx: SessionEndContext = {
      event: 'session:end',
      agentId: info?.agentId,
      sessionId: sessionKey,
      turnCount: info?.turnCount,
      totalTokens: info?.totalTokens,
      timestamp: Date.now(),
      metadata: {},
    }
    await this.hooks.run(ctx)
  }
}
