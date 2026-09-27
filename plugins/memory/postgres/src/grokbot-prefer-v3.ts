/**
 * Query-time preference for grokbot -v3 / -v3-rows siblings.
 *
 * When a conversation has a -v3 or -v3-rows sibling for the same agent,
 * search / browse / recall hide the unsuffixed and -v2 copies. Nothing is
 * DELETE/UPDATE'd. -v3-store and -v3-voice contain "-v3" and stay visible
 * (they are different formats, not recleans of the same session).
 */

export const GROKBOT_PREFERRED_SESSION_SUFFIXES = ['-v3', '-v3-rows'] as const

export function grokbotSessionBase(session: string): string {
  const voiceAt = session.indexOf('-v3-voice')
  if (voiceAt >= 0) return session.slice(0, voiceAt)
  if (session.endsWith('-v3-store')) return session.slice(0, -'-v3-store'.length)
  if (session.endsWith('-v3-rows')) return session.slice(0, -'-v3-rows'.length)
  if (session.endsWith('-v3')) return session.slice(0, -3)
  if (session.endsWith('-v2')) return session.slice(0, -3)
  return session
}

export function isPreferredGrokbotSession(session: string): boolean {
  return session.includes('-v3')
}

export function preferredGrokbotSession(requested: string, existingKeys: Iterable<string>): string {
  if (isPreferredGrokbotSession(requested)) return requested
  const keys = new Set(existingKeys)
  const base = grokbotSessionBase(requested)
  if (keys.has(`${base}-v3`)) return `${base}-v3`
  if (keys.has(`${base}-v3-rows`)) return `${base}-v3-rows`
  return requested
}

export function shouldHideGrokbotSession(session: string, existingKeys: Iterable<string>): boolean {
  if (isPreferredGrokbotSession(session)) return false
  const keys = new Set(existingKeys)
  const base = grokbotSessionBase(session)
  return keys.has(`${base}-v3`) || keys.has(`${base}-v3-rows`)
}

/**
 * SQL: message alias is not in a superseded unsuffixed/-v2 grokbot session.
 * Uses conversation_id; safe to AND into ros_messages / ros_summaries WHERE.
 */
export function sqlNotSupersededGrokbotMessage(alias = 'm'): string {
  return `NOT EXISTS (
    SELECT 1 FROM ros_conversations grokbot_legacy
    WHERE grokbot_legacy.id = ${alias}.conversation_id
      AND grokbot_legacy.channel = 'grokbot'
      AND grokbot_legacy.session_key NOT LIKE '%-v3%'
      AND EXISTS (
        SELECT 1 FROM ros_conversations grokbot_pref
        WHERE grokbot_pref.agent = grokbot_legacy.agent
          AND grokbot_pref.channel = 'grokbot'
          AND grokbot_pref.session_key IN (
            regexp_replace(grokbot_legacy.session_key, '-v2$', '') || '-v3',
            regexp_replace(grokbot_legacy.session_key, '-v2$', '') || '-v3-rows'
          )
      )
  )`
}

/** SQL: conversation alias is not a superseded unsuffixed/-v2 grokbot session. */
export function sqlNotSupersededGrokbotConversation(alias = 'c'): string {
  return `(
    ${alias}.channel IS DISTINCT FROM 'grokbot'
    OR ${alias}.session_key LIKE '%-v3%'
    OR NOT EXISTS (
      SELECT 1 FROM ros_conversations grokbot_pref
      WHERE grokbot_pref.agent = ${alias}.agent
        AND grokbot_pref.channel = 'grokbot'
        AND grokbot_pref.session_key IN (
          regexp_replace(${alias}.session_key, '-v2$', '') || '-v3',
          regexp_replace(${alias}.session_key, '-v2$', '') || '-v3-rows'
        )
    )
  )`
}

export const RESOLVE_PREFERRED_GROKBOT_SESSION_SQL = `
SELECT c.session_key
  FROM ros_conversations c
 WHERE c.channel = 'grokbot'
   AND c.session_key IN ($2 || '-v3', $2 || '-v3-rows')
   AND EXISTS (
     SELECT 1 FROM ros_conversations src
      WHERE src.session_key = $1 AND src.agent = c.agent
   )
 ORDER BY CASE WHEN c.session_key LIKE '%-v3-rows' THEN 1 ELSE 0 END
 LIMIT 1
`

export async function resolvePreferredGrokbotSession(
  pool: {
    query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ session_key: string }> }>
  },
  sessionId: string,
): Promise<string> {
  if (isPreferredGrokbotSession(sessionId)) return sessionId
  const base = grokbotSessionBase(sessionId)
  const result = await pool.query(RESOLVE_PREFERRED_GROKBOT_SESSION_SQL, [sessionId, base])
  return result.rows[0]?.session_key ?? sessionId
}
