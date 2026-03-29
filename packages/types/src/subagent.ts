/**
 * Sub-agent orchestration types.
 *
 * Supports one-shot delegation ('run') and persistent interactive
 * sessions ('session') between agents.
 */

import type { Message } from './message.js';

// ---------------------------------------------------------------------------
// Sub-agent Session
// ---------------------------------------------------------------------------

export interface SubagentSession {
  /** Unique session identifier */
  id: string;
  /** Agent that spawned this sub-agent */
  parentAgent: string;
  /** Agent running as the sub-agent */
  childAgent: string;
  /** Provider backing the child agent */
  provider: string;
  /** Current session status */
  status: 'running' | 'completed' | 'failed' | 'yielded';
  /** Conversation history within this sub-agent session */
  history: Message[];
  /** When the session was created (epoch ms) */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Spawn Request
// ---------------------------------------------------------------------------

export interface SubagentSpawnRequest {
  /** Agent ID to spawn (e.g., 'grok', 'opus', 'local') */
  agent: string;
  /** Task description or initial message */
  task: string;
  /** 'run' = one-shot (complete task, return result), 'session' = persistent (stays alive) */
  mode: 'run' | 'session';
  /** Optional timeout in milliseconds */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Sub-agent Manager Interface
// ---------------------------------------------------------------------------

export interface SubagentManager {
  /**
   * Spawn a new sub-agent.
   * 'run' mode: executes the task and returns when complete.
   * 'session' mode: starts the session and returns after the first response.
   */
  spawn(request: SubagentSpawnRequest): Promise<SubagentSession>;

  /**
   * Send a message to a persistent (session-mode) sub-agent.
   * Returns the sub-agent's response.
   */
  send(sessionId: string, message: string): Promise<string>;

  /**
   * Yield the parent agent's turn, allowing a sub-agent's completion
   * to arrive as the next message in the parent's context.
   */
  yield(sessionId: string, message?: string): void;

  /** List all active sub-agent sessions. */
  list(): SubagentSession[];

  /** Kill (abort) a running sub-agent session. */
  kill(sessionId: string): void;
}
