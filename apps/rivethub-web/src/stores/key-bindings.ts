/**
 * Rebound shortcuts. Only overrides are stored: an action with no entry uses
 * its built-in default (lib/hub-keys), and an empty list means "unbound".
 *
 * `recording` is true while Settings waits for a keypress to record, so the
 * live shortcut listeners stand down instead of acting on that press.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { normalizeCombos, type KeyCombo } from '../lib/key-combo.js'

const KEY = 'rivethub.keyBindings'

interface KeyBindingsState {
  overrides: Record<string, KeyCombo[]>
  recording: boolean
  setBinding: (id: string, combos: KeyCombo[]) => void
  resetBinding: (id: string) => void
  resetAll: () => void
  setRecording: (on: boolean) => void
}

type Persisted = Pick<KeyBindingsState, 'overrides'>

export function normalizeOverrides(raw: unknown): Record<string, KeyCombo[]> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, KeyCombo[]> = {}
  for (const [id, value] of Object.entries(raw)) {
    const combos = normalizeCombos(value)
    if (combos) out[id] = combos
  }
  return out
}

export const useKeyBindings = create<KeyBindingsState>()(
  persist(
    (set) => ({
      overrides: {},
      recording: false,
      setBinding: (id, combos) => set((s) => ({ overrides: { ...s.overrides, [id]: combos } })),
      resetBinding: (id) =>
        set((s) => {
          if (!Object.hasOwn(s.overrides, id)) return s
          const { [id]: _gone, ...rest } = s.overrides
          return { overrides: rest }
        }),
      resetAll: () => set({ overrides: {} }),
      setRecording: (on) => set({ recording: on }),
    }),
    {
      name: KEY,
      // Storage may be missing (tests, private window); shortcuts still work
      // on their defaults.
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
      partialize: (s): Persisted => ({ overrides: s.overrides }),
      merge: (persisted, current) => ({
        ...current,
        overrides: normalizeOverrides((persisted as Partial<Persisted> | undefined)?.overrides),
      }),
    },
  ),
)

export const KEY_BINDINGS_STORAGE_KEY = KEY
