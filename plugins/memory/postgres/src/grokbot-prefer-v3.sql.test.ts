import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import {
  sqlNotSupersededGrokbotConversation,
  sqlNotSupersededGrokbotMessage,
} from './grokbot-prefer-v3.js'

async function mem() {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE ros_conversations (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      agent TEXT NOT NULL,
      channel TEXT NOT NULL
    );
    CREATE TABLE ros_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata JSONB DEFAULT '{}'::jsonb
    );
  `)
  return db
}

describe('grokbot prefer-v3 SQL (executed)', () => {
  it('hides legacy messages only when the -v3 sibling last position covers them', async () => {
    const db = await mem()
    await db.exec(`
      INSERT INTO ros_conversations (id, session_key, agent, channel) VALUES
        ('legacy', 'grokbot-bob', 'rivet-bob', 'grokbot'),
        ('v3', 'grokbot-bob-v3', 'rivet-bob', 'grokbot');
      INSERT INTO ros_messages (id, conversation_id, content, metadata) VALUES
        ('l0', 'legacy', 'l0', '{"ordinal":0}'::jsonb),
        ('l1', 'legacy', 'l1', '{"ordinal":15455}'::jsonb),
        ('v0', 'v3', 'v0', '{"position":100,"ordinal":100000,"capture_source":"grokbot-transcript"}'::jsonb);
    `)

    const incomplete = await db.query<{ id: string }>(
      `SELECT m.id FROM ros_messages m WHERE ${sqlNotSupersededGrokbotMessage('m')} ORDER BY m.id`,
    )
    expect(incomplete.rows.map((r) => r.id)).toEqual(['l0', 'l1', 'v0'])

    await db.exec(`
      INSERT INTO ros_messages (id, conversation_id, content, metadata)
      VALUES ('v1', 'v3', 'v1', '{"position":15455,"ordinal":15455000,"capture_source":"grokbot-transcript"}'::jsonb);
    `)

    const complete = await db.query<{ id: string }>(
      `SELECT m.id FROM ros_messages m WHERE ${sqlNotSupersededGrokbotMessage('m')} ORDER BY m.id`,
    )
    expect(complete.rows.map((r) => r.id)).toEqual(['v0', 'v1'])

    const convs = await db.query<{ session_key: string }>(
      `SELECT c.session_key FROM ros_conversations c
        WHERE ${sqlNotSupersededGrokbotConversation('c')}
        ORDER BY c.session_key`,
    )
    expect(convs.rows.map((r) => r.session_key)).toEqual(['grokbot-bob-v3'])
    await db.close()
  })
})
