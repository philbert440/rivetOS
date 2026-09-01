/**
 * Unit tests for compact-conversation task — transaction handling and summary insertion.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock config to avoid process.exit on missing env vars
vi.mock('../config.js', () => ({
  config: {
    llmUrl: 'http://localhost:8000',
    llmModel: 'test-model',
    llmApiKey: 'test-key',
    pgUrl: 'postgresql://localhost/test',
    compactConcurrency: 1,
    leafBatchSize: 10,
    branchBatchSize: 8,
    rootBatchSize: 5,
    idleMinutes: 15,
    minLeavesForBranch: 5,
    minBranchesForRoot: 3,
    staleMinutes: 4 * 24 * 60,
    staleMinBatch: 2,
    toolSynthEndpoint: 'http://localhost:8000',
    toolSynthModel: 'test-model',
  },
}))

vi.mock('../llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm.js')>()
  return { ...actual, callLlm: vi.fn() }
})

import {
  withTransaction,
  insertSummary,
  leafFloorFor,
  isHeartbeatConversation,
  isPgDeadlockError,
  enqueueExtractWiki,
  enqueueEmbedTarget,
  deadlockBackoffMs,
  propagateLlmFailure,
  formatThrown,
  isJobFinalAttempt,
  compactConversationTask,
  DEADLOCK_RETRIES,
  PG_DEADLOCK_CODE,
  isLlmTruncationError,
  shrinkLeafBatch,
} from './compact-conversation.js'
import { MIN_BATCH_SIZE, BRANCH_SYSTEM_PROMPT } from '@rivetos/memory-postgres'
import { shouldSkip, breakerThreshold, resetBreaker, recordSuccess } from '../circuit-breaker.js'
import { LlmCallError, callLlm } from '../llm.js'

function deadlockError(message = 'deadlock detected'): Error {
  return Object.assign(new Error(message), { code: PG_DEADLOCK_CODE })
}

const LOCK_OPTS = { lockConversationId: 'conv-lock-1' }

/** Shared TX control: BEGIN/COMMIT/ROLLBACK, conversation FOR UPDATE, SET LOCAL. */
function txControlResult(
  sql: string,
  params?: unknown[],
): { rows: unknown[]; rowCount: number | null } | null {
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
    return { rows: [], rowCount: null }
  }
  if (sql.includes('SET LOCAL')) {
    return { rows: [], rowCount: null }
  }
  if (sql.includes('FROM ros_conversations') && sql.includes('FOR UPDATE')) {
    return { rows: [{ id: params?.[0] ?? LOCK_OPTS.lockConversationId }], rowCount: 1 }
  }
  return null
}

