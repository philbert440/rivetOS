/**
 * Runtime Metrics — tracks operational stats for observability.
 *
 * Singleton collector that tracks:
 *   - Turns processed (per agent, per channel)
 *   - Tool calls (per tool)
 *   - Token usage (per agent)
 *   - Latency (per turn)
 *   - Errors (per type)
 *   - Uptime
 *
 * Consumed by:
 *   - Health endpoint (GET /health)
 *   - rivetos status command
 *   - rivetos logs (in JSON mode)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TurnMetric {
  agent: string
  channel: string
  durationMs: number
  toolCalls: number
  promptTokens: number
  completionTokens: number
  timestamp: number
}

export interface MetricsSnapshot {
  uptime: number
  startedAt: string
  turns: {
    total: number
    byAgent: Record<string, number>
    byChannel: Record<string, number>
  }
  tools: {
    total: number
    byTool: Record<string, number>
  }
  tokens: {
    totalPrompt: number
    totalCompletion: number
    byAgent: Record<string, { prompt: number; completion: number }>
  }
  latency: {
    avgMs: number
    p95Ms: number
    maxMs: number
  }
  errors: {
    total: number
    byCode: Record<string, number>
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const MAX_LATENCY_SAMPLES = 1000

class MetricsCollector {
  private startedAt: number = Date.now()
  private turnCount = 0
  private turnsByAgent: Record<string, number> = {}
  private turnsByChannel: Record<string, number> = {}
  private toolCallCount = 0
  private toolCallsByTool: Record<string, number> = {}
  private totalPromptTokens = 0
  private totalCompletionTokens = 0
  private tokensByAgent: Record<string, { prompt: number; completion: number } | undefined> = {}
  private latencies: number[] = []
  private errorCount = 0
  private errorsByCode: Record<string, number> = {}

  /**
   * Record a completed turn.
   */
  recordTurn(metric: TurnMetric): void {
    this.turnCount++
    this.turnsByAgent[metric.agent] = (this.turnsByAgent[metric.agent] ?? 0) + 1
    this.turnsByChannel[metric.channel] = (this.turnsByChannel[metric.channel] ?? 0) + 1

    this.toolCallCount += metric.toolCalls
    this.totalPromptTokens += metric.promptTokens
    this.totalCompletionTokens += metric.completionTokens

    if (!this.tokensByAgent[metric.agent]) {
      this.tokensByAgent[metric.agent] = { prompt: 0, completion: 0 }
    }
    const agentTokens = this.tokensByAgent[metric.agent]!
    agentTokens.prompt += metric.promptTokens
    agentTokens.completion += metric.completionTokens

    // Keep a rolling window of latencies for percentile calculations
    this.latencies.push(metric.durationMs)
    if (this.latencies.length > MAX_LATENCY_SAMPLES) {
      this.latencies.shift()
    }
  }

  /**
   * Record a tool call (called per individual tool invocation).
   */
  recordToolCall(toolName: string): void {
    this.toolCallsByTool[toolName] = (this.toolCallsByTool[toolName] ?? 0) + 1
  }

  /**
   * Record an error by code.
   */
  recordError(code: string): void {
    this.errorCount++
    this.errorsByCode[code] = (this.errorsByCode[code] ?? 0) + 1
  }

  /**
   * Get a snapshot of all metrics.
   */
  getSnapshot(): MetricsSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b)
    const avgMs =
      sorted.length > 0 ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0
    const p95Ms = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0
    const maxMs = sorted.length > 0 ? sorted[sorted.length - 1] : 0

    return {
      uptime: Date.now() - this.startedAt,
      startedAt: new Date(this.startedAt).toISOString(),
      turns: {
        total: this.turnCount,
        byAgent: { ...this.turnsByAgent },
        byChannel: { ...this.turnsByChannel },
      },
      tools: {
        total: this.toolCallCount,
        byTool: { ...this.toolCallsByTool },
      },
      tokens: {
        totalPrompt: this.totalPromptTokens,
        totalCompletion: this.totalCompletionTokens,
        byAgent: Object.fromEntries(
          Object.entries(this.tokensByAgent)
            .filter(
              (entry): entry is [string, { prompt: number; completion: number }] =>
                entry[1] != null,
            )
            .map(([k, v]) => [k, { ...v }]),
        ),
      },
      latency: {
        avgMs,
        p95Ms,
        maxMs,
      },
      errors: {
        total: this.errorCount,
        byCode: { ...this.errorsByCode },
      },
    }
  }

  /**
   * Reset all metrics. Useful for testing.
   */
  reset(): void {
    this.startedAt = Date.now()
    this.turnCount = 0
    this.turnsByAgent = {}
    this.turnsByChannel = {}
    this.toolCallCount = 0
    this.toolCallsByTool = {}
    this.totalPromptTokens = 0
    this.totalCompletionTokens = 0
    this.tokensByAgent = {}
    this.latencies = []
    this.errorCount = 0
    this.errorsByCode = {}
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const metrics = new MetricsCollector()
