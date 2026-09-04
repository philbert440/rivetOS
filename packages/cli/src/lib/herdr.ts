/**
 * herdr provisioning — pinned install + agent-detection manifest overrides.
 *
 * herdr is the optional terminal mux backend for the den (`term.mux: herdr`,
 * backend lane: feat/den-herdr-backend). Nodes that never flip that flag are
 * unaffected — this module only provisions the binary and the manifest
 * overrides; nothing runs herdr until the den backend opts in.
 *
 * Pin policy (see integrations/herdr/README.md):
 *   - We run herdr 0.8.2 exactly. The upstream installer
 *     (https://herdr.dev/install.sh) has NO version-pin support — it always
 *     fetches latest.json (verified 2026-09-04) — so the pinned install path
 *     is the sha256-verified staged binary on the fleet share. The upstream
 *     installer is an explicit opt-in fallback (--from-upstream) that is
 *     accepted only when the binary it lands still reports the pinned version.
 *   - Manifest overrides: herdr 0.8.2 ignores
 *     ~/.local/state/herdr/agent-detection/local/ (undocumented, verified). A
 *     manifest with a HIGHER version dropped into the remote/ cache dir wins
 *     and the updater leaves it alone ("remote version … is older than
 *     cached"). Our manifests carry version 2099.01.01.1 for exactly this.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sharedDir } from '@rivetos/types'

/** Pinned herdr version. Bump together with HERDR_SHA256 and
 *  integrations/herdr/schema/herdr-api.schema.json (scripts/herdr-schema-refresh.sh). */
export const HERDR_VERSION = '0.8.2'
/** sha256 of the staged linux-x86_64 binary at <shared>/fidelity/bin/herdr-0.8.2. */
export const HERDR_SHA256 = '976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** Repo root from packages/cli/(src|dist)/lib — same depth math as update.ts ROOT. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function herdrBinPath(home: string = homedir()): string {
  return join(home, '.local', 'bin', 'herdr')
}

/** herdr's remote manifest cache — the ONLY override channel 0.8.2 honors. */
export function herdrManifestCacheDir(home: string = homedir()): string {
  return join(home, '.local', 'state', 'herdr', 'agent-detection', 'remote')
}

/** Repo manifests that must be mirrored into the cache dir. */
export function herdrRepoManifestsDir(repoRoot: string = REPO_ROOT): string {
  return join(repoRoot, 'integrations', 'herdr', 'manifests')
}

export function herdrStagedBinaryPath(shared: string = sharedDir()): string {
  return (
    process.env.RIVETOS_HERDR_STAGED ?? join(shared, 'fidelity', 'bin', `herdr-${HERDR_VERSION}`)
  )
}

// ---------------------------------------------------------------------------
// Version probe
// ---------------------------------------------------------------------------

/** Parse "herdr 0.8.2" → "0.8.2". Returns null on any other shape. */
export function parseHerdrVersion(output: string): string | null {
  const m = /^herdr\s+(\d+\.\d+\.\d+)\s*$/m.exec(output.trim())
  return m ? m[1] : null
}

