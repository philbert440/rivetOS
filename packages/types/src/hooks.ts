/**
 * Hook system types — composable async pipelines for lifecycle events.
 *
 * Design principles:
 * - Async-first: hooks may call external services
 * - Data passing: hooks transform a context object through the pipeline
 * - Priority ordering: lower number = runs first (0-99)
 * - Short-circuit: hooks can abort the pipeline
 * - Error modes: continue (log & proceed), abort (stop pipeline), retry
 *
 * Usage pattern:
 *   Router uses hooks internally for fallbacks, rate limiting, cost tracking.
 *   Users register hooks via config or code for custom behavior.
 */

// ---------------------------------------------------------------------------
// Hook Event Names
// ---------------------------------------------------------------------------

/**
 * Lifecycle events that hooks can subscribe to.
 *
 * Provider lifecycle:
 *   provider:before  — before calling a provider (rate limit checks, request shaping)
 *   provider:after   — after successful response (token logging, cost tracking)
 *   provider:error   — after provider failure (fallback triggers re-route)
 *
 * Tool lifecycle:
 *   tool:before      — before tool execution (safety checks, approval gates)
 *   tool:after       — after tool execution (auto-format, auto-lint, logging)
 *
 * Session lifecycle:
 *   session:start    — new session created (load context, greet user)
 *   session:end      — session ending (auto-commit, write summary)
 *
 * Turn lifecycle:
 *   turn:before      — before processing a user message (content filtering)
 *   turn:after       — after turn completes (analytics, memory append)
 *
 * Compaction lifecycle:
 *   compact:before   — before memory compaction (preserve important context)
 *   compact:after    — after compaction (verify context survived)
 */
export type HookEventName =
  | 'provider:before'
  | 'provider:after'
  | 'provider:error'
  | 'tool:before'
  | 'tool:after'
  | 'session:start'
  | 'session:end'
  | 'turn:before'
  | 'turn:after'
  | 'compact:before'
  | 'compact:after'
  | 'delegation:before'
  | 'delegation:after'

// ---------------------------------------------------------------------------
// Hook Context — data passed through the pipeline
// ---------------------------------------------------------------------------

/**
 * Base context shared by all hook events.
 * Specific events extend this with event-specific fields.
 */
export interface HookContextBase {
  /** The event that triggered this hook */
  event: HookEventName
  /** Agent ID */
  agentId?: string
  /** Session ID */
  sessionId?: string
  /** Timestamp when the event was emitted */
  timestamp: number
  /** Arbitrary metadata hooks can read/write to pass data downstream */
  metadata: Record<string, unknown>
}

/** Context for provider:before — inspect/modify the request before it goes out */
export interface ProviderBeforeContext extends HookContextBase {
  event: 'provider:before'
  /** Provider being called */
  providerId: string
  /** Model being used */
  model: string
  /** Message array (mutable — hooks can modify) */
  messages: unknown[]
  /** Tool definitions (mutable) */
  tools?: unknown[]
  /** If set to true by a hook, skip this provider and try next fallback */
  skip?: boolean
}

/** Context for provider:after — inspect the response */
export interface ProviderAfterContext extends HookContextBase {
  event: 'provider:after'
  providerId: string
  model: string
  /** Token usage from the response */
  usage?: { promptTokens: number; completionTokens: number }
  /** Response latency in ms */
  latencyMs: number
  /** Whether tool calls were made */
  hasToolCalls: boolean
}

/** Context for provider:error — decide what to do after failure */
export interface ProviderErrorContext extends HookContextBase {
  event: 'provider:error'
  providerId: string
  model: string
  /** The error that occurred */
  error: Error
  /** HTTP status code if available */
  statusCode?: number
  /** Whether to retry with a different provider/model. Set by fallback hooks. */
  retry?: {
    providerId: string
    model: string
  }
}

/** Context for tool:before — inspect/block tool execution */
export interface ToolBeforeContext extends HookContextBase {
  event: 'tool:before'
  /** Tool being called */
  toolName: string
  /** Arguments (mutable — hooks can modify) */
  args: Record<string, unknown>
  /** If set to true, block the tool call and return blockReason */
  blocked?: boolean
  /** Reason for blocking (shown to the LLM) */
  blockReason?: string
}

/** Context for tool:after — inspect tool results */
export interface ToolAfterContext extends HookContextBase {
  event: 'tool:after'
  toolName: string
  args: Record<string, unknown>
  /** Tool result (text or multimodal) */
  result: unknown
  /** Execution time in ms */
  durationMs: number
  /** Whether the tool errored */
  isError: boolean
}

/** Context for session:start */
export interface SessionStartContext extends HookContextBase {
  event: 'session:start'
  /** Channel platform (telegram, discord, etc.) */
  platform?: string
  /** User ID */
  userId?: string
}

/** Context for session:end */
export interface SessionEndContext extends HookContextBase {
  event: 'session:end'
  /** Number of turns in the session */
  turnCount?: number
  /** Total tokens used */
  totalTokens?: { prompt: number; completion: number }
}

/** Context for turn:before — before processing a user message */
export interface TurnBeforeContext extends HookContextBase {
  event: 'turn:before'
  /** User message text */
  userMessage: string
  /** If set to true, skip processing this message */
  skip?: boolean
  /** Reason for skipping */
  skipReason?: string
}

/** Context for turn:after — after turn completes */
export interface TurnAfterContext extends HookContextBase {
  event: 'turn:after'
  /** Agent response text */
  response: string
  /** Tools used during the turn */
  toolsUsed: string[]
  /** Number of tool iterations */
  iterations: number
  /** Whether the turn was aborted */
  aborted: boolean
  /** Token usage */
  usage?: { promptTokens: number; completionTokens: number }
}

