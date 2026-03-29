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
} from '@rivetos/types';
import type { Router } from '../domain/router.js';
import { logger } from '../logger.js';

const log = logger('SessionManager');

// ---------------------------------------------------------------------------
// Session Manager
// ---------------------------------------------------------------------------

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private router: Router;
  private memory?: Memory;

  constructor(router: Router, memory?: Memory) {
    this.router = router;
    this.memory = memory;
  }

  setMemory(memory: Memory): void {
    this.memory = memory;
  }

  /**
   * Get existing session or create a new one (restoring history + settings).
   */
  async getOrCreateSession(sessionKey: string, message: InboundMessage): Promise<SessionState> {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      const { agent } = this.router.route(message);
      session = await this.createSession(sessionKey, agent);
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  /**
   * Get an existing session (no creation).
   */
  get(sessionKey: string): SessionState | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * Set a session in the map.
   */
  set(sessionKey: string, session: SessionState): void {
    this.sessions.set(sessionKey, session);
  }

  /**
   * Delete a session (used by /new).
   */
  delete(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  /**
   * Check if a session exists.
   */
  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  /**
   * Create a new session, restoring history and settings from memory if available.
   */
  async createSession(sessionKey: string, agent: AgentConfig): Promise<SessionState> {
    // Restore history from memory
    let history: Message[] = [];
    if (this.memory) {
      try {
        history = await this.memory.getSessionHistory(sessionKey, { limit: 100 });
      } catch (err: any) {
        log.warn(`Failed to restore session history: ${err.message}`);
      }
    }

    // Restore settings
    let thinking: ThinkingLevel = agent.defaultThinking ?? 'medium';
    let reasoningVisible = false;
    let toolsVisible = false;

    if (this.memory?.loadSessionSettings) {
      try {
        const settings = await this.memory.loadSessionSettings(sessionKey);
        if (settings) {
          thinking = (settings.thinking as ThinkingLevel) ?? thinking;
          reasoningVisible = (settings.reasoningVisible as boolean) ?? reasoningVisible;
          toolsVisible = (settings.toolsVisible as boolean) ?? toolsVisible;
        }
      } catch {}
    }

    return { id: sessionKey, thinking, reasoningVisible, toolsVisible, history };
  }

  /**
   * Persist session settings after a change.
   */
  async saveSessionSettings(session: SessionState): Promise<void> {
    if (!this.memory?.saveSessionSettings) return;
    try {
      await this.memory.saveSessionSettings(session.id, {
        thinking: session.thinking,
        reasoningVisible: session.reasoningVisible,
        toolsVisible: session.toolsVisible,
      });
    } catch {}
  }
}
