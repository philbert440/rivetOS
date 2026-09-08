/**
 * rivetos local [init|up|status|backup|reset]
 *
 * One-shot laptop bring-up: embedded PGlite, local CA, desktop identity,
 * harness plugins, user service, den on :5174.
 *
 * Bare `rivetos local` = init + up. Never spawnSync — a live node hosts the
 * PGlite socket in-process.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir, hostname as osHostname } from 'node:os'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import {
  ATTACH_BACKUP_ERROR,
  embeddedPgLockAlive,
  embeddedPgUrl,
  formatValidationResult,
  migrateEmbedded,
  readEmbeddedPgLock,
  validateConfig,
} from '@rivetos/boot'
import { interpretAnswers } from './init/answers.js'
import { DEFAULT_MODELS, PROVIDER_ENV_KEYS } from './init/agents.js'
import { detectEnvironment } from './init/detect.js'
import { generateConfig } from './init/generate.js'
import { appendOwnerDevices, seedUsersJson } from './init/users.js'
import type { WizardLocal, WizardState } from './init/types.js'
import pluginsInstall from './plugins-install.js'
import { findRoot } from './plugins-sync.js'
import { checkHarnesses } from './doctor.js'
import { dirSizeBytes, formatBytes, readEmbeddedConfig, withEmbeddedPg } from '../lib/embedded.js'
import { loadRivetEnv } from '../lib/env-file.js'
import {
  detectHarnesses,
  execFileAsync,
  findOnPath,
  type DetectedHarness,
  type ExecResult,
} from '../lib/harness-detect.js'
import { ensureLocalCa, listLanIpv4, localCaPaths, localNodeSans } from '../lib/local-ca.js'
import {
  extraDeviceP12Path,
  identityPathsToReset,
  installDesktopIdentity,
  mintDeviceP12,
} from '../lib/hub-identity.js'
import { envFileToRecord, installLaunchdAgent, stopLaunchdAgent } from '../lib/launchd.js'

export { buildConfigYaml, buildEnvFile, buildLocalPluginList } from './init/generate.js'

const DEFAULT_PORT = 5174
const DEFAULT_PG_PORT = 5433
const HEALTHZ_TIMEOUT_MS = 60_000
const SUBS = new Set(['init', 'up', 'status', 'backup', 'reset'])

const PROVIDER_ALIASES: Record<string, string> = {
  grok: 'grok-cli',
  claude: 'claude-cli',
  'claude-code': 'claude-cli',
  kimi: 'kimi-code',
  hermes: 'hermes-cli',
  codex: 'codex-cli',
}

export const HELP_TEXT = `Usage: rivetos local [init|up|status|backup|reset] [options]

One-shot laptop bring-up: embedded DB, local CA, desktop identity, harness
plugins, and a user service. Bare \`rivetos local\` runs init then up.

Commands:
  init      Write config/env, mint CA + identities, warm the DB, install plugins
  up        Start the user service (or print rivetos start) and wait for /healthz
  status    Den healthz + embedded DB + detected harnesses
  backup    PGlite dumpDataDir gzip tarball (stop the node first)
  reset     Stop the service and delete local-mode data (confirm unless --yes)

Options:
  --yes                 Non-interactive (required for reset off a TTY)
  --provider <key>      Agent provider (else first detected CLI harness, else anthropic)
  --api-key K           Provider API key (written to .env)
  --port 5174           Den listen port
  --pg-port 5433        Embedded Postgres loopback port
  --no-lan              Bind den to 127.0.0.1 (no TLS required)
  --no-service          Print \`rivetos start\` instead of installing a user service
  --device <name>       Extra PKCS#12 at ~/.rivetos/devices/<name>.p12 (repeatable)
  --memory lite|full    lite (default) = FTS/trigram; full needs an embed endpoint
  --out <path>          backup destination
  -h, --help            Show this help
`

export type LocalCommand = 'init' | 'up' | 'status' | 'backup' | 'reset' | 'all'

export interface LocalFlags {
  command: LocalCommand
  yes: boolean
  provider?: string
  apiKey?: string
  port: number
  pgPort: number
  exposeLan: boolean
  service: boolean
  devices: string[]
  memory: 'lite' | 'full'
  out?: string
  help: boolean
}

export interface LocalDeps {
  home?: string
  hostname?: string
  platform?: NodeJS.Platform
  uid?: number
  detectEnv?: typeof detectEnvironment
  detectHarnesses?: typeof detectHarnesses
  exec?: typeof execFileAsync
  findRoot?: typeof findRoot
  now?: () => Date
  confirm?: () => Promise<boolean>
}

export function parseLocalArgs(args: string[]): LocalFlags {
  const flags: LocalFlags = {
    command: 'all',
    yes: false,
    port: DEFAULT_PORT,
    pgPort: DEFAULT_PG_PORT,
    exposeLan: true,
    service: true,
    devices: [],
    memory: 'lite',
    help: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-h' || a === '--help') {
      flags.help = true
    } else if (a === '--yes' || a === '-y') {
      flags.yes = true
    } else if (a === '--no-lan') {
      flags.exposeLan = false
    } else if (a === '--no-service') {
      flags.service = false
    } else if (a === '--provider' && args[i + 1]) {
      flags.provider = args[++i]
    } else if (a === '--api-key' && args[i + 1]) {
      flags.apiKey = args[++i]
    } else if (a === '--port' && args[i + 1]) {
      flags.port = parsePort(args[++i], '--port')
    } else if (a === '--pg-port' && args[i + 1]) {
      flags.pgPort = parsePort(args[++i], '--pg-port')
    } else if (a === '--device' && args[i + 1]) {
      flags.devices.push(args[++i])
    } else if (a === '--memory' && args[i + 1]) {
      const m = args[++i]
      if (m !== 'lite' && m !== 'full') {
        throw new Error('--memory must be lite or full')
      }
      flags.memory = m
    } else if (a === '--out' && args[i + 1]) {
      flags.out = args[++i]
    } else if (a.startsWith('-')) {
      throw new Error(`unknown flag: ${a}`)
    } else if (SUBS.has(a) && flags.command === 'all') {
      flags.command = a as LocalCommand
    } else if (flags.command === 'backup' && !flags.out) {
      flags.out = a
    } else {
      throw new Error(`unexpected argument: ${a}`)
    }
  }
  return flags
}

function parsePort(raw: string, flag: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${flag} must be an integer 1–65535`)
  }
  return n
}

export function sanitizeHostname(raw: string): string {
  let s = raw.trim().toLowerCase()
  s = s.replace(/\.local$/i, '')
  s = s.replace(/[^a-z0-9-]+/g, '-')
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!s) return 'local'
  return s.slice(0, 48)
}

export function normalizeProvider(raw: string): string {
  const key = raw.trim().toLowerCase()
  return PROVIDER_ALIASES[key] ?? raw.trim()
}

export function chooseProvider(opts: {
  provider?: string
  apiKey?: string
  harnesses: DetectedHarness[]
}): { provider: string; apiKey?: string } {
  if (opts.provider) {
    const provider = normalizeProvider(opts.provider)
    if (!DEFAULT_MODELS[provider]) {
      throw new Error(
        `--provider ${opts.provider} is not a known provider (try: ${Object.keys(DEFAULT_MODELS).join(', ')})`,
      )
    }
    return { provider, apiKey: opts.apiKey }
  }
  const first = opts.harnesses.find((h) => h.providerKey && DEFAULT_MODELS[h.providerKey])
  if (first?.providerKey) return { provider: first.providerKey, apiKey: opts.apiKey }
  return { provider: 'anthropic', apiKey: opts.apiKey }
}

export function buildLocalAnswers(opts: {
  configExists: boolean
  provider: string
  apiKey?: string
  postgresUrl: string
}): Record<string, unknown> {
  const answers: Record<string, unknown> = {
    deployment: 'manual',
    agents: [
      {
        name: 'rivet',
        provider: opts.provider,
        model: { default: true },
        thinking: { default: true },
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      },
    ],
    postgresUrl: opts.postgresUrl,
    joinMesh: false,
    ownerId: 'owner',
    confirm: true,
  }
  if (opts.configExists) {
    answers.existingConfig = 'overwrite'
    answers.overwriteConfirm = true
  }
  return answers
}

export function localWizardState(
  answered: ReturnType<typeof interpretAnswers>,
  local: WizardLocal,
): WizardState {
  return {
    deployment: answered.deployment,
    agents: answered.agents,
    channels: [],
    postgresPassword: '',
    postgresUrl: answered.postgresUrl,
    ownerId: answered.ownerId,
    local,
  }
}

/**
 * In-process dry boot check. `rivetos start --check` does not exist; validate
 * the generated YAML and refuse an empty `plugins:` list (production discovery
 * crash-loops with "No plugins configured").
 */
