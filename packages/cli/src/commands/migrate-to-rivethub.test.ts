/**
 * rivetos migrate-to-rivethub — preflight refusals, dry-run output, the
 * executed step order, automatic recovery and rollback planning, all against
 * an in-memory Host (no systemd, sudo, network or filesystem is touched).
 */

import { describe, expect, it } from 'vitest'
import { posix } from 'node:path'
import type { Host, PathKind, RunOptions, RunResult } from './migrate-to-rivethub/host.js'
import { migrateToRivethub } from './migrate-to-rivethub.js'
import { parseMigrateArgs } from './migrate-to-rivethub/options.js'
import { planMigration, planRollback, stampOf } from './migrate-to-rivethub/plan.js'
import { probeNode } from './migrate-to-rivethub/probe.js'
import { renderHubUnit } from './migrate-to-rivethub/unit.js'
import { sha256Hex } from './migrate-to-rivethub/release.js'

interface Scenario {
  uid?: number
  user?: string
  home?: string
  tsUnit?: 'system' | 'user' | 'none'
  hubUnit?: 'system' | 'user' | 'none'
  tsUnitUser?: string
  sudo?: boolean
  config?: string | null
  env?: Record<string, string>
  envFile?: string
  /** Extra paths and their kinds. */
  paths?: Record<string, PathKind>
  readonly?: string[]
  validateCode?: number
  validateOutput?: string
  /** Command substrings that fail with exit 1. */
  failOn?: string[]
  insideTsService?: boolean
  arch?: string
  /** du / df results (bytes); unset means the probe output is unreadable. */
  disk?: { state?: number; free?: number; pglite?: number }
  /** Pids that `kill -0` reports alive. */
  alivePids?: number[]
}

interface FakeHost extends Host {
  calls: string[]
  /** Commands and filesystem changes, in the order they happened. */
  events: string[]
  envs: (Record<string, string> | undefined)[]
  logs: string[]
  errors: string[]
  writes: string[]
  paths: Map<string, PathKind>
  gatewayUp: boolean
  /** The trapped-signal handler while one is installed. */
  interruptHandler?: (signal: string) => void
  /** Deliver SIGINT/SIGTERM/SIGHUP when a command containing `needle` runs. */
  interruptOn?: { needle: string; signal: string }
  output(): string
}

