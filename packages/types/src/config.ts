/**
 * Runtime and agent configuration types.
 */

import type { ThinkingLevel } from './provider.js';

export interface RuntimeConfig {
  agents: AgentConfig[];
  workspaceDir: string;
  defaultAgent: string;
  maxToolIterations?: number;
  heartbeats?: HeartbeatConfig[];
}

export interface AgentConfig {
  id: string;
  name: string;
  provider: string;
  workspaceFiles?: string[];
  providerConfig?: Record<string, unknown>;
  /** Default thinking level for this agent */
  defaultThinking?: ThinkingLevel;
}

export interface HeartbeatConfig {
  schedule: string | number;
  agent: string;
  prompt: string;
  outputChannel?: string;
  quietHours?: { start: number; end: number };
}
