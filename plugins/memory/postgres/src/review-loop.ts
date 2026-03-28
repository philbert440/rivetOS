/**
 * Background Review Loop — Hermes-inspired learning via turn counting.
 *
 * After every N user turns, spawns a background LLM call that reviews
 * the conversation and decides what's worth saving to memory.
 *
 * All intelligence lives in the LLM — the loop just provides:
 * 1. Turn counting with configurable thresholds
 * 2. Background LLM call after response delivery (never blocks the turn)
 * 3. Review prompts tuned for memory consolidation
 *
 * Designed to run inside the memory plugin. Core never knows this exists.
 */

import pg from 'pg'

// Local logger — avoids depending on @rivetos/core (plugins should only depend on @rivetos/types)
const PREFIX = '[ReviewLoop]'
const log = {
  debug: (...args: unknown[]) => console.debug(PREFIX, ...args),
  info: (...args: unknown[]) => console.info(PREFIX, ...args),
  warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
  error: (...args: unknown[]) => console.error(PREFIX, ...args),
}

// ---------------------------------------------------------------------------
// Row interfaces for pg queries
// ---------------------------------------------------------------------------

interface RecentMessageRow {
  role: string
  content: string
  created_at: Date
}

interface ConversationRow {
  id: string
}

interface LlmResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ReviewLoopConfig {
  /** LLM endpoint for review calls (e.g., http://192.168.1.50:8000/v1) */
  reviewEndpoint: string
  /** Model name for review (default: 'rivet-v0.1') */
  reviewModel?: string
  /** API key for authenticated endpoints (e.g., xAI, Google) */
  reviewApiKey?: string
  /** Trigger review after this many user turns (default: 10) */
  turnThreshold?: number
  /** Trigger review after this many tool iterations in a single turn (default: 15) */
  iterationThreshold?: number
  /** Maximum tokens for review response (default: 1000) */
  maxReviewTokens?: number
  /** pg.Pool for reading recent messages and writing insights */
  pool: pg.Pool
  /** Whether to log review actions to console (default: true) */
  verbose?: boolean
}

// ---------------------------------------------------------------------------
// Turn data passed from the hook
// ---------------------------------------------------------------------------

export interface TurnCompleteData {
  agentId: string
  sessionId: string
  response: string
  toolsUsed: string[]
  iterations: number
  hadErrorRecovery: boolean
  hadUserCorrection: boolean
  usage?: { promptTokens: number; completionTokens: number }
  /** Names of skills that were loaded/matched this turn */
  skillsUsed?: string[]
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface ReviewMetrics {
  turnCount: number
  lastReviewAt: number
  isReviewing: boolean
  totalReviews: number
  totalInsights: number
  totalSkillSuggestions: number
}

// ---------------------------------------------------------------------------
// Review Prompt
// ---------------------------------------------------------------------------

const MEMORY_REVIEW_PROMPT = `You are a memory consolidation agent. Your job is to review a recent conversation between a human and an AI assistant, and identify insights worth saving to long-term memory.

Focus on:
1. **Decisions made** — what was decided and why
2. **Preferences learned** — things the user likes/dislikes, their workflow patterns
3. **Mistakes and corrections** — what went wrong and how it was fixed (so it's not repeated)
4. **Technical context** — architecture decisions, tool configurations, infrastructure details
5. **Project status changes** — milestones reached, blockers encountered, next steps agreed

Output format:
- If there's something worth saving, write a concise insight (2-4 sentences max) that captures the key information. Write it as a factual statement, not a conversation summary.
- If there's nothing significant worth saving, respond with exactly: NO_ACTION

Examples of good insights:
- "Phil decided to use Hermes-style background review instead of complex hook-based reflection. The key principle: all intelligence lives in the LLM, the framework just provides nudge timing and tools."
- "The V100 on GERTY can only run models up to ~27B parameters in int8. Dense models beyond 14B won't fit without quantization."
- "Phil prefers to discuss architecture before building. 'Lets talk about it' means pause coding and design together."

Do NOT save:
- Routine tool usage (file reads, searches)
- Greetings, acknowledgments, or small talk
- Information that's already captured in workspace files
- Temporary debugging steps that aren't reusable lessons`

const SKILL_REVIEW_PROMPT = `You are a skill improvement agent. Your job is to review a recent conversation and identify opportunities to create, update, or retire skills.

A "skill" is a reusable procedure or knowledge document (SKILL.md) that helps agents handle specific tasks better next time.

Evaluate:
1. **New skill candidates** — Did the conversation involve a multi-step process that could be captured as a reusable skill? (e.g., "deploy to production", "debug memory issues", "set up a new CT")
2. **Skill improvements** — If skills were used, did the agent find a better approach? Should the skill be updated?
3. **Skill retirement** — Are any skills mentioned that are outdated, redundant, or no longer useful?

Output format:
- If a NEW skill should be created: SKILL_CREATE: <name> | <description> | <key steps summary>
- If an existing skill should be updated: SKILL_UPDATE: <name> | <what changed and why>
- If a skill should be retired: SKILL_RETIRE: <name> | <reason>
- If no skill changes needed: NO_ACTION

Be conservative — only suggest skills for procedures that are likely to recur. One-off tasks don't need skills.`

// ---------------------------------------------------------------------------
// Default config values
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  reviewEndpoint: string
  reviewModel: string
  reviewApiKey: string
  turnThreshold: number
  iterationThreshold: number
  maxReviewTokens: number
  pool: pg.Pool
  verbose: boolean
}

