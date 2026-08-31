import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./init/index.js', () => ({
  runInitWizard: vi.fn().mockResolvedValue(undefined),
}))

import init, { parseInitArgs } from './init.js'
import { runInitWizard } from './init/index.js'
import { INIT_MESH_JOIN_PORT } from './init/wizard.js'

describe('parseInitArgs', () => {
  it('finds --join by flag name, not position', () => {
    expect(parseInitArgs(['--join', 'seed.mesh'])).toEqual({
      joinHost: 'seed.mesh',
      answersFile: undefined,
    })
  })

  it('still finds --join when an extra init token precedes it', () => {
    // rivetos config init --join host → process.argv.slice(3) is [init, --join, host]
    expect(parseInitArgs(['init', '--join', 'seed.mesh'])).toEqual({
      joinHost: 'seed.mesh',
      answersFile: undefined,
    })
  })

  it('returns no joinHost when --join is absent', () => {
    expect(parseInitArgs([])).toEqual({ joinHost: undefined, answersFile: undefined })
    expect(parseInitArgs(['--other', 'x'])).toEqual({ joinHost: undefined, answersFile: undefined })
  })

  it('finds --answers-file by flag name', () => {
    expect(parseInitArgs(['--answers-file', '/tmp/a.json'])).toEqual({
      joinHost: undefined,
      answersFile: '/tmp/a.json',
    })
  })

  it('still finds --answers-file when an extra init token precedes it', () => {
    expect(parseInitArgs(['init', '--answers-file', '/tmp/a.json'])).toEqual({
      joinHost: undefined,
      answersFile: '/tmp/a.json',
    })
  })

  it('throws when --answers-file has no path', () => {
    expect(() => parseInitArgs(['--answers-file'])).toThrow(/--answers-file requires a path/)
    expect(() => parseInitArgs(['--answers-file', '--join'])).toThrow(
      /--answers-file requires a path/,
    )
  })
})

describe('init()', () => {
  beforeEach(() => {
    vi.mocked(runInitWizard).mockClear()
  })

  it('forwards --join host to the wizard entry', async () => {
    await init(['--join', 'ct110.mesh'])
    expect(runInitWizard).toHaveBeenCalledWith({ joinHost: 'ct110.mesh', answersFile: undefined })
  })

  it('forwards --answers-file to the wizard entry', async () => {
    await init(['--answers-file', '/tmp/a.json'])
    expect(runInitWizard).toHaveBeenCalledWith({
      joinHost: undefined,
      answersFile: '/tmp/a.json',
    })
  })
})

describe('INIT_MESH_JOIN_PORT', () => {
  it('pings the mesh listener default 3000, not standalone plugin 3100', () => {
    expect(INIT_MESH_JOIN_PORT).toBe(3000)
  })
})
