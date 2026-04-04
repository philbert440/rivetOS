/**
 * Fallback Hook — provider:error hook that implements fallback chains.
 *
 * When a provider fails with a configured trigger code (429, 503, timeout, etc.),
 * this hook sets `retry` on the error context, causing the AgentLoop to switch
 * to the next provider in the fallback chain.
 *
 * Usage:
 *   const fallbackHook = createFallbackHook(fallbackConfigs);
 *   pipeline.register(fallbackHook);
 *
 * Config example:
 *   fallbacks: [
 *     {
 *       providerId: 'google',
 *       fallbacks: ['google:gemini-2.0-flash', 'anthropic:claude-sonnet-4-20250514'],
 *       triggerCodes: [429, 503],
 *       triggerOnTimeout: true,
 *     }
 *   ]
 */

import type { FallbackConfig, HookRegistration, ProviderErrorContext } from '@rivetos/types'

// ---------------------------------------------------------------------------
// State — tracks position in fallback chain per provider per session
// ---------------------------------------------------------------------------

interface FallbackState {
  /** Current index in the fallback chain (0 = first fallback) */
  index: number
  /** Timestamp of last fallback (for cooldown) */
  lastFallback: number
  /** Number of fallbacks in current window */
  count: number
}

// ---------------------------------------------------------------------------
// Timeout detection
// ---------------------------------------------------------------------------

const TIMEOUT_PATTERNS = [
  'timeout',
  'ETIMEDOUT',
  'ECONNABORTED',
  'AbortError',
  'network error',
  'socket hang up',
  'ECONNRESET',
]

function isTimeoutError(error: Error): boolean {
  const msg = error.message.toLowerCase()
  return TIMEOUT_PATTERNS.some((p) => msg.includes(p.toLowerCase()))
}

