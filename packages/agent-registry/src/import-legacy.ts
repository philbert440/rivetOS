import { existsSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentPreset } from '@rivetos/types'
import { FileAgentPresetStore } from './file-store.js'
import { PresetConflictError, type AgentPresetStore } from './store.js'
import { defaultDirectoryFor, validateDirectory } from './validate.js'

export interface ImportLegacyAgentsArgs {
  file: string
  store: AgentPresetStore
  /** Mesh node NAME stamped onto every imported row. */
  node: string
  /** Parent directory used when a legacy row has no `directory`. */
  directoryRoot: string
  log?: (msg: string) => void
}

export interface ImportLegacyAgentsResult {
  imported: number
  skipped: number
  /** Set when the source file was renamed aside. Never deleted. */
  renamedTo?: string
  /** Set when the import was refused (the store file is the source). */
  reason?: string
  /**
   * Presets written by this import. Omitted when the import returns before
   * reading rows (missing file, or the store file is the source). The den
   * materializes every preset hosted on this node (`list({node})`), not only
   * these rows — an id skipped after a crash still gets its directory.
   */
  rows?: AgentPreset[]
}

/** Id conflicts are skipped. Name conflicts are imported under a disambiguated name. */
function isIdConflict(err: PresetConflictError): boolean {
  const message = err.message
  if (message.startsWith('agent id already exists')) return true
  if (message.startsWith('agent name already exists')) return false
  if (message.includes('idx_ros_agent_presets_name')) return false
  return /_pkey\b/.test(message) || message.includes('primary key')
}

/**
 * One-shot import of a den `agents.json` into `store`. An id conflict is
 * skipped and logged. A name conflict (PG's case-insensitive unique name,
 * which the old per-node file den did not enforce) is imported as
 * `"<name> (<node>)"`, then `"<name> (<node> 2)"`, and so on, and logged.
 * The source file is renamed to `<file>.imported-<epoch ms>` and never
 * deleted. A missing file is a no-op.
 */
export async function importLegacyAgentsJson(
  args: ImportLegacyAgentsArgs,
): Promise<ImportLegacyAgentsResult> {
  const { file, store, node, directoryRoot, log } = args
  if (!existsSync(file)) return { imported: 0, skipped: 0 }

  // Slice 2 falls back to the file store and fire-and-forgets this import
  // against the same agents.json. Renaming that file would drop the live registry.
  // `store.file` (not `instanceof`) so a fallback wrapper in file mode is refused
  // too — a wrapper is not a FileAgentPresetStore. The den passes the primary
  // store, never the wrapper; this is belt-and-braces.
  if (
    store.backend === 'file' &&
    store.file !== undefined &&
    resolve(store.file) === resolve(file)
  ) {
    return { imported: 0, skipped: 0, reason: 'store is the source file' }
  }

  const legacy = new FileAgentPresetStore(file)
  const rows = await legacy.list()
  let imported = 0
  let skipped = 0
  const importedRows: AgentPreset[] = []
  for (const row of rows) {
    const validated = validateDirectory(row.directory)
    const directory = validated ?? defaultDirectoryFor(directoryRoot, row.name)
    if (validated === undefined) {
      log?.(
        `legacy agent ${row.id} (${row.name}): directory missing or invalid; using ${directory}`,
      )
    }
    // Same id on every attempt so a name rewrite cannot mint a second row for
    // one legacy preset. Only an id collision gives up.
    const baseName = row.name.trim()
    let importedRow = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate =
        attempt === 0
          ? baseName
          : attempt === 1
            ? `${baseName} (${node})`
            : `${baseName} (${node} ${String(attempt)})`
      try {
        // `create` keeps `createdAt` and stamps `updatedAt` at import time.
        const created = await store.create({
          ...row,
          id: row.id,
          name: candidate,
          createdAt: row.createdAt,
          node,
          directory,
        })
        if (attempt > 0) {
          log?.(
            `imported legacy agent ${row.id} (${baseName}) as "${created.name}" after a name conflict`,
          )
        }
        importedRows.push(created)
        imported += 1
        importedRow = true
        break
      } catch (err) {
        if (!(err instanceof PresetConflictError)) throw err
        if (isIdConflict(err)) {
          skipped += 1
          log?.(`skipped legacy agent ${row.id} (${row.name}): ${err.message}`)
          importedRow = true
          break
        }
        log?.(`legacy agent ${row.id} (${baseName}) name conflict: ${err.message}`)
      }
    }
    if (!importedRow) {
      skipped += 1
      log?.(`skipped legacy agent ${row.id} (${baseName}): name still conflicts after 20 attempts`)
    }
  }

  const outcome: ImportLegacyAgentsResult = { imported, skipped, rows: importedRows }
  // A corrupt file is quarantined (renamed) by the file store on load.
  if (!existsSync(file)) {
    log?.(`legacy agents file ${file} was quarantined and not renamed to .imported`)
    return outcome
  }
  const renamedTo = `${file}.imported-${Date.now()}`
  renameSync(file, renamedTo)
  return { ...outcome, renamedTo }
}
