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
  /** Datahub gateway origin, e.g. http://datahub-host. '' = unset. */
  wikiBaseUrl: string
  setWikiBaseUrl: (url: string) => void
}

function loadStored(): string {
  return normalizeWikiBase(localStorage.getItem(KEY) ?? '')
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
