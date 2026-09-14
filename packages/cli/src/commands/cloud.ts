/**
 * rivetos cloud — point this laptop at Rivet Cloud memory.
 *
 * Usage:
 *   rivetos cloud connect <pg-url> --embed-url <url>
 *       [--embed-model qwen3-embedding-0.6b] [--harness <id>…] [--root <dir>]
 *       [--dry-run] [--yes]
 *   rivetos cloud status
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { HARNESS_IDS, type HarnessId } from '@rivetos/types'
import { defaultRivetEnvPath, formatEnvDiff, loadRivetEnv, upsertEnvVars } from '../lib/env-file.js'
import { parseInstallArgs, runPluginsInstall, type HarnessInstallEvent } from './plugins-install.js'

export const DEFAULT_EMBED_MODEL = 'qwen3-embedding-0.6b'
export const SSLMODE_REQUIRED_MSG = 'cloud URLs must include sslmode=require'
export const NEXT_STEP = 'next: open your harness and run one turn; then `rivetos memory search …`'

const HARNESS_ID_SET = new Set<string>(HARNESS_IDS)
const EMBED_DIMS = 1024
const SMOKE_TIMEOUT_MS = 15_000

export interface CloudConnectFlags {
  pgUrl: string
  embedUrl: string
  embedModel: string
  harnesses: HarnessId[]
  root?: string
  dryRun: boolean
  yes: boolean
}

export type HarnessChecklistStatus = 'installed' | 'skipped' | 'failed'

export interface HarnessChecklistLine {
  id: string
  status: HarnessChecklistStatus
  reason?: string
}

export interface CloudChecklist {
  db: { ok: boolean; messages?: number; error?: string }
  embed: { ok: boolean; dims?: number; error?: string }
  harnesses: HarnessChecklistLine[]
}

export interface CloudDeps {
  home?: string
  envPath?: string
  smokeDb?: (
    pgUrl: string,
  ) => Promise<{ ok: true; messages: number } | { ok: false; error: string }>
  smokeEmbed?: (
    embedUrl: string,
    model: string,
  ) => Promise<{ ok: true; dims: number } | { ok: false; error: string }>
  runInstall?: typeof runPluginsInstall
  log?: (message: string) => void
  error?: (message: string) => void
}

export default async function cloud(args: string[]): Promise<void> {
  const sub = args[0]
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp()
    return
  }
  if (sub === 'connect') {
    await runCloudConnect(args.slice(1))
    return
  }
  if (sub === 'status') {
    await runCloudStatus(args.slice(1))
    return
  }
  throw new Error(`unknown cloud subcommand: ${sub}`)
}

function printHelp(): void {
  console.log(`Usage: rivetos cloud <command>

Point this laptop at Rivet Cloud memory (no local PGlite required).

Commands:
  connect <pg-url> --embed-url <url>   Write ~/.rivetos/.env, smoke DB + embed, install harness hooks
  status                               Show host/db (never the password) and ping DB + embed

Options for connect:
  --embed-url <url>    HTTPS embed endpoint (https://rivetos.cloud/embed/<token>)
  --embed-model <id>   Embedding model (default: ${DEFAULT_EMBED_MODEL})
  --harness <id>       Limit hook install to one harness (repeatable)
  --root <dir>         RivetOS source tree (or set RIVETOS_ROOT)
  --dry-run            Print the env diff and install plan; write nothing
  --yes                Non-interactive (no prompt; connect never prompts today)
  -h, --help           Show this help
`)
}

export function parseConnectArgs(args: string[]): CloudConnectFlags {
  const flags: CloudConnectFlags = {
    pgUrl: '',
    embedUrl: '',
    embedModel: DEFAULT_EMBED_MODEL,
    harnesses: [],
    dryRun: false,
    yes: false,
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') throw new Error('HELP')
    if (arg === '--dry-run') {
      flags.dryRun = true
      continue
    }
    if (arg === '--yes') {
      flags.yes = true
      continue
    }
    if (arg === '--embed-url') {
      const v = args[++i]
      if (!v || v.startsWith('-')) throw new Error('--embed-url requires a URL')
      flags.embedUrl = v
      continue
    }
    if (arg === '--embed-model') {
      const v = args[++i]
      if (!v || v.startsWith('-')) throw new Error('--embed-model requires a model id')
      flags.embedModel = v
      continue
    }
    if (arg === '--root') {
      const v = args[++i]
      if (!v || v.startsWith('-')) throw new Error('--root requires a directory')
      flags.root = v
      continue
    }
    if (arg === '--harness') {
      const id = args[++i]
      if (!id || !HARNESS_ID_SET.has(id)) {
        throw new Error(
          `unknown --harness: ${id ?? '(missing)'} (known: ${HARNESS_IDS.join(', ')})`,
        )
      }
      flags.harnesses.push(id as HarnessId)
      continue
    }
    if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`)
    if (flags.pgUrl) throw new Error(`unexpected argument: ${arg}`)
    flags.pgUrl = arg
  }
  if (!flags.pgUrl) throw new Error('connect requires a postgres URL')
  if (!flags.embedUrl) throw new Error('connect requires --embed-url <url>')
  return flags
}

export function validatePgUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('invalid postgres URL')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('cloud URL scheme must be postgres or postgresql')
  }
  if (!raw.includes('sslmode=')) {
    throw new Error(SSLMODE_REQUIRED_MSG)
  }
  return parsed
}

export function validateEmbedUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('invalid embed URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('embed URL must be https')
  }
  return parsed
}

/** Host + database only — never userinfo. */
export function describePgUrl(raw: string): string {
  try {
    const u = new URL(raw)
    const db = u.pathname.replace(/^\//, '') || '(no db)'
    const ssl = u.searchParams.get('sslmode')
    const host = u.host || u.hostname
    return ssl ? `${host}/${db} (sslmode=${ssl})` : `${host}/${db}`
  } catch {
    return redactSecret(raw)
  }
}

export function redactSecret(url: string): string {
  return url.replace(/:([^:@/]+)@/, ':***@')
}

export function redactEmbedUrl(raw: string): string {
  try {
    const u = new URL(raw)
    const parts = u.pathname.split('/').filter(Boolean)
    // https://rivetos.cloud/embed/<token> → hide the token
    if (parts.length >= 2 && parts[0] === 'embed') {
      u.pathname = '/embed/***'
      u.search = ''
      u.hash = ''
      return u.toString().replace(/\/$/, '')
    }
    return `${u.origin}${u.pathname}`
  } catch {
    return raw
  }
}

export function harnessLineFromEvent(event: HarnessInstallEvent): HarnessChecklistLine {
  if (event.ok) return { id: event.id, status: 'installed' }
  if (/not detected on PATH/i.test(event.detail)) {
    return { id: event.id, status: 'skipped', reason: 'not found' }
  }
  return { id: event.id, status: 'failed', reason: event.detail }
}

export function renderChecklist(c: CloudChecklist): string {
  const lines: string[] = []
  if (c.db.ok) lines.push(`DB ok (${c.db.messages ?? 0} messages)`)
  else lines.push(`DB failed (${c.db.error ?? 'unknown error'})`)
  if (c.embed.ok) lines.push(`embed ok (${c.embed.dims ?? EMBED_DIMS} dims)`)
  else lines.push(`embed failed (${c.embed.error ?? 'unknown error'})`)
  for (const h of c.harnesses) {
    if (h.status === 'installed') lines.push(`${h.id}: installed`)
    else if (h.status === 'skipped') lines.push(`${h.id}: skipped (${h.reason ?? 'not found'})`)
    else lines.push(`${h.id}: failed (${h.reason ?? 'unknown'})`)
  }
  lines.push(NEXT_STEP)
  return lines.join('\n')
}

export async function smokeDb(
  pgUrl: string,
): Promise<{ ok: true; messages: number } | { ok: false; error: string }> {
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({
    connectionString: pgUrl,
    max: 1,
    connectionTimeoutMillis: SMOKE_TIMEOUT_MS,
  })
  try {
    const res = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM ros_messages')
    const n = Number(res.rows[0]?.n ?? 0)
    return { ok: true, messages: Number.isFinite(n) ? n : 0 }
  } catch (err) {
    const code = (err as { code?: string }).code
    const msg = (err as Error).message
    if (code === '42P01') {
      return {
        ok: false,
        error: 'DB unmigrated (ros_messages missing) — run migrations before connecting',
      }
    }
    return { ok: false, error: `DB unreachable: ${msg}` }
  } finally {
    await pool.end().catch(() => undefined)
  }
}

export async function smokeEmbed(
  embedUrl: string,
  model: string,
): Promise<{ ok: true; dims: number } | { ok: false; error: string }> {
  const url = `${embedUrl.replace(/\/$/, '')}/v1/embeddings`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'ping', model }),
      signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        ok: false,
        error: `embed HTTP ${String(res.status)}${body ? `: ${body.slice(0, 160)}` : ''}`,
      }
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: unknown }> }
    const embedding = json?.data?.[0]?.embedding
    if (!Array.isArray(embedding)) {
      return { ok: false, error: 'embed response missing data[0].embedding' }
    }
    if (embedding.length !== EMBED_DIMS) {
      return {
        ok: false,
        error: `embed returned ${String(embedding.length)} dims, expected ${String(EMBED_DIMS)}`,
      }
    }
    return { ok: true, dims: embedding.length }
  } catch (err) {
    return { ok: false, error: `embed unreachable: ${(err as Error).message}` }
  }
}