describe('compact-conversation', () => {
  afterEach(() => {
    resetBreaker()
    vi.mocked(callLlm).mockReset()
  })

  describe('leafFloorFor', () => {
    it('drops to staleMinBatch for a session_stale flush', () => {
      expect(leafFloorFor('session_stale', 2)).toBe(2)
    })

    it('holds the normal MIN_BATCH_SIZE for every other trigger', () => {
      expect(leafFloorFor('session_idle', 2)).toBe(MIN_BATCH_SIZE)
      expect(leafFloorFor('threshold', 2)).toBe(MIN_BATCH_SIZE)
      expect(leafFloorFor('explicit', 2)).toBe(MIN_BATCH_SIZE)
      expect(leafFloorFor(undefined, 2)).toBe(MIN_BATCH_SIZE)
    })

    it('honors a custom staleMinBatch', () => {
      expect(leafFloorFor('session_stale', 1)).toBe(1)
      expect(leafFloorFor('session_stale', 3)).toBe(3)
    })
  })

  describe('shrinkLeafBatch', () => {
    it('halves a default leaf batch down to the floor', () => {
      expect(shrinkLeafBatch(10, MIN_BATCH_SIZE)).toBe(5)
    })

    it('returns null at the floor so the caller can fail the job', () => {
      expect(shrinkLeafBatch(MIN_BATCH_SIZE, MIN_BATCH_SIZE)).toBeNull()
      expect(shrinkLeafBatch(3, MIN_BATCH_SIZE)).toBeNull()
    })

    it('does not shrink below minBatch', () => {
      expect(shrinkLeafBatch(7, MIN_BATCH_SIZE)).toBe(MIN_BATCH_SIZE)
    })
  })

  describe('isLlmTruncationError', () => {
    it('matches callLlm truncation messages', () => {
      expect(
        isLlmTruncationError(new LlmCallError('LLM response truncated at max_tokens=7000', 1)),
      ).toBe(true)
      expect(isLlmTruncationError(new Error('LLM unreachable'))).toBe(false)
      expect(isLlmTruncationError('truncated at max_tokens=14000')).toBe(true)
    })
  })

  describe('isHeartbeatConversation', () => {
    it('skips scheduled heartbeat sessions', () => {
      expect(isHeartbeatConversation({ session_key: 'heartbeat:rivet-claude' })).toBe(true)
    })

    it('compacts ordinary and null session keys', () => {
      expect(isHeartbeatConversation({ session_key: 'grok-build' })).toBe(false)
      expect(isHeartbeatConversation({ session_key: null })).toBe(false)
      expect(isHeartbeatConversation({})).toBe(false)
    })
  })

  describe('withTransaction', () => {
    function mockTxClient(
      extra?: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount: number | null } | null,
    ) {
      return {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          const tx = txControlResult(sql, params)
          if (tx) return tx
          if (extra) {
            const r = extra(sql, params)
            if (r) return r
          }
          return { rows: [], rowCount: null }
        }),
      }
    }

    it('locks the conversation FOR UPDATE (never SKIP LOCKED) as the first statement after BEGIN', async () => {
      const mockClient = mockTxClient()
      await withTransaction(mockClient, async () => 'result', LOCK_OPTS)

      const calls = mockClient.query.mock.calls.map((c) => c[0] as string)
      expect(calls[0]).toBe('BEGIN')
      expect(calls[1]).toContain('FROM ros_conversations')
      expect(calls[1]).toContain('FOR UPDATE')
      expect(calls[1]).not.toContain('SKIP LOCKED')
      expect(calls[1]).toContain('$1')
      expect(mockClient.query.mock.calls[1][1]).toEqual([LOCK_OPTS.lockConversationId])
      expect(calls[2]).toMatch(/SET LOCAL rivet\.defer_embed_enqueue/)
      expect(calls[calls.length - 1]).toBe('COMMIT')
    })

    it('throws when the conversation row is missing', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: null }
          if (sql.includes('FROM ros_conversations')) return { rows: [], rowCount: 0 }
          return { rows: [], rowCount: null }
        }),
      }
      await expect(
        withTransaction(mockClient, async () => 'nope', LOCK_OPTS),
      ).rejects.toThrow(/Conversation not found/)
    })

    it('requires lockConversationId', async () => {
      const mockClient = mockTxClient()
      await expect(
        withTransaction(mockClient, async () => 'nope', { lockConversationId: '' }),
      ).rejects.toThrow(/lockConversationId/)
    })

    it('should execute the callback between BEGIN and COMMIT', async () => {
      const callOrder: string[] = []
      const mockClient = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql === 'BEGIN') {
            callOrder.push('BEGIN')
            return { rows: [], rowCount: null }
          }
          if (sql === 'COMMIT') {
            callOrder.push('COMMIT')
            return { rows: [], rowCount: null }
          }
          const tx = txControlResult(sql, params)
          if (tx) return tx
          return { rows: [], rowCount: null }
        }),
      }

      await withTransaction(
        mockClient,
        async () => {
          callOrder.push('callback')
          return 'done'
        },
        LOCK_OPTS,
      )

      expect(callOrder).toEqual(['BEGIN', 'callback', 'COMMIT'])
    })

    it('should return the callback result', async () => {
      const mockClient = mockTxClient()
      const result = await withTransaction(mockClient, async () => ({ value: 42 }), LOCK_OPTS)
      expect(result).toEqual({ value: 42 })
    })

    it('should ROLLBACK on callback error', async () => {
      const mockClient = mockTxClient()
      await expect(
        withTransaction(
          mockClient,
          async () => {
            throw new Error('Callback failed')
          },
          LOCK_OPTS,
        ),
      ).rejects.toThrow('Callback failed')

      const cmds = mockClient.query.mock.calls.map((c) => c[0] as string)
      expect(cmds).toContain('ROLLBACK')
      expect(cmds).not.toContain('COMMIT')
    })

    it('should handle ROLLBACK failure gracefully', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql === 'ROLLBACK') throw new Error('ROLLBACK failed')
          const tx = txControlResult(sql, params)
          if (tx) return tx
          return { rows: [], rowCount: null }
        }),
      }
      await expect(
        withTransaction(
          mockClient,
          async () => {
            throw new Error('Callback error')
          },
          LOCK_OPTS,
        ),
      ).rejects.toThrow('Callback error')
      expect(mockClient.query.mock.calls.map((c) => c[0] as string)).toContain('ROLLBACK')
    })

    it('retries 40P01 then commits on the next attempt', async () => {
      let runs = 0
      const mockClient = mockTxClient()
      const result = await withTransaction(
        mockClient,
        async () => {
          runs += 1
          if (runs === 1) throw deadlockError()
          return 'recovered'
        },
        LOCK_OPTS,
      )
      expect(result).toBe('recovered')
      expect(runs).toBe(2)
      const cmds = mockClient.query.mock.calls.map((c) => c[0] as string)
      expect(cmds.filter((s) => s === 'BEGIN')).toHaveLength(2)
      expect(cmds.filter((s) => s === 'ROLLBACK')).toHaveLength(1)
      expect(cmds.filter((s) => s === 'COMMIT')).toHaveLength(1)
      const firstRollback = cmds.indexOf('ROLLBACK')
      const secondBegin = cmds.indexOf('BEGIN', firstRollback)
      expect(secondBegin).toBeGreaterThan(firstRollback)
    })

    it('does not retry a non-deadlock error (23505 / generic)', async () => {
      let runs = 0
      const mockClient = mockTxClient()
      await expect(
        withTransaction(
          mockClient,
          async () => {
            runs += 1
            throw Object.assign(new Error('unique_violation'), { code: '23505' })
          },
          LOCK_OPTS,
        ),
      ).rejects.toThrow('unique_violation')
      expect(runs).toBe(1)
      expect(mockClient.query.mock.calls.filter((c) => c[0] === 'BEGIN')).toHaveLength(1)
    })

    it('gives up after DEADLOCK_RETRIES+1 attempts and does not start a further BEGIN', async () => {
      let runs = 0
      const mockClient = mockTxClient()
      await expect(
        withTransaction(
          mockClient,
          async () => {
            runs += 1
            throw deadlockError()
          },
          LOCK_OPTS,
        ),
      ).rejects.toThrow(/deadlock detected/)
      expect(runs).toBe(DEADLOCK_RETRIES + 1)
      expect(mockClient.query.mock.calls.filter((c) => c[0] === 'BEGIN')).toHaveLength(
        DEADLOCK_RETRIES + 1,
      )
    })

    it('jitter is in [base, 2*base)', () => {
      const spy = vi.spyOn(Math, 'random')
      spy.mockReturnValue(0)
      expect(deadlockBackoffMs(0)).toBe(25)
      spy.mockReturnValue(0.999)
      expect(deadlockBackoffMs(0)).toBe(25 + Math.floor(0.999 * 25))
      spy.mockRestore()
    })
  })

  describe('isPgDeadlockError', () => {
    it('matches node-pg 40P01', () => {
      expect(isPgDeadlockError(deadlockError())).toBe(true)
    })

    it('matches a deadlock message without a code', () => {
      expect(isPgDeadlockError(new Error('deadlock detected'))).toBe(true)
    })

    it('rejects unrelated errors', () => {
      expect(isPgDeadlockError(new Error('unique_violation'))).toBe(false)
      expect(isPgDeadlockError({ code: '23505' })).toBe(false)
    })
  })

  describe('enqueueExtractWiki', () => {
    it('adds extract-wiki after the caller has committed', async () => {
      const mockClient = {
        query: vi.fn(async () => ({ rows: [], rowCount: null })),
      }

      await enqueueExtractWiki(mockClient, 'sum-1', 'conv-1')

      expect(mockClient.query).toHaveBeenCalledOnce()
      const [sql, params] = (mockClient.query as any).mock.calls[0] as [string, unknown[]]
      expect(sql).toMatch(/graphile_worker\.add_job\('extract-wiki'/)
      expect(params[0]).toBe(JSON.stringify({ summaryId: 'sum-1', conversationId: 'conv-1' }))
      expect(params[1]).toBe('wiki-ext-sum-1')
    })

    it('swallows add_job failures so a committed leaf is not rolled back', async () => {
      const mockClient = {
        query: vi.fn(async () => {
          throw deadlockError()
        }),
      }
      await expect(enqueueExtractWiki(mockClient, 'sum-1', 'conv-1')).resolves.toBeUndefined()
    })
  })

  describe('enqueueEmbedTarget', () => {
    it('adds embed-target with the same job_key the trigger would have used', async () => {
      const mockClient = {
        query: vi.fn(async () => ({ rows: [], rowCount: null })),
      }
      await enqueueEmbedTarget(mockClient, 'ros_summaries', 'sum-1')
      const [sql, params] = mockClient.query.mock.calls[0] as [string, unknown[]]
      expect(sql).toMatch(/graphile_worker\.add_job\('embed-target'/)
      expect(params[0]).toBe(JSON.stringify({ targetTable: 'ros_summaries', targetId: 'sum-1' }))
      expect(params[1]).toBe('embed-ros_summaries-sum-1')
    })
  })

  describe('insertSummary', () => {
    it('should build correct INSERT statement and params', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO ros_summaries')) {
            expect(params).toHaveLength(9)
            expect(params?.[0]).toBe('conv-123')
            expect(params?.[1]).toBe(0) // depth
            expect(params?.[3]).toBe('leaf') // kind
            expect(params?.[2]).toBe('Summary content')
            return { rows: [{ id: 'summary-uuid' }], rowCount: 1 }
          }
          return { rows: [], rowCount: null }
        }),
      }

      const id = await insertSummary(mockClient, {
        conversationId: 'conv-123',
        depth: 0,
        kind: 'leaf',
        content: 'Summary content',
        messageCount: 5,
        earliestAt: new Date('2026-01-01'),
        latestAt: new Date('2026-01-02'),
      })

      expect(id).toBe('summary-uuid')
      expect(mockClient.query).toHaveBeenCalledOnce()
    })

    it('should return the inserted summary id', async () => {
      const mockClient = {
        query: vi.fn(async () => ({
          rows: [{ id: 'test-id-999' }],
          rowCount: 1,
        })),
      }

      const result = await insertSummary(mockClient, {
        conversationId: 'conv-xyz',
        depth: 1,
        kind: 'branch',
        content: 'Branch summary',
        messageCount: 10,
        earliestAt: new Date(),
        latestAt: new Date(),
      })

      expect(result).toBe('test-id-999')
    })

    it('should use config.llmModel in pipeline_version field', async () => {
      const capturedParams: unknown[] = []
      const mockClient = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO ros_summaries')) {
            capturedParams.push(...(params || []))
          }
          return { rows: [{ id: 'id-1' }], rowCount: 1 }
        }),
      }

      await insertSummary(mockClient, {
        conversationId: 'conv-1',
        depth: 2,
        kind: 'root',
        content: 'Root',
        messageCount: 20,
        earliestAt: new Date(),
        latestAt: new Date(),
      })

      // Model should be in params[7]
      expect(capturedParams[7]).toBeDefined()
    })

    it('should handle various summary kinds correctly', async () => {
      const kinds: Array<'leaf' | 'branch' | 'root'> = ['leaf', 'branch', 'root']

      for (const kind of kinds) {
        const mockClient = {
          query: vi.fn(async (sql: string, params?: unknown[]) => {
            expect(params?.[3]).toBe(kind)
            return { rows: [{ id: 'id' }], rowCount: 1 }
          }),
        }

        await insertSummary(mockClient, {
          conversationId: 'conv',
          depth: 0,
          kind,
          content: 'Test',
          messageCount: 5,
          earliestAt: new Date(),
          latestAt: new Date(),
        })
      }
    })

    it('should pass different depths to INSERT', async () => {
      const depths = [0, 1, 2]

      for (const depth of depths) {
        const mockClient = {
          query: vi.fn(async (sql: string, params?: unknown[]) => {
            expect(params?.[1]).toBe(depth)
            return { rows: [{ id: 'id' }], rowCount: 1 }
          }),
        }

        await insertSummary(mockClient, {
          conversationId: 'conv',
          depth,
          kind: 'leaf',
          content: 'Test',
          messageCount: 5,
          earliestAt: new Date(),
          latestAt: new Date(),
        })
      }
    })

    it('should preserve message count, earliest_at, and latest_at', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          expect(params?.[4]).toBe(42) // messageCount
          return { rows: [{ id: 'id' }], rowCount: 1 }
        }),
      }

      const earliest = new Date('2026-01-01')
      const latest = new Date('2026-01-15')

      await insertSummary(mockClient, {
        conversationId: 'conv',
        depth: 0,
        kind: 'leaf',
        content: 'Test',
        messageCount: 42,
        earliestAt: earliest,
        latestAt: latest,
      })

      const calls = (mockClient.query as any).mock.calls
      const params = calls[0][1]
      expect(params[4]).toBe(42)
      expect(params[5]).toBe(earliest)
      expect(params[6]).toBe(latest)
    })
  })

  describe('integration: withTransaction + insertSummary', () => {
    it('should insert summary within a transaction', async () => {
      const callSequence: string[] = []

      const mockClient = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql === 'BEGIN') {
            callSequence.push('BEGIN')
            return { rows: [], rowCount: null }
          }
          if (sql.includes('INSERT INTO ros_summaries')) {
            callSequence.push('INSERT')
            return { rows: [{ id: 'summary-1' }], rowCount: 1 }
          }
          if (sql === 'COMMIT') {
            callSequence.push('COMMIT')
            return { rows: [], rowCount: null }
          }
          const tx = txControlResult(sql, params)
          if (tx) return tx
          return { rows: [], rowCount: null }
        }),
      }

      const result = await withTransaction(
        mockClient,
        async () => {
        return insertSummary(mockClient, {
          conversationId: 'conv-1',
          depth: 0,
          kind: 'leaf',
          content: 'Summary',
          messageCount: 5,
          earliestAt: new Date(),
          latestAt: new Date(),
        })
        },
        LOCK_OPTS,
      )

      expect(result).toBe('summary-1')
      expect(callSequence).toEqual(['BEGIN', 'INSERT', 'COMMIT'])
    })

    it('should rollback if insertSummary throws within transaction', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT')) throw new Error('INSERT failed')
          const tx = txControlResult(sql, params)
          if (tx) return tx
          return { rows: [], rowCount: null }
        }),
      }

      await expect(
        withTransaction(
          mockClient,
          async () => {
          await insertSummary(mockClient, {
            conversationId: 'conv',
            depth: 0,
            kind: 'leaf',
            content: 'Test',
            messageCount: 1,
            earliestAt: new Date(),
            latestAt: new Date(),
          })
          },
          LOCK_OPTS,
        ),
      ).rejects.toThrow('INSERT failed')

      const calls = (mockClient.query as any).mock.calls
      const cmds = calls.map((c: any) => c[0])
      expect(cmds).toContain('ROLLBACK')
      expect(cmds).not.toContain('COMMIT')
    })
  })

  describe('formatThrown', () => {
    it('uses Error.message', () => {
      expect(formatThrown(new Error('nope'))).toBe('nope')
    })

    it('passes strings through', () => {
      expect(formatThrown('boom')).toBe('boom')
    })

    it('extracts .message from thrown objects instead of [object Object]', () => {
      expect(formatThrown({ message: 'rate limited' })).toBe('rate limited')
    })

    it('JSON-stringifies objects without a message field', () => {
      expect(formatThrown({ status: 500, reason: 'down' })).toBe(
        JSON.stringify({ status: 500, reason: 'down' }),
      )
    })
  })

  describe('isJobFinalAttempt', () => {
    it('is true when attempts >= max_attempts', () => {
      expect(isJobFinalAttempt({ attempts: 3, max_attempts: 3 })).toBe(true)
      expect(isJobFinalAttempt({ attempts: 2, max_attempts: 3 })).toBe(false)
      expect(isJobFinalAttempt({ attempts: 1, max_attempts: 3 })).toBe(false)
    })
  })

  describe('propagateLlmFailure', () => {
    const final = { isFinalAttempt: true }
    const retry = { isFinalAttempt: false }

    it('rethrows the original LlmCallError so graphile last_error stays honest', () => {
      const err = new LlmCallError('LLM unreachable at http://example:8003/v1 (fetch failed)', 4)
      expect(() => propagateLlmFailure('conv-throw-1', err, 'leaf', final)).toThrow(err)
    })

    it('wraps non-Error throws so graphile still records a message', () => {
      expect(() => propagateLlmFailure('conv-throw-2', 'boom', 'branch', final)).toThrow('boom')
    })

    it('wraps thrown objects via formatThrown rather than [object Object]', () => {
      expect(() =>
        propagateLlmFailure('conv-throw-obj', { message: 'payload too large' }, 'root', final),
      ).toThrow('payload too large')
    })

    it('trips the circuit breaker after THRESHOLD final-attempt failures', () => {
      const id = 'conv-throw-breaker'
      const err = new Error('LLM timed out')
      expect(() => propagateLlmFailure(id, err, 'leaf', final)).toThrow(err)
      expect(shouldSkip(id, 'leaf')).toBe(false)
      expect(() => propagateLlmFailure(id, err, 'leaf', final)).toThrow(err)
      expect(shouldSkip(id, 'leaf')).toBe(false)
      expect(() => propagateLlmFailure(id, err, 'leaf', final)).toThrow(err)
      expect(shouldSkip(id, 'leaf')).toBe(true)
      expect(breakerThreshold).toBe(3)
    })

    it('does not increment the breaker on intermediate graphile attempts', () => {
      const id = 'conv-not-final'
      const err = new Error('LLM timed out')
      expect(() => propagateLlmFailure(id, err, 'leaf', retry)).toThrow(err)
      expect(() => propagateLlmFailure(id, err, 'leaf', retry)).toThrow(err)
      expect(() => propagateLlmFailure(id, err, 'leaf', retry)).toThrow(err)
      expect(shouldSkip(id, 'leaf')).toBe(false)
    })

    it('leaf success does not wipe branch failures — branch trips after 3 final attempts', () => {
      const id = 'conv-leaf-ok-branch-fail'
      const err = new Error('branch LLM down')
      recordSuccess(id, 'leaf')
      expect(() => propagateLlmFailure(id, err, 'branch', final)).toThrow(err)
      expect(() => propagateLlmFailure(id, err, 'branch', final)).toThrow(err)
      expect(shouldSkip(id, 'branch')).toBe(false)
      expect(() => propagateLlmFailure(id, err, 'branch', final)).toThrow(err)
      expect(shouldSkip(id, 'branch')).toBe(true)
      expect(shouldSkip(id, 'leaf')).toBe(false)
    })

    it('records a terminal skip on non-retryable 4xx even on a non-final attempt', () => {
      const id = 'conv-4xx-terminal'
      const err = new LlmCallError('LLM HTTP 400: Bad Request (not retrying)', 1, {
        retryable: false,
        status: 400,
      })
      expect(() => propagateLlmFailure(id, err, 'branch', retry)).toThrow(err)
      expect(shouldSkip(id, 'branch')).toBe(true)
      expect(shouldSkip(id, 'leaf')).toBe(false)
    })
  })

  describe('compactConversationTask', () => {
    function makeMessages(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        id: `m-${String(i)}`,
        role: 'user',
        content: `message content ${String(i)} is long enough`,
        agent: 'rivet',
        created_at: new Date('2026-01-01T00:00:00Z'),
        tool_name: null,
        tool_args: null,
      }))
    }

    function makeLeaves(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        id: `leaf-${String(i)}`,
        content: `leaf summary ${String(i)} with enough detail`,
        kind: 'leaf',
        earliest_at: new Date('2026-01-01T00:00:00Z'),
        latest_at: new Date('2026-01-01T01:00:00Z'),
        message_count: 5,
        created_at: new Date('2026-01-01T01:00:00Z'),
      }))
    }

    function mockClient(opts: {
      messages: ReturnType<typeof makeMessages>
      leaves?: ReturnType<typeof makeLeaves>
      lockableLeafIds?: string[]
      claimedMessageIds?: string[]
      lockableMessageIds?: string[]
    }) {
      let unsummarizedQueries = 0
      return {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('SET LOCAL')) {
            return { rows: [], rowCount: null }
          }
          if (sql.includes('FROM ros_conversations')) {
            return {
              rows: [
                {
                  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                  agent: 'rivet',
                  channel: 'cli',
                  channel_id: null,
                  title: 'test',
                  session_key: 'grok-build',
                },
              ],
              rowCount: 1,
            }
          }
          if (sql.includes('FROM ros_messages') && sql.includes('FOR UPDATE SKIP LOCKED')) {
            const requested = new Set((params?.[0] as string[] | undefined) ?? [])
            const ids = (opts.lockableMessageIds ?? opts.messages.map((m) => m.id)).filter(
              (id) => requested.size === 0 || requested.has(id),
            )
            return { rows: ids.map((id) => ({ id })), rowCount: ids.length }
          }
          if (sql.includes('FROM ros_summary_sources') && sql.includes('SELECT')) {
            const claimed = opts.claimedMessageIds ?? []
            return {
              rows: claimed.map((message_id) => ({ message_id })),
              rowCount: claimed.length,
            }
          }
          if (sql.includes('FROM ros_messages')) {
            unsummarizedQueries += 1
            if (unsummarizedQueries === 1) {
              return { rows: opts.messages, rowCount: opts.messages.length }
            }
            return { rows: [], rowCount: 0 }
          }
          if (sql.includes('FOR UPDATE SKIP LOCKED') && sql.includes('ros_summaries')) {
            const all = (opts.leaves ?? []).map((r) => r.id)
            const ids = opts.lockableLeafIds ?? all
            return { rows: ids.map((id) => ({ id })), rowCount: ids.length }
          }
          if (sql.includes('FROM ros_summaries')) {
            const kind = params?.[1]
            if (kind === 'leaf') {
              const rows = opts.leaves ?? []
              return { rows, rowCount: rows.length }
            }
            return { rows: [], rowCount: 0 }
          }
          if (sql.includes('INSERT INTO ros_summaries')) {
            return { rows: [{ id: '11111111-2222-3333-4444-555555555555' }], rowCount: 1 }
          }
          if (sql.includes('INSERT INTO ros_summary_sources')) {
            return { rows: [], rowCount: null }
          }
          if (sql.includes('extract-wiki') || sql.includes('add_job') || sql.includes('embed-target')) {
            return { rows: [], rowCount: null }
          }
          if (sql.includes('UPDATE ros_summaries')) {
            return { rows: [], rowCount: null }
          }
          throw new Error(`Unexpected query: ${sql}`)
        }),
      }
    }

    function mockHelpers(
      client: { query: ReturnType<typeof vi.fn> },
      job: { attempts: number; max_attempts: number } = { attempts: 3, max_attempts: 3 },
    ) {
      return {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        job,
        withPgClient: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
      }
    }

    it('rejects the task promise when callLlm throws', async () => {
      const err = new LlmCallError('LLM unreachable at http://llm.test:8003/v1 (fetch failed)', 2)
      vi.mocked(callLlm).mockRejectedValue(err)
      const client = mockClient({ messages: makeMessages(5) })
      const helpers = mockHelpers(client, { attempts: 1, max_attempts: 3 })

      await expect(
        compactConversationTask(
          { conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
          helpers as never,
        ),
      ).rejects.toThrow(err)
    })

    it('shrinks a truncated leaf batch and writes only the prefix', async () => {
      const trunc = new LlmCallError('LLM response truncated at max_tokens=7000', 1)
      vi.mocked(callLlm)
        .mockRejectedValueOnce(trunc)
        .mockResolvedValueOnce('ok summary text that is long enough')
      const client = mockClient({ messages: makeMessages(10) })
      const helpers = mockHelpers(client, { attempts: 1, max_attempts: 3 })

      await compactConversationTask(
        { conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
        helpers as never,
      )

      expect(vi.mocked(callLlm)).toHaveBeenCalledTimes(2)
      const insert = client.query.mock.calls.find((c) =>
        String(c[0]).includes('INSERT INTO ros_summaries'),
      )
      expect(insert?.[1]?.[4]).toBe(5)
      const sources = client.query.mock.calls.find((c) =>
        String(c[0]).includes('INSERT INTO ros_summary_sources'),
      )
      // 5 rows × 3 params
      expect((sources?.[1] as unknown[] | undefined)?.length).toBe(15)
    })

    it('still fails when truncation cannot shrink below the floor', async () => {
      const trunc = new LlmCallError('LLM response truncated at max_tokens=7000', 1)
      vi.mocked(callLlm).mockRejectedValue(trunc)
      const client = mockClient({ messages: makeMessages(MIN_BATCH_SIZE) })
      const helpers = mockHelpers(client, { attempts: 1, max_attempts: 3 })

      await expect(
        compactConversationTask(
          { conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
          helpers as never,
        ),
      ).rejects.toThrow(trunc)
      expect(vi.mocked(callLlm)).toHaveBeenCalledTimes(1)
    })

    it('leaf succeeds, branch fails ×3 → shouldSkip true for branch only', async () => {
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      const branchErr = new LlmCallError('branch LLM down', 4)
      vi.mocked(callLlm).mockImplementation(async (systemPrompt: string) => {
        if (systemPrompt === BRANCH_SYSTEM_PROMPT) throw branchErr
        return 'ok summary text that is long enough'
      })

      for (let i = 0; i < 3; i++) {
        const client = mockClient({ messages: makeMessages(5), leaves: makeLeaves(5) })
        const helpers = mockHelpers(client, { attempts: 3, max_attempts: 3 })
        await expect(
          compactConversationTask({ conversationId: id }, helpers as never),
        ).rejects.toThrow(branchErr)
      }

      expect(shouldSkip(id, 'branch')).toBe(true)
      expect(shouldSkip(id, 'leaf')).toBe(false)
    })

    it('emits circuit_breaker_skip JSON when a level is already open', async () => {
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      const err = new Error('LLM timed out')
      expect(() => propagateLlmFailure(id, err, 'leaf', { isFinalAttempt: true })).toThrow(err)
      expect(() => propagateLlmFailure(id, err, 'leaf', { isFinalAttempt: true })).toThrow(err)
      expect(() => propagateLlmFailure(id, err, 'leaf', { isFinalAttempt: true })).toThrow(err)
      expect(shouldSkip(id, 'leaf')).toBe(true)

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(callLlm).mockRejectedValue(new Error('should not be called'))
      const client = mockClient({ messages: makeMessages(5) })
      const helpers = mockHelpers(client)

      await expect(
        compactConversationTask({ conversationId: id }, helpers as never),
      ).resolves.toBeUndefined()

      const skipLines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('circuit_breaker_skip'))
      expect(skipLines.length).toBeGreaterThan(0)
      expect(skipLines[0]).toContain('"kind":"leaf"')
      expect(vi.mocked(callLlm)).not.toHaveBeenCalled()
      warn.mockRestore()
    })

  describe('lock order (deadlock contract)', () => {
    it('withTransaction locks the conversation row right after BEGIN when asked', async () => {
      const cmds: string[] = []
      const mockClient = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          cmds.push(sql)
          const tx = txControlResult(sql, params)
          if (tx) return tx
          return { rows: [], rowCount: null }
        }),
      }

      await withTransaction(
        mockClient,
        async () => {
          cmds.push('callback')
          return 'ok'
        },
        { lockConversationId: 'conv-lock-1' },
      )

      expect(cmds[0]).toBe('BEGIN')
      expect(cmds[1]).toContain('FROM ros_conversations')
      expect(cmds[1]).toContain('FOR UPDATE')
      expect(cmds[1]).not.toContain('SKIP LOCKED')
      expect(cmds[2]).toMatch(/SET LOCAL rivet\.defer_embed_enqueue/)
      expect(cmds[3]).toBe('callback')
      expect(cmds[4]).toBe('COMMIT')
    })

    it('two overlapping compactions lock the conversation before any summary write', async () => {
      const CONV_A = 'aaaaaaaa-0000-0000-0000-00000000000a'
      const CONV_B = 'bbbbbbbb-0000-0000-0000-00000000000b'

      interface LogEntry {
        conn: string
        sql: string
        params?: unknown[]
      }
      const log: LogEntry[] = []

      // Turnstile: each INSERT INTO ros_summaries pairs the two tasks up, so
      // both transactions are genuinely open at the same time.
      let waiting: (() => void) | null = null
      const pairGate = (): Promise<void> =>
        new Promise((resolve) => {
          if (waiting) {
            const other = waiting
            waiting = null
            other()
            resolve()
          } else {
            waiting = resolve
          }
        })

      vi.mocked(callLlm).mockResolvedValue('ok summary text that is long enough')

      function makeConn(convId: string, tag: string) {
        let messageQueries = 0
        // created_at ascending (batch order) with ids deliberately descending —
        // proves the sources INSERT re-locks in id-ascending order.
        const messages = Array.from({ length: 5 }, (_, i) => ({
          id: `${tag}-m-${String(5 - i)}`,
          role: 'user',
          content: `message content ${String(i)} is long enough`,
          agent: 'rivet',
          created_at: new Date(Date.UTC(2026, 0, 1, 0, i)),
          tool_name: null,
          tool_args: null,
        }))
        // Leaves returned in created_at order with ids descending.
        const leaves = Array.from({ length: 5 }, (_, i) => ({
          id: `${tag}-l-${String(5 - i)}`,
          content: `leaf summary ${String(i)} with enough detail`,
          kind: 'leaf',
          earliest_at: new Date(Date.UTC(2026, 0, 1, i)),
          latest_at: new Date(Date.UTC(2026, 0, 1, i + 1)),
          message_count: 5,
          created_at: new Date(Date.UTC(2026, 0, 1, i + 1)),
        }))

        return {
          query: vi.fn(async (sql: string, params?: unknown[]) => {
            log.push({ conn: tag, sql, params })
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('SET LOCAL')) {
              return { rows: [], rowCount: null }
            }
            if (sql.includes('FOR UPDATE SKIP LOCKED')) {
              // Real PG honors ORDER BY id ASC; emulate it.
              const ids = [...(params?.[0] as string[])].sort()
              return { rows: ids.map((id) => ({ id })), rowCount: ids.length }
            }
            if (sql.includes('FROM ros_summary_sources') && sql.includes('SELECT')) {
              return { rows: [], rowCount: 0 }
            }
            if (sql.includes('FROM ros_conversations')) {
              return {
                rows: [
                  {
                    id: convId,
                    agent: 'rivet',
                    channel: 'cli',
                    channel_id: null,
                    title: 'test',
                    session_key: 'grok-build',
                  },
                ],
                rowCount: 1,
              }
            }
            if (sql.includes('FROM ros_messages')) {
              messageQueries += 1
              return messageQueries === 1
                ? { rows: messages, rowCount: messages.length }
                : { rows: [], rowCount: 0 }
            }
            if (sql.includes('INSERT INTO ros_summaries')) {
              await pairGate()
              return { rows: [{ id: `${tag}-new-summary` }], rowCount: 1 }
            }
            if (sql.includes('FROM ros_summaries')) {
              const kind = params?.[1]
              if (kind === 'leaf') return { rows: leaves, rowCount: leaves.length }
              return { rows: [], rowCount: 0 }
            }
            if (sql.includes('INSERT INTO ros_summary_sources')) {
              return { rows: [], rowCount: null }
            }
            if (sql.includes('UPDATE ros_summaries')) {
              return { rows: [], rowCount: null }
            }
            if (sql.includes('add_job')) {
              return { rows: [], rowCount: null }
            }
            throw new Error(`Unexpected query: ${sql}`)
          }),
        }
      }

      const helpersFor = (client: { query: ReturnType<typeof vi.fn> }) => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        job: { attempts: 1, max_attempts: 3 },
        withPgClient: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
      })

      await Promise.all([
        compactConversationTask(
          { conversationId: CONV_A },
          helpersFor(makeConn(CONV_A, 'a')) as never,
        ),
        compactConversationTask(
          { conversationId: CONV_B },
          helpersFor(makeConn(CONV_B, 'b')) as never,
        ),
      ])

      // Overlap proven: both leaf-transaction BEGINs land before the first
      // COMMIT — the insert turnstile holds each task's first TX open until
      // the other task has begun its own.
      const beginIdxs = log.map((e, i) => (e.sql === 'BEGIN' ? i : -1)).filter((i) => i >= 0)
      const commitIdxs = log.map((e, i) => (e.sql === 'COMMIT' ? i : -1)).filter((i) => i >= 0)
      expect(beginIdxs.length).toBeGreaterThanOrEqual(2)
      expect(beginIdxs[1]).toBeLessThan(commitIdxs[0])

      // Per connection: inside every [BEGIN, COMMIT] window the FIRST
      // statement is the ros_conversations FOR UPDATE lock, and no
      // ros_summaries write precedes it.
      for (const conn of ['a', 'b']) {
        const stmts = log.filter((e) => e.conn === conn)
        let inTx = false
        let locked = false
        for (const e of stmts) {
          if (e.sql === 'BEGIN') {
            inTx = true
            locked = false
            continue
          }
          if (e.sql === 'COMMIT' || e.sql === 'ROLLBACK') {
            expect(locked).toBe(true)
            inTx = false
            continue
          }
          if (!inTx) continue // enqueueExtractWiki runs after COMMIT by design
          if (!locked) {
            expect(e.sql).toContain('FROM ros_conversations')
            expect(e.sql).toContain('FOR UPDATE')
            expect(e.sql).not.toContain('SKIP LOCKED')
            locked = true
          }
        }
      }

      // Leaf sources: message ids ascending, ordinals still chronological.
      const sources = log.filter((e) => e.sql.includes('INSERT INTO ros_summary_sources'))
      expect(sources.length).toBe(2)
      for (const e of sources) {
        const p = e.params as unknown[]
        const ids = [p[1], p[4], p[7], p[10], p[13]] as string[]
        const ordinals = [p[2], p[5], p[8], p[11], p[14]] as number[]
        expect([...ids].sort()).toEqual(ids)
        // ids were handed to the batch in descending order → ordinals reversed.
        expect(ordinals).toEqual([4, 3, 2, 1, 0])
      }

      // Parent level: children locked FOR UPDATE SKIP LOCKED in id order
      // before the parent UPDATE. (Leaf also SKIP LOCKs source messages.)
      const childLocks = log.filter(
        (e) => e.sql.includes('FOR UPDATE SKIP LOCKED') && e.sql.includes('ros_summaries'),
      )
      expect(childLocks.length).toBe(2)
      for (const e of childLocks) {
        expect(e.sql).toContain('ORDER BY id ASC')
        expect(e.sql).toContain('parent_id IS NULL')
      }
      const msgLocks = log.filter(
        (e) => e.sql.includes('FOR UPDATE SKIP LOCKED') && e.sql.includes('ros_messages'),
      )
      expect(msgLocks.length).toBe(2)
      const parentUpdates = log.filter((e) => e.sql.includes('UPDATE ros_summaries'))
      expect(parentUpdates.length).toBe(2)
      for (const e of parentUpdates) {
        const ids = e.params?.[1] as string[]
        expect([...ids].sort()).toEqual(ids)
      }
    })

    it('bails the leaf when ros_summary_sources already claims the batch', async () => {
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      vi.mocked(callLlm).mockResolvedValue('ok summary text that is long enough')
      const client = mockClient({
        messages: makeMessages(5),
        claimedMessageIds: ['m-0'],
      })
      await compactConversationTask({ conversationId: id }, mockHelpers(client) as never)
      expect(
        client.query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO ros_summaries')),
      ).toBe(false)
    })

    it('parent SKIP LOCKED subset aborts: no insertSummary, no parent_id UPDATE, no recordSuccess', async () => {
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      vi.mocked(callLlm).mockResolvedValue('ok summary text that is long enough')
      const client = mockClient({
        messages: makeMessages(5),
        leaves: makeLeaves(5),
        lockableLeafIds: ['leaf-0', 'leaf-1', 'leaf-2', 'leaf-3'],
      })
      const helpers = mockHelpers(client)
      await compactConversationTask({ conversationId: id }, helpers as never)

      const parentInserts = client.query.mock.calls.filter((c) =>
        String(c[0]).includes('INSERT INTO ros_summaries'),
      )
      // Leaf insert only — parent aborted on set mismatch.
      expect(parentInserts).toHaveLength(1)
      const parentUpdates = client.query.mock.calls.filter((c) =>
        String(c[0]).includes('UPDATE ros_summaries'),
      )
      expect(parentUpdates).toHaveLength(0)
      expect(shouldSkip(id, 'branch')).toBe(false)
    })

    it('retries 40P01 on the child lock then succeeds; 23505 is not retried', async () => {
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      vi.mocked(callLlm).mockResolvedValue('ok summary text that is long enough')
      let childLockAttempts = 0
      const base = mockClient({ messages: makeMessages(5), leaves: makeLeaves(5) })
      const orig = base.query.getMockImplementation()!
      base.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FOR UPDATE SKIP LOCKED') && sql.includes('ros_summaries')) {
          childLockAttempts += 1
          if (childLockAttempts === 1) throw deadlockError()
        }
        return orig(sql, params)
      })
      await compactConversationTask({ conversationId: id }, mockHelpers(base) as never)
      expect(childLockAttempts).toBe(2)
      expect(base.query.mock.calls.some((c) => c[0] === 'ROLLBACK')).toBe(true)
      expect(base.query.mock.calls.filter((c) => c[0] === 'BEGIN').length).toBeGreaterThanOrEqual(2)

      childLockAttempts = 0
      const boom = mockClient({ messages: makeMessages(5), leaves: makeLeaves(5) })
      const orig2 = boom.query.getMockImplementation()!
      boom.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FOR UPDATE SKIP LOCKED') && sql.includes('ros_summaries')) {
          childLockAttempts += 1
          throw Object.assign(new Error('unique_violation'), { code: '23505' })
        }
        return orig2(sql, params)
      })
      await expect(
        compactConversationTask({ conversationId: id }, mockHelpers(boom) as never),
      ).rejects.toMatchObject({ code: '23505' })
      expect(childLockAttempts).toBe(1)
    })
  })
  })
})
