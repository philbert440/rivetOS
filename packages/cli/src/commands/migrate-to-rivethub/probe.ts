/**
 * Read-only facts about this node that the migration plan is built from.
 * Nothing here changes the machine: every probe is a read, a `systemctl cat`
 * / `show` / `is-active`, `sudo -n true`, or `rh config validate`.
 */

import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { resolveEmbeddedPg, resolveEnvVars, type RivetConfig } from '@rivetos/boot'
import { parseRivetEnv } from '../../lib/env-file.js'
import { shellArg } from '../../lib/ssh.js'
import { denProbeHost, parseDenSettings } from '../update/den-deploy.js'
import type { Host, PathKind, RunResult } from './host.js'
import type { MigrateOptions } from './options.js'
import { HUB_UNIT, systemctl, TS_UNIT, type ScopeContext, type UnitScope } from './unit.js'

export type MemoryFacts =
  | { kind: 'postgres'; url: string }
  | { kind: 'pglite'; dataDir: string; lockPid?: number; lockAlive: boolean }
  | {
      kind: 'sqlite'
      path: string
      exists: boolean
      /** Outside ~/.rivetos, so not in the state tarball and not moved. */
      external: boolean
      /** The pre-migration copy (sqliteBackupPath) exists. */
      backupExists: boolean
    }
  | { kind: 'none' }
  | { kind: 'unreadable'; reason: string }

export type BinarySource =
  | { source: 'local'; rh: string; migrate: string; rhKind: PathKind; migrateKind: PathKind }
  | { source: 'release'; tag?: string }

export interface NodeFacts {
  home: string
  user: string
  uid: number
  platform: string
  arch: string
  /** ~/.rivetos */
  legacy: PathKind
  legacyTarget?: string
  /** ~/.rivethub */
  hub: PathKind
  configPath: string
  configExists: boolean
  memory: MemoryFacts
  tsUnit: UnitScope
  tsActive: boolean
  /** User= of a system rivetos.service ('root' when unset). */
  tsUnitUser?: string
  hubUnit: UnitScope
  canRoot: boolean
  /** This process runs inside rivetos.service — stopping it would kill us. */
  insideTsService: boolean
  /** Paths the migration must write but cannot (labels, with owner). */
  ownershipBlockers: string[]
  binary: BinarySource
  /** Where the binaries are installed (and the unit's ExecStart points). */
  installedRh: string
  installedMigrate: string
  /** `rh config validate` result, when an rh binary was available to run. */
  validate?: RunResult
  /** Bash condition: the gateway answers /healthz on this node. */
  healthCheck: string
  gatewayPort: number
  /** The TS gateway answers right now. */
  gatewayAnswers: boolean
  /** ~/.rivetos/memory.sqlite (the PGlite import target) exists. */
  sqliteTargetExists: boolean
  /** Sizes for the free-space check; a field is undefined when it could not be measured. */
  disk: DiskFacts
  scope: ScopeContext
}

export interface DiskFacts {
  /** Bytes under ~/.rivetos (the backup tarball is at most about this). */
  stateBytes?: number
  /** Free bytes on the home filesystem (backup, dump and import land there). */
  homeFree?: number
  /** Bytes in the PGlite data directory (dump + SQLite import headroom). */
  pgliteBytes?: number
  /** Bytes of an external SQLite file and its -wal/-shm (copied aside). */
  sqliteBytes?: number
  /** Free bytes where the external SQLite file lives. */
  sqliteFree?: number
}

export const SQLITE_TARGET = 'memory.sqlite'