export async function runCloudConnect(
  args: string[],
  deps: CloudDeps = {},
): Promise<CloudChecklist> {
  const log = deps.log ?? console.log
  const error = deps.error ?? console.error
  let flags: CloudConnectFlags
  try {
    flags = parseConnectArgs(args)
  } catch (err) {
    if ((err as Error).message === 'HELP') {
      printHelp()
      return emptyChecklist()
    }
    throw err
  }

  validatePgUrl(flags.pgUrl)
  validateEmbedUrl(flags.embedUrl)
  // --yes is accepted so scripts can pass it; connect never prompts.
  void flags.yes

  const home = deps.home ?? homedir()
  const envPath = deps.envPath ?? join(home, '.rivetos', '.env')
  const vars = {
    RIVETOS_PG_URL: flags.pgUrl,
    RIVETOS_EMBED_URL: flags.embedUrl,
    RIVETOS_EMBED_MODEL: flags.embedModel,
  }
  const upsert = upsertEnvVars(envPath, vars, { dryRun: flags.dryRun })
  const printable = upsert.diff.map((d) => ({
    ...d,
    from: d.from === undefined ? d.from : redactForKey(d.key, d.from),
    to: redactForKey(d.key, d.to),
  }))
  if (flags.dryRun) {
    log(`dry-run env ${envPath}`)
    log(formatEnvDiff(printable) || '(no changes)')
  } else {
    log(`${upsert.created ? 'wrote' : 'updated'} ${envPath} (0600)`)
  }

  process.env.RIVETOS_PG_URL = flags.pgUrl
  process.env.RIVETOS_EMBED_URL = flags.embedUrl
  process.env.RIVETOS_EMBED_MODEL = flags.embedModel

  const dbFn = deps.smokeDb ?? smokeDb
  const embedFn = deps.smokeEmbed ?? smokeEmbed
  const db = await dbFn(flags.pgUrl)
  const embed = await embedFn(flags.embedUrl, flags.embedModel)

  if (!db.ok || !embed.ok) {
    const checklist: CloudChecklist = { db, embed, harnesses: [] }
    error(renderChecklist(checklist))
    const bits: string[] = []
    if (!db.ok) bits.push(db.error ?? 'DB failed')
    if (!embed.ok) bits.push(embed.error ?? 'embed failed')
    throw new Error(`cloud connect smoke failed: ${bits.join('; ')}`)
  }

  const harnessEvents: HarnessInstallEvent[] = []
  const runInstall = deps.runInstall ?? runPluginsInstall
  const installArgs = [
    ...(flags.dryRun ? (['--dry-run'] as const) : []),
    ...(flags.root ? (['--root', flags.root] as const) : []),
    ...flags.harnesses.flatMap((id) => ['--harness', id]),
  ]
  let installErr: Error | undefined
  try {
    await runInstall(parseInstallArgs([...installArgs]), {
      home,
      onHarness: (event) => harnessEvents.push(event),
    })
  } catch (err) {
    installErr = err as Error
    if (harnessEvents.length === 0) {
      error(`harness install: ${installErr.message}`)
    }
  }

  const checklist: CloudChecklist = {
    db,
    embed,
    harnesses: harnessEvents.map(harnessLineFromEvent),
  }
  log(renderChecklist(checklist))
  const failedHarnesses = checklist.harnesses.filter((h) => h.status === 'failed')
  if (failedHarnesses.length > 0) {
    throw new Error(`${String(failedHarnesses.length)} harness install(s) failed`)
  }
  if (installErr) throw installErr
  return checklist
}

