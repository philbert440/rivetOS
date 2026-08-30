/**
 * Rekey support for chat threads: when a session's id changes underneath an
 * open conversation (draft adoption, native-id rotation, a bare-id 404 that
 * list-scans to a claimed id), every store keyed by the old id must move —
 * including the agent last-session pin and the session-node binding, or the
 * next poll resolves the dead id and snaps the thread back.
 */

import { rekeyAgentLastSessions } from './agent-session.js'
import { moveSessionMode } from './session-mode.js'
import { rekeySessionNodeBinding, sessionNodeFor } from './session-node.js'
import { rekeySystemPromptSent } from './system-prompt-sent.js'
import { useChatSettings } from '../stores/chat-settings.js'
import { useSessionNames } from '../stores/session-names.js'

/** localStorage key for a thread's per-node persisted state. */
export const storageKey = (baseUrl: string, key: string): string => `${baseUrl}::${key}`

/**
 * Move a thread's persisted state onto a key it has just been rekeyed to.
 *
 * The read fallback in the chat page's `persisted()` covers bare → canonical.
 * This covers the case it cannot: a driver ROTATING its native id, where old
 * and new keys share nothing. Lazy — only threads the client actually touches
 * pay for it.
 *
 * ONLY call this when the thread's records really moved. On a destination
 * collision `rekey` deliberately leaves two live threads apart, and copying
 * the retired one's custom name onto the survivor (then clearing it from the
 * original) would swap two real conversations' metadata at exactly the moment
 * the code decided they must not merge — hence the `moved` gate at every call
 * site. Both stores are cleared, not just the name: a half-migrated key would
 * resurrect stale settings through `persisted()`'s fallback.
 */
export function migrateSessionKey(
  currentBase: string,
  rosterUrls: readonly string[],
  from: string,
  to: string,
): void {
  // Per-thread state is keyed on the SESSION's node, which for a cross-node
  // thread is not the caller's node — resolve it BEFORE the binding rekeys.
  const node = sessionNodeFor(from, currentBase, rosterUrls)
  const names = useSessionNames.getState()
  const name = names.byKey[storageKey(node, from)]
  if (name !== undefined && names.byKey[storageKey(node, to)] === undefined) {
    names.set(storageKey(node, to), name)
  }
  names.set(storageKey(node, from), '') // empty clears the override
  const settings = useChatSettings.getState()
  const prior = settings.byKey[storageKey(node, from)]
  if (prior !== undefined && settings.byKey[storageKey(node, to)] === undefined) {
    settings.set(storageKey(node, to), prior)
  }
  settings.clear(storageKey(node, from))
  // Dest-non-clobber (names rule): an existing remembered view on the
  // canonical key survives adoption. Deliberately the OPPOSITE of the node
  // binding's last-write-wins below — a stale mode costs one click, a stale
  // node binding retargets every request for the thread.
  moveSessionMode(storageKey(node, from), storageKey(node, to))
  rekeyAgentLastSessions(from, to)
  rekeySessionNodeBinding(from, to)
  rekeySystemPromptSent(from, to)
}
