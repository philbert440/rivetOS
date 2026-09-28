/**
 * The agent the conversations pane is narrowed to. Picking an agent in the
 * rail (click or Ctrl+Tab) sets it; the pane lists only that agent's sessions
 * and its `+ new` starts a fresh one with the agent. Session state — not
 * persisted, so a reload shows every conversation again.
 *
 * `startNew` is handed over by the agents section, which owns what a fresh
 * agent session needs (settings, node, pin). It is refreshed whenever the
 * roster re-renders, so it never runs against a stale agent.
 */

import { create } from 'zustand'

export interface AgentFilterState {
  agentId?: string
  name?: string
  accent?: string
  startNew?: () => void
  select: (filter: { agentId: string; name: string; accent: string; startNew: () => void }) => void
  clear: () => void
}

export const useAgentFilter = create<AgentFilterState>((set) => ({
  select: (filter) => set(filter),
  clear: () => set({ agentId: undefined, name: undefined, accent: undefined, startNew: undefined }),
}))
