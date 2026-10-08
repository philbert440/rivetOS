/**
 * Start a new conversation — the pane's `+ new` and Ctrl+T. With an agent
 * selected in the rail (stores/agent-filter) it starts one with that agent,
 * re-pinning it; otherwise a bare draft, which the chat page's default
 * harness picks up on first send.
 *
 * The canvas binds a starter while it is focused on a space that has
 * defaults. That mint wins over the rail. No binding, or a starter that
 * returns undefined, keeps today's behaviour.
 */

import { useAgentFilter } from '../stores/agent-filter.js'
import { useChat } from '../stores/chat.js'
import { uuidv4 } from './uuid.js'

/** Returns a new draft id, or undefined when this Ctrl+T should stay on the rail. */
type SpaceThreadStarter = () => string | undefined

let spaceThreadStarter: SpaceThreadStarter | null = null

/** Canvas-only. `null` clears it. The starter must mint synchronously. */
export function bindSpaceThreadStarter(starter: SpaceThreadStarter | null): void {
  spaceThreadStarter = starter
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
    // A draft id IS a UUID so it can become the harness's native session id.
    const id = uuidv4()
    chat.addDraft(id)
    chat.setActive(id)
  }
  return useChat.getState().drafts.find((id) => !before.has(id))
}
