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
      // WebKit writes no BOM, but strip one defensively.
      out[row.key] = text.replace(/^﻿/, '')
    }
    return out
  } finally {
    db.close()
  }
}

export interface MigrationHandle {
  /** Payload for the preload to seed, or null when nothing is pending. */
  pending: () => Record<string, string> | null
  /** The renderer finished seeding — write the marker, drop the payload. */
  markDone: () => void
}

/**
 * Load the legacy payload once per install. `markerPath` lives in userData
 * so a reinstall re-offers the migration but a normal run never re-reads.
 */
export function prepareMigration(markerPath: string, legacyFile: string): MigrationHandle {
  let payload: Record<string, string> | null = null
  try {
    if (!fs.existsSync(markerPath) && fs.existsSync(legacyFile)) {
      const data = readLegacyStorage(legacyFile)
      if (Object.keys(data).length > 0) payload = data
    }
  } catch (e) {
    console.error(
      `RivetHub: tauri localStorage migration skipped: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  return {
    pending: () => payload,
    markDone: () => {
      payload = null
      try {
        fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`)
      } catch {
        /* marker failing just means a redundant (idempotent) re-offer */
      }
    },
  }
}
