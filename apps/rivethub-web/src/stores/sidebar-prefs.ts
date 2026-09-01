/**
 * Sidebar UI prefs. Conversations-list collapse is the first one; the
 * persist key is shared so later rail prefs can join the same blob.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

const KEY = 'rivethub.sidebar'

interface SidebarPrefsState {
  conversationsCollapsed: boolean
  setConversationsCollapsed: (collapsed: boolean) => void
}

export const useSidebarPrefs = create<SidebarPrefsState>()(
  persist(
    (set) => ({
      conversationsCollapsed: false,
      setConversationsCollapsed: (conversationsCollapsed) => set({ conversationsCollapsed }),
    }),
    {
      name: KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ conversationsCollapsed: s.conversationsCollapsed }),
    },
  ),
)