export function assertLocalConfigReady(parsed: unknown): void {
  const result = validateConfig(parsed)
  if (!result.valid) {
    throw new Error(`generated config is invalid:\n${formatValidationResult(result)}`)
  }
  const plugins =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).plugins
      : undefined
  if (!Array.isArray(plugins) || plugins.length === 0) {
    throw new Error(
      'generated config has an empty `plugins:` list. Production deployments require an explicit plugins list (boot will crash-loop with "No plugins configured").',
    )
  }
}

function checkGeneratedConfigFile(configPath: string): void {
  if (!existsSync(configPath)) {
    throw new Error(`generated config missing at ${configPath}`)
  }
  let parsed: unknown
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf-8'))
  } catch (err) {
    throw new Error(`generated config is not valid YAML: ${(err as Error).message}`)
  }
  assertLocalConfigReady(parsed)
}

export function lastNLines(text: string, n: number): string {
  const lines = text.replace(/\n+$/, '').split(/\r?\n/)
  if (lines.length <= n) return lines.join('\n')
  return lines.slice(-n).join('\n')
}

export function renderSystemdUserUnit(opts: {
  workingDir: string
  envFile: string
  execStart: string
}): string {
  return `[Unit]
Description=RivetOS Agent Runtime
After=network.target

[Service]
Type=simple
WorkingDirectory=${opts.workingDir}
ExecStart=${opts.execStart}
EnvironmentFile=${opts.envFile}
Environment=RIVETOS_LOG_LEVEL=info
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`
}

