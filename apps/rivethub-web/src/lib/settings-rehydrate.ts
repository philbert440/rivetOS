/**
 * Re-read the file-backed zustand persist stores after
 * hydrateSettingsIfEmpty(). Each store hydrated synchronously at module init,
 * before the async file restore landed, so after a localStorage wipe it holds
 * defaults — and its first write would persist those over the restored file.
 */

import { useChatSettings } from '../stores/chat-settings.js'
import { useKeyBindings } from '../stores/key-bindings.js'
import { usePreferences } from '../stores/preferences.js'
import { useSessionNames } from '../stores/session-names.js'
import { useSpaces } from '../stores/spaces.js'
import { useWikiSettings } from '../stores/wiki-settings.js'

/** Persist stores whose keys are in settings-sync's SETTINGS_KEYS. */
const FILE_BACKED_STORES = [
  useChatSettings,
  useKeyBindings,
  usePreferences,
  useSessionNames,
  useSpaces,
  useWikiSettings,
]

export async function rehydrateFileBackedStores(): Promise<void> {
  await Promise.all(FILE_BACKED_STORES.map((s) => Promise.resolve(s.persist.rehydrate())))
}
