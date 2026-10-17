/**
 * Canvas HUD state the rail reaches: the shortcuts dock, opened from the
 * rail's Shortcuts button, and the Agents pop-out, which Ctrl+Tab opens
 * from anywhere. The canvas owns both and publishes its "needs you" count
 * here so the rail button can badge it while the dock is shut.
 * Session state — not persisted.
 */

import { create } from 'zustand'

export interface CanvasDockState {
  open: boolean
  needs: number
  agentsOpen: boolean
  /** Which agent row takes focus when the pop-out opens from the keyboard. */
  agentsFrom: 'first' | 'last'
  /** Bumped on every keyboard open, so a repeat re-focuses the list. */
  agentsSeq: number
  setOpen: (open: boolean) => void
  toggle: () => void
  setNeeds: (needs: number) => void
  setAgentsOpen: (open: boolean) => void
  /** Ctrl+Tab: open the pop-out with keyboard focus in its list. */
  focusAgents: (from: 'first' | 'last') => void
}

export const useCanvasDock = create<CanvasDockState>((set) => ({
  open: false,
  needs: 0,
  agentsOpen: false,
  agentsFrom: 'first',
  agentsSeq: 0,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setNeeds: (needs) => set({ needs }),
  setAgentsOpen: (agentsOpen) => set({ agentsOpen }),
  focusAgents: (from) =>
    set((s) => ({ agentsOpen: true, agentsFrom: from, agentsSeq: s.agentsSeq + 1 })),
}))
