/**
 * rivetos cloud — point this laptop at Rivet Cloud memory.
 *
 * Usage:
 *   rivetos cloud connect <pg-url> --embed-url <url>
 *       [--embed-model qwen3-embedding-0.6b] [--harness <id>…] [--root <dir>]
 *       [--token <token>] [--dry-run] [--yes]
 *   rivetos cloud status
 *   rivetos cloud export [--out <file>]
 *   rivetos cloud import <file>
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { Transform, type Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HARNESS_IDS, type HarnessId } from '@rivetos/types'
import { defaultRivetEnvPath, formatEnvDiff, loadRivetEnv, upsertEnvVars } from '../lib/env-file.js'
import { parseInstallArgs, runPluginsInstall, type HarnessInstallEvent } from './plugins-install.js'

export const DEFAULT_EMBED_MODEL = 'qwen3-embedding-0.6b'
export const SSLMODE_REQUIRED_MSG =
  'cloud URLs must set sslmode to require, verify-ca, or verify-full'
export const NEXT_STEP = 'next: open your harness and run one turn; then use the memory_search tool'
export const CLOUD_TOKEN_ENV = 'RIVETOS_CLOUD_TOKEN'
export const CLOUD_IMPORT_HINT =
  'RIVETOS_PG_URL host is rivetos.cloud; tenant roles cannot import summaries/wiki. Use `rivetos cloud import <file>` instead.'

const HARNESS_ID_SET = new Set<string>(HARNESS_IDS)
const EMBED_DIMS = 1024
const SMOKE_TIMEOUT_MS = 15_000
/** Inactivity guard on the response only — the transfer itself has no socket timeout. */
export const CLOUD_TRANSFER_IDLE_TIMEOUT_MS = 120_000
const TRANSFER_PROGRESS_EVERY = 1024 * 1024

export interface CloudHttpsRequestOptions {
  method: string
  headers: Record<string, string>
  body?: Readable
}

export interface CloudHttpsResponse {
  statusCode: number
  stream: Readable
}

