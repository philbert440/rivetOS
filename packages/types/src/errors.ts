/**
 * Structured error hierarchy for RivetOS.
 *
 * Every error is typed, coded, and JSON-serializable for structured logging.
 * All errors carry severity and retryable flags for circuit breakers and log routing.
 *
 * Hierarchy:
 *   RivetError (base)
 *   ├── ChannelError
 *   ├── MemoryError
 *   ├── ConfigError
 *   ├── ToolError
 *   ├── DelegationError
 *   └── RuntimeError
 *
 * Note: ProviderError lives in provider.ts for backward compatibility
 * but follows the same patterns (toJSON, retryable, severity).
 */

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export type ErrorSeverity = 'fatal' | 'error' | 'warning' | 'transient'

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export interface RivetErrorOptions {
  code: string
  message: string
  severity?: ErrorSeverity
  cause?: Error
  context?: Record<string, unknown>
  retryable?: boolean
}

export class RivetError extends Error {
  readonly code: string
  readonly severity: ErrorSeverity
  readonly context: Record<string, unknown>
  readonly retryable: boolean
  readonly timestamp: number

  constructor(options: RivetErrorOptions) {
    super(options.message)
    this.name = 'RivetError'
    this.code = options.code
    this.severity = options.severity ?? 'error'
    this.context = options.context ?? {}
    this.retryable = options.retryable ?? false
    this.timestamp = Date.now()
    if (options.cause) {
      this.cause = options.cause
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      severity: this.severity,
      retryable: this.retryable,
      timestamp: this.timestamp,
      context: this.context,
      ...(this.cause instanceof Error ? { cause: this.cause.message } : {}),
      stack: this.stack,
    }
  }
}

// ---------------------------------------------------------------------------
// Channel Errors
// ---------------------------------------------------------------------------

export type ChannelErrorCode =
  | 'CHANNEL_DISCONNECTED'
  | 'CHANNEL_SEND_FAILED'
  | 'CHANNEL_AUTH_FAILED'
  | 'CHANNEL_RATE_LIMITED'
  | 'CHANNEL_START_FAILED'

export class ChannelError extends RivetError {
  readonly channelId?: string
  readonly platform?: string

  constructor(
    code: ChannelErrorCode,
    message: string,
    options?: {
      channelId?: string
      platform?: string
      severity?: ErrorSeverity
      cause?: Error
      context?: Record<string, unknown>
      retryable?: boolean
    },
  ) {
    const defaults: Record<ChannelErrorCode, { severity: ErrorSeverity; retryable: boolean }> = {
      CHANNEL_DISCONNECTED: { severity: 'transient', retryable: true },
      CHANNEL_SEND_FAILED: { severity: 'error', retryable: true },
      CHANNEL_AUTH_FAILED: { severity: 'fatal', retryable: false },
      CHANNEL_RATE_LIMITED: { severity: 'transient', retryable: true },
      CHANNEL_START_FAILED: { severity: 'fatal', retryable: false },
    }

    super({
      code,
      message,
      severity: options?.severity ?? defaults[code].severity,
      retryable: options?.retryable ?? defaults[code].retryable,
      cause: options?.cause,
      context: {
        ...options?.context,
        ...(options?.channelId ? { channelId: options.channelId } : {}),
        ...(options?.platform ? { platform: options.platform } : {}),
      },
    })
    this.name = 'ChannelError'
    this.channelId = options?.channelId
    this.platform = options?.platform
  }
}

// ---------------------------------------------------------------------------
// Memory Errors
// ---------------------------------------------------------------------------

export type MemoryErrorCode =
  | 'MEMORY_CONNECTION_FAILED'
  | 'MEMORY_QUERY_FAILED'
  | 'MEMORY_MIGRATION_FAILED'
  | 'MEMORY_EMBED_FAILED'

export class MemoryError extends RivetError {
  constructor(
    code: MemoryErrorCode,
    message: string,
    options?: {
      severity?: ErrorSeverity
      cause?: Error
      context?: Record<string, unknown>
      retryable?: boolean
    },
  ) {
    const defaults: Record<MemoryErrorCode, { severity: ErrorSeverity; retryable: boolean }> = {
      MEMORY_CONNECTION_FAILED: { severity: 'fatal', retryable: true },
      MEMORY_QUERY_FAILED: { severity: 'error', retryable: true },
      MEMORY_MIGRATION_FAILED: { severity: 'fatal', retryable: false },
      MEMORY_EMBED_FAILED: { severity: 'warning', retryable: true },
    }

    super({
      code,
      message,
      severity: options?.severity ?? defaults[code].severity,
      retryable: options?.retryable ?? defaults[code].retryable,
      cause: options?.cause,
      context: options?.context,
    })
    this.name = 'MemoryError'
  }
}