function isAuthError(statusCode?: number, error?: Error): boolean {
  if (statusCode === 401 || statusCode === 403) return true
  const msg = error?.message?.toLowerCase() ?? ''
  return (
    msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('invalid api key')
  )
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a provider:error hook that implements fallback chains.
 *
 * Returns a HookRegistration ready to be added to a HookPipeline.
 * The hook maintains state per provider-session to track position in the chain.
 */
export function createFallbackHook(
  configs: FallbackConfig[],
): HookRegistration<ProviderErrorContext> {
  // Build lookup: providerId → FallbackConfig
  const configMap = new Map<string, FallbackConfig>()
  for (const config of configs) {
    configMap.set(config.providerId, config)
  }

  // State per provider:session
  const state = new Map<string, FallbackState>()

  // Cooldown: reset fallback index after 5 minutes of no fallbacks
  const COOLDOWN_MS = 5 * 60 * 1000

  return {
    id: 'rivetos:fallback-chain',
    event: 'provider:error',
    priority: 10, // Run early — other error hooks may want to know if fallback happened
    description: 'Provider fallback chains — retries with next model on failure',

    handler: async (ctx: ProviderErrorContext) => {
      const config = configMap.get(ctx.providerId)
      if (!config || config.fallbacks.length === 0) return

      // Check if this error type should trigger fallback
      const triggerCodes = config.triggerCodes ?? [429, 503]
      const triggerOnTimeout = config.triggerOnTimeout ?? true
      const triggerOnAuth = config.triggerOnAuthFailure ?? false

      const codeMatch = ctx.statusCode !== undefined && triggerCodes.includes(ctx.statusCode)
      const timeoutMatch = triggerOnTimeout && isTimeoutError(ctx.error)
      const authMatch = triggerOnAuth && isAuthError(ctx.statusCode, ctx.error)

      if (!codeMatch && !timeoutMatch && !authMatch) return

      // Get or create state for this provider + session
      const stateKey = `${ctx.providerId}:${ctx.sessionId ?? 'global'}`
      let fallbackState = state.get(stateKey)

      if (!fallbackState) {
        fallbackState = { index: 0, lastFallback: 0, count: 0 }
        state.set(stateKey, fallbackState)
      }

      // Reset if cooldown expired
      if (Date.now() - fallbackState.lastFallback > COOLDOWN_MS) {
        fallbackState.index = 0
        fallbackState.count = 0
      }

      // Check if we've exhausted the chain
      if (fallbackState.index >= config.fallbacks.length) {
        // Chain exhausted — reset for next time, let the error propagate
        fallbackState.index = 0
        fallbackState.count = 0
        return
      }

      // Get next fallback
      const fallbackSpec = config.fallbacks[fallbackState.index]
      fallbackState.index++
      fallbackState.lastFallback = Date.now()
      fallbackState.count++

      // Parse "provider:model" or just "model" (same provider)
      let fallbackProviderId: string
      let fallbackModel: string

      if (fallbackSpec.includes(':')) {
        ;[fallbackProviderId, fallbackModel] = fallbackSpec.split(':', 2)
      } else {
        fallbackProviderId = ctx.providerId
        fallbackModel = fallbackSpec
      }

      // Set retry info on context — AgentLoop reads this
      ctx.retry = {
        providerId: fallbackProviderId,
        model: fallbackModel,
      }

      // Store fallback info in metadata for downstream hooks (logging, metrics)
      ctx.metadata.fallbackFrom = `${ctx.providerId}:${ctx.model}`
      ctx.metadata.fallbackTo = `${fallbackProviderId}:${fallbackModel}`
      ctx.metadata.fallbackIndex = fallbackState.index
      ctx.metadata.fallbackReason = ctx.statusCode
        ? `HTTP ${ctx.statusCode}`
        : isTimeoutError(ctx.error)
          ? 'timeout'
          : 'auth'
    },
  }
}

/**
 * Reset all fallback state. Useful for testing.
 */
export function createFallbackHookWithState(configs: FallbackConfig[]): {
  hook: HookRegistration<ProviderErrorContext>
  reset: () => void
  getState: () => Map<string, FallbackState>
} {
  const hook = createFallbackHook(configs)
  // Access closure state via a wrapper
  const stateRef = new Map<string, FallbackState>()

  // Re-create with exposed state
  const configMap = new Map<string, FallbackConfig>()
  for (const config of configs) {
    configMap.set(config.providerId, config)
  }

  const COOLDOWN_MS = 5 * 60 * 1000

  const hookWithState: HookRegistration<ProviderErrorContext> = {
    ...hook,
    handler: async (ctx: ProviderErrorContext) => {
      const config = configMap.get(ctx.providerId)
      if (!config || config.fallbacks.length === 0) return

      const triggerCodes = config.triggerCodes ?? [429, 503]
      const triggerOnTimeout = config.triggerOnTimeout ?? true
      const triggerOnAuth = config.triggerOnAuthFailure ?? false

      const codeMatch = ctx.statusCode !== undefined && triggerCodes.includes(ctx.statusCode)
      const timeoutMatch = triggerOnTimeout && isTimeoutError(ctx.error)
      const authMatch = triggerOnAuth && isAuthError(ctx.statusCode, ctx.error)

      if (!codeMatch && !timeoutMatch && !authMatch) return

      const stateKey = `${ctx.providerId}:${ctx.sessionId ?? 'global'}`
      let fallbackState = stateRef.get(stateKey)

      if (!fallbackState) {
        fallbackState = { index: 0, lastFallback: 0, count: 0 }
        stateRef.set(stateKey, fallbackState)
      }

      if (Date.now() - fallbackState.lastFallback > COOLDOWN_MS) {
        fallbackState.index = 0
        fallbackState.count = 0
      }

      if (fallbackState.index >= config.fallbacks.length) {
        fallbackState.index = 0
        fallbackState.count = 0
        return
      }

      const fallbackSpec = config.fallbacks[fallbackState.index]
      fallbackState.index++
      fallbackState.lastFallback = Date.now()
      fallbackState.count++

      let fallbackProviderId: string
      let fallbackModel: string

      if (fallbackSpec.includes(':')) {
        ;[fallbackProviderId, fallbackModel] = fallbackSpec.split(':', 2)
      } else {
        fallbackProviderId = ctx.providerId
        fallbackModel = fallbackSpec
      }

      ctx.retry = {
        providerId: fallbackProviderId,
        model: fallbackModel,
      }

      ctx.metadata.fallbackFrom = `${ctx.providerId}:${ctx.model}`
      ctx.metadata.fallbackTo = `${fallbackProviderId}:${fallbackModel}`
      ctx.metadata.fallbackIndex = fallbackState.index
      ctx.metadata.fallbackReason = ctx.statusCode
        ? `HTTP ${ctx.statusCode}`
        : isTimeoutError(ctx.error)
          ? 'timeout'
          : 'auth'
    },
  }

  return {
    hook: hookWithState,
    reset: () => stateRef.clear(),
    getState: () => stateRef,
  }
}
