import { describe, expect, it, vi } from 'vitest'
import type { MeshFile, MeshNode } from '../../lib/mesh-file.js'
import type { Host } from './host.js'
import {
  detachedStartCommand,
  FOLLOW_RECONNECTS,
  followCommand,
  meshMigrate,
  remoteCommand,
  skipReason,
  type MeshDeps,
} from './mesh.js'
import { forwardedFlags, parseMigrateArgs, type MigrateOptions } from './options.js'

function node(name: string, extra: Partial<MeshNode> = {}): MeshNode {
  return {
    id: name,
    name,
    agents: [],
    host: `10.0.0.${String(name.length)}${name.slice(-1)}`,
    port: 3100,
    providers: [],
    models: [],
    capabilities: [],
    status: 'online',
    ...extra,
  } as MeshNode
}

function opts(args: string[]): MigrateOptions {
  const r = parseMigrateArgs(args)
  if (!r.ok) throw new Error(r.error)
  return r.opts
}

function deps(nodes: MeshNode[], codes: number[], localCode = 0) {
  const logs: string[] = []
  const host = {
    log: (l: string) => logs.push(l),
    error: (l: string) => logs.push(l),
    run: vi.fn(() => ({ code: 0, stdout: '', stderr: '' })),
    now: () => new Date(Date.parse('2026-10-16T12:00:00Z')),
    sleep: () => Promise.resolve(),
  } as unknown as Host
  // Starting a detached run succeeds; the codes are what the runs (or, for a
  // dry run, the streamed command) exit with.
  const sshRun = vi.fn((_h: string, _u: string, c: string) =>
    Promise.resolve(c.includes('nohup') ? 0 : (codes.shift() ?? 0)),
  )
  const migrateLocal = vi.fn(() => Promise.resolve(localCode))
  const mesh = { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) } as unknown as MeshFile
  const d: MeshDeps = {
    host,
    loadMesh: () => Promise.resolve(mesh),
    isLocal: (a) => a === 'local',
    resolveSshUser: () => 'rivet',
    sshRun,
    migrateLocal,
  }
  return { d, logs, sshRun, migrateLocal }
}

describe('mesh walk', () => {
  it('skips non-agent, non-linux and opted-out nodes', () => {
    expect(skipReason(node('dh', { role: 'datahub' } as Partial<MeshNode>))).toMatch(/role=datahub/)
    expect(skipReason(node('ph', { platform: 'android' } as Partial<MeshNode>))).toMatch(/android/)
    expect(skipReason(node('a'))).toBeUndefined()
  })

  it('forwards flags and prefers the checkout CLI on the remote', () => {
    const cmd = remoteCommand(
      '/opt/rivetos',
      forwardedFlags(opts(['--dry-run', '--version', 'v1'])),
    )
    expect(cmd).toContain("node '/opt/rivetos/packages/cli/dist/index.js'")
    expect(cmd).toContain('$cli migrate-to-rivethub --dry-run --version v1')
    expect(cmd).toContain('exit 3')
  })

  it('migrates remotes one at a time, then this node', async () => {
    const { d, sshRun, migrateLocal } = deps(
      [node('a'), node('b'), node('self', { host: 'local' })],
      [0, 0],
    )
    expect(await meshMigrate(opts(['--mesh']), d)).toBe(0)
    // start + follow per node
    expect(sshRun).toHaveBeenCalledTimes(4)
    expect(migrateLocal).toHaveBeenCalledWith(expect.objectContaining({ mesh: false }))
  })

  it('stops at the first failed node and leaves this node alone', async () => {
    const { d, sshRun, migrateLocal, logs } = deps([node('a'), node('b')], [1, 0])
    expect(await meshMigrate(opts(['--mesh']), d)).toBe(1)
    expect(sshRun).toHaveBeenCalledTimes(2)
    expect(migrateLocal).not.toHaveBeenCalled()
    expect(logs.join('\n')).toMatch(/stopping the mesh walk/)
  })

  it('reports refusals with exit 2 but keeps walking', async () => {
    const { d, sshRun } = deps([node('a'), node('b')], [2, 0])
    expect(await meshMigrate(opts(['--mesh']), d)).toBe(2)
    expect(sshRun).toHaveBeenCalledTimes(4)
  })

  it('uploads --binary and passes the uploaded path', async () => {
    const { d, sshRun } = deps([node('a')], [0])
    await meshMigrate(opts(['--mesh', '--binary', '/opt/rh/rh']), d)
    expect(sshRun.mock.calls[0]?.[2]).toContain('--binary .cache/rivethub-migrate/rh')
  })

  it('starts real runs detached and follows them; dry runs stream directly', async () => {
    const real = deps([node('a')], [0])
    await meshMigrate(opts(['--mesh']), real.d)
    const [start, follow] = real.sshRun.mock.calls.map((c) => c[2])
    expect(start).toContain('setsid')
    expect(start).toContain('nohup bash -c')
    expect(start).toContain('$cli migrate-to-rivethub')
    expect(follow).toContain('tail -n +1 -F .cache/rivethub-migrate/run-20261016T120000Z.log')

    const dry = deps([node('a')], [0])
    await meshMigrate(opts(['--mesh', '--dry-run']), dry.d)
    expect(dry.sshRun).toHaveBeenCalledTimes(1)
    expect(dry.sshRun.mock.calls[0]?.[2]).not.toContain('nohup')
  })

  it('reconnects when the SSH connection drops while following', async () => {
    const { d, sshRun, logs } = deps([node('a')], [255, 255, 0])
    expect(await meshMigrate(opts(['--mesh']), d)).toBe(0)
    const follows = sshRun.mock.calls.map((c) => c[2]).filter((c) => c.includes('tail'))
    expect(follows).toHaveLength(3)
    expect(follows[1]).toContain('tail -n 20 -F')
    expect(logs.join('\n')).toMatch(/Reconnecting/)
  })

  it('gives up following after the reconnects, and on a lost run', async () => {
    const dropped = deps([node('a')], Array<number>(FOLLOW_RECONNECTS + 2).fill(255))
    expect(await meshMigrate(opts(['--mesh']), dropped.d)).toBe(1)
    expect(dropped.logs.join('\n')).toMatch(/run continues on the node/)
    expect(dropped.migrateLocal).not.toHaveBeenCalled()

    const lost = deps([node('a')], [4])
    expect(await meshMigrate(opts(['--mesh']), lost.d)).toBe(1)
    expect(lost.logs.join('\n')).toMatch(/run lost/)
  })

  it('keeps the run id and quoting inside the detached script', () => {
    const cmd = detachedStartCommand('ID', "echo 'x'")
    expect(cmd).toContain(
      `bash -c 'echo $$ > .cache/rivethub-migrate/run-ID.pid; ( echo '\\''x'\\'' );`,
    )
    expect(followCommand('ID', false)).toContain(
      'exit "$(cat .cache/rivethub-migrate/run-ID.exit)"',
    )
  })
})