// ---------------------------------------------------------------------------
// Config Errors
// ---------------------------------------------------------------------------

export type ConfigErrorCode = 'CONFIG_INVALID' | 'CONFIG_MISSING' | 'CONFIG_PARSE_FAILED'

export class ConfigError extends RivetError {
  readonly path?: string

  constructor(
    code: ConfigErrorCode,
    message: string,
    options?: {
      path?: string
      severity?: ErrorSeverity
      cause?: Error
      context?: Record<string, unknown>
    },
  ) {
    super({
      code,
      message,
      severity: options?.severity ?? 'fatal',
      retryable: false,
      cause: options?.cause,
      context: {
        ...options?.context,
        ...(options?.path ? { path: options.path } : {}),
      },
    })
    this.name = 'ConfigError'
    this.path = options?.path
  }
}

// ---------------------------------------------------------------------------
// Tool Errors
// ---------------------------------------------------------------------------

export type ToolErrorCode =
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_TIMEOUT'
  | 'TOOL_BLOCKED'

export class ToolError extends RivetError {
  readonly toolName?: string

  constructor(
    code: ToolErrorCode,
    message: string,
    options?: {
      toolName?: string
      severity?: ErrorSeverity
      cause?: Error
      context?: Record<string, unknown>
      retryable?: boolean
    },
  ) {
    const defaults: Record<ToolErrorCode, { severity: ErrorSeverity; retryable: boolean }> = {
      TOOL_EXECUTION_FAILED: { severity: 'error', retryable: false },
      TOOL_NOT_FOUND: { severity: 'error', retryable: false },
      TOOL_TIMEOUT: { severity: 'warning', retryable: true },
      TOOL_BLOCKED: { severity: 'warning', retryable: false },
    }

    super({
      code,
      message,
      severity: options?.severity ?? defaults[code].severity,
      retryable: options?.retryable ?? defaults[code].retryable,
      cause: options?.cause,
      context: {
        ...options?.context,
        ...(options?.toolName ? { toolName: options.toolName } : {}),
      },
    })
    this.name = 'ToolError'
    this.toolName = options?.toolName
  }
}

// ---------------------------------------------------------------------------
// Delegation Errors
// ---------------------------------------------------------------------------

export type DelegationErrorCode =
  | 'DELEGATION_TIMEOUT'
  | 'DELEGATION_AGENT_NOT_FOUND'
  | 'DELEGATION_FAILED'

export class DelegationError extends RivetError {
  readonly fromAgent?: string
  readonly toAgent?: string

  constructor(
    code: DelegationErrorCode,
    message: string,
    options?: {
      fromAgent?: string
      toAgent?: string
      severity?: ErrorSeverity
      cause?: Error
      context?: Record<string, unknown>
      retryable?: boolean
    },
  ) {
    const defaults: Record<DelegationErrorCode, { severity: ErrorSeverity; retryable: boolean }> = {
      DELEGATION_TIMEOUT: { severity: 'error', retryable: true },
      DELEGATION_AGENT_NOT_FOUND: { severity: 'error', retryable: false },
      DELEGATION_FAILED: { severity: 'error', retryable: false },
    }

    super({
      code,
      message,
      severity: options?.severity ?? defaults[code].severity,
      retryable: options?.retryable ?? defaults[code].retryable,
      cause: options?.cause,
      context: {
        ...options?.context,
        ...(options?.fromAgent ? { fromAgent: options.fromAgent } : {}),
        ...(options?.toAgent ? { toAgent: options.toAgent } : {}),
      },
    })
    this.name = 'DelegationError'
    this.fromAgent = options?.fromAgent
    this.toAgent = options?.toAgent
  }
}

// ---------------------------------------------------------------------------
// Runtime Errors
// ---------------------------------------------------------------------------

export type RuntimeErrorCode = 'RUNTIME_START_FAILED' | 'RUNTIME_SHUTDOWN_ERROR'

export class RuntimeError extends RivetError {
  constructor(
    code: RuntimeErrorCode,
    message: string,
    options?: {
      severity?: ErrorSeverity
      cause?: Error
      context?: Record<string, unknown>
    },
  ) {
    super({
      code,
      message,
      severity: options?.severity ?? (code === 'RUNTIME_START_FAILED' ? 'fatal' : 'error'),
      retryable: false,
      cause: options?.cause,
      context: options?.context,
    })
    this.name = 'RuntimeError'
  }
}
