/**
 * rivetos doctor
 *
 * Comprehensive health check for a RivetOS installation.
 *
 * Checks:
 *   1. System — Node.js version, memory, disk space
 *   2. Config — file exists, schema validates
 *   3. Workspace — required files present
 *   4. Environment — API keys, tokens, secrets
 *   5. Secrets — .env permissions, no secrets in config YAML
 *   6. Containers — Docker health (if applicable)
 *   7. Memory backend — Postgres connectivity
 *   8. Embedding width — ros_messages.embedding atttypmod vs EMBED_TRUNCATE_DIMS
 *      (same connection; skipped when the backend check already failed)
 *      + rivet_device SELECT on ros_message_chunks
 *      + Memory queue — graphile-worker dead jobs (WARN when any task has some)
 *        and extract-wiki starvation (due jobs older than 6h)
 *   9. Shared storage — RIVETOS_SHARED_DIR (default /rivet-shared) mount writable
 *  10. Provider connectivity — API endpoint reachability
 *  11. DNS — can resolve provider hostnames
 *  12. Peer reachability — health check other agents in mesh
 *  13. Leaf cert expiry — warn if this node's mTLS leaf expires within 30 days
 *
 * Usage:
 *   rivetos doctor               Run all checks
 *   rivetos doctor --json        Output results as JSON
 *   rivetos doctor --help        Show help
 */

import { readFile, access, writeFile, unlink, stat as fsStat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'
import { validateConfig } from '@rivetos/boot'
import { sharedDir, sharedPath } from '@rivetos/types'
import { loadMeshFile } from '../lib/mesh-file.js'
import { leafCertExpiryCheck, renewHubTargetFromSeed } from '../lib/mesh-enroll.js'
import { resolveLocalNodeName } from '../lib/node-identity.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string
  category: string
  status: 'pass' | 'warn' | 'fail'
  message: string
  detail?: string
}

interface DoctorReport {
  version: string
  timestamp: string
  checks: CheckResult[]
  summary: { pass: number; warn: number; fail: number }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface DoctorOptions {
  json: boolean
  sshUser: string
}

function parseArgs(): DoctorOptions {
  const args = process.argv.slice(3)
  const opts: DoctorOptions = { json: false, sshUser: 'rivet' }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--json':
        opts.json = true
        break
      case '--ssh-user':
        if (args[i + 1]) opts.sshUser = args[++i]
        break
      case '--help':
      case '-h':
        showHelp()
        process.exit(0)
        break
    }
  }

  return opts
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VERSION = '0.5.0'

function check(
  category: string,
  name: string,
  status: 'pass' | 'warn' | 'fail',
  message: string,
  detail?: string,
): CheckResult {
  return { category, name, status, message, detail }
}

function printCheck(r: CheckResult): void {
  const icon = r.status === 'pass' ? '✅' : r.status === 'warn' ? '⚠️ ' : '❌'
  console.log(`${icon} ${r.message}`)
  if (r.detail) {
    console.log(`   ${r.detail}`)
  }
}

// ---------------------------------------------------------------------------
// Check: System
// ---------------------------------------------------------------------------

