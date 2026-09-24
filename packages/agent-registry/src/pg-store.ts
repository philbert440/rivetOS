import {
  CATALOG_AGENT_TO_HARNESS,
  HARNESS_IDS,
  migrateAgentPreset,
  type AgentPreset,
  type HarnessId,
} from '@rivetos/types'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import {
  findPresetByHandle,
  presetFromCreate,
  PresetConflictError,
  type AgentPresetInput,
  type AgentPresetPatch,
  type AgentPresetStore,
} from './store.js'
import { isHarnessId } from './validate.js'

/**
 * DataHub preset table (`ros_agent_presets`). Never creates the table —
 * migration 0017 does. Every mutation is one `pool.query` (no named
 * prepares, no LISTEN) so embedded PGlite and several dens can share it.
 * The SET list is built from the patch; the row is not read-modify-written.
 */

export interface PgAgentPresetStoreOptions {
  now?: () => number
}

interface PresetRow {
  id: string
  name: string
  color: string
  harness_id: string | null
  model: string
  effort: string
  system_prompt: string
  node: string
  directory: string
  shared_link: boolean
  node_base_url: string
  created_at: Date | string
  updated_at: Date | string
}

type QueryParam = string | number | boolean | Date | null

function assertPool(pool: pg.Pool): pg.Pool {
  if (typeof pool.query !== 'function') {
    throw new TypeError(`PgAgentPresetStore expected a pg.Pool (${pg.Pool.name})`)
  }
  return pool
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  return err.code === '23505'
}

function conflictMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('constraint' in err)) {
    return 'agent preset conflicts with an existing id or name'
  }
  return typeof err.constraint === 'string'
    ? `agent preset conflicts with an existing id or name (${err.constraint})`
    : 'agent preset conflicts with an existing id or name'
}

function rethrow(err: unknown): never {
  if (isUniqueViolation(err)) throw new PresetConflictError(conflictMessage(err))
  throw err
}

function epochMs(value: Date | string): number {
  if (value instanceof Date) return value.getTime()
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`invalid preset timestamp: ${value}`)
  return parsed
}

function rowToPreset(row: PresetRow): AgentPreset {
  const preset: AgentPreset = {
    id: row.id,
    name: row.name,
    color: row.color,
    model: row.model,
    effort: row.effort,
    systemPrompt: row.system_prompt,
    node: row.node,
    directory: row.directory,
    sharedLink: row.shared_link,
    nodeBaseUrl: row.node_base_url,
    createdAt: epochMs(row.created_at),
    updatedAt: epochMs(row.updated_at),
  }
  const harness = row.harness_id
  if (harness && isHarnessId(harness)) preset.harnessId = harness
  return migrateAgentPreset(preset)
}

/** SQL string literal. Tokens come from HARNESS_IDS / the catalog map, never from user input. */
function sqlString(value: string): string {
  if (!/^[a-z0-9.-]+$/.test(value)) throw new Error(`refusing to embed ${value} in SQL`)
  return `'${value}'`
}

/**
 * `CASE <modelExpr> WHEN 'claude' THEN 'claude-code' … ELSE NULL END`,
 * matching `catalogAgentToHarness` (canonical harness ids win, then the catalog map).
 */
function harnessFromModelSql(modelExpr: string): string {
  const pairs = new Map<string, HarnessId>()
  for (const id of HARNESS_IDS) pairs.set(id, id)
  for (const [catalog, harness] of Object.entries(CATALOG_AGENT_TO_HARNESS)) {
    if (!pairs.has(catalog)) pairs.set(catalog, harness)
  }
  const whens: string[] = []
  for (const [model, harness] of pairs) {
    whens.push(`WHEN ${modelExpr} = ${sqlString(model)} THEN ${sqlString(harness)}`)
  }
  return `CASE ${whens.join(' ')} ELSE NULL END`
}

export class PgAgentPresetStore implements AgentPresetStore {
  readonly backend = 'postgres' as const
  private readonly pool: pg.Pool
  private readonly now: () => number
  /** A true result is cached. False is not — the table may appear later. */
  private ready = false

  constructor(pool: pg.Pool, opts?: PgAgentPresetStoreOptions) {
    this.pool = assertPool(pool)
    this.now = opts?.now ?? Date.now
  }

  async isReady(): Promise<boolean> {
    if (this.ready) return true
    const result = await this.pool.query<{ reg: string | null }>(
      `SELECT to_regclass('ros_agent_presets') AS reg`,
    )
    const ok = result.rows[0]?.reg != null
    if (ok) this.ready = true
    return ok
  }

  async list(filter?: { node?: string }): Promise<AgentPreset[]> {
    const result = await this.pool.query<PresetRow>(
      `SELECT * FROM ros_agent_presets
       WHERE ($1::text IS NULL OR node = $1)
       ORDER BY created_at ASC, id ASC`,
      [filter?.node ?? null],
    )
    return result.rows.map(rowToPreset)
  }

