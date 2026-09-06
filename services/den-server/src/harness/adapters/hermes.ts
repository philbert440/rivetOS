import type { HarnessTranscriptTurn } from '@rivetos/types'
import { openHermesDb } from '../../term/hermes-db.js'
import { extractTurnText, type HarnessTurn } from './parse-helpers.js'
import type { HarnessAdapter } from './types.js'

export function readHermesTurns(id: string): HarnessTurn[] {
  const db = openHermesDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT role, content FROM messages
         WHERE session_id = ? AND role IN ('user', 'assistant')
         ORDER BY timestamp ASC`,
      )
      .all(id)
    const out: HarnessTurn[] = []
    for (const r of rows) {
      const role = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'user' : null
      if (!role) continue
      const text = extractTurnText(r.content, role)
      if (text) out.push({ role, text })
    }
    return out
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

export const hermesAdapter: HarnessAdapter = {
  id: 'hermes',
  store: {
    readTurns(_ref, _maxBytes, sessionId): Promise<HarnessTranscriptTurn[]> {
      return Promise.resolve(sessionId ? readHermesTurns(sessionId) : [])
    },
  },
  promptToolNames: [],
  capabilities: () => ({ liveTurn: false, prompts: false, approvals: true }),
}
