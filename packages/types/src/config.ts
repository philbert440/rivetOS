/**
 * Runtime and agent configuration types.
 */

import type { ThinkingLevel } from './provider.js';
import type { HookConfig, FallbackConfig } from './hooks.js';

export interface RuntimeConfig {
  agents: AgentConfig[];
  workspaceDir: string;
  defaultAgent: string;
  maxToolIterations?: number;
  heartbeats?: HeartbeatConfig[];
  /** Declarative hook definitions (loaded from config) */
  hooks?: HookConfig[];
  /** Provider fallback chains */
  fallbacks?: FallbackConfig[];
}

export interface AgentConfig {
  id: string;
  name: string;
  provider: string;
  workspaceFiles?: string[];
  providerConfig?: Record<string, unknown>;
  /** Default thinking level for this agent */
  defaultThinking?: ThinkingLevel;
  /** Per-agent hook overrides */
  hooks?: HookConfig[];
  /** Per-agent fallback chain (overrides global fallback for this agent's provider) */
  fallbacks?: string[];
}

export interface HeartbeatConfig {
  schedule: string | number;
  agent: string;
  prompt: string;
  outputChannel?: string;
  quietHours?: { start: number; end: number };
}
