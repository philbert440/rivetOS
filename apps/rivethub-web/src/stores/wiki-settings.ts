/**
 * Memory-wiki endpoint override, persisted. The wiki lives on ONE node (the
 * datahub serves /wiki for the whole mesh), so unlike everything else in the
 * app it should not follow the node switcher — an explicit URL set here wins;
 * unset falls back to the active gateway's /wiki.
 */

import { create } from 'zustand'

const KEY = 'rivethub.wikiUrl'

interface WikiSettingsState {
  /** Full URL of the wiki root, e.g. http://datahub-host/wiki. '' = unset. */
  wikiUrl: string
  setWikiUrl: (url: string) => void
}

/** http(s) URL, origin + optional path — same shape the iframe src needs. */
export function isValidWikiUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export const useWikiSettings = create<WikiSettingsState>((set) => ({
  wikiUrl: localStorage.getItem(KEY) ?? '',
  setWikiUrl(raw: string): void {
    const url = raw.trim().replace(/\/+$/, '')
    if (url) localStorage.setItem(KEY, url)
    else localStorage.removeItem(KEY)
    set({ wikiUrl: url })
  },
}))
