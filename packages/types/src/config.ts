/**
 * Runtime and agent configuration types.
 */

import type { ThinkingLevel } from './provider.js'
import type { HookConfig, FallbackConfig } from './hooks.js'
import type { MeshConfig } from './mesh.js'

export interface RuntimeConfig {
  agents: AgentConfig[]
  workspaceDir: string
  defaultAgent: string
  maxToolIterations?: number
  heartbeats?: HeartbeatConfig[]
  /** Declarative hook definitions (loaded from config) */
  hooks?: HookConfig[]
  /** Provider fallback chains */
  fallbacks?: FallbackConfig[]
  /** Learning loop configuration (M4.2) */
  learning?: LearningLoopConfig
  /** Multi-agent mesh configuration (M7.5) */
  mesh?: MeshConfig
}

export interface LearningLoopConfig {
  /** Minimum tool calls to trigger reflection (default: 5) */
  reflectToolThreshold?: number
  /** Whether to reflect on error recovery turns (default: true) */
  reflectOnErrorRecovery?: boolean
  /** Whether to reflect on fallback triggers (default: true) */
  reflectOnFallback?: boolean
  /** Whether to reflect on user corrections/steers (default: true) */
  reflectOnCorrection?: boolean
  /** Periodic nudge interval in ms (default: 1800000 = 30min, 0 to disable) */
  periodicNudgeIntervalMs?: number
}

/** Agent-scoped tool filtering — controls which tools are available when this agent runs as a delegate */
export interface AgentToolFilter {
  /** Tools to exclude (blocklist) — these tools will not be available to this agent */
  exclude?: string[]
  /** Tools to include (allowlist) — only these tools will be available. Overrides exclude if both set. */
  include?: string[]
}

export interface AgentConfig {
  id: string
  name: string
  provider: string
  workspaceFiles?: string[]
  providerConfig?: Record<string, unknown>
  /** Default thinking level for this agent */
  defaultThinking?: ThinkingLevel
  /** Per-agent hook overrides */
  hooks?: HookConfig[]
  /** Per-agent fallback chain (overrides global fallback for this agent's provider) */
  fallbacks?: string[]
  /** Whether this agent uses a local/self-hosted provider (free tokens → extended context) */
  local?: boolean
  /** Tool filtering for when this agent runs as a delegate or sub-agent */
  tools?: AgentToolFilter
}

export interface HeartbeatConfig {
  schedule: string | number
  agent: string
  prompt: string
  outputChannel?: string
  quietHours?: { start: number; end: number }
}
