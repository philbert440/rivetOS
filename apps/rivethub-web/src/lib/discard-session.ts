/**
 * Discard a local draft EVERYWHERE. `removeDraft` drops the chat store's
 * records; this also clears every persisted per-key trace — custom name,
 * chat settings, view-mode memory, archived flag, system-prompt-sent latch,
 * and the agent last-session pointer if one targets the draft. Archive is a
 * hide; discard is a delete, and a delete that leaks keys resurrects them
 * the next time a session lands on the same id.
 *
 * `forgetDeletedSession` is the same sweep for a session the node deleted
 * (DELETE /api/sessions/{id}): its row is gone server-side, so nothing local
 * may bring its name, settings or pointer back either.
 */

import { useChat } from '../stores/chat.js'
import { useChatSettings } from '../stores/chat-settings.js'
import { useSessionNames } from '../stores/session-names.js'
import { useArchived } from '../stores/archived.js'
import { useSpaces } from '../stores/spaces.js'
import { clearSessionMode } from './session-mode.js'
import { clearSessionNodeBinding } from './session-node.js'
import { clearSystemPromptSent } from './system-prompt-sent.js'
import { clearAgentSessionPointer, listAgentSessions } from './agent-session.js'
import { denRoomKey } from './harness-chat.js'

function forgetLocalTraces(baseUrl: string, sessionId: string): void {
  const key = `${baseUrl}::${sessionId}`
  useChat.getState().removeDraft(sessionId)
  useSessionNames.getState().set(key, '') // empty clears the override
  useChatSettings.getState().clear(key)
  useArchived.getState().unarchive(key)
  useSpaces.getState().unplace(key)
  clearSessionMode(key)
  clearSystemPromptSent(sessionId)
  // Reverse bind (written by setAgentLastSession) names the owning agent;
  // pointers are per-(agent, node) — compare-and-delete only the node slots
  // that really target this session, so a stale bind can never nuke a pointer
  // at a newer session.
  try {
    const agentId = localStorage.getItem(`rivethub.agent.${sessionId}`)
    if (agentId) {
      const mine = listAgentSessions(agentId).filter((p) => p.sessionId === sessionId)
      for (const p of mine) clearAgentSessionPointer(agentId, p.nodeBaseUrl, sessionId)
      if (mine.length === 0) localStorage.removeItem(`rivethub.agent.${sessionId}`)
    }
  } catch {
    /* storage disabled */
  }
}

export function discardDraft(baseUrl: string, sessionId: string): void {
  forgetLocalTraces(baseUrl, sessionId)
}

/**
 * Clear every local trace of a session the node has deleted. A canonical id's
 * state may also sit under its bare native id (names and settings predate
 * canonical keys and reads fall back to the native key — `persisted` in
 * drawer-item), so both keys are swept, plus the session's node binding.
 */
export function forgetDeletedSession(baseUrl: string, sessionId: string): void {
  for (const id of new Set([sessionId, denRoomKey(sessionId)])) {
    forgetLocalTraces(baseUrl, id)
    clearSessionNodeBinding(id)
  }
}
