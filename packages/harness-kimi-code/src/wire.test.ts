/**
 * wire tests — session-directory resolution (index first, bucket hash second)
 * and the post-hoc usage reconcile, against transcripts written to a temp
 * KIMI_CODE_HOME.
 *
 * The bucket-hash expectation is not invented: `sha256(root)[:12]` was checked
 * against all nine `wd_*` buckets on the rivet-kimi node and matched every one.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  findBucketDir,
  kimiHome,
  listSessionIds,
  readSessionIndex,
  reconcileTurn,
  resolveSessionDir,
  sessionsRoot,
  wireFilesFor,
  workDirHash,
} from './wire.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-wire-'))
  tmpDirs.push(dir)
  return dir
}

interface WriteOpts {
  home: string
  cwd: string
  sessionId: string
  /** Slot → lines. 'main' unless a subagent slot is named. */
  slots: Record<string, unknown[]>
  /** Write the session_index.jsonl entry too. Default true. */
  index?: boolean
}

function writeSession(opts: WriteOpts): string {
  const bucket = path.join(sessionsRoot(opts.home), `wd_work_${workDirHash(opts.cwd)}`)
  const sessionDir = path.join(bucket, opts.sessionId)
  for (const [slot, lines] of Object.entries(opts.slots)) {
    const dir = path.join(sessionDir, 'agents', slot)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'wire.jsonl'),
      lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
    )
  }
  if (opts.index !== false) {
    fs.appendFileSync(
      path.join(opts.home, 'session_index.jsonl'),
      JSON.stringify({ sessionId: opts.sessionId, sessionDir, workDir: opts.cwd }) + '\n',
    )
  }
  return sessionDir
}

const usage = (time: number, over: Partial<Record<string, number>> = {}): unknown => ({
  type: 'usage.record',
  model: 'moonshotai/kimi-k3',
  usage: {
    inputOther: over.inputOther ?? 100,
    output: over.output ?? 10,
    inputCacheRead: over.inputCacheRead ?? 5,
    inputCacheCreation: over.inputCacheCreation ?? 0,
  },
  usageScope: 'turn',
  time,
})

describe('home + bucket resolution', () => {
  it('honours KIMI_CODE_HOME, else ~/.kimi-code', () => {
    expect(kimiHome({ KIMI_CODE_HOME: '/somewhere/else' })).toBe('/somewhere/else')
    expect(kimiHome({})).toBe(path.join(os.homedir(), '.kimi-code'))
  })

  it('derives the 12-hex bucket suffix kimi uses', () => {
    // The formula, spelled out: nothing here is a magic constant.
    expect(workDirHash('/tmp')).toBe(
      crypto.createHash('sha256').update('/tmp', 'utf8').digest('hex').slice(0, 12),
    )
    expect(workDirHash('/tmp')).toHaveLength(12)
  })

  it('finds a bucket by hash suffix, whatever the slug is', () => {
    const home = tmpHome()
    const cwd = '/some/work/dir'
    const bucket = path.join(sessionsRoot(home), `wd_totally-different-slug_${workDirHash(cwd)}`)
    fs.mkdirSync(bucket, { recursive: true })
    expect(findBucketDir(sessionsRoot(home), cwd)).toBe(bucket)
    expect(findBucketDir(sessionsRoot(home), '/another/dir')).toBeUndefined()
  })
})

describe('resolveSessionDir', () => {
  it('prefers the session index', () => {
    const home = tmpHome()
    const cwd = '/work/a'
    const dir = writeSession({ home, cwd, sessionId: 'session_a', slots: { main: [] } })
    expect(resolveSessionDir({ home, cwd, sessionId: 'session_a' })).toBe(dir)
  })

  it('falls back to the computed bucket when the index is missing', () => {
    const home = tmpHome()
    const cwd = '/work/b'
    const dir = writeSession({ home, cwd, sessionId: 'session_b', slots: { main: [] }, index: false })
    expect(readSessionIndex(home)).toEqual([])
    expect(resolveSessionDir({ home, cwd, sessionId: 'session_b' })).toBe(dir)
  })

  it('returns undefined for a session that is not on disk', () => {
    const home = tmpHome()
    expect(resolveSessionDir({ home, cwd: '/work/c', sessionId: 'session_nope' })).toBeUndefined()
  })
})

describe('listSessionIds', () => {
  it('unions the index and the bucket, scoped to the working directory', () => {
    const home = tmpHome()
    writeSession({ home, cwd: '/work/d', sessionId: 'session_d1', slots: { main: [] } })
    writeSession({ home, cwd: '/work/d', sessionId: 'session_d2', slots: { main: [] }, index: false })
    writeSession({ home, cwd: '/work/other', sessionId: 'session_o', slots: { main: [] } })

    expect([...listSessionIds(home, '/work/d')].sort()).toEqual(['session_d1', 'session_d2'])
  })
})

describe('reconcileTurn', () => {
  it('sums turn-scoped usage at or after the floor, across every agent slot', () => {
    const home = tmpHome()
    const cwd = '/work/e'
    const dir = writeSession({
      home,
      cwd,
      sessionId: 'session_e',
      slots: {
        main: [
          { type: 'metadata', protocol_version: '1.5', created_at: 1000 },
          usage(1000), // before the floor — a previous turn on a resumed session
          usage(2000, { inputOther: 200, output: 20, inputCacheRead: 0 }),
          {
            type: 'usage.record',
            usage: { inputOther: 9999, output: 9999 },
            usageScope: 'session',
            time: 2000,
          },
          { type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 1234, time: 2100 },
        ],
        'agent-0': [usage(2050, { inputOther: 50, output: 5, inputCacheRead: 0 })],
      },
    })

    const facts = reconcileTurn({ sessionDir: dir, sinceMs: 1500 })
    expect(facts.usage).toEqual({ inputTokens: 250, outputTokens: 25, totalTokens: 275 })
    expect(facts.usageRecords).toBe(2)
    expect(facts.turnEnded).toMatchObject({ reason: 'completed', turnId: 1, durationMs: 1234 })
    expect(facts.files).toBe(2)
  })

  it('tolerates a torn final line the way kimi’s own reader does', () => {
    const home = tmpHome()
    const cwd = '/work/f'
    const dir = writeSession({
      home,
      cwd,
      sessionId: 'session_f',
      slots: { main: [usage(3000), '{"type":"turn.ended","reason":"cancel'] },
    })
    const facts = reconcileTurn({ sessionDir: dir, sinceMs: 0 })
    expect(facts.malformed).toBe(1)
    expect(facts.usage.totalTokens).toBe(115)
    expect(facts.turnEnded).toBeUndefined()
  })

  it('reports zero rather than throwing when there is no transcript', () => {
    const facts = reconcileTurn({ sessionDir: '/nonexistent/session', sinceMs: 0 })
    expect(facts.usage.totalTokens).toBe(0)
    expect(facts.files).toBe(0)
    expect(wireFilesFor('/nonexistent/session')).toEqual([])
  })

  it('takes the main slot’s turn.ended, not a subagent’s', () => {
    const home = tmpHome()
    const cwd = '/work/g'
    const dir = writeSession({
      home,
      cwd,
      sessionId: 'session_g',
      slots: {
        main: [{ type: 'turn.ended', reason: 'cancelled', time: 5000 }],
        'agent-0': [{ type: 'turn.ended', reason: 'completed', time: 6000 }],
      },
    })
    expect(reconcileTurn({ sessionDir: dir, sinceMs: 0 }).turnEnded?.reason).toBe('cancelled')
  })
})
