/**
 * Experimental feature flags. Files / Tasks / Workflows are unfinished —
 * off by default, persisted so a reload keeps the choice. Memory is not
 * experimental and is not in this slice.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { EXPERIMENTAL_DEFAULTS, type ExperimentalFlags } from '../lib/visible-nav.js'

export type { ExperimentalFlags }

const KEY = 'rivethub.experimental'

interface ExperimentalState {
  experimental: ExperimentalFlags
  setFiles: (files: boolean) => void
  setTasks: (tasks: boolean) => void
  setWorkflows: (workflows: boolean) => void
}

type Persisted = Pick<ExperimentalState, 'experimental'>

export function setExperimentalFlag(
  flags: ExperimentalFlags,
  key: keyof ExperimentalFlags,
  value: boolean,
): ExperimentalFlags {
  if (flags[key] === value) return flags
  return { ...flags, [key]: value }
}

function normalizeFlags(raw: Partial<ExperimentalFlags> | undefined): ExperimentalFlags {
  return {
    files: raw?.files === true,
    tasks: raw?.tasks === true,
    workflows: raw?.workflows === true,
  }
}

export const useExperimental = create<ExperimentalState>()(
  persist(
    (set) => ({
      experimental: { ...EXPERIMENTAL_DEFAULTS },
      setFiles: (files) =>
        set((s) => ({ experimental: setExperimentalFlag(s.experimental, 'files', files) })),
      setTasks: (tasks) =>
        set((s) => ({ experimental: setExperimentalFlag(s.experimental, 'tasks', tasks) })),
      setWorkflows: (workflows) =>
        set((s) => ({ experimental: setExperimentalFlag(s.experimental, 'workflows', workflows) })),
    }),
    {
      name: KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s): Persisted => ({ experimental: s.experimental }),
      merge: (persisted, current) => {
        const p = persisted as Partial<Persisted> | undefined
        return {
          ...current,
          experimental: normalizeFlags(p?.experimental),
        }
      },
    },
  ),
)