function fakeHost(s: Scenario = {}): FakeHost {
  const home = s.home ?? '/home/rivet'
  const uid = s.uid ?? 1000
  const user = s.user ?? 'rivet'
  const tsUnit = s.tsUnit ?? 'system'
  const hubUnit = s.hubUnit ?? 'none'
  const legacy = `${home}/.rivetos`
  const hub = `${home}/.rivethub`
  const paths = new Map<string, PathKind>([
    [home, 'dir'],
    [legacy, 'dir'],
    [`${home}/.local/bin`, 'dir'],
  ])
  const texts = new Map<string, string>()
  const config =
    s.config === undefined
      ? 'memory:\n  postgres:\n    connection_string: postgres://u:s3cret@db.example/rivet\n'
      : s.config
  if (config !== null) {
    paths.set(`${legacy}/config.yaml`, 'file')
    texts.set(`${legacy}/config.yaml`, config)
  }
  if (s.envFile !== undefined) {
    paths.set(`${legacy}/.env`, 'file')
    texts.set(`${legacy}/.env`, s.envFile)
  }
  if (s.insideTsService) texts.set('/proc/self/cgroup', '0::/system.slice/rivetos.service\n')
  for (const [p, k] of Object.entries(s.paths ?? {})) paths.set(p, k)
  const links = new Map<string, string>()
  let clock = Date.parse('2026-10-16T12:00:00Z')

  const host: FakeHost = {
    pid: 4242,
    home,
    uid,
    user,
    platform: 'linux',
    arch: s.arch ?? 'x64',
    env: { ...(s.env ?? {}) },
    calls: [],
    events: [],
    envs: [],
    logs: [],
    errors: [],
    writes: [],
    paths,
    gatewayUp: tsUnit !== 'none',
    output() {
      return [...host.logs, ...host.errors].join('\n')
    },
    run(cmd: string, opts?: RunOptions): RunResult {
      host.calls.push(cmd)
      host.events.push(cmd)
      host.envs.push(opts?.env)
      if (host.interruptOn && cmd.includes(host.interruptOn.needle)) {
        if (!host.interruptHandler) throw new Error(`no trap installed at "${cmd}"`)
        host.interruptHandler(host.interruptOn.signal)
      }
      const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
      const no: RunResult = { code: 1, stdout: '', stderr: '' }
      if (s.failOn?.some((f) => cmd.includes(f))) return { code: 1, stdout: '', stderr: 'boom' }
      const killed = /^kill -0 (\d+)/.exec(cmd)
      if (killed) return (s.alivePids ?? []).includes(Number(killed[1])) ? ok() : no
      if (cmd.startsWith('du -scb')) {
        const pglite = cmd.includes('pglite') && !cmd.includes(`${legacy} `)
        const bytes = pglite ? s.disk?.pglite : s.disk?.state
        return bytes === undefined ? ok() : ok(`${String(bytes)}\ttotal`)
      }
      if (cmd.startsWith('df ')) return s.disk?.free === undefined ? ok() : ok(String(s.disk.free))
      if (cmd.startsWith('systemctl cat rivetos.service')) return tsUnit === 'system' ? ok() : no
      if (cmd.includes('systemctl --user cat rivetos.service')) return tsUnit === 'user' ? ok() : no
      if (cmd.startsWith('systemctl cat rivethub.service')) return hubUnit === 'system' ? ok() : no
      if (cmd.includes('systemctl --user cat rivethub.service')) {
        return hubUnit === 'user' ? ok() : no
      }
      if (cmd.startsWith('systemctl show rivetos.service')) return ok(s.tsUnitUser ?? user)
      if (cmd.startsWith('sudo -n true')) return s.sudo === false ? no : ok()
      if (cmd.includes('config validate')) {
        return {
          code: s.validateCode ?? 0,
          stdout: s.validateOutput ?? 'config ok',
          stderr: '',
        }
      }
      if (cmd.includes('/healthz')) return host.gatewayUp ? ok() : no
      if (cmd.includes('disable --now rivetos.service')) host.gatewayUp = false
      if (cmd.includes('enable --now rivetos.service')) host.gatewayUp = true
      if (cmd.includes('disable --now rivethub.service')) host.gatewayUp = false
      if (cmd.includes('start rivethub.service')) {
        // RivetHub refuses to start while ~/.rivetos is still a directory
        // (it would adopt it itself); the plan moves and links it first.
        if (paths.get(legacy) !== 'symlink' || paths.get(hub) !== 'dir') return no
        host.gatewayUp = true
      }
      if (cmd.endsWith(' status')) return ok('RivetHub gateway healthy')
      return ok()
    },
    kind: (p) => paths.get(p) ?? 'missing',
    readText: (p) => {
      const real = p.startsWith(`${legacy}/`) && paths.get(legacy) === 'symlink'
      const key = real ? p.replace(legacy, hub) : p
      return texts.get(key) ?? texts.get(p)
    },
    readLink: (p) => links.get(p),
    writable: (p) => !(s.readonly ?? []).includes(p),
    ownerUid: () => uid,
    mkdirp: (p) => {
      host.writes.push(`mkdir ${p}`)
      host.events.push(`mkdir ${p}`)
      paths.set(p, 'dir')
    },
    writeFile: (p, data) => {
      host.writes.push(`write ${p}`)
      host.events.push(`write ${p}`)
      paths.set(p, 'file')
      texts.set(p, typeof data === 'string' ? data : new TextDecoder().decode(data))
    },
    createExclusive: (p, data) => {
      if ((paths.get(p) ?? 'missing') !== 'missing') return false
      host.writes.push(`lock ${p}`)
      paths.set(p, 'file')
      texts.set(p, data)
      return true
    },
    copyExecutable: (from, to) => {
      host.writes.push(`copy ${from} ${to}`)
      host.events.push(`copy ${from} ${to}`)
      paths.set(to, 'file')
    },
    rename: (from, to) => {
      host.writes.push(`rename ${from} ${to}`)
      host.events.push(`rename ${from} ${to}`)
      const kind = paths.get(from) ?? 'missing'
      paths.delete(from)
      paths.set(to, kind)
      for (const [p, k] of [...paths]) {
        if (p.startsWith(`${from}/`)) {
          paths.delete(p)
          paths.set(posix.join(to, p.slice(from.length + 1)), k)
        }
      }
    },
    symlink: (target, p) => {
      host.writes.push(`symlink ${target} ${p}`)
      host.events.push(`symlink ${target} ${p}`)
      paths.set(p, 'symlink')
      links.set(p, target)
    },
    remove: (p) => {
      host.writes.push(`remove ${p}`)
      host.events.push(`remove ${p}`)
      paths.delete(p)
      texts.delete(p)
      links.delete(p)
    },
    download: () => Promise.reject(new Error('no network in tests')),
    dumpPglite: (_config, out) => {
      host.writes.push(`dump ${out}`)
      host.events.push(`dump ${out}`)
      paths.set(out, 'file')
      return Promise.resolve({ ros_conversations: 2, ros_messages: 5 })
    },
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms
      return Promise.resolve()
    },
    log: (line) => host.logs.push(line),
    error: (line) => host.errors.push(line),
    onInterrupt: (handler) => {
      host.interruptHandler = handler
      return () => {
        host.interruptHandler = undefined
      }
    },
  }
  return host
}

const PGLITE = 'memory:\n  postgres:\n    embedded:\n      data_dir: ~/.rivetos/pglite\n'
const MUTATING =
  /disable --now|enable --now|install -m|daemon-reload|tar czf|rivethub-migrate (postgres|sqlite)|start rivethub/

function facts(s: Scenario = {}, args: string[] = []) {
  const host = fakeHost(s)
  const parsed = parseMigrateArgs(args)
  if (!parsed.ok) throw new Error(parsed.error)
  return { host, facts: probeNode(host, parsed.opts), opts: parsed.opts }
}

function refusalsFor(s: Scenario, args: string[] = []): string[] {
  const { facts: f, opts } = facts(s, args)
  return planMigration(f, opts, 'STAMP').refusals
}

