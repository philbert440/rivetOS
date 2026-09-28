/**
 * Start a new conversation — the pane's `+ new` and Ctrl+T. With an agent
 * selected in the rail (stores/agent-filter) it starts one with that agent,
 * re-pinning it; otherwise a bare draft, which the chat page's default
 * harness picks up on first send.
 */

import { useAgentFilter } from '../stores/agent-filter.js'
import { useChat } from '../stores/chat.js'
import { uuidv4 } from './uuid.js'

export function startNewConversation(): void {
  const { startNew } = useAgentFilter.getState()
  if (startNew) {
    startNew()
    return
  }
  // A draft id IS a UUID so it can become the harness's native session id.
  const id = uuidv4()
  const chat = useChat.getState()
  chat.addDraft(id)
  chat.setActive(id)
}