export interface CloudConnectFlags {
  pgUrl: string
  embedUrl: string
  embedModel: string
  harnesses: HarnessId[]
  root?: string
  dryRun: boolean
  yes: boolean
  token?: string
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
  /** Test override; production uses node:https request(). */
  cloudHttpsRequest?: (
    url: string,
    options: CloudHttpsRequestOptions,
  ) => Promise<CloudHttpsResponse>
  stdout?: Writable
  isTTY?: boolean
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
  if (sub === 'export') {
    await runCloudExport(args.slice(1))
    return
  }
  if (sub === 'import') {
    await runCloudImport(args.slice(1))
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
  export [--out <file>]                Download a gzip dump via the cloud HTTPS API
  import <file>                        Upload a gzip dump via the cloud HTTPS API

Options for connect:
  --embed-url <url>    HTTPS embed endpoint (https://rivetos.cloud/embed/<token>)
  --embed-model <id>   Embedding model (default: ${DEFAULT_EMBED_MODEL})
  --token <token>      Tenant token (written as RIVETOS_CLOUD_TOKEN)
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
    token: undefined,
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
    if (arg === '--token') {
      const v = args[++i]
      if (!v || v.startsWith('-')) throw new Error('--token requires a token')
      flags.token = v
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
  const sslmode = parsed.searchParams.get('sslmode')
  if (sslmode !== 'require' && sslmode !== 'verify-ca' && sslmode !== 'verify-full') {
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
  try {
    const u = new URL(url)
    if (u.username !== '' || u.password !== '') {
      u.username = '***'
      u.password = ''
    }
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase() === 'password') u.searchParams.set(key, '***')
    }
    return u.toString()
  } catch {
    return '<redacted>'
  }
}

export function isRivetCloudPgUrl(pgUrl: string): boolean {
  try {
    return new URL(pgUrl).hostname === 'rivetos.cloud'
  } catch {
    return false
  }
}

/** HTTPS origin + tenant slug from RIVETOS_PG_URL (hostname, not postgres port). */
export function resolveCloudApi(pgUrl: string): { origin: string; slug: string } {
  let u: URL
  try {
    u = new URL(pgUrl)
  } catch {
    throw new Error('invalid postgres URL')
  }
  const db = decodeURIComponent(u.pathname.replace(/^\//, '').split('/')[0] ?? '')
  const slug = db.startsWith('tenant_') ? db.slice('tenant_'.length) : db
  if (!slug) throw new Error('cloud API slug missing from RIVETOS_PG_URL database name')
  return { origin: `https://${u.hostname}`, slug }
}

export function cloudExportApiUrl(pgUrl: string): string {
  const { origin, slug } = resolveCloudApi(pgUrl)
  return `${origin}/api/t/${encodeURIComponent(slug)}/export`
}

export function cloudImportApiUrl(pgUrl: string): string {
  const { origin, slug } = resolveCloudApi(pgUrl)
  return `${origin}/api/t/${encodeURIComponent(slug)}/import`
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
  // Same file plugins-install reads: $RIVETOS_ENV_FILE, else ~/.rivetos/.env.
  const envPath = deps.envPath ?? defaultRivetEnvPath()
  const vars: Record<string, string> = {
    RIVETOS_PG_URL: flags.pgUrl,
    RIVETOS_EMBED_URL: flags.embedUrl,
    RIVETOS_EMBED_MODEL: flags.embedModel,
  }
  if (flags.token) vars.RIVETOS_CLOUD_TOKEN = flags.token
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
  if (flags.token) process.env.RIVETOS_CLOUD_TOKEN = flags.token

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
      overrideEnv: true,
      envFile: envPath,
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
  if (key === CLOUD_TOKEN_ENV) return '***'
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

export interface CloudExportFlags {
  out?: string
}

export interface CloudImportFlags {
  file: string
}

export function parseCloudExportArgs(args: string[]): CloudExportFlags {
  const flags: CloudExportFlags = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--out') {
      const v = args[++i]
      if (!v || v.startsWith('-')) throw new Error('--out requires a file path')
      flags.out = v
      continue
    }
    if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`)
    throw new Error(`unexpected argument: ${arg}`)
  }
  return flags
}

export function parseCloudImportArgs(args: string[]): CloudImportFlags {
  const flags: CloudImportFlags = { file: '' }
  for (const arg of args) {
    if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`)
    if (flags.file) throw new Error(`unexpected argument: ${arg}`)
    flags.file = arg
  }
  if (!flags.file) throw new Error('import requires a file path')
  return flags
}

function requireCloudEnv(): { pgUrl: string; token: string } {
  const pgUrl = process.env.RIVETOS_PG_URL
  const token = process.env[CLOUD_TOKEN_ENV]
  if (!pgUrl) throw new Error('RIVETOS_PG_URL is required')
  if (!token) {
    throw new Error(`${CLOUD_TOKEN_ENV} is required (pass --token to rivetos cloud connect)`)
  }
  return { pgUrl, token }
}

export function formatCloudHttpError(kind: string, status: number, body: string): string {
  const statusPart = `${kind} HTTP ${String(status)}`
  if (!body) return statusPart
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>
      const bits: string[] = []
      if (typeof rec.error === 'string') bits.push(rec.error)
      if (rec.committed != null) bits.push(`committed: ${JSON.stringify(rec.committed)}`)
      if (bits.length > 0) return `${statusPart}: ${bits.join('; ')}`
    }
  } catch {
    // not JSON
  }
  return `${statusPart}: ${body.slice(0, 500)}`
}

function logTransferProgress(
  log: (message: string) => void,
  label: string,
  sent: number,
  total?: number,
): void {
  const totalPart = total == null ? '' : `/${String(total)}`
  log(`${label}: ${String(sent)}${totalPart} bytes`)
}

function chunkByteLength(chunk: string | Buffer | Uint8Array): number {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk)
  return chunk.length
}

/**
 * Socket inactivity timeout only — never a `data` listener. Attaching `data`
 * before the caller pipes/iterates the response puts IncomingMessage in
 * flowing mode and can drain buffered bytes before the consumer attaches.
 * IncomingMessage.setTimeout reads `this.socket` with no null check; Node
 * detaches the socket on end, so skip when it is already gone.
 */
