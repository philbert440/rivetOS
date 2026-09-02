/**
 * Sidebar UI prefs. `conversationsCollapsed` means the conversations pane is
 * hidden (it collapses into the Conversations rail entry — not an in-drawer
 * disclosure). `railCollapsed` is the left nav's icon-only mode.
 * The persist key is shared so both flags round-trip in one blob.
 *
 * Persist `version` is 2: v<2 blobs treated `conversationsCollapsed` as an
 * in-drawer list disclosure, so migrate resets it to `false` (pane visible)
 * rather than hiding the pane for anyone who had collapsed the list (#628).
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

const KEY = 'rivethub.sidebar'

interface SidebarPrefsState {
  /** True when the conversations pane is unmounted / hidden. */
  conversationsCollapsed: boolean
  setConversationsCollapsed: (collapsed: boolean) => void
  /** True when the left nav rail is icon-only (~48 px). */
  railCollapsed: boolean
  setRailCollapsed: (collapsed: boolean) => void
  /** Re-show the conversations pane — rail Conversations button only. */
  openConversation: () => void
}

type PersistedSidebarPrefs = Pick<SidebarPrefsState, 'conversationsCollapsed' | 'railCollapsed'>

export const useSidebarPrefs = create<SidebarPrefsState>()(
  persist(
    (set) => ({
      conversationsCollapsed: false,
      setConversationsCollapsed: (conversationsCollapsed) => set({ conversationsCollapsed }),
      railCollapsed: false,
      setRailCollapsed: (railCollapsed) => set({ railCollapsed }),
      openConversation: () => set({ conversationsCollapsed: false }),
    }),
    {
      name: KEY,
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (s): PersistedSidebarPrefs => ({
        conversationsCollapsed: s.conversationsCollapsed,
        railCollapsed: s.railCollapsed,
      }),
      migrate: (persisted, version): PersistedSidebarPrefs => {
        const state = (persisted ?? {}) as Partial<PersistedSidebarPrefs>
        if (version < 2) {
          return {
            conversationsCollapsed: false,
            railCollapsed: state.railCollapsed ?? false,
          }
        }
        return {
          conversationsCollapsed: state.conversationsCollapsed ?? false,
          railCollapsed: state.railCollapsed ?? false,
        }
      },
    },
  ),
)