describe('parseMigrateArgs', () => {
  it('accepts the documented flags', () => {
    const r = parseMigrateArgs(['--dry-run', '--rollback', '--mesh', '--version', 'v0.1.0'])
    expect(r).toEqual({
      ok: true,
      opts: expect.objectContaining({
        dryRun: true,
        rollback: true,
        mesh: true,
        version: 'v0.1.0',
      }) as unknown,
    })
  })

  it('resolves a relative --binary against cwd', () => {
    const r = parseMigrateArgs(['--binary', 'bin/rh'], '/work')
    expect(r.ok && r.opts.binary).toBe('/work/bin/rh')
  })

  it('rejects unknown flags, missing values, unsafe values and --binary with --version', () => {
    expect(parseMigrateArgs(['--frobnicate']).ok).toBe(false)
    expect(parseMigrateArgs(['--binary']).ok).toBe(false)
    expect(parseMigrateArgs(['--version', 'v1;rm -rf /']).ok).toBe(false)
    expect(parseMigrateArgs(['--binary', '/x/rh', '--version', 'v1']).ok).toBe(false)
  })
})

describe('preflight refusals', () => {
  it('passes for a healthy Postgres node with a system unit and sudo', () => {
    expect(refusalsFor({})).toEqual([])
  })

  it('reports an already-migrated node as done, not refused', () => {
    const { facts: f, opts } = facts({
      hubUnit: 'system',
      paths: { '/home/rivet/.rivetos': 'symlink', '/home/rivet/.rivethub': 'dir' },
    })
    const plan = planMigration(f, opts, 'S')
    expect(plan.done).toMatch(/Already migrated/)
    expect(plan.steps).toEqual([])
  })

  it('does not call a linked node migrated when rivethub.service is missing', () => {
    const { facts: f, opts } = facts({
      paths: { '/home/rivet/.rivetos': 'symlink', '/home/rivet/.rivethub': 'dir' },
    })
    const plan = planMigration(f, opts, 'S')
    expect(plan.done).toBeUndefined()
    expect(plan.refusals.join('\n')).toMatch(/no rivethub\.service is installed.*--rollback/)
  })

  it('refuses when ~/.rivethub already exists', () => {
    expect(refusalsFor({ paths: { '/home/rivet/.rivethub': 'dir' } }).join('\n')).toMatch(
      /~\/\.rivethub already exists/,
    )
  })

  it('refuses a system unit without passwordless sudo', () => {
    expect(refusalsFor({ sudo: false }).join('\n')).toMatch(/system unit.*sudo/)
  })

  it('refuses when the unit runs as another user', () => {
    expect(refusalsFor({ tsUnitUser: 'agent' }).join('\n')).toMatch(/runs as agent/)
  })

  it('refuses to run inside rivetos.service', () => {
    expect(refusalsFor({ insideTsService: true }).join('\n')).toMatch(/inside rivetos\.service/)
  })

  it('refuses when no unit exists but a runtime still answers', () => {
    const r = refusalsFor({ tsUnit: 'none' }, [])
    expect(r).toEqual([])
    const host = fakeHost({ tsUnit: 'none' })
    host.gatewayUp = true
    const parsed = parseMigrateArgs([])
    if (!parsed.ok) throw new Error('parse')
    const plan = planMigration(probeNode(host, parsed.opts), parsed.opts, 'S')
    expect(plan.refusals.join('\n')).toMatch(/gateway answers/)
  })

  it('refuses an existing rivethub.service', () => {
    expect(refusalsFor({ hubUnit: 'system' }).join('\n')).toMatch(/already installed/)
  })

  it('refuses unwritable state with the owner in the message', () => {
    expect(refusalsFor({ readonly: ['/home/rivet/.rivetos'] }).join('\n')).toMatch(
      /Not writable by rivet: \/home\/rivet\/\.rivetos \(owner uid=1000\)/,
    )
  })

  it('refuses a config RivetHub rejects, quoting the validator', () => {
    const r = refusalsFor(
      {
        paths: { '/home/rivet/.local/bin/rh': 'file' },
        validateCode: 1,
        validateOutput: 'bad key x',
      },
      [],
    )
    expect(r.join('\n')).toMatch(/rh config validate rejected[\s\S]*bad key x/)
  })

  it('refuses a release download on an unsupported architecture', () => {
    expect(refusalsFor({ arch: 'arm64' }).join('\n')).toMatch(/--binary/)
  })

  it('refuses --binary without rivethub-migrate next to it', () => {
    const r = refusalsFor({ paths: { '/opt/rh/rh': 'file' } }, ['--binary', '/opt/rh/rh'])
    expect(r.join('\n')).toMatch(/rivethub-migrate must sit next to rh/)
  })

  it('refuses a PGlite import when memory.sqlite already exists', () => {
    const r = refusalsFor({
      config: PGLITE,
      paths: { '/home/rivet/.rivetos/memory.sqlite': 'file' },
    })
    expect(r.join('\n')).toMatch(/memory\.sqlite already exists/)
  })
})

