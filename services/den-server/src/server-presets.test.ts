import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDenServer, type DenServer } from './server.js'
import { baseTestDenConfig } from './test-config.js'

interface PresetRow {
  id: string
  name: string
  color: string
  harness_id: string | null
  model: string
  effort: string
  system_prompt: string
  node: string
  directory: string
  shared_link: boolean
  node_base_url: string
  created_at: Date
  updated_at: Date
}

describe('preset store wiring', () => {
  const servers: DenServer[] = []
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  })

  it('probes at boot, imports into the primary pool, and ends the pool on close', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'den-preset-wire-'))
    dirs.push(stateDir)
    writeFileSync(
      join(stateDir, 'agents.json'),
      JSON.stringify({
        agents: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Reviewer',
            color: '',
            model: 'opus',
            effort: 'medium',
            systemPrompt: '',
            nodeBaseUrl: 'http://127.0.0.1:9',
            createdAt: 10,
            updatedAt: 10,
          },
        ],
      }),
    )

    const queries: string[] = []
    const rows: PresetRow[] = []
    let ended = 0
    const pool = {
      async query(sql: string, params?: unknown[]) {
        queries.push(sql)
        if (sql.includes('to_regclass')) return { rows: [{ reg: 'ros_agent_presets' }] }
        if (sql.includes('INSERT INTO')) {
          const row: PresetRow = {
            id: String(params?.[0]),
            name: String(params?.[1]),
            color: String(params?.[2] ?? ''),
            harness_id: (params?.[3] as string | null) ?? null,
            model: String(params?.[4] ?? ''),
            effort: String(params?.[5] ?? ''),
            system_prompt: String(params?.[6] ?? ''),
            node: String(params?.[7]),
            directory: String(params?.[8]),
            shared_link: params?.[9] !== false,
            node_base_url: String(params?.[10] ?? ''),
            created_at: params?.[11] instanceof Date ? params[11] : new Date(1),
            updated_at: params?.[12] instanceof Date ? params[12] : new Date(2),
          }
          rows.push(row)
          return { rows: [row] }
        }
        if (sql.includes('FROM ros_agent_presets')) {
          const node = params?.[0]
          const matched = typeof node === 'string' ? rows.filter((row) => row.node === node) : rows
          return { rows: matched }
        }
        return { rows: [] }
      },
      async end() {
        ended += 1
      },
    } as unknown as Pool

    const den = createDenServer(baseTestDenConfig(stateDir, { nodeName: 'ct115' }), {
      presetPool: pool,
      aliasBreadcrumbs: null,
    })
    servers.push(den)

    const started = Date.now()
    while (!queries.some((sql) => sql.includes('to_regclass'))) {
      if (Date.now() - started > 2_000) throw new Error('probe was not kicked at boot')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    while (!rows.some((row) => row.name === 'Reviewer')) {
      if (Date.now() - started > 2_000) throw new Error('import did not write the primary')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(queries[0]).toMatch(/to_regclass/)
    expect(rows[0]).toMatchObject({ name: 'Reviewer', node: 'ct115' })
    expect(existsSync(rows[0]?.directory ?? '')).toBe(true)
    expect(existsSync(join(stateDir, 'agents.json'))).toBe(false)
    expect(readdirSync(stateDir).some((name) => name.includes('.imported-'))).toBe(true)

    await den.close()
    expect(ended).toBe(1)
  })
})
