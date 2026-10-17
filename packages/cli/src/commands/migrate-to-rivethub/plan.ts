/**
 * Preflight and plan for `rivetos migrate-to-rivethub` and its `--rollback`.
 *
 * planMigration / planRollback are pure over NodeFacts: they return the
 * refusals (any refusal stops the run before it changes anything) and the
 * ordered steps. `--dry-run` prints exactly these steps; the executor runs
 * them. Each step's `commands` is what it runs (or, for steps that are not a
 * shell command, what it does), with credentials redacted.
 */

import { join } from 'node:path'
import { shellArg as q } from '../../lib/ssh.js'
import type { Host } from './host.js'
import type { MigrateOptions } from './options.js'
import { sqliteBackupPath, SQLITE_TARGET, type NodeFacts } from './probe.js'
import {
  latestReleaseApiUrl,
  parseChecksum,
  parseReleaseTag,
  releaseAssetUrl,
  releaseSupportsHost,
  RIVETHUB_RELEASE,
  sha256Hex,
} from './release.js'
import {
  asRoot,
  HUB_UNIT,
  renderHubUnit,
  systemctl,
  TS_UNIT,
  unitPath,
  type UnitScope,
} from './unit.js'

/**
 * prepare — nothing about the running node has changed yet.
 * switch  — the TS runtime is down (and, after the move step, the state is
 *           at ~/.rivethub behind the link); a failure here, up to and
 *           including RivetHub's health check, puts RivetOS back automatically.
 */
export type Phase = 'prepare' | 'switch'

export interface Step {
  id: string
  title: string
  phase: Phase
  commands: string[]
  /** A failure is a refusal (exit 2) rather than a failed step (exit 1). */
  refuseOnFailure?: boolean
  /** Throws on failure; may return a line of detail for the log. */
  run(host: Host): Promise<string | undefined>
}

export interface Plan {
  mode: 'migrate' | 'rollback'
  refusals: string[]
  /** Set when there is nothing to do (already migrated / nothing to undo). */
  done?: string
  steps: Step[]
  /** Run after a failed `switch` step to bring the TS runtime back. */
  recovery: Step[]
  notes: string[]
}

export const HEALTH_TIMEOUT_MS = 120_000
const POLL_MS = 2_000

/** UTC stamp used for backup / dump / parked file names. */
export function stampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

function sh(host: Host, cmd: string, label: string, env?: Record<string, string>): string {
  const res = host.run(cmd, { timeoutMs: 600_000, env })
  if (res.code !== 0) {
    const tail = (res.stderr.trim() || res.stdout.trim()).split('\n').slice(-4).join(' | ')
    throw new Error(`${label} failed (exit ${String(res.code)})${tail ? `: ${tail}` : ''}`)
  }
  return res.stdout.trim()
}

async function poll(host: Host, timeoutMs: number, ok: () => boolean): Promise<boolean> {
  const deadline = host.now().getTime() + timeoutMs
  for (;;) {
    if (ok()) return true
    if (host.now().getTime() >= deadline) return false
    await host.sleep(POLL_MS)
  }
}

function lastLines(text: string, n: number): string {
  return text.trim().split('\n').slice(-n).join('\n      ')
}

