/**
 * /api/outcomes (2g) — aggregates over InMemoryTaskStore.listOutcomes,
 * driven over a bare http server like the other gateway route suites.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, afterEach } from 'vitest'
import type { TaskUsage } from '@rivetos/types'
import { InMemoryTaskStore } from './store.js'
import { createOutcomesApiRoute } from './outcomes-api.js'

const usage: TaskUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, turns: 1, wallClockMs: 5 }
const CRIT = [{ id: 'c1', description: 'd', kind: 'manual' as const }]

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function seedAndServe(): Promise<{ base: string; store: InMemoryTaskStore }> {
  const store = new InMemoryTaskStore(() => {})
  const mk = async (
    agentId: string,
    evalVerdict?: 'verified' | 'refuted' | 'escalated',
    opts?: { criteria?: boolean; costUsd?: number },
  ) => {
    const row = await store.create({
      goal: 'g',
      executor: 'chat-loop',
      agentId,
      origin: 'api',
      acceptanceCriteria: opts?.criteria === false ? [] : CRIT,
    })
    await store.claim(row.id, 'n')
    await store.finish(row.id, 'completed', {
      verdict: 'completed',
      summary: 's',
      artifacts: [],
      usage: { ...usage, costUsd: opts?.costUsd },
    })
    if (evalVerdict) {
      await store.recordEval(row.id, {
        verdict: evalVerdict,
        attempts: evalVerdict === 'escalated' ? 1 : 0,
        verifierTaskIds: [],
        criteriaReport: [],
        diverged: evalVerdict === 'refuted',
      })
    }
    return row
  }
  await mk('alpha', 'verified', { costUsd: 0.01 })
  await mk('alpha', 'verified')
  await mk('alpha', 'escalated')
  await mk('beta', 'verified')
  await mk('beta', undefined, { criteria: false }) // unevaluable — excluded
  // verifier child — excluded
  const child = await store.create({
    goal: 'verify',
    executor: 'chat-loop',
    agentId: 'alpha',
    origin: 'eval',
    acceptanceCriteria: CRIT, // even with criteria, origin excludes it
  })
  await store.claim(child.id, 'n')
  await store.finish(child.id, 'completed', {
    verdict: 'completed',
    summary: 's',
    artifacts: [],
    usage,
  })

  const route = createOutcomesApiRoute({ store })
  const server: Server = createServer((req, res) => {
    void route.handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => server.close(r)))
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, store }
}

describe('/api/outcomes', () => {
  it('aggregates totals/byAgent, excludes unevaluable + verifier rows', async () => {
    const { base } = await seedAndServe()
    const res = await fetch(`${base}/api/outcomes`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      totals: { tasks: number; verified: number; escalated: number; divergenceRate: number; totalCostUsd?: number }
      byAgent: Record<string, { tasks: number; verified: number }>
    }
    expect(body.totals.tasks).toBe(4) // 3 alpha + 1 beta; no bare row, no eval child
    expect(body.totals.verified).toBe(3)
    expect(body.totals.escalated).toBe(1)
    expect(body.totals.divergenceRate).toBeCloseTo(0.25)
    expect(body.totals.totalCostUsd).toBeCloseTo(0.01)
    expect(body.byAgent.alpha.tasks).toBe(3)
    expect(body.byAgent.beta.tasks).toBe(1)
  })

  it('filters by agentId; 405 on non-GET', async () => {
    const { base } = await seedAndServe()
    const filtered = (await (await fetch(`${base}/api/outcomes?agentId=beta`)).json()) as {
      totals: { tasks: number }
    }
    expect(filtered.totals.tasks).toBe(1)
    expect((await fetch(`${base}/api/outcomes`, { method: 'POST' })).status).toBe(405)
  })
})
