/**
 * Datahub gateway for the Memory wiki.
 *
 * Wiki is memory-DB summaries in human-readable topic form; it lives on
 * **datahub**, independent of the chat-node switcher. Store the datahub
 * gateway origin (http(s)://host[:port]); Hub calls `/api/wiki` there.
 *
 * Legacy iframe values (`…/wiki`) are normalized on load.
 */

import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
import { normalizeWikiBase } from '../lib/wiki-base.js'

const KEY = 'rivethub.wikiUrl'

interface WikiSettingsState {
  /** Datahub gateway origin, e.g. https://datahub-host:5174. '' = unset. */
  wikiBaseUrl: string
  setWikiBaseUrl: (url: string) => void
}

type Persisted = Pick<WikiSettingsState, 'wikiBaseUrl'>

/** On-disk format is the bare normalized URL string (removed when unset), no envelope. */
const storage: PersistStorage<Persisted> = {
  getItem: (name) => {
    const raw = localStorage.getItem(name) ?? ''
    const url = normalizeWikiBase(raw)
    // Persist http://lan-host → https://lan-host:5174 so a later reader that
    // skips normalize cannot send the desktop pipe at :443 again.
    if (url && url !== raw) localStorage.setItem(name, url)
    return { state: { wikiBaseUrl: url }, version: 0 }
  },
  setItem: (name, value) => {
    if (value.state.wikiBaseUrl) localStorage.setItem(name, value.state.wikiBaseUrl)
    else localStorage.removeItem(name)
  },
  removeItem: (name) => {
    localStorage.removeItem(name)
  },
}

export const useWikiSettings = create<WikiSettingsState>()(
  persist(
    (set) => ({
      wikiBaseUrl: '',
      setWikiBaseUrl(raw: string): void {
        set({ wikiBaseUrl: normalizeWikiBase(raw) })
      },
    }),
    { name: KEY, storage, partialize: (s) => ({ wikiBaseUrl: s.wikiBaseUrl }) },
  ),
)
