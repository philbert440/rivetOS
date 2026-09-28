/**
 * Default view for a conversation: which of Terminal | Chat it opens on, for
 * new conversations and for old ones the user never switched. An explicit
 * switch inside a conversation is remembered for that thread
 * (lib/session-mode.ts) and wins over this; so does a TUI-only legacy
 * session, which has no chat surface and always opens on the terminal.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { SessionViewMode } from '../lib/session-mode.js'

const KEY = 'rivethub.conversationView'

interface ConversationViewState {
  defaultView: SessionViewMode
  setDefaultView: (view: SessionViewMode) => void
}

type Persisted = Pick<ConversationViewState, 'defaultView'>

/** Anything but an explicit 'terminal' is the historical default, chat. */
export function normalizeDefaultView(raw: unknown): SessionViewMode {
  return raw === 'terminal' ? 'terminal' : 'chat'
}

export const useConversationView = create<ConversationViewState>()(
  persist(
    (set) => ({
      defaultView: 'chat',
      setDefaultView: (view) => set({ defaultView: normalizeDefaultView(view) }),
    }),
    {
      name: KEY,
      // Resolved per call, and failures ignored: storage may be disabled
      // (private window) or not there yet, and the setting then just
      // doesn't persist — it must never break opening a conversation.
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          try {
            return globalThis.localStorage.getItem(name)
          } catch {
            return null
          }
        },
        setItem: (name, value) => {
          try {
            globalThis.localStorage.setItem(name, value)
          } catch {
            /* not persisted */
          }
        },
        removeItem: (name) => {
          try {
            globalThis.localStorage.removeItem(name)
          } catch {
            /* not persisted */
          }
        },
      })),
      partialize: (s): Persisted => ({ defaultView: s.defaultView }),
      merge: (persisted, current) => ({
        ...current,
        defaultView: normalizeDefaultView(
          (persisted as Partial<Persisted> | undefined)?.defaultView,
        ),
      }),
    },
  ),
)
