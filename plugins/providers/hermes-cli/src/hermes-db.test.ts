import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  emptyUsage,
  hermesDbPath,
  readHermesSessionTokens,
  tokensForTurn,
  tokensFromRow,
  UNKNOWN_TOKENS,
  usageDelta,
  usageFromTokens,
} from './hermes-db.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-db-'))
}

describe('tokensFromRow', () => {
  it('maps input_tokens / output_tokens', () => {
    expect(tokensFromRow({ input_tokens: 12, output_tokens: 4 })).toEqual({ input: 12, output: 4 })
  })

  it('falls back to prompt_tokens / completion_tokens', () => {
    expect(tokensFromRow({ prompt_tokens: 8, completion_tokens: 2 })).toEqual({
      input: 8,
      output: 2,
    })
  })

  it('treats token_count as output when input/output columns are absent', () => {
    expect(tokensFromRow({ token_count: 7 })).toEqual({ output: 7 })
  })

  it('reads cache_read_tokens / cache_write_tokens / reasoning_tokens when present', () => {
    expect(
      tokensFromRow({
        input_tokens: 40,
        output_tokens: 10,
        cache_read_tokens: 8,
        cache_write_tokens: 2,
        reasoning_tokens: 3,
      }),
    ).toEqual({ input: 40, output: 10, cacheRead: 8, cacheWrite: 2, reasoning: 3 })
  })

  it('tolerates missing cache/reasoning columns', () => {
    expect(tokensFromRow({ input_tokens: 1, output_tokens: 2 })).toEqual({ input: 1, output: 2 })
  })

  it('ignores negative and non-numeric values', () => {
    expect(tokensFromRow({ input_tokens: -1, output_tokens: 'nope' })).toEqual({})
    expect(tokensFromRow(undefined)).toEqual({})
  })
})

describe('usageFromTokens / usageDelta', () => {
  it('empty counts → empty usage (every field undefined)', () => {
    expect(usageFromTokens({})).toEqual(emptyUsage())
    expect(usageFromTokens({}).inputTokens.total).toBeUndefined()
    expect(usageFromTokens({}).outputTokens.total).toBeUndefined()
  })

  it('fills totals and cache/reasoning; leaves noCache unknown', () => {
    const u = usageFromTokens({ input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 4 })
    expect(u.inputTokens.total).toBe(100)
    expect(u.inputTokens.noCache).toBeUndefined()
    expect(u.inputTokens.cacheRead).toBe(30)
    expect(u.inputTokens.cacheWrite).toBe(5)
    expect(u.outputTokens.total).toBe(20)
    expect(u.outputTokens.reasoning).toBe(4)
  })

  it('does not claim noCache === input when cache columns are absent', () => {
    const u = usageFromTokens({ input: 100, output: 20 })
    expect(u.inputTokens.noCache).toBeUndefined()
    expect(u.outputTokens.reasoning).toBeUndefined()
  })

  it('delta subtracts prior session totals (resume)', () => {
    expect(usageDelta({ input: 100, output: 10 }, { input: 150, output: 40 })).toEqual({
      input: 50,
      output: 30,
    })
  })

  it('delta clamps a regression to zero rather than going negative', () => {
    expect(usageDelta({ input: 90, output: 20 }, { input: 40, output: 5 })).toEqual({
      input: 0,
      output: 0,
    })
  })

  it('delta omits a field whose baseline was not read (not treated as zero)', () => {
    expect(usageDelta({ output: 10 }, { input: 150, output: 40 })).toEqual({ output: 30 })
    expect(usageDelta({}, { input: 100100, output: 10010 })).toEqual({})
  })
})

