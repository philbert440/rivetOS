/**
 * One-time localStorage migration from the Tauri shell.
 *
 * The Tauri webview kept the hub's localStorage (node roster, active node,
 * session names, chat settings, agent bindings) in WebKitGTK's per-origin
 * sqlite store; the Electron shell's app://bundle origin starts empty, which
 * strands an upgrading device with no node connections. On first run the
 * main process reads the legacy sqlite (node:sqlite — no native deps) and
 * the preload seeds any `rivethub.*` key the new origin does not already
 * have. A marker file makes it once-ever; every failure path is silent —
 * a device with no Tauri history simply boots fresh.
 *
 * node:sqlite is experimental (warning on stderr, harmless); if the module
 * is ever absent the migration is skipped, never fatal.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** WebKitGTK's localStorage db for the Tauri origin (linux layout). */
export function legacySqlitePath(dataHome: string): string {
  return path.join(
    dataHome,
    'dev.rivetos.rivethub',
    'localstorage',
    'tauri_localhost_0.localstorage',
  )
}

/**
 * Read every `rivethub.*` key from a WebKit localStorage sqlite file.
 * Values are UTF-16LE blobs (WebKit stores DOMString bytes verbatim).
 */
export function readLegacyStorage(file: string): Record<string, string> {
  // Lazy require: keeps module load safe on a Node without node:sqlite.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db
      .prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'rivethub.%'")
      .all() as { key: string; value: Uint8Array | string | null }[]
    const out: Record<string, string> = {}
    for (const row of rows) {
      if (row.value == null) continue
      const text =
        typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf16le')
      // WebKit writes no BOM, but strip one defensively (escaped so a
      // non-ASCII source cleanup can never silently blank the pattern).
      out[row.key] = text.replace(/^\uFEFF/, '')
    }
    return out
  } finally {
    db.close()
  }
}

export interface MigrationHandle {
  /**
   * Hand the payload to the renderer — CONSUMES it: the marker is written
   * here, main-side, before the renderer touches storage, so once-ever
   * never depends on a second IPC leg that might not arrive (review
   * finding, PR #556). Null when nothing is pending.
   */
  consume: () => Record<string, string> | null
}

/**
 * Load the legacy payload once per install. `markerPath` lives in userData
 * so a reinstall re-offers the migration but a normal run never re-reads.
 * A FAILED read also writes the marker: retrying a garbage sqlite on every
 * launch is noise, not recovery.
 */
export function prepareMigration(markerPath: string, legacyFile: string): MigrationHandle {
  let payload: Record<string, string> | null = null
  const writeMarker = (note: string): void => {
    try {
      fs.writeFileSync(markerPath, `${note} ${new Date().toISOString()}\n`)
    } catch (e) {
      // Loud: an unwritable userData means the migration re-offers next
      // launch, and the roster merge would re-append nodes the user has
      // since deleted.
      console.error(
        `RivetHub: cannot write migration marker ${markerPath}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
  try {
    if (!fs.existsSync(markerPath) && fs.existsSync(legacyFile)) {
      const data = readLegacyStorage(legacyFile)
      if (Object.keys(data).length > 0) payload = data
      else writeMarker('empty')
    }
  } catch (e) {
    console.error(
      `RivetHub: tauri localStorage migration skipped: ${e instanceof Error ? e.message : String(e)}`,
    )
    writeMarker('failed')
  }
  return {
    consume: () => {
      const out = payload
      if (out !== null) {
        payload = null
        writeMarker('migrated')
      }
      return out
    },
  }
}