function resolveConfig(config: ReviewLoopConfig): ResolvedConfig {
  return {
    reviewEndpoint: config.reviewEndpoint,
    reviewModel: config.reviewModel ?? 'rivet-v0.1',
    reviewApiKey: config.reviewApiKey ?? '',
    turnThreshold: config.turnThreshold ?? 10,
    iterationThreshold: config.iterationThreshold ?? 15,
    maxReviewTokens: config.maxReviewTokens ?? 1000,
    pool: config.pool,
    verbose: config.verbose ?? true,
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** One hour in milliseconds — default lookback for first review */
const ONE_HOUR_MS = 3_600_000

export class ReviewLoop {
  private turnCount = 0
  private lastReviewAt = Date.now()
  private reviewing = false
  private totalReviews = 0
  private totalInsights = 0
  private totalSkillSuggestions = 0
  private cfg: ResolvedConfig

  constructor(config: ReviewLoopConfig) {
    this.cfg = resolveConfig(config)
  }

  /**
   * Called after each turn completes. Increments counters and triggers
   * background review if thresholds are met.
   *
   * This is fire-and-forget — never blocks the turn.
   */
  onTurnComplete(turnData: TurnCompleteData): void {
    this.turnCount++

    const shouldReview =
      this.turnCount >= this.cfg.turnThreshold ||
      turnData.iterations >= this.cfg.iterationThreshold ||
      turnData.hadErrorRecovery ||
      turnData.hadUserCorrection

    if (shouldReview && !this.reviewing) {
      // Fire and forget — never block the response
      this.runReview(turnData).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        log.error(`Review failed: ${msg}`)
      })
    }
  }

  /** Get current review loop metrics */
  getMetrics(): ReviewMetrics {
    return {
      turnCount: this.turnCount,
      lastReviewAt: this.lastReviewAt,
      isReviewing: this.reviewing,
      totalReviews: this.totalReviews,
      totalInsights: this.totalInsights,
      totalSkillSuggestions: this.totalSkillSuggestions,
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async runReview(turnData: TurnCompleteData): Promise<void> {
    this.reviewing = true
    try {
      // 1. Fetch recent messages since last review (up to 50)
      const recentMessages = await this.fetchRecentMessages(turnData.agentId, 50)
      if (recentMessages.length < 3) {
        log.debug('Not enough messages for review, skipping')
        return
      }

      // 2. Build conversation snapshot
      const conversationSnapshot = recentMessages
        .map((m) => `[${m.role}] ${m.content}`)
        .join('\n\n')

      // 3. Call LLM with memory review prompt
      const reviewResult = await this.callReviewLLM(
        MEMORY_REVIEW_PROMPT,
        conversationSnapshot,
        turnData,
      )

      this.totalReviews++

      // 4. Parse and persist memory insights
      if (reviewResult && reviewResult.trim() !== 'NO_ACTION') {
        await this.persistInsight(reviewResult, turnData.agentId, 'review_insight')
        this.totalInsights++
        if (this.cfg.verbose) {
          log.info('💾 Memory review: insight saved')
        }
      } else {
        log.debug('Memory review found nothing worth saving')
      }

      // 5. Run skill review if skills were used or complex tool usage occurred
      const shouldReviewSkills =
        (turnData.skillsUsed && turnData.skillsUsed.length > 0) ||
        turnData.toolsUsed.length >= 5 ||
        turnData.iterations >= this.cfg.iterationThreshold

      if (shouldReviewSkills) {
        const skillResult = await this.callReviewLLM(
          SKILL_REVIEW_PROMPT,
          conversationSnapshot,
          turnData,
        )

        if (skillResult && skillResult.trim() !== 'NO_ACTION') {
          await this.persistInsight(skillResult, turnData.agentId, 'skill_suggestion')
          this.totalSkillSuggestions++
          if (this.cfg.verbose) {
            log.info('📝 Skill review: suggestion saved')
          }
        }
      }

      // 6. Reset counters
      this.turnCount = 0
      this.lastReviewAt = Date.now()
    } finally {
      this.reviewing = false
    }
  }

  private async fetchRecentMessages(agentId: string, limit: number): Promise<RecentMessageRow[]> {
    // On first review, look back 1 hour instead of from construction time
    const lookbackTime = new Date(Math.min(this.lastReviewAt, Date.now() - ONE_HOUR_MS))

    const result = await this.cfg.pool.query<RecentMessageRow>(
      `SELECT role, content, created_at
       FROM ros_messages
       WHERE agent = $1
         AND created_at > $2
         AND content IS NOT NULL
         AND LENGTH(content) > 10
       ORDER BY created_at DESC
       LIMIT $3`,
      [agentId, lookbackTime, limit],
    )

    // Return in chronological order
    return result.rows.reverse()
  }

  private async callReviewLLM(
    systemPrompt: string,
    conversation: string,
    turnData: TurnCompleteData,
  ): Promise<string | null> {
    const statsLines = [
      '\n## Turn Stats',
      `Tool calls: ${String(turnData.toolsUsed.length)}`,
      `Iterations: ${String(turnData.iterations)}`,
      `Tools: ${turnData.toolsUsed.join(', ') || 'none'}`,
      `Had errors: ${String(turnData.hadErrorRecovery)}`,
      `Had correction: ${String(turnData.hadUserCorrection)}`,
    ]

    if (turnData.skillsUsed && turnData.skillsUsed.length > 0) {
      statsLines.push(`Skills used: ${turnData.skillsUsed.join(', ')}`)
    }

    const userContent = ['## Recent Conversation\n', conversation, ...statsLines].join('\n')

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.cfg.reviewApiKey) {
        headers['Authorization'] = `Bearer ${this.cfg.reviewApiKey}`
      }

      const response = await fetch(`${this.cfg.reviewEndpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.cfg.reviewModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          max_tokens: this.cfg.maxReviewTokens,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(30_000),
      })

      if (!response.ok) {
        log.error(`Review LLM returned ${String(response.status)} ${response.statusText}`)
        return null
      }

      const data = (await response.json()) as LlmResponse
      return data.choices?.[0]?.message?.content ?? null
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`Review LLM call failed: ${msg}`)
      return null
    }
  }

  private async persistInsight(
    insight: string,
    agentId: string,
    type: 'review_insight' | 'skill_suggestion' = 'review_insight',
  ): Promise<void> {
    // Find an active conversation for this agent to attach the insight to
    const conv = await this.cfg.pool.query<ConversationRow>(
      `SELECT id FROM ros_conversations
       WHERE agent = $1 AND active = true
       ORDER BY updated_at DESC
       LIMIT 1`,
      [agentId],
    )

    if (conv.rows.length === 0) {
      log.warn('No active conversation found for review insight, skipping persist')
      return
    }

    await this.cfg.pool.query(
      `INSERT INTO ros_messages
         (conversation_id, agent, channel, role, content, metadata, created_at)
       VALUES ($1, $2, 'review', 'system', $3, $4, NOW())`,
      [conv.rows[0].id, agentId, insight, JSON.stringify({ type, source: 'background_review' })],
    )
  }
}
