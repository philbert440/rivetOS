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
  /** Last unarchived conversation count (ephemeral — ChatPage publishes).
   *  `null` until chat has mounted once this session. */
  unarchivedCount: number | null
  setUnarchivedCount: (n: number) => void
  /** True while ChatPage is mounted (WS status is only meaningful then). */
  chatMounted: boolean
  setChatMounted: (mounted: boolean) => void
  /** Re-show the conversations pane (deep link, agent rail, row click). */
  openConversation: () => void
}

type PersistedSidebarPrefs = Pick<SidebarPrefsState, 'conversationsCollapsed' | 'railCollapsed'>

/**
 * Badge on the Conversations rail entry when the pane is hidden.
 * Empty string means "don't render a badge" (zero / non-finite).
 */
export function railBadgeText(unarchivedCount: number): string {
  if (!Number.isFinite(unarchivedCount) || unarchivedCount <= 0) return ''
  return unarchivedCount > 99 ? '99+' : String(Math.round(unarchivedCount))
}

/**
 * Whether a `?session=` URL change should re-show the conversations pane.
 * The first (pre-mount) run must not — otherwise a reload of `/?session=X`
 * undoes a deliberately hidden pane. Subsequent navigations still open it.
 */
export function shouldOpenPaneOnUrlChange(opts: {
  mounted: boolean
  sessionFromUrl: string | undefined
  prev: string | undefined
}): boolean {
  if (!opts.mounted) return false
  if (!opts.sessionFromUrl) return false
  return opts.sessionFromUrl !== opts.prev
}

export const useSidebarPrefs = create<SidebarPrefsState>()(
  persist(
    (set) => ({
      conversationsCollapsed: false,
      setConversationsCollapsed: (conversationsCollapsed) => set({ conversationsCollapsed }),
      railCollapsed: false,
      setRailCollapsed: (railCollapsed) => set({ railCollapsed }),
      unarchivedCount: null,
      setUnarchivedCount: (unarchivedCount) => set({ unarchivedCount }),
      chatMounted: false,
      setChatMounted: (chatMounted) => set({ chatMounted }),
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