function rivetDir(home: string): string {
  return join(home, '.rivetos')
}

function sharedDirFor(home: string): string {
  return join(home, '.rivetos', 'shared')
}

function applySharedDir(home: string): string {
  const shared = sharedDirFor(home)
  process.env.RIVETOS_SHARED_DIR = shared
  return shared
}

function resolveCliEntry(root: string | null): string {
  if (root) {
    const p = join(root, 'packages', 'cli', 'dist', 'index.js')
    if (existsSync(p)) return p
  }
  return process.argv[1] ?? 'rivetos'
}

function deviceIdOk(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

async function confirmReset(yes: boolean, ask?: () => Promise<boolean>): Promise<boolean> {
  if (yes) return true
  if (ask) return ask()
  if (!process.stdin.isTTY) {
    throw new Error('reset deletes local-mode data — re-run with --yes')
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>((resolveAns) => {
    rl.question('Delete ~/.rivetos pglite, config, env, CA, and identities? [y/N] ', resolveAns)
  })
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

export function formatBanner(opts: {
  port: number
  exposeLan: boolean
  lanAddrs: string[]
  p12Paths: string[]
}): string {
  const lines = [
    '',
    'RivetHub local is up.',
    '',
    `  Desktop  https://localhost:${String(opts.port)}`,
  ]
  if (opts.exposeLan) {
    for (const ip of opts.lanAddrs) {
      lines.push(`  LAN      https://${ip}:${String(opts.port)}`)
    }
  }
  for (const p of opts.p12Paths) {
    lines.push(`  Device   ${p}`)
  }
  lines.push('  Apps     https://rivethub.io/apps')
  lines.push('')
  lines.push('  run claude / grok — memory capture is live while the node runs')
  lines.push('')
  return lines.join('\n')
}

export async function waitHealthz(opts: {
  port: number
  caPem?: string
  timeoutMs?: number
  https?: boolean
}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? HEALTHZ_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const useHttps = opts.https !== false && Boolean(opts.caPem)
  const url = useHttps
    ? `https://localhost:${String(opts.port)}/healthz`
    : `http://127.0.0.1:${String(opts.port)}/healthz`

  while (Date.now() < deadline) {
    try {
      const { fetch: undiciFetch, Agent } = await import('undici')
      const req: Record<string, unknown> = { signal: AbortSignal.timeout(2000) }
      if (useHttps && opts.caPem) {
        req.dispatcher = new Agent({
          connect: { ca: opts.caPem, rejectUnauthorized: true },
        })
      }
      const res = await undiciFetch(url, req)
      if (res.status === 200) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function runExec(
  exec: typeof execFileAsync,
  file: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<ExecResult> {
  return exec(file, args, { timeoutMs })
}

async function readServiceLogTail(opts: {
  platform: NodeJS.Platform
  workingDir: string
  exec: typeof execFileAsync
}): Promise<string> {
  if (opts.platform === 'darwin') {
    const errPath = join(opts.workingDir, 'launchd.err.log')
    const outPath = join(opts.workingDir, 'launchd.out.log')
    const path = existsSync(errPath) ? errPath : outPath
    if (!existsSync(path)) return `(no launchd log at ${errPath} or ${outPath})`
    try {
      return lastNLines(readFileSync(path, 'utf-8'), 20)
    } catch (err) {
      return `(could not read ${path}: ${(err as Error).message})`
    }
  }
  if (opts.platform === 'win32') {
    return '(Windows has no user service log in v1)'
  }
  const result = await runExec(
    opts.exec,
    'journalctl',
    ['--user', '-u', 'rivetos', '-n', '20', '--no-pager'],
    8_000,
  )
  const text = (result.stdout || result.stderr).trim()
  return text || '(journalctl --user -u rivetos -n 20 produced no output)'
}

async function installLinuxService(opts: {
  home: string
  workingDir: string
  envFile: string
  nodePath: string
  cliEntry: string
  exec: typeof execFileAsync
}): Promise<string> {
  const unitPath = join(opts.home, '.config', 'systemd', 'user', 'rivetos.service')
  mkdirSync(dirname(unitPath), { recursive: true })
  const execStart = `${opts.nodePath} ${opts.cliEntry} start`
  writeFileSync(
    unitPath,
    renderSystemdUserUnit({
      workingDir: opts.workingDir,
      envFile: opts.envFile,
      execStart,
    }),
  )
  const user = process.env.USER ?? ''
  if (user) {
    const linger = await runExec(opts.exec, 'loginctl', ['enable-linger', user], 8_000)
    if (linger.code !== 0) {
      await runExec(opts.exec, 'sudo', ['-n', 'loginctl', 'enable-linger', user], 8_000)
    }
  }
  await runExec(opts.exec, 'systemctl', ['--user', 'daemon-reload'])
  await runExec(opts.exec, 'systemctl', ['--user', 'enable', 'rivetos'])
  const start = await runExec(opts.exec, 'systemctl', ['--user', 'start', 'rivetos'])
  if (start.code !== 0 && start.code !== null) {
    throw new Error(
      `systemctl --user start rivetos failed: ${(start.stderr || start.stdout).trim().slice(0, 300)}`,
    )
  }
  return unitPath
}

async function stopLinuxService(exec: typeof execFileAsync): Promise<void> {
  await runExec(exec, 'systemctl', ['--user', 'stop', 'rivetos'])
}

async function runInit(
  flags: LocalFlags,
  deps: LocalDeps,
): Promise<{
  home: string
  hostname: string
  p12Paths: string[]
  lanAddrs: string[]
  port: number
  exposeLan: boolean
  caPem?: string
}> {
  const home = deps.home ?? homedir()
  const hostname = sanitizeHostname(deps.hostname ?? osHostname())
  const shared = applySharedDir(home)
  const dir = rivetDir(home)
  const root = (deps.findRoot ?? findRoot)()
  if (root && !process.env.RIVETOS_ROOT) process.env.RIVETOS_ROOT = root

  const detectEnv = deps.detectEnv ?? detectEnvironment
  await detectEnv({ quiet: true, minNodeMajor: 22 })

  const harnesses = await (deps.detectHarnesses ?? detectHarnesses)({
    home,
    skipVersion: true,
  })
  const chosen = chooseProvider({
    provider: flags.provider,
    apiKey: flags.apiKey,
    harnesses,
  })
  const envKey = PROVIDER_ENV_KEYS[chosen.provider]
  const apiKey = chosen.apiKey ?? (envKey ? process.env[envKey] : undefined)
  if (envKey && !apiKey) {
    throw new Error(
      `${envKey} is not set — pass --api-key, export ${envKey}, or --provider of a detected CLI harness`,
    )
  }
  const postgresUrl = embeddedPgUrl(flags.pgPort)
  const configExists = existsSync(join(dir, 'config.yaml'))
  const answers = buildLocalAnswers({
    configExists,
    provider: chosen.provider,
    apiKey,
    postgresUrl,
  })
  const interpreted = interpretAnswers(answers, {
    configExists,
    dockerAvailable: false,
  })
  if (!interpreted.confirm) {
    throw new Error('init cancelled')
  }

  const muxNone = !findOnPath('tmux', { home })
  const lanAddrs = listLanIpv4()
  const local: WizardLocal = {
    pgPort: flags.pgPort,
    dataDir: join(dir, 'pglite'),
    denPort: flags.port,
    exposeLan: flags.exposeLan,
    tls: true,
    harnesses: harnesses.map((h) => ({
      id: h.id,
      binary: h.binary,
      providerKey: h.providerKey,
    })),
    sharedDir: shared,
    hostname,
    root: root ?? undefined,
    memory: flags.memory,
    muxNone,
    embedEndpoint:
      flags.memory === 'full' ? process.env.RIVETOS_EMBED_URL?.trim() || undefined : undefined,
  }
  const state = localWizardState(interpreted, local)
  await generateConfig(state, dir)
  checkGeneratedConfigFile(join(dir, 'config.yaml'))

  await seedUsersJson(interpreted.ownerId)
  const deviceIds = [`desktop-${hostname}`, ...flags.devices]
  await appendOwnerDevices(deviceIds, interpreted.ownerId)

  const exec = deps.exec ?? execFileAsync
  const ca = await ensureLocalCa({
    home,
    hostname,
    lanAddrs,
    sans: localNodeSans({ hostname, lanAddrs }),
    exec,
    root,
  })
  installDesktopIdentity({
    home,
    hostname,
    platform: deps.platform ?? process.platform,
  })

  const p12Paths: string[] = []
  for (const name of flags.devices) {
    if (!deviceIdOk(name)) {
      throw new Error(`--device ${name} must be alphanumeric / . _ - (rivet-ca issue-client)`)
    }
    const minted = await mintDeviceP12({
      home,
      name,
      exec,
      root,
    })
    p12Paths.push(minted.p12Path)
    console.log(`Device ${name} PKCS#12: ${minted.p12Path}`)
    console.log(`Passphrase (shown once): ${minted.passphrase}`)
  }

  console.log('starting memory engine…')
  const embedded = readEmbeddedConfig(join(dir, 'config.yaml'))
  if (!embedded) {
    throw new Error('generated config is missing memory.postgres.embedded')
  }
  await withEmbeddedPg(embedded.config, async (handle) => {
    if (handle.owned) {
      await migrateEmbedded(handle.pgUrl)
      if (flags.memory !== 'full' && handle.exec) {
        await handle.exec(`SET rivet.defer_embed_enqueue = 'on'`).catch(() => undefined)
      }
    }
  })

  try {
    await pluginsInstall([])
  } catch (err) {
    console.error(`plugins install: ${(err as Error).message}`)
  }

  return {
    home,
    hostname,
    p12Paths,
    lanAddrs,
    port: flags.port,
    exposeLan: flags.exposeLan,
    caPem: existsSync(ca.caChainPem)
      ? readFileSync(ca.caChainPem, 'utf-8')
      : existsSync(ca.chainPem)
        ? readFileSync(ca.chainPem, 'utf-8')
        : undefined,
  }
}

async function runUp(
  flags: LocalFlags,
  deps: LocalDeps,
  fromInit?: Awaited<ReturnType<typeof runInit>>,
): Promise<void> {
  const home = fromInit?.home ?? deps.home ?? homedir()
  applySharedDir(home)
  const dir = rivetDir(home)
  const envFile = join(dir, '.env')
  const root = (deps.findRoot ?? findRoot)()
  const workingDir = root ?? dir
  const cliEntry = resolveCliEntry(root)
  const exec = deps.exec ?? execFileAsync
  const platform = deps.platform ?? process.platform

  checkGeneratedConfigFile(join(dir, 'config.yaml'))

  if (!flags.service) {
    console.log('Start the node with: rivetos start')
  } else if (platform === 'darwin') {
    let env: Record<string, string>
    try {
      env = envFileToRecord(await readFile(envFile, 'utf-8'))
    } catch {
      env = {}
    }
    await installLaunchdAgent({
      home,
      uid: deps.uid,
      nodePath: process.execPath,
      cliEntry,
      workingDir,
      env,
      exec,
    })
  } else if (platform === 'win32') {
    console.log('Windows service install is not in v1 — start the node with: rivetos start')
  } else {
    await installLinuxService({
      home,
      workingDir,
      envFile,
      nodePath: process.execPath,
      cliEntry,
      exec,
    })
  }

  if (!flags.service) return

  const paths = localCaPaths(home)
  const caPath = existsSync(paths.caChainPem) ? paths.caChainPem : paths.chainPem
  const caPem = fromInit?.caPem ?? (existsSync(caPath) ? readFileSync(caPath, 'utf-8') : undefined)
  const port = flags.port
  const ok = await waitHealthz({
    port,
    caPem,
    https: Boolean(caPem),
    timeoutMs: HEALTHZ_TIMEOUT_MS,
  })
  if (!ok) {
    const log = await readServiceLogTail({ platform, workingDir, exec })
    throw new Error(
      `den did not become ready at https://localhost:${String(port)}/healthz within 60s\nLast 20 lines of service log:\n${log}`,
    )
  }
  const lanAddrs = fromInit?.lanAddrs ?? listLanIpv4()
  const p12Paths =
    fromInit?.p12Paths ??
    flags.devices.map((n) => extraDeviceP12Path(home, n)).filter((p) => existsSync(p))
  console.log(
    formatBanner({
      port,
      exposeLan: flags.exposeLan,
      lanAddrs,
      p12Paths,
    }),
  )
}

async function runStatus(deps: LocalDeps): Promise<void> {
  const home = deps.home ?? homedir()
  applySharedDir(home)
  const configPath = join(home, '.rivetos', 'config.yaml')
  let port = DEFAULT_PORT
  try {
    const embedded = readEmbeddedConfig(configPath)
    const den = (embedded?.config as { den?: { port?: number } } | undefined)?.den
    if (typeof den?.port === 'number') port = den.port
  } catch {
    /* use default */
  }
  const paths = localCaPaths(home)
  const caPath = existsSync(paths.caChainPem) ? paths.caChainPem : paths.chainPem
  const caPem = existsSync(caPath) ? readFileSync(caPath, 'utf-8') : undefined
  const healthy = await waitHealthz({
    port,
    caPem,
    https: Boolean(caPem),
    timeoutMs: 3_000,
  })
  console.log(
    healthy
      ? `✅ den /healthz  https://localhost:${String(port)}`
      : `❌ den /healthz  not reachable on :${String(port)} — start the node`,
  )

  const embedded = existsSync(configPath) ? readEmbeddedConfig(configPath) : undefined
  if (embedded?.resolved) {
    const size = formatBytes(dirSizeBytes(embedded.resolved.dataDir))
    const lock = readEmbeddedPgLock(embedded.resolved.dataDir)
    const running = lock ? embeddedPgLockAlive(lock) : false
    if (!running || !lock) {
      console.log(
        `⚠️  embedded PGlite: ${embedded.resolved.dataDir} (${size}), not running — start the node`,
      )
    } else {
      console.log(
        `✅ embedded PGlite: ${embedded.resolved.dataDir} (${size}), owner pid ${String(lock.pid)}`,
      )
    }
  } else {
    console.log('⚠️  embedded PGlite: not configured')
  }

  const harnessRows = await checkHarnesses({ home })
  for (const row of harnessRows) {
    const icon = row.status === 'pass' ? '✅' : row.status === 'warn' ? '⚠️ ' : '❌'
    console.log(`${icon} ${row.message}`)
  }
}

async function runBackup(flags: LocalFlags, deps: LocalDeps): Promise<void> {
  const home = deps.home ?? homedir()
  applySharedDir(home)
  const configPath = join(home, '.rivetos', 'config.yaml')
  const embedded = readEmbeddedConfig(configPath)
  if (!embedded) {
    throw new Error('memory.postgres.embedded is not configured — run rivetos local init')
  }
  const now: () => Date = deps.now ?? ((): Date => new Date())
  const stamp = now().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = flags.out ?? join(home, '.rivetos', 'backups', `pglite-${stamp}.tar.gz`)
  await withEmbeddedPg(embedded.config, async (handle) => {
    if (!handle.owned) {
      throw new Error(ATTACH_BACKUP_ERROR)
    }
    await handle.backup(out)
  })
  console.log(`✅ backup wrote ${out}`)
}

async function runReset(flags: LocalFlags, deps: LocalDeps): Promise<void> {
  const ok = await confirmReset(flags.yes, deps.confirm)
  if (!ok) {
    console.log('reset cancelled')
    return
  }
  const home = deps.home ?? homedir()
  const exec = deps.exec ?? execFileAsync
  const platform = deps.platform ?? process.platform
  try {
    if (platform === 'darwin') await stopLaunchdAgent({ uid: deps.uid, exec })
    else if (platform !== 'win32') await stopLinuxService(exec)
  } catch {
    // not installed
  }
  const dir = rivetDir(home)
  const targets = [
    join(dir, 'pglite'),
    join(dir, 'config.yaml'),
    join(dir, '.env'),
    ...identityPathsToReset(home, platform),
    join(home, '.config', 'systemd', 'user', 'rivetos.service'),
    join(home, 'Library', 'LaunchAgents', 'dev.rivetos.node.plist'),
  ]
  for (const t of targets) {
    try {
      rmSync(t, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  console.log('✅ local-mode data removed')
}

export async function runLocal(args: string[], deps: LocalDeps = {}): Promise<void> {
  const flags = parseLocalArgs(args)
  if (flags.help) {
    console.log(HELP_TEXT)
    return
  }
  const home = deps.home ?? homedir()
  loadRivetEnv(join(home, '.rivetos', '.env'))
  applySharedDir(home)

  if (flags.command === 'status') {
    await runStatus(deps)
    return
  }
  if (flags.command === 'backup') {
    await runBackup(flags, deps)
    return
  }
  if (flags.command === 'reset') {
    await runReset(flags, deps)
    return
  }

  let initResult: Awaited<ReturnType<typeof runInit>> | undefined
  if (flags.command === 'init' || flags.command === 'all') {
    initResult = await runInit(flags, deps)
  }
  if (flags.command === 'up' || flags.command === 'all') {
    await runUp(flags, deps, initResult)
  }
}

export default async function local(args: string[]): Promise<void> {
  await runLocal(args)
}
