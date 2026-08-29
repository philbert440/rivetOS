/**
 * Discard a local draft EVERYWHERE. `removeDraft` drops the chat store's
 * records; this also clears every persisted per-key trace — custom name,
 * chat settings, view-mode memory, archived flag, system-prompt-sent latch,
 * and the agent last-session pointer if one targets the draft. Archive is a
 * hide; discard is a delete, and a delete that leaks keys resurrects them
 * the next time a session lands on the same id.
 */

import { useChat } from '../stores/chat.js'
import { useChatSettings } from '../stores/chat-settings.js'
import { useSessionNames } from '../stores/session-names.js'
import { useArchived } from '../stores/archived.js'
import { clearSessionMode } from './session-mode.js'
import { clearSystemPromptSent } from './system-prompt-sent.js'
import { clearAgentLastSession, getAgentLastSession } from './agent-session.js'

export function discardDraft(baseUrl: string, sessionId: string): void {
  const key = `${baseUrl}::${sessionId}`
  useChat.getState().removeDraft(sessionId)
  useSessionNames.getState().set(key, '') // empty clears the override
  useChatSettings.getState().clear(key)
  useArchived.getState().unarchive(key)
  clearSessionMode(key)
  clearSystemPromptSent(sessionId)
  // Reverse bind (written by setAgentLastSession) names the owning agent;
  // clear through the exported API only when the pointer really targets this
  // draft — a stale bind must not nuke a pointer at a newer session.
  try {
    const agentId = localStorage.getItem(`rivethub.agent.${sessionId}`)
    if (agentId && getAgentLastSession(agentId)?.sessionId === sessionId) {
      clearAgentLastSession(agentId)
    } else if (agentId) {
      localStorage.removeItem(`rivethub.agent.${sessionId}`)
    }
  } catch {
    /* storage disabled */
  }
}