/** Context for compact:before */
export interface CompactBeforeContext extends HookContextBase {
  event: 'compact:before'
  /** Number of messages being compacted */
  messageCount: number
}

/** Context for compact:after */
export interface CompactAfterContext extends HookContextBase {
  event: 'compact:after'
  /** Number of messages after compaction */
  remainingMessages: number
  /** Summary that was generated */
  summary?: string
}

/** Context for delegation:before — before delegating to another agent */
export interface DelegationBeforeContext extends HookContextBase {
  event: 'delegation:before'
  /** Agent initiating the delegation */
  fromAgent: string
  /** Target agent */
  toAgent: string
  /** Task being delegated */
  task: string
  /** Current chain depth */
  chainDepth: number
  /** If set to true, block the delegation */
  blocked?: boolean
  /** Reason for blocking */
  blockReason?: string
}

/** Context for delegation:after — after delegation completes */
export interface DelegationAfterContext extends HookContextBase {
  event: 'delegation:after'
  fromAgent: string
  toAgent: string
  task: string
  /** Result status */
  status: 'completed' | 'failed' | 'timeout' | 'cached'
  /** Duration in ms */
  durationMs: number
  /** Token usage from the delegate */
  usage?: { promptTokens: number; completionTokens: number }
  /** Whether the result came from cache */
  cached: boolean
}

/** Union of all context types */
export type HookContext =
  | ProviderBeforeContext
  | ProviderAfterContext
  | ProviderErrorContext
  | ToolBeforeContext
  | ToolAfterContext
  | SessionStartContext
  | SessionEndContext
  | TurnBeforeContext
  | TurnAfterContext
  | CompactBeforeContext
  | CompactAfterContext
  | DelegationBeforeContext
  | DelegationAfterContext

// ---------------------------------------------------------------------------
// Hook Handler
// ---------------------------------------------------------------------------

/** What to do when a hook errors */
export type HookErrorMode = 'continue' | 'abort' | 'retry'

/**
 * A hook handler — a function that receives context and can modify it.
 *
 * Return values:
 * - void/undefined: continue to next hook
 * - 'abort': stop the pipeline, no more hooks run
 * - 'skip': skip remaining hooks but don't error (soft abort)
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export type HookHandlerReturn = void | undefined | 'abort' | 'skip'
export type HookHandlerFn<T extends HookContext = HookContext> = (
  ctx: T,
) => Promise<HookHandlerReturn> | HookHandlerReturn

/**
 * A registered hook with metadata.
 */
export interface HookRegistration<T extends HookContext = HookContext> {
  /** Unique ID for this hook (for removal/debugging) */
  id: string
  /** Event to listen for */
  event: HookEventName
  /** Handler function */
  handler: HookHandlerFn<T>
  /** Priority: lower = runs first. Default: 50. Range: 0-99. */
  priority?: number
  /** What to do if this hook throws. Default: 'continue'. */
  onError?: HookErrorMode
  /** Optional: only run for specific agents */
  agentFilter?: string[]
  /** Optional: only run for specific tools (tool:before/after) */
  toolFilter?: string[]
  /** Description for logging/debugging */
  description?: string
  /** Whether this hook is enabled. Default: true. */
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// Hook Pipeline Interface
// ---------------------------------------------------------------------------

/**
 * Result of running a hook pipeline.
 */
export interface HookPipelineResult<T extends HookContext = HookContext> {
  /** The (possibly mutated) context after all hooks ran */
  context: T
  /** Whether the pipeline was aborted by a hook */
  aborted: boolean
  /** Whether the pipeline was skipped (soft abort) */
  skipped: boolean
  /** Errors from hooks that used 'continue' error mode */
  errors: Array<{ hookId: string; error: Error }>
  /** IDs of hooks that ran */
  ran: string[]
}

/**
 * The hook pipeline — manages registration and execution of hooks.
 */
export interface HookPipeline {
  /** Register a hook */
  register<T extends HookContext>(hook: HookRegistration<T>): void

  /** Unregister a hook by ID */
  unregister(hookId: string): boolean

  /** Run all hooks for an event, passing context through the pipeline */
  run<T extends HookContext>(ctx: T): Promise<HookPipelineResult<T>>

  /** Get all registered hooks (optionally filtered by event) */
  getHooks(event?: HookEventName): HookRegistration[]

  /** Clear all hooks (for testing) */
  clear(): void
}

// ---------------------------------------------------------------------------
// Config types for declarative hook definitions
// ---------------------------------------------------------------------------

/**
 * Hook definition in config — maps to a HookRegistration at boot time.
 */
export interface HookConfig {
  /** Unique ID */
  id: string
  /** Event to listen for */
  event: HookEventName
  /** Handler type */
  type: 'shell' | 'http' | 'internal'
  /** For shell: command to run. For http: URL. For internal: module path. */
  target: string
  /** Priority (0-99, default 50) */
  priority?: number
  /** Error mode */
  onError?: HookErrorMode
  /** Agent filter */
  agentFilter?: string[]
  /** Tool filter */
  toolFilter?: string[]
  /** Description */
  description?: string
  /** Enabled (default true) */
  enabled?: boolean
}

/**
 * Fallback chain config — per provider.
 */
export interface FallbackConfig {
  /** Provider ID this fallback chain belongs to */
  providerId: string
  /** Ordered list of fallback models: provider:model or just model (same provider) */
  fallbacks: string[]
  /** Error codes that trigger fallback (default: [429, 503]) */
  triggerCodes?: number[]
  /** Also trigger on timeout (default: true) */
  triggerOnTimeout?: boolean
  /** Also trigger on auth failure (default: false) */
  triggerOnAuthFailure?: boolean
}