  async get(id: string): Promise<AgentPreset | undefined> {
    const result = await this.pool.query<PresetRow>(
      `SELECT * FROM ros_agent_presets WHERE id = $1`,
      [id],
    )
    if (result.rows.length === 0) return undefined
    return rowToPreset(result.rows[0])
  }

  async findByHandle(handle: string): Promise<AgentPreset | undefined> {
    const trimmed = handle.trim()
    const result = await this.pool.query<PresetRow>(
      `SELECT * FROM ros_agent_presets
       WHERE id = $1 OR name = $1 OR lower(name) = lower($1)`,
      [trimmed],
    )
    return findPresetByHandle(
      result.rows.map((row) => rowToPreset(row)),
      trimmed,
    )
  }

  async create(
    input: AgentPresetInput & { id?: string; createdAt?: number },
  ): Promise<AgentPreset> {
    const preset = presetFromCreate(input, { id: input.id ?? randomUUID(), now: this.now() })
    const node = preset.node
    const directory = preset.directory
    if (node === undefined || directory === undefined) {
      throw new Error('agent preset node and directory are required')
    }
    try {
      const result = await this.pool.query<PresetRow>(
        `INSERT INTO ros_agent_presets (
           id, name, color, harness_id, model, effort, system_prompt,
           node, directory, shared_link, node_base_url, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          preset.id,
          preset.name,
          preset.color,
          preset.harnessId ?? null,
          preset.model,
          preset.effort,
          preset.systemPrompt,
          node,
          directory,
          preset.sharedLink ?? true,
          // Still persisted for pre-registry clients; the field is deprecated on the type.
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          preset.nodeBaseUrl,
          new Date(preset.createdAt),
          new Date(preset.updatedAt),
        ],
      )
      if (result.rows.length === 0) throw new Error('insert returned no row')
      return rowToPreset(result.rows[0])
    } catch (err) {
      rethrow(err)
    }
  }

  async update(id: string, patch: AgentPresetPatch): Promise<AgentPreset | undefined> {
    const sets: string[] = []
    const params: QueryParam[] = []
    const bind = (value: QueryParam): string => {
      params.push(value)
      return `$${params.length}`
    }
    const set = (column: string, value: QueryParam): void => {
      sets.push(`${column} = ${bind(value)}`)
    }
    const setExpr = (column: string, expr: string): void => {
      sets.push(`${column} = ${expr}`)
    }

    if (patch.name !== undefined) set('name', patch.name.trim())
    if (patch.color !== undefined) set('color', patch.color)
    if (patch.effort !== undefined) set('effort', patch.effort)
    if (patch.systemPrompt !== undefined) set('system_prompt', patch.systemPrompt)
    if (patch.directory !== undefined) set('directory', patch.directory)
    if (patch.sharedLink !== undefined) set('shared_link', patch.sharedLink)

    if (patch.harnessId === null && patch.model !== undefined) {
      const migrated = migrateAgentPreset<{ model: string; harnessId?: HarnessId }>({
        model: patch.model,
      })
      set('model', migrated.model)
      set('harness_id', migrated.harnessId ?? null)
    } else if (patch.harnessId === null) {
      const mapped = harnessFromModelSql('model')
      setExpr('model', `CASE WHEN (${mapped}) IS NOT NULL THEN '' ELSE model END`)
      setExpr('harness_id', mapped)
    } else if (typeof patch.harnessId === 'string') {
      set('harness_id', patch.harnessId)
      if (patch.model !== undefined) set('model', patch.model)
    } else if (patch.model !== undefined) {
      const migrated = migrateAgentPreset<{ model: string; harnessId?: HarnessId }>({
        model: patch.model,
      })
      const modelParam = bind(patch.model)
      const migratedModel = bind(migrated.model)
      const migratedHarness = bind(migrated.harnessId ?? null)
      setExpr(
        'model',
        `CASE WHEN harness_id IS NOT NULL THEN ${modelParam} ELSE ${migratedModel} END`,
      )
      setExpr(
        'harness_id',
        `CASE WHEN harness_id IS NOT NULL THEN harness_id ELSE ${migratedHarness} END`,
      )
    }

    set('updated_at', new Date(this.now()))
    const idParam = bind(id)
    try {
      const result = await this.pool.query<PresetRow>(
        `UPDATE ros_agent_presets SET ${sets.join(', ')} WHERE id = ${idParam} RETURNING *`,
        params,
      )
      if (result.rows.length === 0) return undefined
      return rowToPreset(result.rows[0])
    } catch (err) {
      rethrow(err)
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query<{ id: string }>(
      `DELETE FROM ros_agent_presets WHERE id = $1 RETURNING id`,
      [id],
    )
    return result.rows.length > 0
  }
}