describe('free space', () => {
  const MiB = 1024 * 1024

  it('refuses when the backup does not fit in home', () => {
    const r = refusalsFor({ disk: { state: 900 * MiB, free: 1000 * MiB } })
    expect(r.join('\n')).toMatch(/Not enough free space in \/home\/rivet: the backup needs/)
  })

  it('passes with room for the backup', () => {
    expect(refusalsFor({ disk: { state: 100 * MiB, free: 10_000 * MiB } })).toEqual([])
  })

  it('counts the PGlite dump and import', () => {
    const disk = { state: 100 * MiB, pglite: 1000 * MiB, free: 1500 * MiB }
    expect(refusalsFor({ disk }).join('\n')).toEqual('')
    const paths = { '/home/rivet/.rivetos/pglite': 'dir' } as const
    expect(refusalsFor({ config: PGLITE, disk, paths }).join('\n')).toMatch(
      /backup, PGlite dump and SQLite import need about 2\.3 GiB/,
    )
  })

  it('notes, rather than refuses, when du/df cannot be read', async () => {
    const host = fakeHost({})
    expect(await migrateToRivethub(['--dry-run'], host)).toBe(0)
    expect(host.output()).toMatch(/Could not measure the free space/)
  })
})

describe('run lock', () => {
  const LOCK = '/home/rivet/.cache/rivethub-migrate/migrate.lock'
  const bin = { '/opt/rh/rh': 'file', '/opt/rh/rivethub-migrate': 'file' } as const

  function locked(pid: number, alive: boolean): FakeHost {
    const host = fakeHost({ paths: { ...bin }, alivePids: alive ? [pid] : [] })
    host.createExclusive(LOCK, JSON.stringify({ pid }), 0o600)
    host.writes.length = 0
    return host
  }

  it('takes the lock for the run and releases it', async () => {
    const host = fakeHost({ paths: { ...bin } })
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(0)
    expect(host.writes.slice(0, 2)).toEqual([
      `mkdir /home/rivet/.cache/rivethub-migrate`,
      `lock ${LOCK}`,
    ])
    expect(host.writes).toContain(`remove ${LOCK}`)
    expect(host.paths.get(LOCK)).toBeUndefined()
  })

  it('refuses while another run holds it, for a migration, a rollback and a dry run', async () => {
    for (const args of [['--binary', '/opt/rh/rh'], ['--rollback'], ['--dry-run']]) {
      const host = locked(777, true)
      expect(await migrateToRivethub(args, host)).toBe(2)
      expect(host.errors.join('\n')).toMatch(/pid 777\) is in progress/)
      expect(host.calls.filter((c) => MUTATING.test(c))).toEqual([])
      expect(host.paths.get(LOCK)).toBe('file')
    }
  })

  it('takes over a stale lock', async () => {
    const host = locked(777, false)
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(0)
    expect(host.output()).toMatch(/Removing a stale lock/)
    expect(host.paths.get(LOCK)).toBeUndefined()
  })
})

describe('dry run', () => {
  it('prints the plan, redacts the database URL and changes nothing', async () => {
    const host = fakeHost({})
    const code = await migrateToRivethub(['--dry-run'], host)
    expect(code).toBe(0)
    const out = host.output()
    expect(out).toContain('Preflight passed')
    expect(out).toContain(
      'rivethub-migrate status postgres --config /home/rivet/.rivetos/config.yaml',
    )
    expect(out).toContain('sudo -n systemctl disable --now rivetos.service')
    expect(out).toContain('tar czf /home/rivet/rivetos-state-')
    expect(out).toContain('RIVETHUB_PG_URL=<memory.postgres URL>')
    expect(out).toContain(
      'mv /home/rivet/.rivetos /home/rivet/.rivethub && ln -s /home/rivet/.rivethub /home/rivet/.rivetos',
    )
    expect(out).not.toMatch(/Wait for RivetHub/)
    expect(out).toContain('api.github.com/repos/philbert440/rivethub-runtime/releases/latest')
    expect(out).toContain('releases/download/<tag>/rh')
    expect(out).toContain('nothing was changed')
    expect(out).not.toContain('s3cret')
    expect(host.writes).toEqual([])
    expect(host.calls.filter((c) => MUTATING.test(c))).toEqual([])
  })

  it('plans the PGlite dump and the one-time SQLite import', async () => {
    const host = fakeHost({ config: PGLITE })
    expect(await migrateToRivethub(['--dry-run', '--version', 'v0.2.0'], host)).toBe(0)
    const out = host.output()
    expect(out).toMatch(
      /PGlite \/home\/rivet\/\.rivetos\/pglite → .*pglite-memory-\d{8}T\d{6}Z\.sql/,
    )
    expect(out).toMatch(
      /rivethub-migrate sqlite --path \/home\/rivet\/\.rivetos\/memory\.sqlite --import-pg-dump/,
    )
    expect(out).toContain('releases/download/v0.2.0/rh')
    expect(out).not.toContain('api.github.com')
    expect(out).not.toContain('status postgres')
  })

  it('shell-quotes paths under a home with spaces', async () => {
    const host = fakeHost({ home: '/srv/rivet home' })
    expect(await migrateToRivethub(['--dry-run'], host)).toBe(0)
    const out = host.output()
    expect(out).toContain(
      "tar czf '/srv/rivet home/rivetos-state-20261016T120000Z.tgz' -C '/srv/rivet home' .rivetos",
    )
    expect(out).toContain("mv '/srv/rivet home/.rivetos' '/srv/rivet home/.rivethub'")
    expect(out).toContain("--config '/srv/rivet home/.rivetos/config.yaml'")
    expect(out).toContain(
      "sudo -n install -m 0644 '/srv/rivet home/.rivethub/migrate/rivethub.service'",
    )
  })

  it('uses the user manager for a user unit', async () => {
    const host = fakeHost({ tsUnit: 'user' })
    expect(await migrateToRivethub(['--dry-run'], host)).toBe(0)
    const out = host.output()
    expect(out).toContain(
      'XDG_RUNTIME_DIR=/run/user/1000 systemctl --user disable --now rivetos.service',
    )
    expect(out).toContain('/home/rivet/.config/systemd/user/rivethub.service')
    expect(out).not.toContain('sudo -n')
  })

  it('prints refusals and exits 2', async () => {
    const host = fakeHost({ sudo: false })
    expect(await migrateToRivethub(['--dry-run'], host)).toBe(2)
    expect(host.errors.join('\n')).toMatch(/refused by the preflight/)
  })

  it('exits 2 on bad arguments', async () => {
    const host = fakeHost({})
    expect(await migrateToRivethub(['--nope'], host)).toBe(2)
  })
})

