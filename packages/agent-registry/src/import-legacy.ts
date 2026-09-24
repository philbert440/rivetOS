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
   * materializes a directory for each of these and no others.
   */
  rows?: AgentPreset[]
}

/**
 * One-shot import of a den `agents.json` into `store`. An id or name conflict
 * is skipped and logged. The source file is renamed to
 * `<file>.imported-<epoch ms>` and never deleted. A missing file is a no-op.
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
    try {
      // `create` keeps `createdAt` and stamps `updatedAt` at import time.
      const created = await store.create({
        ...row,
        id: row.id,
        createdAt: row.createdAt,
        node,
        directory,
      })
      importedRows.push(created)
      imported += 1
    } catch (err) {
      if (err instanceof PresetConflictError) {
        skipped += 1
        log?.(`skipped legacy agent ${row.id} (${row.name}): ${err.message}`)
        continue
      }
      throw err
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
