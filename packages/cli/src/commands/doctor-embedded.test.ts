import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkMemoryBackend } from './doctor.js'

const ORIGINAL_HOME = process.env.HOME
const ORIGINAL_PG_URL = process.env.RIVETOS_PG_URL

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'doctor-embedded-'))
  process.env.HOME = tmp
  delete process.env.RIVETOS_PG_URL
  mkdirSync(join(tmp, '.rivetos'), { recursive: true })
})

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
  if (ORIGINAL_PG_URL === undefined) delete process.env.RIVETOS_PG_URL
  else process.env.RIVETOS_PG_URL = ORIGINAL_PG_URL
  rmSync(tmp, { recursive: true, force: true })
})

describe('doctor embedded ${HOME} expansion', () => {
  it("expands data_dir: '${HOME}/pglite' the same way as boot and the CLI", async () => {
    writeFileSync(
      join(tmp, '.rivetos', 'config.yaml'),
      "memory:\n  postgres:\n    embedded:\n      data_dir: '${HOME}/pglite'\n",
    )

    const { results } = await checkMemoryBackend()
    const row = results.find((r) => r.category === 'memory' && r.name === 'embedded')
    expect(row?.status).toBe('warn')
    expect(row?.message).toContain(`${tmp}/pglite`)
    expect(row?.message).not.toContain('${HOME}')
  })
})