/** `herdr --version` at an explicit path; null when missing/unexecutable. */
export function readHerdrVersion(binPath: string): string | null {
  try {
    const out = execFileSync(binPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseHerdrVersion(out)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Pure planner (unit-tested — no fs, no exec)
// ---------------------------------------------------------------------------

export type HerdrBinaryAction = 'current' | 'install-staged' | 'install-upstream' | 'unavailable'
export type HerdrManifestAction = 'current' | 'install' | 'update-backup' | 'update-overwrite'

export interface HerdrManifestState {
  /** Manifest id, e.g. "grok" (file <agent>.toml). */
  agent: string
  /** Content currently in the remote cache dir; null when absent. */
  installed: string | null
  /** Desired content from integrations/herdr/manifests/<agent>.toml. */
  desired: string
  /** True when <agent>.toml.orig already exists — the FIRST backup is never clobbered. */
  origExists: boolean
}

export interface HerdrPlanInput {
  /** Version at the pinned bin path (readHerdrVersion); null when absent. */
  installedVersion: string | null
  stagedAvailable: boolean
  /** Permit the unpinned upstream installer as a last resort. */
  allowUpstream: boolean
  manifests: HerdrManifestState[]
}

export interface HerdrPlan {
  binary: HerdrBinaryAction
  manifests: Array<{ agent: string; action: HerdrManifestAction }>
}

/**
 * Decide what an install run must do. Idempotency lives here: an already
 * current binary and byte-identical manifests plan as 'current' and the
 * executor touches nothing.
 */
export function planHerdrInstall(input: HerdrPlanInput): HerdrPlan {
  let binary: HerdrBinaryAction
  if (input.installedVersion === HERDR_VERSION) {
    binary = 'current'
  } else if (input.stagedAvailable) {
    binary = 'install-staged'
  } else if (input.allowUpstream) {
    binary = 'install-upstream'
  } else {
    binary = 'unavailable'
  }

  return {
    binary,
    manifests: input.manifests.map((m) => {
      let action: HerdrManifestAction
      if (m.installed === m.desired) action = 'current'
      else if (m.installed === null) action = 'install'
      else if (m.origExists) action = 'update-overwrite'
      else action = 'update-backup'
      return { agent: m.agent, action }
    }),
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Thrown when herdr is absent and no install source is available — callers
 *  (e.g. `rivetos update`) treat this as a quiet skip, not a failure. */
export class HerdrUnavailableError extends Error {}

export interface InstallHerdrOptions {
  home?: string
  repoRoot?: string
  sharedDir?: string
  /** Allow the unpinned upstream installer when no staged binary is available. */
  allowUpstream?: boolean
  /** sha256 the staged binary must match (tests override; production uses the pin). */
  expectedSha256?: string
  log?: (msg: string) => void
}

export interface InstallHerdrResult {
  plan: HerdrPlan
  binaryPath: string
  /** Version reporting at the bin path after the run. */
  version: string | null
}

/**
 * Provision herdr on this node: pinned binary at ~/.local/bin/herdr plus the
 * repo's manifest overrides in herdr's remote cache dir. Idempotent — a
 * current install is reported, not redone. Throws on any verification
 * failure (callers in `update` treat that as non-fatal).
 */
export function installHerdr(opts: InstallHerdrOptions = {}): InstallHerdrResult {
  const log = opts.log ?? ((): void => {})
  const home = opts.home ?? homedir()
  const binPath = herdrBinPath(home)
  const cacheDir = herdrManifestCacheDir(home)
  const stagedPath = herdrStagedBinaryPath(opts.sharedDir)
  const expectedSha = opts.expectedSha256 ?? HERDR_SHA256

  // Gather current state for the planner.
  const manifestsDir = herdrRepoManifestsDir(opts.repoRoot)
  const manifests: HerdrManifestState[] = []
  if (existsSync(manifestsDir)) {
    for (const file of readdirSync(manifestsDir).filter((f) => f.endsWith('.toml'))) {
      const agent = file.slice(0, -'.toml'.length)
      const installedPath = join(cacheDir, file)
      manifests.push({
        agent,
        installed: existsSync(installedPath) ? readFileSync(installedPath, 'utf-8') : null,
        desired: readFileSync(join(manifestsDir, file), 'utf-8'),
        origExists: existsSync(`${installedPath}.orig`),
      })
    }
  } else {
    log(`  ⚠️  repo manifests dir not found (${manifestsDir}) — skipping manifest sync`)
  }

  const plan = planHerdrInstall({
    installedVersion: readHerdrVersion(binPath),
    stagedAvailable: existsSync(stagedPath),
    allowUpstream: opts.allowUpstream ?? false,
    manifests,
  })

  // --- binary ---
  switch (plan.binary) {
    case 'current':
      log(`  ✅ herdr ${HERDR_VERSION} already current (${binPath})`)
      break
    case 'install-staged': {
      // Read the staged file ONCE and hash the exact bytes we will write —
      // hashing then copying is two reads over NFS (a re-stage between them
      // would install unverified bytes). Then temp-file + rename: atomic, never
      // truncates a working binary mid-copy, and REPLACES a symlink at the
      // target instead of following it.
      const bytes = readFileSync(stagedPath)
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== expectedSha) {
        throw new Error(
          `staged herdr binary sha256 mismatch: ${stagedPath}\n` +
            `  expected ${expectedSha}\n  actual   ${actual}\n` +
            `  refusing to install an unverified binary`,
        )
      }
      mkdirSync(dirname(binPath), { recursive: true })
      const tmp = `${binPath}.tmp-${process.pid}`
      writeFileSync(tmp, bytes, { mode: 0o755 })
      try {
        renameSync(tmp, binPath)
      } catch (err) {
        rmSync(tmp, { force: true })
        throw err
      }
      const v = readHerdrVersion(binPath)
      if (v !== HERDR_VERSION) {
        throw new Error(
          `installed herdr reports version ${v ?? 'unparseable'}, expected ${HERDR_VERSION}`,
        )
      }
      log(`  ✅ herdr ${HERDR_VERSION} installed from staged binary (sha256 verified)`)
      break
    }
    case 'install-upstream': {
      // Upstream installer has no pin support; accept only if it happens to
      // land the pinned version (true while latest == pin).
      mkdirSync(dirname(binPath), { recursive: true })
      execFileSync('sh', ['-c', 'curl -fsSL https://herdr.dev/install.sh | sh'], {
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: 180_000,
        env: { ...process.env, HERDR_INSTALL_DIR: dirname(binPath) },
      })
      const v = readHerdrVersion(binPath)
      if (v !== HERDR_VERSION) {
        throw new Error(
          `upstream installer landed herdr ${v ?? 'unparseable'}, not the pinned ${HERDR_VERSION} — ` +
            `stage the pinned binary and re-run without --from-upstream`,
        )
      }
      log(`  ✅ herdr ${HERDR_VERSION} installed via upstream installer (version verified)`)
      break
    }
    case 'unavailable':
      throw new HerdrUnavailableError(
        `herdr is not installed at ${binPath} and no staged binary was found at ${stagedPath}.\n` +
          `  Stage the pinned binary there (sha256 ${expectedSha}) or re-run with --from-upstream.`,
      )
  }

  // --- manifest overrides ---
  for (const action of plan.manifests) {
    if (action.action === 'current') {
      log(`  ✅ herdr manifest ${action.agent}.toml already current`)
      continue
    }
    const state = manifests.find((m) => m.agent === action.agent)!
    const target = join(cacheDir, `${action.agent}.toml`)
    mkdirSync(cacheDir, { recursive: true })
    if (action.action === 'update-backup') {
      renameSync(target, `${target}.orig`)
      log(`  ↳ backed up existing ${action.agent}.toml → ${action.agent}.toml.orig`)
    }
    writeFileSync(target, state.desired)
    log(
      action.action === 'install'
        ? `  ✅ herdr manifest override installed: ${action.agent}.toml`
        : `  ✅ herdr manifest override updated: ${action.agent}.toml`,
    )
  }

  return { plan, binaryPath: binPath, version: readHerdrVersion(binPath) }
}

/** systemd EnvironmentFile the rivetos unit loads (`service init` writes
 *  `EnvironmentFile=~/.rivetos/.env`). The CLI itself never loads it into
 *  process.env, so opt-in checks must read it explicitly. */
export function rivetosDotEnvPath(home: string = homedir()): string {
  return join(home, '.rivetos', '.env')
}

/** Look up ONE key in EnvironmentFile-style contents: `KEY=VALUE` per line,
 *  optional `export ` prefix, optional matching single/double quotes around
 *  the value, `#` comment lines. Last assignment wins (systemd semantics).
 *  Never throws. */
export function readDotEnvValue(name: string, contents: string | null): string | undefined {
  if (!contents) return undefined
  let found: string | undefined
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m || m[1] !== name) continue
    let v = m[2].trim()
    if (
      v.length >= 2 &&
      ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    ) {
      v = v.slice(1, -1)
    }
    found = v
  }
  return found
}

/** Resolve the den terminal mux the way the RUNTIME sees it: the process
 *  environment first (what `rivetos start` under systemd has), then the unit's
 *  EnvironmentFile (`~/.rivetos/.env` — a shell-launched `rivetos update` /
 *  `doctor` does not inherit it), then the forward-compatible YAML key
 *  `den.terminal.mux`. Lower-cased; undefined when nothing sets it. */
export function resolveHerdrMux(
  env: NodeJS.ProcessEnv = process.env,
  dotEnvContents: string | null = null,
  rawConfigYaml: string | null = null,
): string | undefined {
  const fromEnv = env.RIVETOS_DEN_TERM_MUX?.trim().toLowerCase()
  if (fromEnv) return fromEnv
  const fromFile = readDotEnvValue('RIVETOS_DEN_TERM_MUX', dotEnvContents)?.trim().toLowerCase()
  if (fromFile) return fromFile
  if (!rawConfigYaml) return undefined
  // Scoped lookup (den.terminal.mux), same as `rivetos doctor` — never a
  // whole-file `mux:` match, which would fail OPEN toward provisioning.
  try {
    const parsed = parseYaml(rawConfigYaml) as { den?: { terminal?: { mux?: unknown } } } | null
    const y = parsed?.den?.terminal?.mux
    return typeof y === 'string' && y.trim() ? y.trim().toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/** Read `~/.rivetos/.env` for the opt-in check; null when absent/unreadable. */
export function readRivetosDotEnv(home: string = homedir()): string | null {
  try {
    return readFileSync(rivetosDotEnvPath(home), 'utf-8')
  } catch {
    return null
  }
}

/** Has this node opted into the herdr mux? `rivetos update` provisions herdr
 *  ONLY when this is true — the staged binary lives on /rivet-shared, which
 *  every fleet node mounts, so "staged" is not a signal of intent. See
 *  resolveHerdrMux for the lookup order (env → ~/.rivetos/.env → YAML). */
export function herdrOptedIn(
  env: NodeJS.ProcessEnv = process.env,
  rawConfigYaml: string | null = null,
  dotEnvContents: string | null = null,
): boolean {
  return resolveHerdrMux(env, dotEnvContents, rawConfigYaml) === 'herdr'
}
