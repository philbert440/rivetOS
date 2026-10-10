/**
 * Start a new conversation — the pane's `+ new` and Ctrl+T. With an agent
 * selected in the rail (stores/agent-filter) it starts one with that agent,
 * re-pinning it; otherwise a bare draft, which the chat page's default
 * harness picks up on first send.
 *
 * The canvas binds a starter while it is focused on a space that has
 * defaults. That mint wins over the rail. No binding, or a starter that
 * returns undefined, keeps today's behaviour.
 *
 * With neither, Settings → General's new-conversation defaults (agent
 * preset, thinking level) start it the way space defaults do. A preset that
 * is not on the roster right now is skipped; the thinking level still applies.
 *
 * Every new conversation lands in a space: the one the canvas is focused on,
 * else the default space (stores/spaces). The canvas binds the focus getter.
 */

import { useAgentFilter } from '../stores/agent-filter.js'
import { useChat } from '../stores/chat.js'
import { useConnection } from '../stores/connection.js'
import { usePreferences } from '../stores/preferences.js'
import { useSpaces, type SpaceDefaults } from '../stores/spaces.js'
import { startThreadWithDefaults } from '../components/spaces-canvas/new-thread.js'
import { startablePreset } from '../components/spaces-canvas/space-defaults.js'
import { rosterSnapshot } from './use-agent-roster.js'
import { storageKey } from './session-rekey.js'
import { getSessionNodeBinding } from './session-node.js'
import { uuidv4 } from './uuid.js'

/** Returns a new draft id, or undefined when this Ctrl+T should stay on the rail. */
type SpaceThreadStarter = () => string | undefined

let spaceThreadStarter: SpaceThreadStarter | null = null
let focusedSpace: (() => string | undefined) | null = null

/** Canvas-only. `null` clears it. The starter must mint synchronously. */
export function bindSpaceThreadStarter(starter: SpaceThreadStarter | null): void {
  spaceThreadStarter = starter
}

/** Canvas-only. `null` clears it. Returns the space the canvas is focused on. */
export function bindFocusedSpace(getter: (() => string | undefined) | null): void {
  focusedSpace = getter
}

/** Place a fresh draft in the focused space, else the default space. A
 *  node-bound draft is keyed on its node, as `rowMembershipKey` reads it. */
export function placeNewDraft(id: string): void {
  const node = getSessionNodeBinding(id) ?? useConnection.getState().baseUrl
  useSpaces.getState().place(storageKey(node, id), newDraftSpace())
}

function newDraftSpace(): string {
  const spaces = useSpaces.getState()
  const focused = focusedSpace?.()
  return focused && spaces.spaces.some((s) => s.id === focused) ? focused : spaces.defaultSpaceId()
}

/** Start with Settings → General's defaults, or undefined when there are none. */
function startWithPreferences(): string | undefined {
  const prefs = usePreferences.getState().newChat
  const roster = rosterSnapshot()
  const preset = startablePreset(prefs, roster)
  const defaults: SpaceDefaults | undefined = preset
    ? prefs
    : prefs.effort
      ? { effort: prefs.effort }
      : undefined
  if (!defaults) return undefined
  return startThreadWithDefaults(
    newDraftSpace(),
    defaults,
    useConnection.getState().baseUrl,
    roster,
  )
}

/** Returns the draft id when one was created synchronously, otherwise undefined. */
export function startNewConversation(): string | undefined {
  const fromSpace = spaceThreadStarter?.()
  if (fromSpace) return fromSpace
  const chat = useChat.getState()
  const before = new Set(chat.drafts)
  const { startNew } = useAgentFilter.getState()
  if (startNew) {
    startNew()
  } else {
    const fromPreferences = startWithPreferences()
    if (fromPreferences) return fromPreferences
    // A draft id IS a UUID so it can become the harness's native session id.
    const id = uuidv4()
    chat.addDraft(id)
    chat.setActive(id)
  }
  const id = useChat.getState().drafts.find((draft) => !before.has(draft))
  if (id) placeNewDraft(id)
  return id
}