function redactForKey(key: string, value: string): string {
  if (key === 'RIVETOS_PG_URL') return redactSecret(value)
  if (key === 'RIVETOS_EMBED_URL') return redactEmbedUrl(value)
  return value
}

function emptyChecklist(): CloudChecklist {
  return { db: { ok: false }, embed: { ok: false }, harnesses: [] }
}

async function runCloudStatus(args: string[], deps: CloudDeps = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }
  const log = deps.log ?? console.log
  loadRivetEnv(deps.envPath ?? defaultRivetEnvPath())
  const pgUrl = process.env.RIVETOS_PG_URL
  const embedUrl = process.env.RIVETOS_EMBED_URL
  const embedModel = process.env.RIVETOS_EMBED_MODEL ?? DEFAULT_EMBED_MODEL

  log(`RIVETOS_PG_URL: ${pgUrl ? describePgUrl(pgUrl) : '(not set)'}`)
  log(`RIVETOS_EMBED_URL: ${embedUrl ? redactEmbedUrl(embedUrl) : '(not set)'}`)
  log(`RIVETOS_EMBED_MODEL: ${embedModel}`)

  if (!pgUrl) {
    log('DB: skipped (RIVETOS_PG_URL not set)')
  } else {
    const db = await (deps.smokeDb ?? smokeDb)(pgUrl)
    log(db.ok ? `DB: ok (${String(db.messages)} messages)` : `DB: failed (${db.error})`)
  }
  if (!embedUrl) {
    log('embed: skipped (RIVETOS_EMBED_URL not set)')
  } else {
    const embed = await (deps.smokeEmbed ?? smokeEmbed)(embedUrl, embedModel)
    log(embed.ok ? `embed: ok (${String(embed.dims)} dims)` : `embed: failed (${embed.error})`)
  }
}
