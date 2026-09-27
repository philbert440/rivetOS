/**
 * Query-time preference for grokbot -v3 / -v3-rows siblings.
 *
 * Hide unsuffixed and -v2 copies only when a -v3 or -v3-rows sibling for
 * the same agent is *complete*: its last source position covers the legacy
 * session's last position. Completeness is query-time only — no completion
 * marker is written, and nothing is DELETE/UPDATE'd.
 *
 * Position (same rule as storedRowPosition / new-style ingest):
 *   metadata.position when present;
 *   else metadata.ordinal / 1000 when metadata.capture_source is set;
 *   else metadata.ordinal (legacy sequential 0..N).
 *
 * -v3-store and -v3-voice contain "-v3" and stay visible (they are different
 * formats, not recleans of the same session).
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

export type GrokbotCoverage = {
  preferredLast: number | null
  legacyLast: number | null
}

/** Sibling covers legacy when its last position is at least the legacy last. */
export function grokbotSiblingCoversLegacy(
  preferredLast: number | null,
  legacyLast: number | null,
): boolean {
  if (preferredLast == null) return false
  return preferredLast >= (legacyLast ?? 0)
}

export function preferredGrokbotSession(
  requested: string,
  existingKeys: Iterable<string>,
  coverage?: GrokbotCoverage,
): string {
  if (isPreferredGrokbotSession(requested)) return requested
  const keys = new Set(existingKeys)
  const base = grokbotSessionBase(requested)
  const v3 = `${base}-v3`
  const rows = `${base}-v3-rows`
  const pick = keys.has(v3) ? v3 : keys.has(rows) ? rows : undefined
  if (!pick) return requested
  if (coverage && !grokbotSiblingCoversLegacy(coverage.preferredLast, coverage.legacyLast)) {
    return requested
  }
  if (!coverage) return pick
  return pick
}

export function shouldHideGrokbotSession(
  session: string,
  existingKeys: Iterable<string>,
  coverage?: GrokbotCoverage,
): boolean {
  if (isPreferredGrokbotSession(session)) return false
  const keys = new Set(existingKeys)
  const base = grokbotSessionBase(session)
  const hasSibling = keys.has(`${base}-v3`) || keys.has(`${base}-v3-rows`)
  if (!hasSibling) return false
  if (!coverage) return false
  return grokbotSiblingCoversLegacy(coverage.preferredLast, coverage.legacyLast)
}

/**
 * Last source position of messages in a conversation.
 * metadata.position wins; new-style capture_source rows decode ordinal/1000;
 * old sequential ordinals are used as-is. COALESCE to -1 when empty.
 */
export function grokbotMessagePositionSql(alias = 'm'): string {
  return `COALESCE(
    NULLIF(${alias}.metadata->>'position', '')::int,
    CASE
      WHEN ${alias}.metadata->'capture_source' IS NOT NULL
        THEN NULLIF(${alias}.metadata->>'ordinal', '')::int / 1000
      ELSE NULLIF(${alias}.metadata->>'ordinal', '')::int
    END
  )`
}

export function grokbotLastPositionSql(conversationAlias: string, messageAlias: string): string {
  return `COALESCE((
    SELECT MAX(${grokbotMessagePositionSql(messageAlias)})
      FROM ros_messages ${messageAlias}
     WHERE ${messageAlias}.conversation_id = ${conversationAlias}.id
  ), -1)`
}

/**
 * Last source position per conversation, computed once (GROUP BY).
 * Used inside an uncorrelated NOT IN subquery so search does not re-run
 * MAX(position) for every message.
 */
export function sqlGrokbotLastPosCte(name = 'grokbot_last_pos'): string {
  return `${name} AS (
    SELECT gm.conversation_id,
           COALESCE(MAX(${grokbotMessagePositionSql('gm')}), -1) AS last_pos
      FROM ros_messages gm
     GROUP BY gm.conversation_id
  )`
}

/** Uncorrelated: last positions are aggregated once, then joined. */
export function sqlSupersededGrokbotConversationIds(): string {
  return `
    WITH ${sqlGrokbotLastPosCte('grokbot_last_pos')}
    SELECT grokbot_legacy.id
      FROM ros_conversations grokbot_legacy
      INNER JOIN ros_conversations grokbot_pref
        ON grokbot_pref.agent = grokbot_legacy.agent
       AND grokbot_pref.channel = 'grokbot'
       AND grokbot_pref.session_key IN (
         regexp_replace(grokbot_legacy.session_key, '-v2$', '') || '-v3',
         regexp_replace(grokbot_legacy.session_key, '-v2$', '') || '-v3-rows'
       )
      INNER JOIN grokbot_last_pos pref_last
        ON pref_last.conversation_id = grokbot_pref.id
      INNER JOIN grokbot_last_pos leg_last
        ON leg_last.conversation_id = grokbot_legacy.id
     WHERE grokbot_legacy.channel = 'grokbot'
       AND grokbot_legacy.session_key NOT LIKE '%-v3%'
       AND pref_last.last_pos >= leg_last.last_pos
  `
}

/**
 * SQL: message alias is not in a superseded unsuffixed/-v2 grokbot session.
 * Uses conversation_id; safe to AND into ros_messages / ros_summaries WHERE.
 * Legacy is hidden only when the sibling last position covers it.
 */
export function sqlNotSupersededGrokbotMessage(alias = 'm'): string {
  return `${alias}.conversation_id NOT IN (${sqlSupersededGrokbotConversationIds()})`
}

/** SQL: conversation alias is not a superseded unsuffixed/-v2 grokbot session. */
export function sqlNotSupersededGrokbotConversation(alias = 'c'): string {
  return `(
    ${alias}.channel IS DISTINCT FROM 'grokbot'
    OR ${alias}.session_key LIKE '%-v3%'
    OR ${alias}.id NOT IN (${sqlSupersededGrokbotConversationIds()})
  )`
}

export const RESOLVE_PREFERRED_GROKBOT_SESSION_SQL = `
WITH ${sqlGrokbotLastPosCte('grokbot_last_pos')}
SELECT c.session_key
  FROM ros_conversations c
  INNER JOIN grokbot_last_pos pref_last ON pref_last.conversation_id = c.id
  INNER JOIN ros_conversations src
    ON src.session_key = $1 AND src.agent = c.agent
  INNER JOIN grokbot_last_pos leg_last ON leg_last.conversation_id = src.id
 WHERE c.channel = 'grokbot'
   AND c.session_key IN ($2 || '-v3', $2 || '-v3-rows')
   AND pref_last.last_pos >= leg_last.last_pos
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