describe('tokensForTurn', () => {
  it('new session reports session totals as-is', () => {
    expect(
      tokensForTurn(false, UNKNOWN_TOKENS, {
        kind: 'session-total',
        counts: { input: 42, output: 7 },
      }),
    ).toEqual({ input: 42, output: 7 })
  })

  it('resume session-total subtracts a known baseline', () => {
    expect(
      tokensForTurn(
        true,
        { kind: 'session-total', counts: { input: 100000, output: 10000 } },
        { kind: 'session-total', counts: { input: 100100, output: 10010 } },
      ),
    ).toEqual({ input: 100, output: 10 })
  })

  it('resume with unknown baseline reports empty rather than lifetime totals', () => {
    expect(
      tokensForTurn(true, UNKNOWN_TOKENS, {
        kind: 'session-total',
        counts: { input: 100100, output: 10010 },
      }),
    ).toEqual({})
  })

  it('message fallback is reported as-is, including decreasing counts on resume', () => {
    expect(
      tokensForTurn(
        true,
        { kind: 'message', counts: { input: 100, output: 20 } },
        { kind: 'message', counts: { input: 60, output: 10 } },
      ),
    ).toEqual({ input: 60, output: 10 })
  })

  it('unknown after → empty', () => {
    expect(
      tokensForTurn(true, { kind: 'session-total', counts: { input: 1, output: 1 } }, UNKNOWN_TOKENS),
    ).toEqual({})
  })
})

describe('readHermesSessionTokens', () => {
  it('returns unknown when the db file is missing', () => {
    const dbFile = path.join(tmp(), 'state.db')
    expect(readHermesSessionTokens('sess-missing', dbFile)).toEqual(UNKNOWN_TOKENS)
  })

  it('hermesDbPath respects HERMES_HOME', () => {
    const prev = process.env.HERMES_HOME
    const base = tmp()
    process.env.HERMES_HOME = base
    try {
      expect(hermesDbPath()).toBe(path.join(base, 'state.db'))
    } finally {
      if (prev === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = prev
    }
  })

  it('reads session totals from state.db', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbFile = path.join(tmp(), 'state.db')
    const db = new DatabaseSync(dbFile)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
        input_tokens INTEGER, output_tokens INTEGER
      );
      CREATE TABLE messages (
        session_id TEXT, role TEXT, content TEXT, timestamp INTEGER, token_count INTEGER
      );
      INSERT INTO sessions VALUES ('sess-9', 1000, 2000, 111, 22);
      INSERT INTO messages VALUES ('sess-9','assistant','hi',1001,NULL);
    `)
    db.close()
    expect(readHermesSessionTokens('sess-9', dbFile)).toEqual({
      kind: 'session-total',
      counts: { input: 111, output: 22 },
    })
    expect(readHermesSessionTokens('nope', dbFile)).toEqual(UNKNOWN_TOKENS)
  })

  it('reads cache and reasoning columns from a 0.20.0-shaped sessions row', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbFile = path.join(tmp(), 'state.db')
    const db = new DatabaseSync(dbFile)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
        input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER
      );
      INSERT INTO sessions VALUES ('sess-c', 1, 2, 40, 10, 8, 2, 3);
    `)
    db.close()
    expect(readHermesSessionTokens('sess-c', dbFile)).toEqual({
      kind: 'session-total',
      counts: { input: 40, output: 10, cacheRead: 8, cacheWrite: 2, reasoning: 3 },
    })
  })

  it('falls back to the latest assistant message when session totals are absent', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbFile = path.join(tmp(), 'state.db')
    const db = new DatabaseSync(dbFile)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER);
      CREATE TABLE messages (
        session_id TEXT, role TEXT, content TEXT, timestamp INTEGER,
        input_tokens INTEGER, output_tokens INTEGER
      );
      INSERT INTO sessions VALUES ('sess-m', 1000, 2000);
      INSERT INTO messages VALUES ('sess-m','user','hi',1000,NULL,NULL);
      INSERT INTO messages VALUES ('sess-m','assistant','a',1001,10,2);
      INSERT INTO messages VALUES ('sess-m','assistant','b',1002,30,8);
    `)
    db.close()
    expect(readHermesSessionTokens('sess-m', dbFile)).toEqual({
      kind: 'message',
      counts: { input: 30, output: 8 },
    })
  })
})
