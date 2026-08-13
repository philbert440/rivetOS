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
import { normalizeWikiBase } from '../lib/wiki-base.js'

const KEY = 'rivethub.wikiUrl'

interface WikiSettingsState {
  /** Datahub gateway origin, e.g. https://datahub-host:5174. '' = unset. */
  wikiBaseUrl: string
  setWikiBaseUrl: (url: string) => void
}

function loadStored(): string {
  const raw = localStorage.getItem(KEY) ?? ''
  const url = normalizeWikiBase(raw)
  // Persist http://lan-host → https://lan-host:5174 so a later reader that
  // skips normalize cannot send the desktop pipe at :443 again.
  if (url && url !== raw) localStorage.setItem(KEY, url)
  return url
}

export const useWikiSettings = create<WikiSettingsState>((set) => ({
  wikiBaseUrl: loadStored(),
  setWikiBaseUrl(raw: string): void {
    const url = normalizeWikiBase(raw)
    if (url) localStorage.setItem(KEY, url)
    else localStorage.removeItem(KEY)
    set({ wikiBaseUrl: url })
  },
}))
