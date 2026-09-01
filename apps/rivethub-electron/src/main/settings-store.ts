/**
 * Settings persistence — the source-of-truth JSON file in userData that
 * survives Chromium localStorage wipes. On boot, hydrate the renderer's
 * localStorage from the file when the store is empty; persist writes back
 * to the file immediately. Tauri sqlite fallback when the JSON is also
 * missing (one-time migration from the legacy shell).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { App } from 'electron'

export interface Settings {
  [key: string]: unknown
}

/** Keys that RivetHub settings use (rivethub.* namespace). */
const SETTINGS_KEYS = [
  'rivethub.baseUrl',
  'rivethub.roster',
  'rivethub.wikiUrl',
  'rivethub.theme',
  'rivethub.chatSettings',
  'rivethub.sessionNames',
  'rivethub.remoteUi',
  'rivethub.agent.lastSession',
] as const

export class SettingsStore {
  private readonly settingsPath: string
  private readonly tauriDbPath: string
  private settings: Settings = {}

  constructor(app: App) {
    const userData = app.getPath('userData')
    this.settingsPath = path.join(userData, 'settings.json')
    // Tauri shell's config dir — fallback for migration
    this.tauriDbPath = path.join(
      app.getPath('appData'),
      'dev.rivetos.rivethub',
      'rivethub.db',
    )
    this.load()
  }

  /** Load settings from the JSON file, falling back to Tauri sqlite if needed. */
  private load(): void {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const raw = fs.readFileSync(this.settingsPath, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.settings = parsed as Settings
          return
        }
      }
    } catch {
      /* file corrupt or unreadable — try Tauri fallback */
    }

    // Tauri sqlite fallback: one-time migration from the legacy shell
    try {
      if (fs.existsSync(this.tauriDbPath)) {
        this.settings = this.loadFromTauriSqlite()
        this.save() // persist the migration
      }
    } catch {
      /* Tauri db also missing or unreadable — start empty */
    }
  }

  /** One-time migration: read settings from Tauri's sqlite store. */
  private loadFromTauriSqlite(): Settings {
    // Tauri's plugin-store writes a sqlite db; the kv table has key/value
    // columns both TEXT. This is a best-effort read: if the db is locked,
    // corrupt, or shaped differently, we bail to empty.
    try {
      // Lazy-load better-sqlite3 only when needed (not a prod dependency)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3')
      const db = new Database(this.tauriDbPath, { readonly: true })
      const rows: Array<{ key: string; value: string }> = db
        .prepare('SELECT key, value FROM kv WHERE key LIKE ?')
        .all('rivethub.%')
      db.close()

      const settings: Settings = {}
      for (const { key, value } of rows) {
        try {
          settings[key] = JSON.parse(value)
        } catch {
          // value is not JSON — store it as a string
          settings[key] = value
        }
      }
      return settings
    } catch {
      return {}
    }
  }

  /** Save settings to the JSON file. */
  private save(): void {
    try {
      const dir = path.dirname(this.settingsPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8')
    } catch {
      /* storage full / disabled — keep the in-memory value */
    }
  }

  /** Get a single setting value. */
  get(key: string): unknown {
    return this.settings[key]
  }

  /** Set a single setting value and persist. */
  set(key: string, value: unknown): void {
    this.settings[key] = value
    this.save()
  }

  /** Get all settings (for boot-time hydration). */
  getAll(): Settings {
    return { ...this.settings }
  }

  /** Batch-set multiple settings and persist once. */
  setAll(updates: Settings): void {
    this.settings = { ...this.settings, ...updates }
    this.save()
  }

  /** Clear a single setting and persist. */
  remove(key: string): void {
    delete this.settings[key]
    this.save()
  }
}
