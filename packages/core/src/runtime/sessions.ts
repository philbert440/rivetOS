/**
 * Session Manager — owns session lifecycle, history, and settings.
 *
 * Manages the in-memory session map, creates sessions with restored
 * history and settings from memory, and persists settings changes.
 */

import type {
  AgentConfig,
  InboundMessage,
  Memory,
  Message,
  SessionState,
  ThinkingLevel,
} from '@rivetos/types'
import type { Router } from '../domain/router.js'
import { logger } from '../logger.js'

const _log = logger('SessionManager')

// ---------------------------------------------------------------------------
// Session Manager
// ---------------------------------------------------------------------------

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map()
  private router: Router
  private memory?: Memory

  constructor(router: Router, memory?: Memory) {
    this.router = router
    this.memory = memory
  }

  setMemory(memory: Memory): void {
    this.memory = memory
  }

  /**
   * Get existing session or create a new one (restoring history + settings).
   */
  async getOrCreateSession(sessionKey: string, message: InboundMessage): Promise<SessionState> {
    let session = this.sessions.get(sessionKey)
    if (!session) {
      const { agent } = this.router.route(message)
      session = await this.createSession(sessionKey, agent)
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
   * Delete a session (used by /new). Next message creates a truly fresh session.
   */
  delete(sessionKey: string): void {
    this.sessions.delete(sessionKey)
  }

  /**
   * Check if a session exists.
   */
  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey)
  }

  /**
   * Create a new session, restoring history and settings from memory if available.
   */
  async createSession(sessionKey: string, agent: AgentConfig): Promise<SessionState> {
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
    let reasoningVisible = false
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

    return { id: sessionKey, thinking, reasoningVisible, toolsVisible, history }
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
}
