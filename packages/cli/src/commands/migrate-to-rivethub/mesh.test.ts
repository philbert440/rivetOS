import { describe, expect, it, vi } from 'vitest'
import type { MeshFile, MeshNode } from '../../lib/mesh-file.js'
import type { Host } from './host.js'
import { meshMigrate, remoteCommand, skipReason, type MeshDeps } from './mesh.js'
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
  } as unknown as Host
  const sshRun = vi.fn((_h: string, _u: string, _c: string) => Promise.resolve(codes.shift() ?? 0))
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
    expect(sshRun).toHaveBeenCalledTimes(2)
    expect(migrateLocal).toHaveBeenCalledWith(expect.objectContaining({ mesh: false }))
  })

  it('stops at the first failed node and leaves this node alone', async () => {
    const { d, sshRun, migrateLocal, logs } = deps([node('a'), node('b')], [1, 0])
    expect(await meshMigrate(opts(['--mesh']), d)).toBe(1)
    expect(sshRun).toHaveBeenCalledTimes(1)
    expect(migrateLocal).not.toHaveBeenCalled()
    expect(logs.join('\n')).toMatch(/stopping the mesh walk/)
  })

  it('reports refusals with exit 2 but keeps walking', async () => {
    const { d, sshRun } = deps([node('a'), node('b')], [2, 0])
    expect(await meshMigrate(opts(['--mesh']), d)).toBe(2)
    expect(sshRun).toHaveBeenCalledTimes(2)
  })

  it('uploads --binary and passes the uploaded path', async () => {
    const { d, sshRun } = deps([node('a')], [0])
    await meshMigrate(opts(['--mesh', '--binary', '/opt/rh/rh']), d)
    expect(sshRun.mock.calls[0]?.[2]).toContain('--binary .cache/rivethub-migrate/rh')
  })
})