/** Pre-migration copy of an external SQLite file (plus -wal/-shm), restored on rollback. */
export function sqliteBackupPath(path: string): string {
  return `${path}.pre-rivethub`
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/** Bash condition that is true when /healthz answers 200 over https or http. */
export function healthCheckCommand(host: string, port: number): string {
  const target = `${host}:${String(port)}/healthz`
  const probe = (scheme: string): string =>
    `[ "$(curl -ks -m 3 -o /dev/null -w '%{http_code}' ${scheme}://${target})" = 200 ]`
  return `${probe('https')} || ${probe('http')}`
}

function readEnvFile(host: Host, path: string): Record<string, string> {
  const text = host.readText(path)
  return text ? parseRivetEnv(text) : {}
}

export function detectMemory(
  rawConfig: string | undefined,
  host: Host,
  envFile: Record<string, string>,
): MemoryFacts {
  if (rawConfig === undefined) return { kind: 'none' }
  let config: RivetConfig
  try {
    config = resolveEnvVars((parseYaml(rawConfig) ?? {}) as RivetConfig)
  } catch (err: unknown) {
    return { kind: 'unreadable', reason: (err as Error).message }
  }
  const embedded = resolveEmbeddedPg(config, host.home)
  if (embedded) {
    const lockText = host.readText(join(embedded.dataDir, 'rivetos-owner.lock'))
    let lockPid: number | undefined
    if (lockText) {
      try {
        const parsed = JSON.parse(lockText) as { pid?: unknown }
        if (typeof parsed.pid === 'number') lockPid = parsed.pid
      } catch {
        // unreadable lock: treated as absent
      }
    }
    const lockAlive =
      lockPid !== undefined && host.run(`kill -0 ${String(lockPid)} 2>/dev/null`).code === 0
    return { kind: 'pglite', dataDir: embedded.dataDir, lockPid, lockAlive }
  }
  const memory = config.memory as Record<string, unknown> | undefined
  const sqlite = memory?.sqlite as { path?: unknown } | undefined
  if (sqlite && typeof sqlite.path === 'string' && sqlite.path.trim() !== '') {
    const path = expandHome(sqlite.path.trim(), host.home)
    const inState = [join(host.home, '.rivetos'), join(host.home, '.rivethub')].some((root) =>
      path.startsWith(`${root}/`),
    )
    return {
      kind: 'sqlite',
      path,
      exists: host.kind(path) === 'file',
      external: !inState,
      backupExists: host.kind(sqliteBackupPath(path)) !== 'missing',
    }
  }
  const pg = memory?.postgres as { connection_string?: unknown } | undefined
  const fromConfig = typeof pg?.connection_string === 'string' ? pg.connection_string.trim() : ''
  const fromFile = Object.hasOwn(envFile, 'RIVETOS_PG_URL') ? envFile.RIVETOS_PG_URL.trim() : ''
  const url = fromConfig || host.env.RIVETOS_PG_URL?.trim() || fromFile
  if (url) return { kind: 'postgres', url }
  return { kind: 'none' }
}

/** Leading integer of the last output line of a du / df command. */
function bytesFrom(host: Host, cmd: string): number | undefined {
  const res = host.run(cmd, { timeoutMs: 120_000 })
  if (res.code !== 0) return undefined
  const m = /^(\d+)/.exec(res.stdout.trim().split('\n').slice(-1)[0]?.trim() ?? '')
  return m ? Number(m[1]) : undefined
}

export function probeDisk(host: Host, legacy: string, memory: MemoryFacts): DiskFacts {
  const du = (paths: string[]): number | undefined =>
    bytesFrom(host, `du -scb ${paths.map(shellArg).join(' ')} 2>/dev/null | tail -n 1`)
  const free = (path: string): number | undefined =>
    bytesFrom(host, `df -P -B1 ${shellArg(path)} 2>/dev/null | awk 'NR==2 {print $4}'`)
  const disk: DiskFacts = {
    stateBytes: host.kind(legacy) === 'dir' ? du([legacy]) : undefined,
    homeFree: free(host.home),
  }
  if (memory.kind === 'pglite' && host.kind(memory.dataDir) === 'dir') {
    disk.pgliteBytes = du([memory.dataDir])
  }
  if (memory.kind === 'sqlite' && memory.external && memory.exists) {
    const files = ['', '-wal', '-shm']
      .map((suffix) => memory.path + suffix)
      .filter((p) => host.kind(p) === 'file')
    disk.sqliteBytes = du(files)
    disk.sqliteFree = free(dirname(memory.path))
  }
  return disk
}

function unitScope(host: Host, unit: string, scope: ScopeContext): UnitScope {
  if (host.run(`systemctl cat ${unit} >/dev/null 2>&1`).code === 0) return 'system'
  if (host.run(`${systemctl('user', `cat ${unit}`, scope)} >/dev/null 2>&1`).code === 0) {
    return 'user'
  }
  return 'none'
}

function ownershipBlockers(host: Host, legacy: string, memory: MemoryFacts): string[] {
  const blockers: string[] = []
  const check = (path: string, label: string): void => {
    const kind = host.kind(path)
    if (kind === 'missing') return
    if (!host.writable(path)) {
      const owner = host.ownerUid(path)
      blockers.push(`${label} (owner ${owner === 0 ? 'root' : `uid=${String(owner)}`})`)
    }
  }
  // The rename ~/.rivetos → ~/.rivethub needs the home directory writable.
  check(host.home, host.home)
  check(legacy, legacy)
  check(join(legacy, 'config.yaml'), join(legacy, 'config.yaml'))
  check(join(legacy, '.env'), join(legacy, '.env'))
  check(join(host.home, '.local', 'bin'), join(host.home, '.local', 'bin'))
  if (memory.kind === 'pglite') check(memory.dataDir, memory.dataDir)
  if (memory.kind === 'sqlite') check(dirname(memory.path), dirname(memory.path))
  if (host.uid === 0 && host.ownerUid(legacy) !== undefined && host.ownerUid(legacy) !== 0) {
    blockers.push(
      `${legacy} belongs to uid=${String(host.ownerUid(legacy))} but this runs as root — run as the install owner`,
    )
  }
  return blockers
}

export function probeNode(host: Host, opts: MigrateOptions): NodeFacts {
  const legacyPath = join(host.home, '.rivetos')
  const hubPath = join(host.home, '.rivethub')
  // After RivetHub moved the state but before the link exists, the config
  // lives under ~/.rivethub (rollback reads it there).
  const stateRoot =
    host.kind(legacyPath) === 'missing' && host.kind(hubPath) === 'dir' ? hubPath : legacyPath
  const configPath = join(stateRoot, 'config.yaml')
  const scope: ScopeContext = { uid: host.uid, runtimeDir: host.env.XDG_RUNTIME_DIR }
  const rawConfig = host.readText(configPath)
  const envFile = readEnvFile(host, join(stateRoot, '.env'))
  const memory = detectMemory(rawConfig, host, envFile)

  const tsUnit = unitScope(host, TS_UNIT, scope)
  const tsActive =
    tsUnit !== 'none' &&
    host.run(systemctl(tsUnit, `is-active --quiet ${TS_UNIT}`, scope)).code === 0
  const tsUnitUser =
    tsUnit === 'system'
      ? host.run(`systemctl show ${TS_UNIT} -p User --value`).stdout.trim() || 'root'
      : undefined
  const hubUnit = unitScope(host, HUB_UNIT, scope)
  const canRoot = host.uid === 0 || host.run('sudo -n true 2>/dev/null').code === 0
  const insideTsService = (host.readText('/proc/self/cgroup') ?? '').includes(`/${TS_UNIT}`)

  const installedRh = join(host.home, '.local', 'bin', 'rh')
  const installedMigrate = join(host.home, '.local', 'bin', 'rivethub-migrate')
  const binary: BinarySource = opts.binary
    ? {
        source: 'local',
        rh: opts.binary,
        migrate: join(dirname(opts.binary), 'rivethub-migrate'),
        rhKind: host.kind(opts.binary),
        migrateKind: host.kind(join(dirname(opts.binary), 'rivethub-migrate')),
      }
    : { source: 'release', tag: opts.version }

  // Validate with whatever rh is already here; a downloaded one validates in
  // its own step. `rh config validate` reads ~/.rivetos/config.yaml while
  // ~/.rivethub does not exist and never moves state.
  const validator =
    binary.source === 'local' && binary.rhKind === 'file'
      ? binary.rh
      : host.kind(installedRh) === 'file'
        ? installedRh
        : undefined
  const validate =
    validator && rawConfig !== undefined
      ? host.run(`${shellArg(validator)} config validate`, { timeoutMs: 60_000 })
      : undefined

  const den = parseDenSettings(rawConfig)
  const healthCheck = healthCheckCommand(denProbeHost(den.host), den.port)

  return {
    home: host.home,
    user: host.user,
    uid: host.uid,
    platform: host.platform,
    arch: host.arch,
    legacy: host.kind(legacyPath),
    legacyTarget: host.readLink(legacyPath),
    hub: host.kind(hubPath),
    configPath,
    configExists: rawConfig !== undefined,
    memory,
    tsUnit,
    tsActive,
    tsUnitUser,
    hubUnit,
    canRoot,
    insideTsService,
    ownershipBlockers: ownershipBlockers(host, legacyPath, memory),
    binary,
    installedRh,
    installedMigrate,
    validate,
    healthCheck,
    gatewayPort: den.port,
    gatewayAnswers: host.run(healthCheck, { timeoutMs: 10_000 }).code === 0,
    sqliteTargetExists: host.kind(join(stateRoot, SQLITE_TARGET)) !== 'missing',
    disk: opts.rollback ? {} : probeDisk(host, legacyPath, memory),
    scope,
  }
}