/** Scope the new unit is installed in: the old unit's, else by uid. */
export function hubScopeFor(facts: NodeFacts): 'system' | 'user' {
  if (facts.tsUnit !== 'none') return facts.tsUnit
  return facts.uid === 0 ? 'system' : 'user'
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export function migrationRefusals(facts: NodeFacts): string[] {
  const r: string[] = []
  if (facts.platform !== 'linux') {
    r.push(`RivetHub is installed as a systemd service; this host is ${facts.platform}.`)
  }
  if (facts.legacy === 'missing') {
    r.push('~/.rivetos does not exist — there is no RivetOS install to migrate.')
  } else if (facts.legacy !== 'dir') {
    r.push('~/.rivetos is not a directory.')
  }
  if (facts.hub !== 'missing') {
    r.push(
      '~/.rivethub already exists. RivetHub uses it instead of adopting ~/.rivetos; move it aside (or remove a test install) first.',
    )
  }
  if (!facts.configExists) r.push(`No config at ${facts.configPath}.`)
  if (facts.memory.kind === 'unreadable') {
    r.push(`Cannot parse ${facts.configPath}: ${facts.memory.reason}`)
  }
  if (facts.insideTsService) {
    r.push(
      `This command is running inside ${TS_UNIT}; stopping the service would kill it mid-migration. Run it from an SSH shell, or from another node with --mesh.`,
    )
  }
  if (facts.binary.source === 'release') {
    if (!releaseSupportsHost(facts.platform, facts.arch)) {
      r.push(
        `RivetHub releases ship ${RIVETHUB_RELEASE.platform}/${RIVETHUB_RELEASE.arch} binaries only (this host: ${facts.platform}/${facts.arch}). Build rh and pass --binary <path>.`,
      )
    }
  } else {
    if (facts.binary.rhKind !== 'file') r.push(`--binary ${facts.binary.rh} is not a file.`)
    if (facts.binary.migrateKind !== 'file') {
      r.push(`rivethub-migrate must sit next to rh: ${facts.binary.migrate} is missing.`)
    }
  }
  if (facts.tsUnit === 'system') {
    if (!facts.canRoot) {
      r.push(
        `${TS_UNIT} is a system unit and this user cannot run sudo without a password. Run as root's sudo-capable install owner, or give this user passwordless sudo for systemctl.`,
      )
    }
    if (facts.tsUnitUser && facts.tsUnitUser !== facts.user) {
      r.push(
        `${TS_UNIT} runs as ${facts.tsUnitUser}, but this command runs as ${facts.user}. Run it as ${facts.tsUnitUser} (the owner of ~/.rivetos).`,
      )
    }
  }
  if (facts.tsUnit === 'none' && facts.gatewayAnswers) {
    r.push(
      `No ${TS_UNIT} is installed, but a gateway answers on :${String(facts.gatewayPort)}. Stop the running RivetOS runtime first (rivetos stop / rivetos local down).`,
    )
  }
  if (facts.hubUnit !== 'none') {
    r.push(
      `${HUB_UNIT} is already installed (${facts.hubUnit} unit). Remove it, or run --rollback if this node was migrated before.`,
    )
  }
  if (hubScopeFor(facts) === 'system' && !facts.canRoot) {
    r.push(`Installing a system ${HUB_UNIT} needs root or passwordless sudo.`)
  }
  for (const b of facts.ownershipBlockers) r.push(`Not writable by ${facts.user}: ${b}`)
  if (facts.memory.kind === 'pglite') {
    if (facts.memory.lockAlive && facts.tsUnit === 'none') {
      r.push(
        `The embedded database is held by pid ${String(facts.memory.lockPid)} (${facts.memory.dataDir}). Stop that process first.`,
      )
    }
    if (facts.sqliteTargetExists) {
      r.push(
        `~/.rivetos/${SQLITE_TARGET} already exists; the one-time PGlite import needs an empty target. Move it aside first.`,
      )
    }
  }
  if (facts.memory.kind === 'sqlite' && !facts.memory.exists) {
    r.push(`memory.sqlite.path points at ${facts.memory.path}, which does not exist.`)
  }
  if (facts.memory.kind === 'sqlite' && facts.memory.external && facts.memory.backupExists) {
    r.push(
      `${sqliteBackupPath(facts.memory.path)} already exists (left by an earlier run). Move it aside first; the migration writes its pre-migration copy there.`,
    )
  }
  if (facts.validate && facts.validate.code !== 0) {
    r.push(
      `rh config validate rejected ${facts.configPath}:\n      ${lastLines(
        facts.validate.stdout + '\n' + facts.validate.stderr,
        8,
      )}`,
    )
  }
  return r
}

function installBinariesStep(facts: NodeFacts): Step {
  const binDir = join(facts.home, '.local', 'bin')
  const targets = [
    { asset: RIVETHUB_RELEASE.assets.rh, dest: facts.installedRh },
    { asset: RIVETHUB_RELEASE.assets.migrate, dest: facts.installedMigrate },
  ]
  if (facts.binary.source === 'local') {
    const local = facts.binary
    const pairs = [
      { from: local.rh, to: facts.installedRh },
      { from: local.migrate, to: facts.installedMigrate },
    ]
    return {
      id: 'install-binaries',
      title: 'Install rh and rivethub-migrate into ~/.local/bin',
      phase: 'prepare',
      commands: pairs.map((p) =>
        p.from === p.to ? `${p.to} (already in place)` : `install -m 755 ${q(p.from)} ${q(p.to)}`,
      ),
      run: (host) => {
        host.mkdirp(binDir)
        for (const p of pairs) if (p.from !== p.to) host.copyExecutable(p.from, p.to)
        return Promise.resolve(undefined)
      },
    }
  }
  const pinned = facts.binary.tag
  // Without --version the latest tag is resolved once, so rh and
  // rivethub-migrate always come from the same release.
  return {
    id: 'install-binaries',
    title: `Download RivetHub ${pinned ?? '(latest release)'} into ~/.local/bin`,
    phase: 'prepare',
    commands: [
      ...(pinned ? [] : [`resolve the latest release tag (${latestReleaseApiUrl()})`]),
      ...targets.map(
        (t) =>
          `download ${releaseAssetUrl(t.asset, pinned ?? '<tag>')} → ${t.dest} (sha256 from ${RIVETHUB_RELEASE.checksumAsset(t.asset)})`,
      ),
    ],
    run: async (host) => {
      let tag = pinned
      if (!tag) {
        const json = new TextDecoder().decode(await host.download(latestReleaseApiUrl()))
        tag = parseReleaseTag(json)
        if (!tag) throw new Error(`${latestReleaseApiUrl()} did not name a release tag`)
      }
      host.mkdirp(binDir)
      for (const t of targets) {
        const bytes = await host.download(releaseAssetUrl(t.asset, tag))
        const sums = await host.download(
          releaseAssetUrl(RIVETHUB_RELEASE.checksumAsset(t.asset), tag),
        )
        const expected = parseChecksum(new TextDecoder().decode(sums))
        if (!expected) throw new Error(`${RIVETHUB_RELEASE.checksumAsset(t.asset)} is not a sha256`)
        const actual = sha256Hex(bytes)
        if (actual !== expected) {
          throw new Error(`${t.asset}: sha256 ${actual} does not match the release (${expected})`)
        }
        const tmp = `${t.dest}.download`
        host.writeFile(tmp, bytes, 0o755)
        host.rename(tmp, t.dest)
      }
      return `${tag}: checksums verified`
    },
  }
}

function memorySteps(facts: NodeFacts, stamp: string): Step[] {
  const migrate = facts.installedMigrate
  const state = join(facts.home, '.rivetos')
  const mem = facts.memory
  switch (mem.kind) {
    case 'postgres': {
      const cmd = `${q(migrate)} postgres --config ${q(facts.configPath)}`
      return [
        {
          id: 'migrate-postgres',
          title: 'Adopt the Postgres database (rivethub-migrate postgres)',
          phase: 'switch',
          commands: [`RIVETHUB_PG_URL=<memory.postgres URL> ${cmd}`],
          run: (host) =>
            Promise.resolve(sh(host, cmd, 'rivethub-migrate postgres', pgEnv(mem.url))),
        },
      ]
    }
    case 'pglite': {
      const dump = join(state, 'migrate', `pglite-memory-${stamp}.sql`)
      const target = join(state, SQLITE_TARGET)
      const importCmd = `${q(migrate)} sqlite --path ${q(target)} --import-pg-dump ${q(dump)}`
      return [
        {
          id: 'dump-pglite',
          title: 'Dump the PGlite memory tables (plain pg_dump format)',
          phase: 'switch',
          commands: [`PGlite ${mem.dataDir} → ${dump} (mode 600)`],
          run: async (host) => {
            host.mkdirp(join(state, 'migrate'))
            const rows = await host.dumpPglite(facts.configPath, dump)
            const total = Object.values(rows).reduce((a, b) => a + b, 0)
            return `${String(total)} rows from ${String(Object.keys(rows).length)} tables`
          },
        },
        {
          id: 'import-sqlite',
          title: 'Import the dump into RivetHub SQLite memory (one time)',
          phase: 'switch',
          commands: [importCmd],
          run: (host) => Promise.resolve(sh(host, importCmd, 'rivethub-migrate sqlite import')),
        },
      ]
    }
    case 'sqlite': {
      const cmd = `${q(migrate)} sqlite --path ${q(mem.path)}`
      // A file outside ~/.rivetos is not in the state tarball: copy it (and
      // its -wal/-shm) before the in-place schema change, so a rollback can
      // put the RivetOS version back. The main file is copied last, so its
      // copy existing means the set is complete.
      const backup = sqliteBackupPath(mem.path)
      const backupCmd =
        `p=${q(mem.path)}; b=${q(backup)}; for s in -wal -shm ''; do rm -f "$b$s"; ` +
        `if [ -e "$p$s" ]; then cp -p "$p$s" "$b$s.partial" && mv "$b$s.partial" "$b$s" || exit 1; fi; done`
      const backupStep: Step[] = mem.external
        ? [
            {
              id: 'backup-sqlite',
              title: 'Copy the SQLite memory file aside (it lives outside ~/.rivetos)',
              phase: 'switch',
              commands: [backupCmd],
              run: (host) => {
                sh(host, backupCmd, 'SQLite backup')
                return Promise.resolve(backup)
              },
            },
          ]
        : []
      return [
        ...backupStep,
        {
          id: 'migrate-sqlite',
          title: 'Bring the SQLite memory file to the RivetHub schema',
          phase: 'switch',
          commands: [cmd],
          run: (host) => Promise.resolve(sh(host, cmd, 'rivethub-migrate sqlite')),
        },
      ]
    }
    default:
      return []
  }
}

function pgEnv(url: string): Record<string, string> {
  return { RIVETHUB_PG_URL: url }
}

function unitSteps(facts: NodeFacts, hubScope: 'system' | 'user'): Step[] {
  const unit = renderHubUnit({
    scope: hubScope,
    user: facts.user,
    home: facts.home,
    rhPath: facts.installedRh,
  })
  const dest = unitPath(hubScope, facts.home)
  const staged = join(facts.home, '.rivethub', 'migrate', HUB_UNIT)
  const s = (args: string): string => systemctl(hubScope, args, facts.scope)
  const installCmd =
    hubScope === 'system'
      ? `${asRoot(`install -m 0644 ${q(staged)} ${q(dest)}`, facts.scope)} && ${s('daemon-reload')} && ${s(`enable ${HUB_UNIT}`)}`
      : `mkdir -p ${q(join(facts.home, '.config', 'systemd', 'user'))} && install -m 0644 ${q(staged)} ${q(dest)} && ${s('daemon-reload')} && ${s(`enable ${HUB_UNIT}`)}`
  const startCmd = s(`start ${HUB_UNIT}`)
  return [
    {
      id: 'install-unit',
      title: `Install ${HUB_UNIT} (${hubScope} unit, ExecStart=${facts.installedRh} start)`,
      phase: 'switch',
      commands: [`write ${staged}`, installCmd],
      run: (host) => {
        host.mkdirp(join(facts.home, '.rivethub', 'migrate'))
        host.writeFile(staged, unit, 0o644)
        sh(host, installCmd, `install ${HUB_UNIT}`)
        return Promise.resolve(dest)
      },
    },
    {
      id: 'start-rivethub',
      title: `Start ${HUB_UNIT}`,
      phase: 'switch',
      commands: [startCmd],
      run: (host) => Promise.resolve(sh(host, startCmd, `start ${HUB_UNIT}`) || undefined),
    },
  ]
}

export function planMigration(facts: NodeFacts, opts: MigrateOptions, stamp: string): Plan {
  const plan: Plan = { mode: 'migrate', refusals: [], steps: [], recovery: [], notes: [] }
  if (facts.legacy === 'symlink' && facts.hub === 'dir') {
    if (facts.hubUnit !== 'none') {
      plan.done = `Already migrated: ~/.rivetos → ${facts.legacyTarget ?? '~/.rivethub'}.`
      return plan
    }
    plan.refusals.push(
      `~/.rivetos is already linked to ~/.rivethub, but no ${HUB_UNIT} is installed — a migration stopped part way. Run --rollback, then migrate again.`,
    )
    return plan
  }
  if (facts.legacy === 'missing' && facts.hub === 'dir') {
    plan.refusals.push(
      'RivetHub already moved ~/.rivetos to ~/.rivethub, but the ~/.rivetos link is missing. Create it (ln -s ~/.rivethub ~/.rivetos) or run --rollback.',
    )
    return plan
  }
  plan.refusals = migrationRefusals(facts)

  const hubScope = hubScopeFor(facts)
  const home = facts.home
  const legacy = join(home, '.rivetos')
  const hub = join(home, '.rivethub')
  const backup = join(home, `rivetos-state-${stamp}.tgz`)
  const pidFile = join(legacy, 'rivetos.pid')
  const backupCmd = `(umask 077 && tar czf ${q(backup)} -C ${q(home)} .rivetos) && chmod 600 ${q(backup)}`
  const validateCmd = `${q(facts.installedRh)} config validate`

  plan.steps.push(installBinariesStep(facts), {
    id: 'validate-config',
    title: 'Validate ~/.rivetos/config.yaml with RivetHub',
    phase: 'prepare',
    refuseOnFailure: true,
    commands: [validateCmd],
    run: (host) => {
      const out = sh(host, validateCmd, 'rh config validate')
      return Promise.resolve(out.split('\n').slice(-1)[0] || undefined)
    },
  })
  if (facts.memory.kind === 'postgres') {
    const url = facts.memory.url
    const statusCmd = `${q(facts.installedMigrate)} status postgres --config ${q(facts.configPath)}`
    plan.steps.push({
      id: 'postgres-status',
      title: 'Check the database schema (rivethub-migrate status postgres)',
      phase: 'prepare',
      refuseOnFailure: true,
      commands: [`RIVETHUB_PG_URL=<memory.postgres URL> ${statusCmd}`],
      run: (host) =>
        Promise.resolve(sh(host, statusCmd, 'rivethub-migrate status postgres', pgEnv(url))),
    })
  }
  if (facts.tsUnit !== 'none') {
    const stopCmd = systemctl(facts.tsUnit, `disable --now ${TS_UNIT}`, facts.scope)
    plan.steps.push({
      id: 'stop-rivetos',
      title: `Stop and disable ${TS_UNIT} (${facts.tsUnit} unit)`,
      phase: 'switch',
      commands: [stopCmd],
      run: (host) => Promise.resolve(sh(host, stopCmd, `stop ${TS_UNIT}`) || undefined),
    })
  } else {
    plan.notes.push(`No ${TS_UNIT} found; nothing to stop.`)
  }
  plan.steps.push(
    {
      id: 'backup',
      title: 'Back up ~/.rivetos',
      phase: 'switch',
      commands: [backupCmd],
      run: (host) => {
        sh(host, backupCmd, 'backup')
        return Promise.resolve(backup)
      },
    },
    ...memorySteps(facts, stamp),
    {
      id: 'move-state',
      title: 'Move ~/.rivetos to ~/.rivethub and link it back (before the first start)',
      phase: 'switch',
      commands: [
        `rm -f ${q(pidFile)}`,
        `mv ${q(legacy)} ${q(hub)} && ln -s ${q(hub)} ${q(legacy)}`,
      ],
      run: (host) => {
        host.remove(pidFile)
        host.rename(legacy, hub)
        host.symlink(hub, legacy)
        return Promise.resolve(`${legacy} → ${hub}`)
      },
    },
    ...unitSteps(facts, hubScope),
    healthStep('health', HUB_UNIT, hubScope, facts, 'switch', `${q(facts.installedRh)} status`),
  )

  if (facts.memory.kind === 'none') {
    plan.notes.push('No memory backend in config.yaml; the memory step is skipped.')
  }
  if (facts.memory.kind === 'postgres') {
    plan.notes.push(
      'The database stays adopted after a rollback: the RivetOS runtime reads it through the ros_* views.',
    )
  }
  if (opts.dryRun) {
    plan.notes.push(`Rollback: rivetos migrate-to-rivethub --rollback (backup: ${backup}).`)
  }
  plan.recovery = rollbackSteps(facts, hubScope, stamp, 'recovery')
  return plan
}

function journalHint(scope: 'system' | 'user'): string {
  return scope === 'system'
    ? `journalctl -u ${HUB_UNIT} -n 50`
    : `journalctl --user -u ${HUB_UNIT} -n 50`
}

function healthStep(
  id: string,
  unit: string,
  scope: UnitScope,
  facts: NodeFacts,
  phase: Phase,
  statusCmd?: string,
): Step {
  const active =
    scope === 'none' ? undefined : systemctl(scope, `is-active --quiet ${unit}`, facts.scope)
  const commands = [
    ...(active ? [active] : []),
    `/healthz on :${String(facts.gatewayPort)} (wait up to ${String(HEALTH_TIMEOUT_MS / 1000)}s)`,
    ...(statusCmd ? [statusCmd] : []),
  ]
  return {
    id,
    title: `Health check (${unit})`,
    phase,
    commands,
    run: async (host) => {
      const healthy = await poll(
        host,
        HEALTH_TIMEOUT_MS,
        () =>
          (!active || host.run(active).code === 0) &&
          host.run(facts.healthCheck, { timeoutMs: 10_000 }).code === 0,
      )
      if (!healthy) {
        throw new Error(
          `${unit} did not become healthy within ${String(HEALTH_TIMEOUT_MS / 1000)}s` +
            (scope === 'none' ? '' : ` — check: ${journalHint(scope)}`),
        )
      }
      if (!statusCmd) return `/healthz ok on :${String(facts.gatewayPort)}`
      const status = host.run(statusCmd, { timeoutMs: 30_000 })
      const line = (status.stdout.trim() || status.stderr.trim()).split('\n')[0] ?? ''
      return status.code === 0
        ? `/healthz ok; rh status: ${line}`
        : `/healthz ok; rh status exited ${String(status.code)}: ${line}`
    },
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * The steps that put the TS runtime back. Each one decides at run time what
 * is left to undo, so the same list serves `--rollback` and the automatic
 * recovery after a failed switch step (where some of it never happened).
 */
function rollbackSteps(
  facts: NodeFacts,
  hubScope: UnitScope,
  stamp: string,
  purpose: 'rollback' | 'recovery',
): Step[] {
  const home = facts.home
  const legacy = join(home, '.rivetos')
  const hub = join(home, '.rivethub')
  const steps: Step[] = []

  if (hubScope !== 'none') {
    const s = (args: string): string => systemctl(hubScope, args, facts.scope)
    const dest = unitPath(hubScope, home)
    const rm = hubScope === 'system' ? asRoot(`rm -f ${q(dest)}`, facts.scope) : `rm -f ${q(dest)}`
    const stopCmd = `${s(`disable --now ${HUB_UNIT}`)} 2>/dev/null || true`
    const removeCmd = `${rm} && ${s('daemon-reload')}`
    steps.push({
      id: 'stop-rivethub',
      title: `Stop, disable and remove ${HUB_UNIT} (${hubScope} unit)`,
      phase: 'switch',
      commands: [stopCmd, removeCmd],
      run: (host) => {
        sh(host, stopCmd, `stop ${HUB_UNIT}`)
        sh(host, removeCmd, `remove ${HUB_UNIT}`)
        return Promise.resolve(undefined)
      },
    })
  }

  steps.push({
    id: 'restore-state',
    title: 'Put the state directory back at ~/.rivetos',
    phase: 'switch',
    commands: [`if ~/.rivetos is the link: rm ${q(legacy)}; then mv ${q(hub)} ${q(legacy)}`],
    run: (host) => {
      const l = host.kind(legacy)
      const h = host.kind(hub)
      if (l === 'symlink' && h === 'dir') {
        host.remove(legacy)
        host.rename(hub, legacy)
        return Promise.resolve('moved ~/.rivethub back to ~/.rivetos')
      }
      if (l === 'missing' && h === 'dir') {
        host.rename(hub, legacy)
        return Promise.resolve('moved ~/.rivethub back to ~/.rivetos')
      }
      if (l === 'dir' && h === 'missing') return Promise.resolve('state was never moved')
      throw new Error(
        `unexpected state: ~/.rivetos is ${l}, ~/.rivethub is ${h} — resolve by hand (backup: ~/rivetos-state-*.tgz)`,
      )
    },
  })

  if (facts.memory.kind === 'pglite') {
    const target = join(legacy, SQLITE_TARGET)
    steps.push({
      id: 'park-sqlite',
      title: `Move RivetHub's ${SQLITE_TARGET} aside (PGlite stays the RivetOS store)`,
      phase: 'switch',
      commands: [`mv ${q(target)} ${q(`${target}.rivethub-${stamp}`)} (and its -wal/-shm)`],
      run: (host) => {
        let moved = 0
        for (const suffix of ['', '-wal', '-shm']) {
          if (host.kind(target + suffix) === 'missing') continue
          host.rename(target + suffix, `${target}.rivethub-${stamp}${suffix}`)
          moved++
        }
        return Promise.resolve(moved > 0 ? `parked as ${SQLITE_TARGET}.rivethub-${stamp}` : 'none')
      },
    })
  }

  if (facts.memory.kind === 'sqlite' && facts.memory.external) {
    const path = facts.memory.path
    const backup = sqliteBackupPath(path)
    const parked = `${path}.rivethub-${stamp}`
    steps.push({
      id: 'restore-sqlite',
      title: "Put the pre-migration SQLite memory file back (RivetHub's copy is parked)",
      phase: 'switch',
      commands: [`mv ${q(path)} ${q(parked)}; mv ${q(backup)} ${q(path)} (and their -wal/-shm)`],
      run: (host) => {
        if (host.kind(backup) === 'missing')
          return Promise.resolve('no pre-migration copy; left as is')
        for (const suffix of ['', '-wal', '-shm']) {
          if (host.kind(path + suffix) !== 'missing') host.rename(path + suffix, parked + suffix)
        }
        for (const suffix of ['-wal', '-shm', '']) {
          if (host.kind(backup + suffix) !== 'missing') host.rename(backup + suffix, path + suffix)
        }
        return Promise.resolve(`restored ${path}; RivetHub's copy parked as ${parked}`)
      },
    })
  }

  if (facts.tsUnit !== 'none') {
    const startCmd = systemctl(facts.tsUnit, `enable --now ${TS_UNIT}`, facts.scope)
    steps.push(
      {
        id: 'start-rivetos',
        title: `Enable and start ${TS_UNIT} (${facts.tsUnit} unit)`,
        phase: 'switch',
        commands: [startCmd],
        run: (host) => Promise.resolve(sh(host, startCmd, `start ${TS_UNIT}`) || undefined),
      },
      healthStep(
        purpose === 'rollback' ? 'health' : 'health-rivetos',
        TS_UNIT,
        facts.tsUnit,
        facts,
        'switch',
      ),
    )
  }
  return steps
}

export function planRollback(facts: NodeFacts, stamp: string): Plan {
  const plan: Plan = { mode: 'rollback', refusals: [], steps: [], recovery: [], notes: [] }
  const moved =
    (facts.legacy === 'symlink' && facts.hub === 'dir') ||
    (facts.legacy === 'missing' && facts.hub === 'dir')
  if (!moved && facts.hubUnit === 'none') {
    plan.done = 'Nothing to roll back: ~/.rivetos is in place and no rivethub.service is installed.'
    return plan
  }
  if (facts.platform !== 'linux') plan.refusals.push(`Rollback needs systemd (${facts.platform}).`)
  if (facts.legacy === 'dir' && facts.hub === 'dir') {
    plan.refusals.push(
      'Both ~/.rivetos and ~/.rivethub are directories; it is not clear which one holds the live state. Resolve by hand.',
    )
  }
  if (facts.legacy === 'symlink' && facts.hub !== 'dir') {
    plan.refusals.push('~/.rivetos is a link, but ~/.rivethub is not a directory.')
  }
  if ((facts.hubUnit === 'system' || facts.tsUnit === 'system') && !facts.canRoot) {
    plan.refusals.push('A system unit is involved and this user has no passwordless sudo.')
  }
  if (facts.tsUnit === 'none') {
    plan.notes.push(
      `No ${TS_UNIT} is installed: after the rollback start the RivetOS runtime by hand (rivetos start).`,
    )
  }
  if (facts.memory.kind === 'postgres') {
    plan.notes.push('The database stays adopted; RivetOS reads it through the ros_* views.')
  }
  if (facts.memory.kind === 'pglite') {
    plan.notes.push(
      'Memory written while RivetHub ran is in the parked SQLite file, not in PGlite.',
    )
  }
  if (facts.memory.kind === 'sqlite' && facts.memory.external) {
    plan.notes.push(
      `Memory written while RivetHub ran stays in the parked ${facts.memory.path}.rivethub-<stamp>.`,
    )
  }
  plan.steps = rollbackSteps(facts, facts.hubUnit, stamp, 'rollback')
  return plan
}