export function attachIdleGuard(res: IncomingMessage, req: ClientRequest): void {
  const onIdle = (): void => {
    req.destroy(new Error('cloud transfer idle timeout'))
  }
  if (res.socket) res.setTimeout(CLOUD_TRANSFER_IDLE_TIMEOUT_MS, onIdle)
  const clear = (): void => {
    if (res.socket) res.setTimeout(0)
  }
  res.on('end', clear)
  res.on('close', clear)
  res.on('error', clear)
}

function transferProgressTransform(log: (message: string) => void, label: string): Transform {
  let received = 0
  let lastLogged = 0
  return new Transform({
    transform(chunk: Buffer | string, _enc, cb) {
      if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
        received += chunkByteLength(chunk)
      }
      if (received - lastLogged >= TRANSFER_PROGRESS_EVERY) {
        lastLogged = received
        logTransferProgress(log, label, received)
      }
      this.push(chunk)
      cb()
    },
    flush(cb) {
      logTransferProgress(log, label, received)
      cb()
    },
  })
}

async function readStreamUtf8(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk))
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk))
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function defaultCloudHttpsRequest(
  urlStr: string,
  options: CloudHttpsRequestOptions,
): Promise<CloudHttpsResponse> {
  return await new Promise((resolve, reject) => {
    const req = httpsRequest(
      urlStr,
      {
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        attachIdleGuard(res, req)
        resolve({ statusCode: res.statusCode ?? 0, stream: res })
      },
    )
    req.setTimeout(0)
    req.on('error', (err: unknown) => {
      reject(err instanceof Error ? err : new Error(String(err)))
    })
    const body = options.body
    if (body) {
      body.on('error', (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        req.destroy(error)
        reject(error)
      })
      body.pipe(req)
    } else {
      req.end()
    }
  })
}

export async function runCloudExport(args: string[], deps: CloudDeps = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }
  const flags = parseCloudExportArgs(args)
  const stdout = deps.stdout ?? process.stdout
  const isTTY = deps.isTTY ?? Reflect.get(stdout, 'isTTY') === true
  if (!flags.out && isTTY) {
    throw new Error('refusing to write gzip to a TTY (redirect stdout or pass --out <file>)')
  }
  loadRivetEnv(deps.envPath ?? defaultRivetEnvPath())
  const { pgUrl, token } = requireCloudEnv()
  const url = cloudExportApiUrl(pgUrl)
  const log = deps.log ?? console.log
  const requestFn = deps.cloudHttpsRequest ?? defaultCloudHttpsRequest
  const res = await requestFn(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/gzip' },
  })
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const body = await readStreamUtf8(res.stream).catch(() => '')
    throw new Error(formatCloudHttpError('cloud export', res.statusCode, body))
  }
  if (flags.out) {
    const dest = createWriteStream(flags.out, { mode: 0o600 })
    await pipeline(res.stream, transferProgressTransform(log, 'cloud export'), dest)
  } else {
    await pipeline(res.stream, stdout, { end: false })
  }
}

export async function runCloudImport(args: string[], deps: CloudDeps = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }
  const flags = parseCloudImportArgs(args)
  loadRivetEnv(deps.envPath ?? defaultRivetEnvPath())
  const { pgUrl, token } = requireCloudEnv()
  const url = cloudImportApiUrl(pgUrl)
  const log = deps.log ?? console.log
  const fileStat = await stat(flags.file)
  const fileStream = createReadStream(flags.file)
  let sent = 0
  let lastLogged = 0
  const report = (force: boolean): void => {
    if (!force && sent - lastLogged < TRANSFER_PROGRESS_EVERY) return
    lastLogged = sent
    logTransferProgress(log, 'cloud import', sent, fileStat.size)
  }
  fileStream.on('data', (chunk) => {
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
      sent += chunkByteLength(chunk)
    }
    report(false)
  })
  fileStream.on('end', () => {
    report(true)
  })
  const requestFn = deps.cloudHttpsRequest ?? defaultCloudHttpsRequest
  let res: CloudHttpsResponse
  try {
    res = await requestFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/gzip',
        'Content-Length': String(fileStat.size),
      },
      body: fileStream,
    })
  } catch (err) {
    fileStream.destroy()
    throw err
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const body = await readStreamUtf8(res.stream).catch(() => '')
    throw new Error(formatCloudHttpError('cloud import', res.statusCode, body))
  }
  const text = await readStreamUtf8(res.stream).catch(() => '')
  log(text || 'cloud import ok')
}
