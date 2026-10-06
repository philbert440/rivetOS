/**
 * The one-shot project-rule backfill: a real cwd is tagged, a Cowork task
 * sandbox is not, a second run tags nothing, and a rejected rule tag stays.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_RULE_NAME, type ProjectRuleResult } from '@rivetos/types'
import { SqliteMemory } from './adapter.js'
import { backfillSqliteProjectRules } from './portability.js'

const HIT: ProjectRuleResult = {
  key: 'project',
  value: 'acme',
  rule: 'cwd-basename',
  reason: 'basename of the working directory',
}

describe('backfillSqliteProjectRules', () => {
  const open: SqliteMemory[] = []
  afterEach(() => {
    for (const memory of open.splice(0)) memory.close()
  })

  it('tags a real cwd, skips a task sandbox, is idempotent, and keeps a rejected rule tag', async () => {
    const memory = new SqliteMemory({ path: ':memory:', workers: false, projectRule: null, log: () => {} })
    open.push(memory)
    const db = memory.database()
    const session = async (sessionId: string, cwd: string): Promise<string> => {
      await memory.append({ sessionId, agent: 'rivet', channel: 'cli', role: 'user', content: 'hi' })
      db.prepare(`UPDATE ros_conversations SET settings = ? WHERE session_key = ?`).run(
        JSON.stringify({ cwd }),
        sessionId,
      )
      const row = db.prepare(`SELECT id FROM ros_conversations WHERE session_key = ?`).get(sessionId) as {
        id: string
      }
      return row.id
    }

    const real = await session('s-real', '/work/acme')
    const sandbox = await session('s-sandbox', '/tmp/local_task1/outputs')
    const rejectedId = await session('s-rejected', '/work/acme')
    const now = '2026-10-06T00:00:00.000Z'
    db.prepare(
      `INSERT INTO ros_tags
         (id, entity_type, entity_id, key, value, display, source, state, proposed_by, reason,
          decided_by, decided_at, created_at, updated_at)
       VALUES (?, 'conversation', ?, 'project', 'old', '', 'rule', 'rejected', ?, 'no', 'alice', ?, ?, ?)`,
    ).run('tag-rejected', rejectedId, PROJECT_RULE_NAME, now, now, now)

    const resolveProject = (): ProjectRuleResult => HIT
    const first = await backfillSqliteProjectRules(db, { resolveProject })
    expect(first.scanned).toBe(3)
    expect(first.tagged).toBe(1)
    const tagged = db
      .prepare(`SELECT key, value, state, source FROM ros_tags WHERE entity_id = ? AND key = 'project'`)
      .get(real) as { key: string; value: string; state: string; source: string }
    expect(tagged).toEqual({ key: 'project', value: 'acme', state: 'accepted', source: 'rule' })
    expect(
      db.prepare(`SELECT count(*) AS n FROM ros_tags WHERE entity_id = ?`).get(sandbox) as { n: number },
    ).toEqual({ n: 0 })

    const again = await backfillSqliteProjectRules(db, { resolveProject })
    expect(again.tagged).toBe(0)

    const kept = db
      .prepare(`SELECT value, state, source FROM ros_tags WHERE id = 'tag-rejected'`)
      .get() as { value: string; state: string; source: string }
    expect(kept).toEqual({ value: 'old', state: 'rejected', source: 'rule' })
  })
})
