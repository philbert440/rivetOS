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
  requireAgentName,
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

/**
 * Runtime use of the `pg` package. A type-only `pg.Pool` annotation is erased,
 * so `@nx/dependency-checks` would treat the declared dependency as unused.
 * One package entry point means file-only consumers load `pg` too.
 */
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
  // A harness_id this build does not know (a newer den in a mixed-version
  // fleet) is dropped, so the preset reads as harness-less. migrateAgentPreset
  // may still map `model`. An older den must not invent a harness id.
  if (harness && isHarnessId(harness)) preset.harnessId = harness
  return migrateAgentPreset(preset)
}

/**
 * Scalar subquery: the harness `migrateAgentPreset` would assign when
 * `harnessId` is unset and `modelExpr` is a catalog agent id or a canonical
 * harness id; NULL otherwise.
 *
 * Reads `HARNESS_IDS` and `CATALOG_AGENT_TO_HARNESS` at runtime (canonical
 * ids win, then the catalog map) so a catalog-map change stays in sync with
 * `catalogAgentToHarness` — do not hand-copy the pairs. Bound parameters,
 * not embedded literals: a future key with `_` or uppercase must not break
 * the statement. `modelExpr` is a column reference, a `$n` placeholder, or a
 * parenthesized SQL expression built from those — never a raw value. VALUES
 * columns are not named `model`, so the outer `model` column is not shadowed.
 */
function harnessFromModelSql(modelExpr: string, bind: (value: string) => string): string {
  const pairs = new Map<string, HarnessId>()
  for (const id of HARNESS_IDS) pairs.set(id, id)
  for (const [catalog, harness] of Object.entries(CATALOG_AGENT_TO_HARNESS)) {
    if (!pairs.has(catalog)) pairs.set(catalog, harness)
  }
  const rows = [...pairs]
    .map(([model, harness]) => `(${bind(model)}::text, ${bind(harness)}::text)`)
    .join(', ')
  return `(SELECT v.harness FROM (VALUES ${rows}) AS v(catalog_model, harness) WHERE v.catalog_model = ${modelExpr})`
}

/**
 * Read-migrated old row, matching a file-store load before `presetFromPatch`.
 * One `mapped(model)` so every branch shares the placeholders.
 *
 * `h' = harness_id IS NULL ? mapped(model) : harness_id`
 * `m' = (harness_id IS NULL AND mapped(model) IS NOT NULL) ? '' : model`
 *
 * Calling this binds parameters. The UPDATE must splice in at least one
 * fragment (both contain the same placeholders).
 */
function readMigratedRowSql(bind: (value: string) => string): { harness: string; model: string } {
  const mappedOld = harnessFromModelSql('model', bind)
  return {
    harness: `CASE WHEN harness_id IS NULL THEN ${mappedOld} ELSE harness_id END`,
    model: `CASE WHEN harness_id IS NULL AND (${mappedOld}) IS NOT NULL THEN '' ELSE model END`,
  }
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
          // Still persisted for pre-registry clients (formally deprecated in slice 7).
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

    if (patch.name !== undefined) set('name', requireAgentName(patch.name))
    if (patch.color !== undefined) set('color', patch.color)
    if (patch.effort !== undefined) set('effort', patch.effort)
    if (patch.systemPrompt !== undefined) set('system_prompt', patch.systemPrompt)
    if (patch.directory !== undefined) set('directory', patch.directory)
    if (patch.sharedLink !== undefined) set('shared_link', patch.sharedLink)

    if (patch.harnessId === null && patch.model !== undefined) {
      // The patch replaces both fields, so the old row is not read. Same as
      // clearing harnessId and then `migrateAgentPreset` on the patch model.
      const migrated = migrateAgentPreset<{ model: string; harnessId?: HarnessId }>({
        model: patch.model,
      })
      set('model', migrated.model)
      set('harness_id', migrated.harnessId ?? null)
    } else if (patch.harnessId === null) {
      // Clear harness, then migrate m'. h' is dropped on purpose.
      const migrated = readMigratedRowSql(bind)
      const mappedModel = harnessFromModelSql(`(${migrated.model})`, bind)
      setExpr('harness_id', mappedModel)
      setExpr(
        'model',
        `CASE WHEN (${mappedModel}) IS NOT NULL THEN '' ELSE (${migrated.model}) END`,
      )
    } else if (typeof patch.harnessId === 'string') {
      set('harness_id', patch.harnessId)
      if (patch.model !== undefined) set('model', patch.model)
      else {
        const migrated = readMigratedRowSql(bind)
        setExpr('model', `(${migrated.model})`)
      }
    } else if (patch.model !== undefined) {
      // SET expressions see the OLD row. Model-only replaces m' and keeps h':
      // a migrated harness stays, and the patch model is stored verbatim. A
      // still-empty harness migrates the new model. Same order as a file-store
      // read followed by `presetFromPatch`.
      const migrated = readMigratedRowSql(bind)
      const patchModel = bind(patch.model)
      const mappedPatch = harnessFromModelSql(patchModel, bind)
      setExpr('harness_id', `COALESCE((${migrated.harness}), ${mappedPatch})`)
      setExpr(
        'model',
        `CASE WHEN (${migrated.harness}) IS NOT NULL THEN ${patchModel} WHEN (${mappedPatch}) IS NOT NULL THEN '' ELSE ${patchModel} END`,
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