async function checkSystem(): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  // Node.js version
  const nodeVersion = process.version
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10)
  if (major >= 20) {
    results.push(check('system', 'node', 'pass', `Node.js: ${nodeVersion}`))
  } else {
    results.push(
      check(
        'system',
        'node',
        'fail',
        `Node.js: ${nodeVersion} (requires >=20)`,
        'Install Node.js 20 or later',
      ),
    )
  }

  // Memory
  const os = await import('node:os')
  const totalMem = Math.round(os.totalmem() / 1024 / 1024)
  const freeMem = Math.round(os.freemem() / 1024 / 1024)
  if (freeMem > 512) {
    results.push(
      check('system', 'memory', 'pass', `Memory: ${freeMem}MB free / ${totalMem}MB total`),
    )
  } else if (freeMem > 256) {
    results.push(
      check('system', 'memory', 'warn', `Memory: ${freeMem}MB free / ${totalMem}MB total (low)`),
    )
  } else {
    results.push(
      check(
        'system',
        'memory',
        'fail',
        `Memory: ${freeMem}MB free / ${totalMem}MB total (critical)`,
      ),
    )
  }

  // Disk space on workspace
  const workspaceDir = resolve(process.env.HOME ?? '.', '.rivetos')
  try {
    const df = execSync(`df -m "${workspaceDir}" 2>/dev/null | tail -1`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    const parts = df.split(/\s+/)
    if (parts.length >= 4) {
      const availMB = parseInt(parts[3], 10)
      if (availMB > 1024) {
        results.push(
          check('system', 'disk', 'pass', `Disk: ${Math.round(availMB / 1024)}GB available`),
        )
      } else if (availMB > 256) {
        results.push(check('system', 'disk', 'warn', `Disk: ${availMB}MB available (low)`))
      } else {
        results.push(check('system', 'disk', 'fail', `Disk: ${availMB}MB available (critical)`))
      }
    }
  } catch {
    results.push(check('system', 'disk', 'warn', 'Disk: unable to check disk space'))
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Config
// ---------------------------------------------------------------------------

async function checkConfig(): Promise<{ results: CheckResult[]; rawConfig: string | null }> {
  const results: CheckResult[] = []
  let rawConfig: string | null = null

  const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
  try {
    rawConfig = await readFile(configPath, 'utf-8')
    results.push(check('config', 'file', 'pass', `Config file: ${configPath}`))
  } catch {
    results.push(check('config', 'file', 'fail', `Config file: not found`, 'Run: rivetos init'))
    return { results, rawConfig }
  }

  // Schema validation
  try {
    const parsed = parseYaml(rawConfig) as Record<string, unknown>
    const result = validateConfig(parsed)

    if (result.valid && result.warnings.length === 0) {
      results.push(check('config', 'schema', 'pass', 'Config schema: valid'))
    } else if (result.valid) {
      results.push(
        check(
          'config',
          'schema',
          'warn',
          `Config schema: valid with ${result.warnings.length} warning(s)`,
          result.warnings.map((w) => `[${w.path}] ${w.message}`).join('; '),
        ),
      )
    } else {
      results.push(
        check(
          'config',
          'schema',
          'fail',
          `Config schema: ${result.errors.length} error(s)`,
          result.errors.map((e) => `[${e.path}] ${e.message}`).join('; '),
        ),
      )
    }
  } catch (err) {
    results.push(
      check('config', 'schema', 'fail', `Config schema: parse error`, (err as Error).message),
    )
  }

  return { results, rawConfig }
}

// ---------------------------------------------------------------------------
// Check: Service User
// ---------------------------------------------------------------------------

function checkServiceUser(): CheckResult[] {
  const results: CheckResult[] = []

  try {
    const userOut = execSync('systemctl show rivetos -p User --value 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()

    if (userOut === 'rivet') {
      results.push(check('service', 'user', 'pass', 'Service user: rivet (uid 2000) ✓'))
    } else if (userOut === 'root') {
      results.push(
        check(
          'service',
          'user',
          'warn',
          'Service user: root — run migrate-to-rivet-user.sh to migrate',
          'Phase 0.25 migration not yet applied on this node',
        ),
      )
    } else if (userOut) {
      results.push(check('service', 'user', 'warn', `Service user: ${userOut} (expected rivet)`))
    }
    // If empty, rivetos.service may not be installed — skip silently
  } catch {
    // systemctl not available or service not installed — skip
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Workspace
// ---------------------------------------------------------------------------

const LEGACY_WORKSPACE_FILES = ['USER.md', 'CORE.md', 'WORKSPACE.md'] as const

export async function checkWorkspace(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const workspacePath = resolve(process.env.HOME ?? '.', '.rivetos', 'workspace')

  const requiredFiles = ['AGENT.md', 'MEMORY.md']

  for (const file of requiredFiles) {
    try {
      await access(resolve(workspacePath, file))
      results.push(check('workspace', file, 'pass', `Workspace: ${file}`))
    } catch {
      let message = `Workspace: ${file} missing (required)`
      if (file === 'AGENT.md') {
        const present: string[] = []
        for (const name of LEGACY_WORKSPACE_FILES) {
          try {
            await access(resolve(workspacePath, name))
            present.push(name)
          } catch {
            // absent
          }
        }
        if (present.length > 0) {
          message = `Workspace: AGENT.md missing (required). Migrate content from ${present.join(', ')} into AGENT.md.`
        }
      }
      results.push(check('workspace', file, 'fail', message))
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Environment Variables
// ---------------------------------------------------------------------------

function checkEnvVars(rawConfig: string | null): CheckResult[] {
  const results: CheckResult[] = []
  const envChecks: Array<{ name: string; context: string }> = []

  if (rawConfig) {
    try {
      type Section = Partial<Record<string, Record<string, unknown>>>
      const parsed = parseYaml(rawConfig) as {
        providers?: Section
        memory?: Section
      }
      const providers: Section = parsed.providers ?? {}
      const memory: Section = parsed.memory ?? {}

      if (providers.anthropic && !providers.anthropic.api_key) {
        envChecks.push({ name: 'ANTHROPIC_API_KEY', context: 'provider: anthropic' })
      }
      if (providers.xai && !providers.xai.api_key) {
        envChecks.push({ name: 'XAI_API_KEY', context: 'provider: xai' })
      }
      if (providers.google && !providers.google.api_key) {
        envChecks.push({ name: 'GOOGLE_API_KEY', context: 'provider: google' })
      }

      // Social channels (telegram/discord/voice-discord) were removed in Phase 5.
      // Doctor no longer probes their bot tokens.

      if (memory.postgres && !memory.postgres.connection_string) {
        envChecks.push({ name: 'RIVETOS_PG_URL', context: 'memory: postgres' })
      }
    } catch {
      /* expected */
    }
  }

  if (envChecks.length === 0) {
    envChecks.push(
      { name: 'ANTHROPIC_API_KEY', context: 'provider' },
      { name: 'RIVETOS_PG_URL', context: 'memory' },
    )
  }

  for (const { name, context } of envChecks) {
    const value = process.env[name]
    if (value) {
      results.push(
        check('env', name, 'pass', `Env: ${name} = ${value.slice(0, 8)}... (${context})`),
      )
    } else {
      results.push(check('env', name, 'warn', `Env: ${name} not set (needed for ${context})`))
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Secrets
// ---------------------------------------------------------------------------

async function checkSecrets(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const envPath = resolve(process.env.HOME ?? '.', '.rivetos', '.env')
  const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')

  // .env permissions
  try {
    const stats = await fsStat(envPath)
    const mode = stats.mode & 0o777
    if (mode === 0o600) {
      results.push(check('secrets', 'env-perms', 'pass', '.env permissions: 600'))
    } else {
      results.push(
        check(
          'secrets',
          'env-perms',
          'warn',
          `.env permissions: ${mode.toString(8)} (should be 600)`,
          'Run: chmod 600 ~/.rivetos/.env',
        ),
      )
    }
  } catch {
    results.push(check('secrets', 'env-perms', 'warn', '.env file not found'))
  }

  // Secrets in config
  try {
    const content = await readFile(configPath, 'utf-8')
    const secretPatterns = [
      /sk-ant-api03-[a-zA-Z0-9_-]+/,
      /sk-[a-zA-Z0-9]{48,}/,
      /xai-[a-zA-Z0-9_-]+/,
      /api_key:\s*["']?[a-zA-Z0-9_-]{20,}/,
      /bot_token:\s*["']?[a-zA-Z0-9._-]{20,}/,
    ]
    const hasSecrets = secretPatterns.some((p) => p.test(content))
    if (hasSecrets) {
      results.push(
        check('secrets', 'config-secrets', 'warn', 'Config contains secrets — move them to .env'),
      )
    } else {
      results.push(check('secrets', 'config-secrets', 'pass', 'Config: no embedded secrets'))
    }
  } catch {
    // No config — skip
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Containers
// ---------------------------------------------------------------------------

function checkContainers(): CheckResult[] {
  const results: CheckResult[] = []

  if (process.env.RIVETOS_BARE_METAL === '1' || process.argv.includes('--bare-metal')) {
    results.push(check('containers', 'docker', 'pass', 'Docker: skipped (bare-metal mode)'))
    return results
  }

  // Only check if Docker is available
  try {
    execSync('docker compose version 2>/dev/null', { timeout: 5000, stdio: 'ignore' })
  } catch {
    return results // Docker not available — skip
  }

  try {
    const output = execSync('docker compose ps --format json 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 10_000,
      cwd: process.env.HOME ? resolve(process.env.HOME, '.rivetos') : undefined,
    }).trim()

    if (!output) {
      results.push(check('containers', 'docker', 'warn', 'Docker: no containers running'))
      return results
    }

    // Docker compose outputs one JSON object per line
    const containers = output
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as { Name: string; State: string; Health: string }
        } catch {
          return null
        }
      })
      .filter(Boolean) as Array<{ Name: string; State: string; Health: string }>

    for (const c of containers) {
      const healthy = c.State === 'running' && (c.Health === 'healthy' || c.Health === '')
      results.push(
        check(
          'containers',
          c.Name,
          healthy ? 'pass' : 'warn',
          `Container ${c.Name}: ${c.State}${c.Health ? ` (${c.Health})` : ''}`,
        ),
      )
    }
  } catch {
    results.push(check('containers', 'docker', 'warn', 'Docker: unable to check container status'))
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Memory Backend
// ---------------------------------------------------------------------------

type DoctorPgQuery = (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>

async function checkMemoryBackend(): Promise<{
  results: CheckResult[]
  query?: DoctorPgQuery
  close?: () => Promise<void>
}> {
  const results: CheckResult[] = []
  const pgUrl = process.env.RIVETOS_PG_URL

  if (!pgUrl) {
    results.push(check('memory', 'postgres', 'warn', 'Memory backend: RIVETOS_PG_URL not set'))
    return { results }
  }

  try {
    // Dynamic import to avoid hard dependency on pg
    const { default: pg } = await import('pg')
    const client = new pg.Client({ connectionString: pgUrl })
    try {
      await client.connect()
      await client.query('SELECT 1')
    } catch (err) {
      try {
        await client.end()
      } catch {
        /* ignore close errors after a failed connect */
      }
      results.push(
        check(
          'memory',
          'postgres',
          'fail',
          'Memory backend: PostgreSQL unreachable',
          (err as Error).message,
        ),
      )
      return { results }
    }
    results.push(check('memory', 'postgres', 'pass', 'Memory backend: PostgreSQL connected'))
    return {
      results,
      query: async (sql) => {
        const res = await client.query(sql)
        return { rows: res.rows as Array<Record<string, unknown>> }
      },
      close: () => client.end(),
    }
  } catch (err) {
    results.push(
      check(
        'memory',
        'postgres',
        'fail',
        'Memory backend: PostgreSQL unreachable',
        (err as Error).message,
      ),
    )
    return { results }
  }
}

// ---------------------------------------------------------------------------
// Check: Embedding width (#624)
// ---------------------------------------------------------------------------

const DEFAULT_EMBED_DIMS = 1024

function expectedEmbedDims(): number {
  const raw = process.env.EMBED_TRUNCATE_DIMS
  if (!raw) return DEFAULT_EMBED_DIMS
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMBED_DIMS
}

/**
 * WARN when ros_messages.embedding atttypmod ≠ configured embed dims.
 * pgvector stores the dimension in atttypmod (not typmod+4). Default expected
 * width is EMBED_TRUNCATE_DIMS, else 1024 (fleet Qwen3-Embedding-0.6B).
 */
export async function checkEmbeddingWidth(opts?: {
  query?: (sql: string) => Promise<{ rows: Array<{ atttypmod: number | null }> }>
}): Promise<CheckResult[]> {
  const expected = expectedEmbedDims()
  const sql = `SELECT a.atttypmod AS atttypmod
                 FROM pg_attribute a
                WHERE a.attrelid = 'ros_messages'::regclass
                  AND a.attname = 'embedding'
                  AND NOT a.attisdropped`

  let typmod: number | null | undefined
  try {
    if (!opts?.query) {
      // Live doctor reuses checkMemoryBackend's connection. Standalone /
      // unit-test callers pass `query`. No query and no live client → skip
      // rather than opening a second connection (duplicate of the backend check).
      return []
    }
    const res = await opts.query(sql)
    typmod = res.rows[0]?.atttypmod ?? null
  } catch (err) {
    return [
      check(
        'memory',
        'embedding-width',
        'warn',
        'Memory: unable to read ros_messages.embedding width',
        (err as Error).message,
      ),
    ]
  }

  if (typmod == null) {
    return [
      check('memory', 'embedding-width', 'warn', 'Memory: ros_messages.embedding column not found'),
    ]
  }

  if (typmod === expected) {
    return [
      check(
        'memory',
        'embedding-width',
        'pass',
        `Memory: ros_messages.embedding is halfvec(${String(typmod)})`,
      ),
    ]
  }

  return [
    check(
      'memory',
      'embedding-width',
      'warn',
      `Memory: ros_messages.embedding is halfvec(${String(typmod)}), expected halfvec(${String(expected)}) (issue #624)`,
      'Apply migration 0015_embedding_width.sql when the column has zero non-null rows, or follow the manual recast procedure in that migration. checkEmbeddingWidth is the operator signal; a refused 0015 does not block 0014_chunks.sql.',
    ),
  ]
}

/** Exact GRANT documented in 0014_chunks.sql for deploys that ran bootstrap before the table existed. */
export const DEVICE_CHUNK_GRANT_SQL = 'GRANT SELECT ON ros_message_chunks TO rivet_device;'

/**
 * WARN when role rivet_device exists but lacks SELECT on ros_message_chunks.
 * Skip when the role or table is missing (not every deploy has devices / 0014).
 */
export async function checkDeviceChunkGrant(opts?: {
  query?: DoctorPgQuery
}): Promise<CheckResult[]> {
  const sql = `SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rivet_device') THEN NULL
         WHEN to_regclass('ros_message_chunks') IS NULL THEN NULL
         ELSE has_table_privilege('rivet_device', 'ros_message_chunks', 'SELECT')
       END AS allowed`

  if (!opts?.query) return []

  let allowed: unknown
  try {
    const res = await opts.query(sql)
    allowed = res.rows[0]?.allowed
  } catch {
    // Backend connectivity is already reported by checkMemoryBackend.
    return []
  }

  if (allowed == null) return []
  if (allowed === true || allowed === 't') {
    return [
      check(
        'memory',
        'device-chunk-grant',
        'pass',
        'Memory: rivet_device has SELECT on ros_message_chunks',
      ),
    ]
  }
  if (allowed === false || allowed === 'f') {
    return [
      check(
        'memory',
        'device-chunk-grant',
        'warn',
        'Memory: rivet_device cannot SELECT ros_message_chunks',
        DEVICE_CHUNK_GRANT_SQL,
      ),
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// Check: Memory Queue (graphile-worker dead jobs)
// ---------------------------------------------------------------------------

export interface MemoryQueueDeadRow {
  task: string
  keyed_dead: string
  keyless_dead: string
  last_error: string | null
  /** Count of unlocked, not-dead jobs with run_at <= now(). Optional on older stubs. */
  due?: string | null
  /** MIN(run_at) of those due jobs. Optional on older stubs. */
  oldest_due_at?: string | Date | null
  /** MAX(locked_at) for this task. Optional on older stubs. */
  last_locked_at?: string | Date | null
}

/**
 * Dead graphile-worker jobs per task. Dead = attempts >= max_attempts: the
 * row never retries on its own. graphile 0.17 add_jobs already releases the
 * key on a dead conflict, so most of these are keyless corpses (dashboard
 * rot, not a blockage). Keyed dead rows still need `rivetos memory requeue`;
 * keyless corpses are deleted by the hourly reap-dead-jobs sweep after 7 days
 * and must never be requeued (no job_key → no dedupe). Live proof
 * (phil_memory, 2026-09-01): 3,435 extract-wiki + 510 compact-conversation
 * jobs dead with nothing surfacing them — those piles are keyless.
 */
export const MEMORY_QUEUE_DEAD_SQL = `SELECT t.identifier AS task,
       COUNT(*) FILTER (WHERE j.attempts >= j.max_attempts AND j.key IS NOT NULL)::text AS keyed_dead,
       COUNT(*) FILTER (WHERE j.attempts >= j.max_attempts AND j.key IS NULL)::text AS keyless_dead,
       COUNT(*) FILTER (WHERE j.attempts < j.max_attempts
                          AND j.run_at <= now()
                          AND j.locked_at IS NULL)::text AS due,
       MIN(j.run_at) FILTER (WHERE j.attempts < j.max_attempts
                               AND j.run_at <= now()
                               AND j.locked_at IS NULL) AS oldest_due_at,
       MAX(j.locked_at) AS last_locked_at,
       LEFT((array_agg(j.last_error ORDER BY j.updated_at DESC NULLS LAST)
         FILTER (WHERE j.attempts >= j.max_attempts))[1], 120) AS last_error
  FROM graphile_worker._private_jobs j
  JOIN graphile_worker._private_tasks t ON t.id = j.task_id
 WHERE j.attempts >= j.max_attempts OR (j.run_at <= now() AND j.locked_at IS NULL)
    OR j.locked_at IS NOT NULL
 GROUP BY t.identifier
 ORDER BY COUNT(*) FILTER (WHERE j.attempts >= j.max_attempts) DESC`

const WIKI_STARVE_MS = 6 * 60 * 60 * 1000
const WIKI_DRAIN_MS = 15 * 60 * 1000

function oldestDueAgeMs(value: string | Date | null | undefined): number | null {
  if (value == null || value === '') return null
  const t = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(t) ? Date.now() - t : null
}

interface PgLikeClient {
  query(sql: string): Promise<{ rows: MemoryQueueDeadRow[] }>
  end(): Promise<void>
}

/**
 * WARN when any task has dead jobs, and when extract-wiki due jobs are
 * older than 6 hours with no extract-wiki lock in the last 15 minutes
 * (starved — not merely draining). Pass `client` in tests; the default
 * connects via RIVETOS_PG_URL (skipped silently when unset — the
 * memory/postgres check already warns about that).
 */
export async function checkMemoryQueue(client?: PgLikeClient): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  let pgClient: PgLikeClient | undefined = client
  let owned = false
  if (!pgClient) {
    const pgUrl = process.env.RIVETOS_PG_URL
    if (!pgUrl) return results
    try {
      const { default: pg } = await import('pg')
      const c = new pg.Client({ connectionString: pgUrl })
      await c.connect()
      pgClient = c
      owned = true
    } catch (err) {
      results.push(
        check('memory', 'queue', 'warn', 'Memory queue: unable to connect', (err as Error).message),
      )
      return results
    }
  }

  try {
    const { rows } = await pgClient.query(MEMORY_QUEUE_DEAD_SQL)
    const totalDead = rows.reduce(
      (sum, r) => sum + Number(r.keyed_dead) + Number(r.keyless_dead),
      0,
    )
    if (totalDead === 0) {
      results.push(check('memory', 'queue', 'pass', 'Memory queue: no dead jobs'))
    } else {
      for (const row of rows) {
        const keyed = Number(row.keyed_dead)
        const keyless = Number(row.keyless_dead)
        const total = keyed + keyless
        if (total === 0) continue
        const prescriptions: string[] = []
        if (keyed > 0) {
          prescriptions.push(`revive with: rivetos memory requeue --task ${row.task}`)
        }
        if (keyless > 0) {
          prescriptions.push(
            'keyless dead rows are corpses; the hourly reap-dead-jobs sweep deletes them after 7 days',
          )
        }
        const countLabel =
          keyed > 0 && keyless > 0
            ? `${total.toLocaleString('en-US')} dead job(s) (${keyed.toLocaleString('en-US')} keyed, ${keyless.toLocaleString('en-US')} keyless)`
            : `${total.toLocaleString('en-US')} dead job(s)`
        results.push(
          check(
            'memory',
            `queue-${row.task}`,
            'warn',
            `Memory queue: ${row.task} has ${countLabel} (won't retry)`,
            (row.last_error ? `${row.last_error} — ` : '') + prescriptions.join('; '),
          ),
        )
      }
    }

    const wiki = rows.find((r) => r.task === 'extract-wiki')
    const due = Number(wiki?.due ?? 0)
    const ageMs = oldestDueAgeMs(wiki?.oldest_due_at)
    const lockAgeMs = oldestDueAgeMs(wiki?.last_locked_at)
    const draining = lockAgeMs != null && lockAgeMs <= WIKI_DRAIN_MS
    if (wiki && due > 0 && ageMs != null && ageMs > WIKI_STARVE_MS && !draining) {
      results.push(
        check(
          'memory',
          'queue-extract-wiki-starved',
          'warn',
          'extract-wiki starved — run a dedicated wiki worker (WORKER_ROLE=wiki)',
          `${due.toLocaleString('en-US')} due, oldest ${Math.round(ageMs / 60_000).toLocaleString('en-US')} min`,
        ),
      )
    }
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') {
      // graphile_worker schema not installed on this DB — workers not deployed
      // here; nothing to warn about.
      results.push(
        check('memory', 'queue', 'pass', 'Memory queue: graphile-worker schema not present'),
      )
    } else {
      results.push(
        check('memory', 'queue', 'warn', 'Memory queue: unable to check', (err as Error).message),
      )
    }
  } finally {
    if (owned) await pgClient.end().catch(() => {})
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Shared Storage
// ---------------------------------------------------------------------------

async function checkSharedStorage(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const dir = sharedDir()

  try {
    await access(dir)
  } catch {
    // shared dir doesn't exist — might not be a multi-agent setup
    return results
  }

  // Check writable
  const testFile = resolve(dir, '.doctor-test')
  try {
    await writeFile(testFile, 'doctor')
    await unlink(testFile)
    results.push(check('shared', 'writable', 'pass', `Shared storage: ${dir}/ is writable`))
  } catch {
    results.push(check('shared', 'writable', 'fail', `Shared storage: ${dir}/ is not writable`))
  }

  // Check subdirectories
  const expectedDirs = ['plans', 'docs', 'status', 'whiteboard']
  for (const sub of expectedDirs) {
    try {
      await access(resolve(dir, sub))
    } catch {
      results.push(check('shared', sub, 'warn', `Shared storage: ${dir}/${sub}/ missing`))
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: DNS
// ---------------------------------------------------------------------------

async function checkDNS(rawConfig: string | null): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const { lookup } = await import('node:dns/promises')

  const hosts: string[] = []
  if (rawConfig) {
    try {
      const parsed = parseYaml(rawConfig) as Record<string, unknown>
      const providers = (parsed.providers ?? {}) as Record<string, unknown>
      if (providers.anthropic) hosts.push('api.anthropic.com')
      if (providers.xai) hosts.push('api.x.ai')
      if (providers.google) hosts.push('generativelanguage.googleapis.com')
      if (providers.openai) hosts.push('api.openai.com')
    } catch {
      /* expected */
    }
  }

  // Always check at least one
  if (hosts.length === 0) hosts.push('api.anthropic.com')

  for (const host of hosts) {
    try {
      await lookup(host)
      results.push(check('dns', host, 'pass', `DNS: ${host} resolves`))
    } catch {
      results.push(check('dns', host, 'fail', `DNS: ${host} failed to resolve`))
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Provider Connectivity
// ---------------------------------------------------------------------------

async function checkProviders(rawConfig: string | null): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  if (!rawConfig) return results

  try {
    type Section = Partial<Record<string, Record<string, unknown>>>
    const parsed = parseYaml(rawConfig) as { providers?: Section }
    const providers: Section = parsed.providers ?? {}

    for (const [name, providerCfg] of Object.entries(providers)) {
      if (!providerCfg) continue
      try {
        const ok = await checkProviderConnectivity(name, providerCfg)
        if (ok) {
          results.push(check('providers', name, 'pass', `Provider ${name}: reachable`))
        } else {
          results.push(check('providers', name, 'fail', `Provider ${name}: unreachable`))
        }
      } catch (err) {
        results.push(
          check('providers', name, 'fail', `Provider ${name}: error`, (err as Error).message),
        )
      }
    }
  } catch {
    /* expected */
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: Peer Reachability
// ---------------------------------------------------------------------------

async function checkPeers(sshUser = 'rivet'): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  // Check for mesh.json (canonical NFS path, then cwd)
  const meshFile = await loadMeshFile(process.cwd())
  if (!meshFile) return results

  try {
    const peers = Object.values(meshFile.nodes)

    for (const peer of peers) {
      const isAgent = !peer.role || peer.role === 'agent'

      if (!isAgent) {
        // Non-agent nodes: SSH reachability check (no HTTP service)
        // Try requestedUser first, fall back to root@
        let sshReachable = false
        let successUser = 'unknown'
        const usersToTry = sshUser !== 'root' ? [sshUser, 'root'] : ['root']
        for (const user of usersToTry) {
          try {
            execSync(
              `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o PasswordAuthentication=no ${user}@${peer.host} "echo ok"`,
              { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
            )
            sshReachable = true
            successUser = user
            break
          } catch {
            // try next user
          }
        }
        if (sshReachable) {
          const userNote =
            successUser !== sshUser
              ? ` (not yet migrated — fell back to root)`
              : ` (SSH as ${successUser})`
          results.push(
            check(
              'peers',
              peer.name,
              successUser !== sshUser ? 'warn' : 'pass',
              `Peer ${peer.name} [${peer.role}]: reachable${userNote}`,
            ),
          )
        } else {
          results.push(
            check(
              'peers',
              peer.name,
              'fail',
              `Peer ${peer.name} [${peer.role}]: unreachable (SSH)`,
            ),
          )
        }
        continue
      }

      try {
        const resp = await fetch(`http://${peer.host}:${String(peer.port)}/health/live`, {
          signal: AbortSignal.timeout(3000),
        })
        if (resp.ok) {
          results.push(check('peers', peer.name, 'pass', `Peer ${peer.name}: reachable`))
        } else {
          results.push(
            check(
              'peers',
              peer.name,
              'warn',
              `Peer ${peer.name}: responded ${String(resp.status)}`,
            ),
          )
        }
      } catch {
        results.push(check('peers', peer.name, 'fail', `Peer ${peer.name}: unreachable`))
      }
    }
  } catch {
    // Malformed mesh.json — skip
  }

  return results
}

/** Den's per-process tmux socket (`rivet-<sha1(stateDir:port)[0:8]>`), matching
 *  den-server `tmuxSocketName`. Duplicated here so the CLI does not import
 *  den-server. Port comes from `den.port` in the config doctor already
 *  loaded, then `RIVETOS_DEN_PORT`, then 5174 — env-only missed a
 *  non-default yaml port and the untagged-session check became a no-op. */
function denTmuxSocketName(rawConfig: string | null): string {
  const stateDir = process.env.RIVETOS_DEN_STATE_DIR ?? join(homedir(), '.rivetos', 'den')
  let port: number | undefined
  if (rawConfig) {
    try {
      const parsed = parseYaml(rawConfig) as { den?: { port?: unknown } }
      const p = parsed.den?.port
      if (typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535) port = p
    } catch {
      /* expected */
    }
  }
  if (port === undefined) {
    const portRaw = process.env.RIVETOS_DEN_PORT
    port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : 5174
  }
  const hash = createHash('sha1').update(`${stateDir}:${port}`).digest('hex').slice(0, 8)
  return `rivet-${hash}`
}

function tmuxSocketPath(socket: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const base = process.env.TMUX_TMPDIR || `/tmp/tmux-${uid}`
  return join(base, socket)
}

/** Cheap (one `tmux list-sessions`): WARN when den's socket has sessions with
 *  empty `@rivet_command`. Skips when the socket file is absent so we never
 *  start a tmux server as a side effect of doctor. */
function checkUntaggedDenTmuxSessions(rawConfig: string | null): CheckResult | undefined {
  const socket = denTmuxSocketName(rawConfig)
  if (!existsSync(tmuxSocketPath(socket))) return undefined
  try {
    const out = execFileSync('tmux', ['-L', socket, 'list-sessions', '-F', '#{@rivet_command}'], {
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const lines = out.split('\n')
    if (lines.at(-1) === '') lines.pop()
    const n = lines.filter((l) => l.length === 0).length
    if (n === 0) return undefined
    return check(
      'terminal',
      'tmux-tags',
      'warn',
      'untagged den tmux sessions — pre-#6xx create; they will be adopted on next open',
      `${n} session(s) on ${socket} have empty @rivet_command`,
    )
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Check: Terminal mux (T1) — WARN when terminals are on and mux would be
// tmux but the binary is missing (sessions won't survive den restarts)
// ---------------------------------------------------------------------------

function checkTerminalMux(rawConfig: string | null): CheckResult[] {
  const results: CheckResult[] = []

  // Read the SAME keys the den-server runtime parses: enablement is
  // RIVETOS_DEN_TERM (or YAML den.terminal.enabled, which the gateway
  // registrar translates into it); the mux choice is RIVETOS_DEN_TERM_MUX —
  // there is NO YAML mux key (den.terminal.mux is not a known config key).
  let termEnabled = false
  if (rawConfig) {
    try {
      const parsed = parseYaml(rawConfig) as {
        den?: { terminal?: { enabled?: unknown } }
      }
      termEnabled = parsed.den?.terminal?.enabled === true
    } catch {
      /* expected */
    }
  }
  const envTerm = (process.env.RIVETOS_DEN_TERM ?? '').trim().toLowerCase()
  if (envTerm === '1' || envTerm === 'on') termEnabled = true
  const mux = process.env.RIVETOS_DEN_TERM_MUX

  if (!termEnabled) return results

  const muxRaw = mux?.trim().toLowerCase()
  if (muxRaw === 'none') {
    results.push(check('terminal', 'mux', 'pass', 'Terminal mux: none (tmux disabled by config)'))
    return results
  }
  // Match den-server config: a garbage value fails safe to 'none' (never
  // silent "auto"). Report the effective mode, not "tmux found".
  if (muxRaw && muxRaw !== 'tmux') {
    results.push(
      check('terminal', 'mux', 'warn', 'Terminal mux: none (invalid RIVETOS_DEN_TERM_MUX value)'),
    )
    return results
  }

  // mux is 'tmux' or unset (unset defaults to tmux when the binary exists).
  // Probe with execFileSync (no shell) and gate on the version: the den
  // create form needs new-session -e, which requires tmux ≥ 3.2.
  try {
    const out = execFileSync('tmux', ['-V'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const m = /(\d+)\.(\d+)/.exec(out)
    const ok = m !== null && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2))
    if (!ok) {
      results.push(
        check(
          'terminal',
          'mux',
          'warn',
          `tmux found but too old (${out || 'unparseable version'}) — den terminal persistence needs tmux ≥ 3.2`,
        ),
      )
    } else {
      results.push(check('terminal', 'mux', 'pass', `Terminal mux: tmux found (${out})`))
      const untagged = checkUntaggedDenTmuxSessions(rawConfig)
      if (untagged) results.push(untagged)
    }
  } catch {
    results.push(
      check(
        'terminal',
        'mux',
        'warn',
        'tmux not installed — den terminal sessions will not survive restarts (sudo apt install tmux)',
      ),
    )
  }

  return results
}

// ---------------------------------------------------------------------------
// Check: leaf cert expiry (90-day leaves; warn within 30 days)
// ---------------------------------------------------------------------------

export async function checkLeafCert(rawConfig: string | null, now?: Date): Promise<CheckResult[]> {
  const nodeName = resolveLocalNodeName()
  if (!nodeName) return []

  const certPath = sharedPath('rivet-ca', 'issued', `${nodeName}.crt`)
  let pem: string
  try {
    pem = await readFile(certPath, 'utf-8')
  } catch {
    // Not enrolled — skip. Missing cert is not a doctor failure on a lone node.
    return []
  }

  let seed: string | undefined
  if (rawConfig) {
    try {
      const parsed = parseYaml(rawConfig) as {
        mesh?: { discovery?: { seed_host?: string; seedHost?: string } }
      }
      seed = parsed.mesh?.discovery?.seed_host ?? parsed.mesh?.discovery?.seedHost
    } catch {
      seed = undefined
    }
  }

  const result = leafCertExpiryCheck({
    certPem: pem,
    nodeName,
    hubTarget: renewHubTargetFromSeed(seed),
    now,
  })
  // `check()` is 5 args: category, name, status, message, detail — printCheck renders detail.
  return [check('mesh', 'leaf-cert', result.status, result.message, result.detail)]
}

// ---------------------------------------------------------------------------
// Provider Connectivity (kept from original)
// ---------------------------------------------------------------------------

async function checkProviderConnectivity(
  name: string,
  config: Record<string, unknown>,
): Promise<boolean> {
  const timeout = 5000

  switch (name) {
    case 'anthropic': {
      const apiKey = (config.api_key as string | undefined) ?? process.env.ANTHROPIC_API_KEY ?? ''
      if (!apiKey) return false
      const resp = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(timeout),
      })
      return resp.ok || resp.status === 401
    }

    case 'xai': {
      const apiKey = (config.api_key as string | undefined) ?? process.env.XAI_API_KEY ?? ''
      if (!apiKey) return false
      const resp = await fetch('https://api.x.ai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeout),
      })
      return resp.ok || resp.status === 401
    }

    case 'google': {
      const apiKey = (config.api_key as string | undefined) ?? process.env.GOOGLE_API_KEY ?? ''
      if (!apiKey) return false
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { signal: AbortSignal.timeout(timeout) },
      )
      return resp.ok || resp.status === 401 || resp.status === 403
    }

    case 'ollama': {
      const baseUrl = (config.base_url as string | undefined) ?? 'http://localhost:11434'
      const resp = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(timeout),
      })
      return resp.ok
    }

    case 'vllm':
    case 'llama-server': {
      const baseUrl = (config.base_url as string | undefined)
        ?.replace(/\/$/, '')
        .replace(/\/v1$/, '')
      if (!baseUrl) return false
      const envKey = name === 'vllm' ? 'VLLM_API_KEY' : 'LLAMA_SERVER_API_KEY'
      const apiKey = (config.api_key as string | undefined) ?? process.env[envKey]
      const headers: Record<string, string> = {}
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const resp = await fetch(`${baseUrl}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(timeout),
      })
      return resp.ok
    }

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`Usage: rivetos doctor [options]

Runs comprehensive health checks on your RivetOS installation.

Options:
  --json              Output results as JSON (for CI/automation)
  --ssh-user <user>   SSH user for peer/infra checks (default: rivet)
                      Falls back to root automatically if rivet auth fails.
  -h, --help          Show this help

Checks: system, config, workspace, env vars, secrets, containers,
        memory backend, embedding width, memory queue (dead jobs, wiki starve), shared
        storage, DNS, provider connectivity, peer reachability, service user,
        leaf cert expiry
`)
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default async function doctor(): Promise<void> {
  const opts = parseArgs()
  const allResults: CheckResult[] = []

  if (!opts.json) {
    console.log(`RivetOS Doctor v${VERSION}\n`)
  }

  // Run all checks
  const systemResults = await checkSystem()
  allResults.push(...systemResults)

  const { results: configResults, rawConfig } = await checkConfig()
  allResults.push(...configResults)

  const serviceUserResults = checkServiceUser()
  allResults.push(...serviceUserResults)

  const workspaceResults = await checkWorkspace()
  allResults.push(...workspaceResults)

  const envResults = checkEnvVars(rawConfig)
  allResults.push(...envResults)

  const secretResults = await checkSecrets()
  allResults.push(...secretResults)

  const containerResults = checkContainers()
  allResults.push(...containerResults)

  const memory = await checkMemoryBackend()
  allResults.push(...memory.results)

  if (memory.query) {
    try {
      const q = memory.query
      allResults.push(
        ...(await checkEmbeddingWidth({
          query: async (sql) => {
            const res = await q(sql)
            return { rows: res.rows as Array<{ atttypmod: number | null }> }
          },
        })),
      )
      allResults.push(...(await checkDeviceChunkGrant({ query: q })))
    } finally {
      await memory.close?.()
    }
  }

  const memoryQueueResults = await checkMemoryQueue()
  allResults.push(...memoryQueueResults)

  const sharedResults = await checkSharedStorage()
  allResults.push(...sharedResults)

  const dnsResults = await checkDNS(rawConfig)
  allResults.push(...dnsResults)

  const providerResults = await checkProviders(rawConfig)
  allResults.push(...providerResults)

  const peerResults = await checkPeers(opts.sshUser)
  allResults.push(...peerResults)

  const terminalMuxResults = checkTerminalMux(rawConfig)
  allResults.push(...terminalMuxResults)

  const leafCertResults = await checkLeafCert(rawConfig)
  allResults.push(...leafCertResults)

  // Summary
  const summary = {
    pass: allResults.filter((r) => r.status === 'pass').length,
    warn: allResults.filter((r) => r.status === 'warn').length,
    fail: allResults.filter((r) => r.status === 'fail').length,
  }

  if (opts.json) {
    const report: DoctorReport = {
      version: VERSION,
      timestamp: new Date().toISOString(),
      checks: allResults,
      summary,
    }
    console.log(JSON.stringify(report, null, 2))
  } else {
    // Group by category
    let currentCategory = ''
    for (const r of allResults) {
      if (r.category !== currentCategory) {
        currentCategory = r.category
        console.log(`\n[${currentCategory.toUpperCase()}]`)
      }
      printCheck(r)
    }

    console.log('')
    if (summary.fail === 0 && summary.warn === 0) {
      console.log(`✅ All ${summary.pass} checks passed.`)
    } else if (summary.fail === 0) {
      console.log(`✅ ${summary.pass} passed, ⚠️  ${summary.warn} warning(s). No critical issues.`)
    } else {
      console.log(
        `❌ ${summary.fail} issue(s), ⚠️  ${summary.warn} warning(s), ✅ ${summary.pass} passed.`,
      )
    }
  }

  if (summary.fail > 0) {
    process.exit(1)
  }
}
