/**
 * File-backed preset registry. The mutex, quarantine, load, and save helpers
 * moved here from den (`services/den-server/src/agents.ts`). den uses this
 * store directly when it has no Postgres, and as the fallback until
 * `ros_agent_presets` is ready.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrateAgentPreset, type AgentPreset } from '@rivetos/types'
import {
  findPresetByHandle,
  nameKey,
  presetFromCreate,
  presetFromPatch,
  PresetConflictError,
  sortPresets,
  type AgentPresetInput,
  type AgentPresetPatch,
  type AgentPresetStore,
} from './store.js'
import { isAgentPreset, isRecord } from './validate.js'

/**
 * In-process promise-chain mutex. Serializes registry RMW so two tabs
 * cannot drop each other's writes. Same shape as mesh-devices.
 */
function makeMutex(): <T>(fn: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

interface Registry {
  agents: AgentPreset[]
}

function quarantineCorrupt(file: string, reason: string): Registry {
  const dest = `${file}.corrupt-${Date.now()}`
  try {
    if (existsSync(file)) renameSync(file, dest)
    console.warn(`[den-server] agents.json ${reason}; quarantined to ${dest}`)
  } catch (err) {
    console.warn(
      `[den-server] agents.json ${reason}; quarantine rename failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return { agents: [] }
}

/**
 * `sortOrder` is cosmetic. A non-integer (a string, a float, null) must not
 * fail `isAgentPreset` — that filter drops the whole preset on the next write.
 * Integers stay. Every other field is still strict.
 */
function withoutInvalidSortOrder(row: unknown): unknown {
  if (!isRecord(row) || !('sortOrder' in row)) return row
  const sortOrder = row.sortOrder
  if (typeof sortOrder === 'number' && Number.isInteger(sortOrder)) return row
  const next = { ...row }
  delete next.sortOrder
  return next
}

function loadRegistry(file: string): Registry {
  if (!existsSync(file)) return { agents: [] }
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(raw) || !Array.isArray(raw.agents)) {
      return quarantineCorrupt(file, 'shape invalid')
    }
    return {
      agents: (raw.agents as unknown[])
        .map((row): unknown => {
          const cleaned = withoutInvalidSortOrder(row)
          return isAgentPreset(cleaned) ? migrateAgentPreset(cleaned) : cleaned
        })
        .filter(isAgentPreset),
    }
  } catch {
    return quarantineCorrupt(file, 'parse failed')
  }
}

function saveRegistry(file: string, reg: Registry): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

function assertNameAvailable(
  presets: readonly AgentPreset[],
  name: string,
  exceptId?: string,
): void {
  const key = nameKey(name)
  const clash = presets.find((preset) => preset.id !== exceptId && nameKey(preset.name) === key)
  if (clash) throw new PresetConflictError(`agent name already exists: ${name.trim()}`)
}

export interface FileAgentPresetStoreOptions {
  now?: () => number
}

export class FileAgentPresetStore implements AgentPresetStore {
  readonly backend = 'file' as const
  private readonly now: () => number
  private readonly mutex: <T>(fn: () => T | Promise<T>) => Promise<T>

  constructor(
    readonly file: string,
    opts?: FileAgentPresetStoreOptions,
  ) {
    this.now = opts?.now ?? Date.now
    this.mutex = makeMutex()
  }

  isReady(): Promise<boolean> {
    return Promise.resolve(true)
  }

  list(filter?: { node?: string }): Promise<AgentPreset[]> {
    const { agents } = loadRegistry(this.file)
    const filtered =
      filter?.node === undefined ? agents : agents.filter((agent) => agent.node === filter.node)
    return Promise.resolve(sortPresets(filtered))
  }

  get(id: string): Promise<AgentPreset | undefined> {
    return Promise.resolve(loadRegistry(this.file).agents.find((agent) => agent.id === id))
  }

  findByHandle(handle: string): Promise<AgentPreset | undefined> {
    return Promise.resolve(findPresetByHandle(loadRegistry(this.file).agents, handle))
  }

  create(input: AgentPresetInput & { id?: string; createdAt?: number }): Promise<AgentPreset> {
    return this.mutex(() => {
      const reg = loadRegistry(this.file)
      const preset = presetFromCreate(input, { id: randomUUID(), now: this.now() })
      if (reg.agents.some((agent) => agent.id === preset.id)) {
        throw new PresetConflictError(`agent id already exists: ${preset.id}`)
      }
      assertNameAvailable(reg.agents, preset.name)
      reg.agents.push(preset)
      saveRegistry(this.file, reg)
      return preset
    })
  }

  update(id: string, patch: AgentPresetPatch): Promise<AgentPreset | undefined> {
    return this.mutex(() => {
      const reg = loadRegistry(this.file)
      const index = reg.agents.findIndex((agent) => agent.id === id)
      if (index < 0) return undefined
      const current = reg.agents[index]
      const next = presetFromPatch(current, patch, this.now())
      assertNameAvailable(reg.agents, next.name, id)
      reg.agents[index] = next
      saveRegistry(this.file, reg)
      return next
    })
  }

  delete(id: string): Promise<boolean> {
    return this.mutex(() => {
      const reg = loadRegistry(this.file)
      const next = reg.agents.filter((agent) => agent.id !== id)
      if (next.length === reg.agents.length) return false
      saveRegistry(this.file, { agents: next })
      return true
    })
  }
}
