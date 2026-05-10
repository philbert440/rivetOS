/**
 * Agent Loop — AI SDK implementation (migration target).
 *
 * Replaces the bespoke streaming/tool-execution machinery in `loop.ts` with
 * `streamText` from the Vercel AI SDK. Mirrors the public surface of `AgentLoop`
 * so call sites (runtime, turn-handler, subagent, delegation) can be switched
 * via a factory once this is fully implemented.
 *
 * Filled in over migration steps 2–6:
 *   - Step 2: xAI provider wired through `prepareStep` (pilot)
 *   - Step 3: hook pipeline composed as language-model middleware
 *   - Step 4: tool registry adapter (Zod) + abort/skip via sentinel exceptions
 *   - Step 5: stream event translator (fullStream parts -> StreamEvent)
 *   - Step 6: remaining @ai-sdk/* providers
 *
 * What this DOES NOT do (deliberately, per migration plan):
 *   - Mid-turn provider fallback (dropped)
 *   - Bespoke streaming/tool-call/usage normalization (delegated to AI SDK)
 *   - Deferred-application hack for compact_context (replaced by prepareStep)
 *
 * Pure domain logic. No I/O. Works with interfaces only.
 */

import type { ContentPart, Message } from '@rivetos/types'
import type { AgentLoopConfig, TurnResult } from './loop.js'

// ---------------------------------------------------------------------------
// Agent Loop (AI SDK)
// ---------------------------------------------------------------------------

export class AgentLoopAiSdk {
  private config: AgentLoopConfig
  private steerQueue: string[] = []

  constructor(config: AgentLoopConfig) {
    this.config = config
  }

  /** Inject a message visible on the next tool iteration. */
  steer(message: string): void {
    this.steerQueue.push(message)
  }

  /**
   * Run one turn.
   * userMessage can be a plain string or multimodal ContentPart[] (text + images).
   */
  run(
    _userMessage: string | ContentPart[],
    _history: Message[],
    _signal?: AbortSignal,
  ): Promise<TurnResult> {
    return Promise.reject(
      new Error('AgentLoopAiSdk.run() not implemented — filled in by migration steps 2–6'),
    )
  }
}