describe('migration run', () => {
  it('runs the steps in order and links the moved state', async () => {
    const host = fakeHost({ paths: { '/opt/rh/rh': 'file', '/opt/rh/rivethub-migrate': 'file' } })
    const code = await migrateToRivethub(['--binary', '/opt/rh/rh'], host)
    expect(host.errors).toEqual([])
    expect(code).toBe(0)
    const order = [
      'config validate',
      'status postgres',
      'disable --now rivetos.service',
      'tar czf',
      'rivethub-migrate postgres',
      'enable rivethub.service',
      'start rivethub.service',
    ].map((needle) => host.calls.findIndex((c) => c.includes(needle)))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The state is moved and linked after the backup and before the unit is
    // installed, so ~/.rivetos never disappears while RivetHub starts.
    const ev = [
      'tar czf',
      'remove /home/rivet/.rivetos/rivetos.pid',
      'rename /home/rivet/.rivetos /home/rivet/.rivethub',
      'symlink /home/rivet/.rivethub /home/rivet/.rivetos',
      'enable rivethub.service',
      'start rivethub.service',
      'is-active --quiet rivethub.service',
    ].map((needle) => host.events.findIndex((e) => e.includes(needle)))
    expect(ev.every((i) => i >= 0)).toBe(true)
    expect([...ev].sort((a, b) => a - b)).toEqual(ev)
    expect(host.paths.get('/home/rivet/.rivetos')).toBe('symlink')
    expect(host.paths.get('/home/rivet/.rivethub')).toBe('dir')
    expect(host.writes).toContain('copy /opt/rh/rh /home/rivet/.local/bin/rh')
    // The database URL reaches rivethub-migrate through the environment only.
    const i = host.calls.findIndex((c) => c.includes('rivethub-migrate postgres'))
    expect(host.envs[i]).toEqual({ RIVETHUB_PG_URL: 'postgres://u:s3cret@db.example/rivet' })
    expect(host.calls.join('\n')).not.toContain('s3cret')
  })

  it('resolves the latest tag once and downloads both binaries from it', async () => {
    const host = fakeHost({})
    const rh = new TextEncoder().encode('rh-bytes')
    const mig = new TextEncoder().encode('migrate-bytes')
    const urls: string[] = []
    const files: Record<string, Uint8Array> = {
      'releases/latest': new TextEncoder().encode('{"tag_name":"v0.3.1"}'),
      '/rh': rh,
      '/rh.sha256': new TextEncoder().encode(`${sha256Hex(rh)}  rh\n`),
      '/rivethub-migrate': mig,
      '/rivethub-migrate.sha256': new TextEncoder().encode(sha256Hex(mig)),
    }
    host.download = (url) => {
      urls.push(url)
      const key = Object.keys(files).find((k) => url.endsWith(k))
      return key ? Promise.resolve(files[key]) : Promise.reject(new Error(url))
    }
    expect(await migrateToRivethub([], host)).toBe(0)
    expect(urls[0]).toMatch(/api\.github\.com\/.*\/releases\/latest$/)
    expect(urls.slice(1)).toEqual(
      ['rh', 'rh.sha256', 'rivethub-migrate', 'rivethub-migrate.sha256'].map(
        (a) => `https://github.com/philbert440/rivethub-runtime/releases/download/v0.3.1/${a}`,
      ),
    )
    expect(host.output()).toContain('v0.3.1: checksums verified')
  })

  it('stages a PGlite dump and imports it before starting RivetHub', async () => {
    const host = fakeHost({
      config: PGLITE,
      paths: { '/opt/rh/rh': 'file', '/opt/rh/rivethub-migrate': 'file' },
    })
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(0)
    const dump = host.writes.findIndex((w) => w.startsWith('dump '))
    expect(dump).toBeGreaterThan(-1)
    const imported = host.calls.findIndex((c) => c.includes('--import-pg-dump'))
    const started = host.calls.findIndex((c) => c.includes('start rivethub.service'))
    expect(imported).toBeGreaterThan(-1)
    expect(imported).toBeLessThan(started)
  })

  it('puts RivetOS back when a switch step fails', async () => {
    const host = fakeHost({
      failOn: ['rivethub-migrate postgres'],
      paths: { '/opt/rh/rh': 'file', '/opt/rh/rivethub-migrate': 'file' },
    })
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(1)
    expect(host.calls.some((c) => c.includes('enable --now rivetos.service'))).toBe(true)
    expect(host.calls.some((c) => c.includes('start rivethub.service'))).toBe(false)
    expect(host.errors.join('\n')).toMatch(/RivetOS runtime is back/)
    expect(host.paths.get('/home/rivet/.rivetos')).toBe('dir')
  })

  it('reports a refusal (exit 2) when validation fails after the download step', async () => {
    const host = fakeHost({
      validateCode: 1,
      paths: { '/opt/rh/rh': 'file', '/opt/rh/rivethub-migrate': 'file' },
    })
    // The preflight validates with --binary already, so this is a preflight refusal.
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(2)
    expect(host.calls.some((c) => c.includes('disable --now'))).toBe(false)
  })

  it('undoes the move and the link when rivethub.service fails to start', async () => {
    const host = fakeHost({
      failOn: ['start rivethub.service'],
      paths: { '/opt/rh/rh': 'file', '/opt/rh/rivethub-migrate': 'file' },
    })
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(1)
    const at = (needle: string): number => host.events.findIndex((e) => e.includes(needle))
    const failedStart = at('start rivethub.service')
    expect(failedStart).toBeGreaterThan(at('symlink /home/rivet/.rivethub /home/rivet/.rivetos'))
    const order = [
      'disable --now rivethub.service',
      'remove /home/rivet/.rivetos',
      'rename /home/rivet/.rivethub /home/rivet/.rivetos',
      'enable --now rivetos.service',
    ].map((needle) => host.events.findIndex((e, i) => i > failedStart && e.includes(needle)))
    expect(order.every((i) => i > failedStart)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(host.paths.get('/home/rivet/.rivetos')).toBe('dir')
    expect(host.paths.get('/home/rivet/.rivethub')).toBeUndefined()
    expect(host.errors.join('\n')).toMatch(/RivetOS runtime is back/)
  })

  it('undoes the move and the link when RivetHub never becomes healthy', async () => {
    const host = fakeHost({
      failOn: ['is-active --quiet rivethub.service'],
      paths: { '/opt/rh/rh': 'file', '/opt/rh/rivethub-migrate': 'file' },
    })
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(1)
    expect(host.writes).toContain('rename /home/rivet/.rivethub /home/rivet/.rivetos')
    expect(host.paths.get('/home/rivet/.rivetos')).toBe('dir')
    expect(host.calls.some((c) => c.includes('enable --now rivetos.service'))).toBe(true)
    expect(host.errors.join('\n')).toMatch(/RivetOS runtime is back/)
  })
})

describe('external SQLite memory', () => {
  const SQLITE = 'memory:\n  sqlite:\n    path: /data/rivet/memory.sqlite\n'
  const scenario = (extra: Partial<Scenario> = {}): Scenario => ({
    config: SQLITE,
    paths: {
      '/opt/rh/rh': 'file',
      '/opt/rh/rivethub-migrate': 'file',
      '/data/rivet/memory.sqlite': 'file',
      '/data/rivet/memory.sqlite-wal': 'file',
    },
    ...extra,
  })
  /** The fake runs no cp: mark the copies as made when the backup command runs. */
  function copying(host: FakeHost): FakeHost {
    const run = host.run.bind(host)
    host.run = (cmd, o) => {
      const res = run(cmd, o)
      if (cmd.includes('.pre-rivethub') && res.code === 0) {
        host.paths.set('/data/rivet/memory.sqlite.pre-rivethub', 'file')
        host.paths.set('/data/rivet/memory.sqlite.pre-rivethub-wal', 'file')
      }
      return res
    }
    return host
  }

  it('copies the file aside before the in-place schema change', async () => {
    const host = copying(fakeHost(scenario()))
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(0)
    const backup = host.calls.findIndex((c) =>
      c.includes('b=/data/rivet/memory.sqlite.pre-rivethub'),
    )
    const migrate = host.calls.findIndex((c) =>
      c.includes('rivethub-migrate sqlite --path /data/rivet/memory.sqlite'),
    )
    expect(backup).toBeGreaterThan(host.calls.findIndex((c) => c.includes('tar czf')))
    expect(backup).toBeLessThan(migrate)
  })

  it('restores the copy when the migration fails after the schema change', async () => {
    const host = copying(fakeHost(scenario({ failOn: ['start rivethub.service'] })))
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(1)
    expect(host.writes).toContain(
      'rename /data/rivet/memory.sqlite /data/rivet/memory.sqlite.rivethub-20261016T120000Z',
    )
    expect(host.writes).toContain(
      'rename /data/rivet/memory.sqlite.pre-rivethub /data/rivet/memory.sqlite',
    )
    expect(host.writes).toContain(
      'rename /data/rivet/memory.sqlite.pre-rivethub-wal /data/rivet/memory.sqlite-wal',
    )
    expect(host.paths.get('/data/rivet/memory.sqlite.pre-rivethub')).toBeUndefined()
  })

  it('plans the restore on --rollback and leaves an in-tree file to the state move', () => {
    const migrated = {
      hubUnit: 'system' as const,
      paths: {
        '/home/rivet/.rivetos': 'symlink' as const,
        '/home/rivet/.rivethub': 'dir' as const,
      },
    }
    const ext = facts({ ...migrated, config: SQLITE }, ['--rollback']).facts
    expect(planRollback(ext, 'S').steps.map((s) => s.id)).toContain('restore-sqlite')
    const inTree = facts(
      { ...migrated, config: 'memory:\n  sqlite:\n    path: ~/.rivetos/memory.sqlite\n' },
      ['--rollback'],
    ).facts
    expect(planRollback(inTree, 'S').steps.map((s) => s.id)).not.toContain('restore-sqlite')
  })

  it('refuses when a pre-migration copy is already there', () => {
    const r = refusalsFor(
      scenario({
        paths: {
          '/data/rivet/memory.sqlite': 'file',
          '/data/rivet/memory.sqlite.pre-rivethub': 'file',
        },
      }),
    )
    expect(r.join('\n')).toMatch(/memory\.sqlite\.pre-rivethub already exists/)
  })
})

describe('interrupts', () => {
  const bin = { '/opt/rh/rh': 'file', '/opt/rh/rivethub-migrate': 'file' } as const

  it('does not trap signals before the running node changes', async () => {
    const host = fakeHost({ paths: { ...bin } })
    const trapped: Record<string, boolean> = {}
    const run = host.run.bind(host)
    host.run = (cmd, o) => {
      for (const needle of ['status postgres', 'disable --now rivetos.service']) {
        if (cmd.includes(needle)) trapped[needle] = host.interruptHandler !== undefined
      }
      return run(cmd, o)
    }
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(0)
    expect(trapped).toEqual({ 'status postgres': false, 'disable --now rivetos.service': true })
    expect(host.interruptHandler).toBeUndefined()
  })

  it('puts RivetOS back after the current step on SIGHUP, once', async () => {
    const host = fakeHost({ paths: { ...bin } })
    host.interruptOn = { needle: 'tar czf', signal: 'SIGHUP' }
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(1)
    const tar = host.calls.findIndex((c) => c.includes('tar czf'))
    expect(tar).toBeGreaterThan(-1)
    expect(host.calls.some((c) => c.includes('rivethub-migrate postgres'))).toBe(false)
    expect(host.calls.filter((c) => c.includes('enable --now rivetos.service'))).toHaveLength(1)
    expect(host.paths.get('/home/rivet/.rivetos')).toBe('dir')
    expect(host.errors.join('\n')).toMatch(/interrupted \(SIGHUP\); the RivetOS runtime is back/)
    expect(host.interruptHandler).toBeUndefined()
  })

  it('cuts the health wait short and undoes the move', async () => {
    const host = fakeHost({
      paths: { ...bin },
      failOn: ['is-active --quiet rivethub.service'],
    })
    host.interruptOn = { needle: 'is-active --quiet rivethub.service', signal: 'SIGINT' }
    const start = host.now().getTime()
    expect(await migrateToRivethub(['--binary', '/opt/rh/rh'], host)).toBe(1)
    // The 120 s wait stopped at the first poll; recovery's own wait is short.
    expect(host.now().getTime() - start).toBeLessThan(30_000)
    expect(host.output()).toMatch(/interrupted/)
    expect(host.paths.get('/home/rivet/.rivetos')).toBe('dir')
    expect(host.calls.filter((c) => c.includes('enable --now rivetos.service'))).toHaveLength(1)
  })

  it('stops a rollback between steps and says to re-run it', async () => {
    const host = fakeHost({
      hubUnit: 'system',
      paths: { '/home/rivet/.rivetos': 'symlink', '/home/rivet/.rivethub': 'dir' },
    })
    host.interruptOn = { needle: 'disable --now rivethub.service', signal: 'SIGTERM' }
    expect(await migrateToRivethub(['--rollback'], host)).toBe(1)
    expect(host.calls.some((c) => c.includes('enable --now rivetos.service'))).toBe(false)
    expect(host.errors.join('\n')).toMatch(/Rollback interrupted \(SIGTERM\).*--rollback/)
  })
})

describe('rollback planning', () => {
  const migrated: Scenario = {
    hubUnit: 'system',
    paths: { '/home/rivet/.rivetos': 'symlink', '/home/rivet/.rivethub': 'dir' },
  }

  it('plans stop → restore → start → health for a migrated node', () => {
    const { facts: f } = facts(migrated, ['--rollback'])
    const plan = planRollback(f, 'S')
    expect(plan.refusals).toEqual([])
    expect(plan.steps.map((s) => s.id)).toEqual([
      'stop-rivethub',
      'restore-state',
      'start-rivetos',
      'health',
    ])
    expect(plan.notes.join('\n')).toMatch(/ros_\* views/)
  })

  it('parks the RivetHub SQLite file on a PGlite node', () => {
    const { facts: f } = facts({ ...migrated, config: PGLITE }, ['--rollback'])
    expect(planRollback(f, 'S').steps.map((s) => s.id)).toContain('park-sqlite')
  })

  it('says there is nothing to roll back on an unmigrated node', async () => {
    const host = fakeHost({})
    expect(await migrateToRivethub(['--rollback'], host)).toBe(0)
    expect(host.output()).toMatch(/Nothing to roll back/)
  })

  it('refuses when both state directories exist', () => {
    const { facts: f } = facts({ hubUnit: 'system', paths: { '/home/rivet/.rivethub': 'dir' } })
    expect(planRollback(f, 'S').refusals.join('\n')).toMatch(/Both ~\/\.rivetos and ~\/\.rivethub/)
  })

  it('executes: removes the link, moves the state back, restarts rivetos.service', async () => {
    const host = fakeHost(migrated)
    expect(await migrateToRivethub(['--rollback'], host)).toBe(0)
    expect(host.writes).toContain('remove /home/rivet/.rivetos')
    expect(host.writes).toContain('rename /home/rivet/.rivethub /home/rivet/.rivetos')
    expect(host.paths.get('/home/rivet/.rivetos')).toBe('dir')
    expect(host.calls).toContain(
      'sudo -n rm -f /etc/systemd/system/rivethub.service && sudo -n systemctl daemon-reload',
    )
    expect(host.calls.some((c) => c.includes('enable --now rivetos.service'))).toBe(true)
  })

  it('handles a move without the link (failed between start and link)', async () => {
    const host = fakeHost({
      hubUnit: 'user',
      tsUnit: 'user',
      paths: { '/home/rivet/.rivethub': 'dir' },
    })
    host.paths.delete('/home/rivet/.rivetos')
    expect(await migrateToRivethub(['--rollback'], host)).toBe(0)
    expect(host.paths.get('/home/rivet/.rivetos')).toBe('dir')
    expect(
      host.calls.some((c) => c.includes('systemctl --user disable --now rivethub.service')),
    ).toBe(true)
  })
})

describe('rivethub.service unit', () => {
  it('keeps the old unit semantics: install owner, ~/.local/bin on PATH, legacy env file', () => {
    const unit = renderHubUnit({
      scope: 'system',
      user: 'rivet',
      home: '/home/rivet',
      rhPath: '/home/rivet/.local/bin/rh',
    })
    expect(unit).toContain('User=rivet')
    expect(unit).toContain('Environment=PATH=/home/rivet/.local/bin:')
    expect(unit).toContain('EnvironmentFile=-/home/rivet/.rivetos/.env')
    expect(unit).toContain('ExecStart=/home/rivet/.local/bin/rh start')
    expect(unit).toContain('WantedBy=multi-user.target')
  })

  it('quotes a home with spaces and escapes specifiers', () => {
    const unit = renderHubUnit({
      scope: 'user',
      user: 'rivet',
      home: '/srv/rivet home',
      rhPath: '/srv/rivet home/.local/bin/rh',
    })
    expect(unit).toContain('Environment="HOME=/srv/rivet home"')
    expect(unit).toContain('ExecStart="/srv/rivet home/.local/bin/rh" start')
    expect(renderHubUnit({ scope: 'user', user: 'r', home: '/h/100%', rhPath: '/h/rh' })).toContain(
      'WorkingDirectory=/h/100%%',
    )
  })

  it('omits User= and targets default.target in user scope', () => {
    const unit = renderHubUnit({ scope: 'user', user: 'rivet', home: '/h', rhPath: '/h/rh' })
    expect(unit).not.toContain('User=')
    expect(unit).toContain('WantedBy=default.target')
  })
})

describe('stampOf', () => {
  it('formats a compact UTC stamp', () => {
    expect(stampOf(new Date('2026-10-16T05:07:09.123Z'))).toBe('20261016T050709Z')
  })
})

describe('ACP adapter preflight', () => {
  const parsed = parseMigrateArgs([])
  if (!parsed.ok) throw new Error(parsed.error)
  const opts = parsed.opts
  const config = [
    'memory:',
    '  postgres:',
    '    connection_string: postgres://u:s3cret@db.example/rivet',
    'agents:',
    '  claude:',
    '    provider: claude-cli',
    '  hermes:',
    '    provider: hermes-cli',
    'providers:',
    '  claude-cli:',
    '    type: claude-cli',
    '  hermes-cli:',
    '    type: hermes-cli',
    '  spare:',
    '    type: claude-cli',
    '',
  ].join('\n')

  it('refuses with the install command when an agent provider lacks its adapter', () => {
    const host = fakeHost({ config, failOn: ['claude-agent-acp', 'hermes acp --check'] })
    const facts = probeNode(host, opts)
    expect(facts.harnessGaps).toHaveLength(2)
    const refusals = planMigration(facts, opts, stampOf(host.now())).refusals
    expect(refusals.some((r) => r.includes('claude-cli') && r.includes('claude-agent-acp'))).toBe(
      true,
    )
    expect(refusals.some((r) => r.includes('hermes-cli') && r.includes("'.[acp]'"))).toBe(true)
  })

  it('passes when the adapters answer, and looks for them on ~/.local/bin too', () => {
    const host = fakeHost({ config })
    const facts = probeNode(host, opts)
    expect(facts.harnessGaps).toEqual([])
    const checks = host.calls.filter(
      (c) => c.includes('claude-agent-acp') || c.includes('hermes acp'),
    )
    expect(checks).toHaveLength(2)
    const envs = host.calls
      .map((c, i) => [c, host.envs[i]] as const)
      .filter(([c]) => c.includes('claude-agent-acp'))
      .map(([, env]) => env?.PATH ?? '')
    expect(envs.every((path) => path.startsWith('/home/rivet/.local/bin:'))).toBe(true)
  })

  it('ignores adapter providers that no agent uses', () => {
    const host = fakeHost({
      config: config.replace('    provider: claude-cli', '    provider: hermes-cli'),
      failOn: ['claude-agent-acp'],
    })
    expect(probeNode(host, opts).harnessGaps).toEqual([])
    expect(host.calls.some((c) => c.includes('claude-agent-acp'))).toBe(false)
  })
})
