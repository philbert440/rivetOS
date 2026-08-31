import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWorkspace } from './doctor.js'

const ORIGINAL_HOME = process.env.HOME

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'doctor-workspace-'))
  process.env.HOME = join(tmp, 'home')
  mkdirSync(join(process.env.HOME, '.rivetos', 'workspace'), { recursive: true })
})

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
  rmSync(tmp, { recursive: true, force: true })
})

function workspaceFile(name: string, content = `${name}\n`): void {
  writeFileSync(join(process.env.HOME!, '.rivetos', 'workspace', name), content)
}

describe('doctor workspace check', () => {
  it('passes AGENT.md and MEMORY.md with no warnings on a fresh install (no HEARTBEAT.md)', async () => {
    workspaceFile('AGENT.md')
    workspaceFile('MEMORY.md')

    const results = await checkWorkspace()
    expect(results.every((r) => r.status === 'pass')).toBe(true)
    expect(results.some((r) => r.status === 'warn')).toBe(false)
    expect(results.map((r) => r.name)).toEqual(['AGENT.md', 'MEMORY.md'])
    expect(results.some((r) => r.message.includes('HEARTBEAT.md'))).toBe(false)
  })

  it('fails AGENT.md as missing (required) when no legacy files exist', async () => {
    workspaceFile('MEMORY.md')

    const results = await checkWorkspace()
    const agent = results.find((r) => r.name === 'AGENT.md')
    expect(agent?.status).toBe('fail')
    expect(agent?.message).toBe('Workspace: AGENT.md missing (required)')
    expect(agent?.message).not.toContain('Migrate')
  })

  it('hints to migrate legacy files into AGENT.md when AGENT.md is missing', async () => {
    workspaceFile('MEMORY.md')
    workspaceFile('USER.md')
    workspaceFile('CORE.md')
    workspaceFile('WORKSPACE.md')

    const results = await checkWorkspace()
    const agent = results.find((r) => r.name === 'AGENT.md')
    expect(agent?.status).toBe('fail')
    expect(agent?.message).toBe(
      'Workspace: AGENT.md missing (required). Migrate content from USER.md, CORE.md, WORKSPACE.md into AGENT.md.',
    )
  })
})
