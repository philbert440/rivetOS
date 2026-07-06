#!/usr/bin/env node
/**
 * task-smoke — live cross-node task-engine smoke (design-doc eval plan).
 *
 * Creates one budget-capped ($0.10 / 2 min) ros_tasks row pinned to a target
 * node and waits for the terminal row via LISTEN ros_task_done. Asserts:
 * terminal status, claimed_by = target, non-empty response, usage recorded.
 *
 * Usage (on any node with RIVETOS_PG_URL, e.g. after `source ~/.rivetos/.env`):
 *   node scripts/task-smoke.mjs [targetNode] [agentId]
 * Defaults: targetNode=ct112 agentId=grok. Exits 0 on pass, 1 on fail.
 *
 * Reads the INSTALLED runtime (/opt/rivetos) so it smokes what is deployed,
 * not the working tree.
 */
import { createRequire } from 'node:module'

const RUNTIME_ROOT = process.env.RIVETOS_ROOT_DIR ?? '/opt/rivetos'
const require = createRequire(`${RUNTIME_ROOT}/package.json`)
const pg = require('pg')
const { PgTaskStore, createTaskCompletionWaiter } = await import(
  `${RUNTIME_ROOT}/node_modules/@rivetos/core/dist/index.js`
)

const targetNode = process.argv[2] ?? 'ct112'
const agentId = process.argv[3] ?? 'grok'
const pgUrl = process.env.RIVETOS_PG_URL
if (!pgUrl) {
  console.error('RIVETOS_PG_URL not set — source ~/.rivetos/.env first')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: pgUrl, max: 2 })
const store = new PgTaskStore(pool)
const waiter = createTaskCompletionWaiter({ store, pgUrl })

const fail = async (msg) => {
  console.error(`SMOKE FAIL: ${msg}`)
  await waiter.stop()
  await pool.end()
  process.exit(1)
}

const row = await store.create({
  goal: 'Reply with exactly the word task-smoke-pong and nothing else.',
  executor: 'chat-loop',
  agentId,
  origin: 'mesh',
  nodeAffinity: targetNode,
  requestedBy: `smoke:${process.env.HOSTNAME ?? 'local'}`,
  chainDepth: 1,
  spec: { delegation: true, smoke: true, excludeTools: ['delegate_task'] },
  budget: { maxWallClockMs: 120_000, maxUsd: 0.1 },
  maxAttempts: 1,
})
console.log(`created ${row.id} → ${agentId}@${targetNode}`)

const started = Date.now()
const terminal = await waiter.wait(row.id, { deadlineMs: 150_000 })
if (!terminal) {
  await store.requestKill(row.id)
  await fail('no terminal row before deadline (row killed)')
}
const response = terminal.result?.output ?? terminal.result?.summary ?? ''
console.log(
  `terminal ${terminal.status} in ${String(Date.now() - started)}ms — claimed_by=${terminal.claimedBy ?? '?'} response=${JSON.stringify(response.slice(0, 80))}`,
)

if (terminal.status !== 'completed') await fail(`status ${terminal.status}: ${terminal.error ?? ''}`)
if (terminal.claimedBy !== targetNode) await fail(`claimed by ${terminal.claimedBy}, expected ${targetNode}`)
if (!response.includes('task-smoke-pong')) await fail(`unexpected response: ${response.slice(0, 200)}`)
if (!terminal.result?.usage || terminal.result.usage.totalTokens <= 0) await fail('no usage recorded')

console.log('SMOKE PASS')
await waiter.stop()
await pool.end()
