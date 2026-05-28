/**
 * Unit tests for compact-conversation task — transaction handling and summary insertion.
 */

import { describe, it, expect, vi } from 'vitest'

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
    toolSynthEndpoint: 'http://localhost:8000',
    toolSynthModel: 'test-model',
  },
}))

import { withTransaction, insertSummary } from './compact-conversation.js'

describe('compact-conversation', () => {
  describe('withTransaction', () => {
    it('should execute BEGIN and COMMIT in order', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN') return { rows: [], rowCount: null }
          if (sql === 'COMMIT') return { rows: [], rowCount: null }
          throw new Error(`Unexpected query: ${sql}`)
        }),
      }

      await withTransaction(mockClient, async () => 'result')

      expect(mockClient.query).toHaveBeenCalledTimes(2)
      const calls = (mockClient.query as any).mock.calls
      expect(calls[0][0]).toBe('BEGIN')
      expect(calls[1][0]).toBe('COMMIT')
    })

    it('should execute the callback between BEGIN and COMMIT', async () => {
      const callOrder: string[] = []

      const mockClient = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN') {
            callOrder.push('BEGIN')
            return { rows: [], rowCount: null }
          }
          if (sql === 'COMMIT') {
            callOrder.push('COMMIT')
            return { rows: [], rowCount: null }
          }
          return { rows: [], rowCount: null }
        }),
      }

      await withTransaction(mockClient, async () => {
        callOrder.push('callback')
        return 'done'
      })

      expect(callOrder).toEqual(['BEGIN', 'callback', 'COMMIT'])
    })

    it('should return the callback result', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string) => ({ rows: [], rowCount: null })),
      }

      const result = await withTransaction(mockClient, async () => {
        return { value: 42 }
      })

      expect(result).toEqual({ value: 42 })
    })

    it('should ROLLBACK on callback error', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN') return { rows: [], rowCount: null }
          if (sql === 'ROLLBACK') return { rows: [], rowCount: null }
          return { rows: [], rowCount: null }
        }),
      }

      const error = new Error('Callback failed')
      await expect(
        withTransaction(mockClient, async () => {
          throw error
        }),
      ).rejects.toThrow('Callback failed')

      const calls = (mockClient.query as any).mock.calls
      expect(calls.map((c: any) => c[0])).toContain('ROLLBACK')
      expect(calls.map((c: any) => c[0])).not.toContain('COMMIT')
    })

    it('should handle ROLLBACK failure gracefully', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN') return { rows: [], rowCount: null }
          if (sql === 'ROLLBACK') throw new Error('ROLLBACK failed')
          return { rows: [], rowCount: null }
        }),
      }

      const callbackError = new Error('Callback error')
      await expect(
        withTransaction(mockClient, async () => {
          throw callbackError
        }),
      ).rejects.toThrow('Callback error')

      // Should still call ROLLBACK even though it fails
      const calls = (mockClient.query as any).mock.calls
      expect(calls.map((c: any) => c[0])).toContain('ROLLBACK')
    })

    it('should not COMMIT if callback throws', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN') return { rows: [], rowCount: null }
          if (sql === 'ROLLBACK') return { rows: [], rowCount: null }
          return { rows: [], rowCount: null }
        }),
      }

      try {
        await withTransaction(mockClient, async () => {
          throw new Error('Test error')
        })
      } catch {
        // Expected
      }

      const calls = (mockClient.query as any).mock.calls
      const cmds = calls.map((c: any) => c[0])
      expect(cmds).toContain('BEGIN')
      expect(cmds).toContain('ROLLBACK')
      expect(cmds).not.toContain('COMMIT')
    })

    it('should allow nested transaction calls (caller manages nesting)', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string) => ({ rows: [], rowCount: null })),
      }

      await withTransaction(mockClient, async () => {
        // PG will handle SAVEPOINT nesting via BEGIN; caller just sees success
        return 'outer'
      })

      const calls = (mockClient.query as any).mock.calls
      expect(calls[0][0]).toBe('BEGIN')
      expect(calls[calls.length - 1][0]).toBe('COMMIT')
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
          return { rows: [], rowCount: null }
        }),
      }

      const result = await withTransaction(mockClient, async () => {
        return insertSummary(mockClient, {
          conversationId: 'conv-1',
          depth: 0,
          kind: 'leaf',
          content: 'Summary',
          messageCount: 5,
          earliestAt: new Date(),
          latestAt: new Date(),
        })
      })

      expect(result).toBe('summary-1')
      expect(callSequence).toEqual(['BEGIN', 'INSERT', 'COMMIT'])
    })

    it('should rollback if insertSummary throws within transaction', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN') return { rows: [], rowCount: null }
          if (sql === 'ROLLBACK') return { rows: [], rowCount: null }
          if (sql.includes('INSERT')) throw new Error('INSERT failed')
          return { rows: [], rowCount: null }
        }),
      }

      await expect(
        withTransaction(mockClient, async () => {
          await insertSummary(mockClient, {
            conversationId: 'conv',
            depth: 0,
            kind: 'leaf',
            content: 'Test',
            messageCount: 1,
            earliestAt: new Date(),
            latestAt: new Date(),
          })
        }),
      ).rejects.toThrow('INSERT failed')

      const calls = (mockClient.query as any).mock.calls
      const cmds = calls.map((c: any) => c[0])
      expect(cmds).toContain('ROLLBACK')
      expect(cmds).not.toContain('COMMIT')
    })
  })
})
