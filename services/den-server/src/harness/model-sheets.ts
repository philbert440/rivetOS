/**
 * Per-harness model/effort capability sheets.
 *
 * Pure: file readers are injected so grok's models_cache.json and kimi's
 * config.toml can be unit-tested without touching the real home directory.
 * Config overrides (`tasks.harnesses.<id>.models` / `.efforts`) REPLACE the
 * sheet's lists when present as a non-empty sanitized array; malformed
 * entries are dropped, and an empty result keeps the sheet.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { EffortOption, HarnessId, HarnessModelOption } from '@rivetos/types'

/** Token accepted on POST /term `model` / `effort` and as a sheet id. */
export const MODEL_EFFORT_TOKEN_RE = /^[A-Za-z0-9._[\]:-]{1,64}$/

export type ReadJson = (path: string) => unknown
export type ReadText = (path: string) => string

export interface SheetReaders {
  readJson?: ReadJson
  readText?: ReadText
  home?: string
}

export interface ModelSheet {
  models?: HarnessModelOption[]
  efforts?: EffortOption[]
  modelFlag?: string
  effortFlag?: string
}

export interface SheetOverride {
  models?: unknown
  efforts?: unknown
}

export const ROSTER_TO_HARNESS: Record<string, HarnessId> = {
  claude: 'claude-code',
  grok: 'grok-build',
  kimi: 'kimi-code',
  hermes: 'hermes',
  dsh: 'deepseek-harness',
}

const CLAUDE_EFFORTS: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium', default: true },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'X-High' },
  { id: 'max', label: 'Max' },
]

const GROK_FALLBACK_EFFORTS: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High', default: true },
  { id: 'xhigh', label: 'X-High' },
]

const HERMES_EFFORTS: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium', default: true },
  { id: 'high', label: 'High' },
]

function defaultReadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function defaultReadText(path: string): string {
  return readFileSync(path, 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Drop malformed effort rows; id must be a token, label defaults to id. */
export function sanitizeEfforts(raw: unknown): EffortOption[] {
  if (!Array.isArray(raw)) return []
  const out: EffortOption[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue
    const id = entry.id.trim()
    if (!MODEL_EFFORT_TOKEN_RE.test(id)) continue
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id
    const opt: EffortOption = { id, label }
    if (entry.default === true) opt.default = true
    out.push(opt)
  }
  return out
}

/** Drop malformed model rows; nested efforts are sanitized the same way. */
export function sanitizeModels(raw: unknown): HarnessModelOption[] {
  if (!Array.isArray(raw)) return []
  const out: HarnessModelOption[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue
    const id = entry.id.trim()
    if (!MODEL_EFFORT_TOKEN_RE.test(id)) continue
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id
    const opt: HarnessModelOption = { id, label }
    if (entry.default === true) opt.default = true
    if (entry.efforts !== undefined) {
      const efforts = sanitizeEfforts(entry.efforts)
      if (efforts.length > 0) opt.efforts = efforts
    }
    out.push(opt)
  }
  return out
}

/**
 * Config override replaces the sheet's models and/or efforts when the
 * override actually carries that key as an array. A non-array value is
 * ignored (keep the sheet). An array that sanitizes to empty is also
 * ignored (keep the sheet) and logged when a sink is provided.
 */
export function applySheetOverride(
  sheet: ModelSheet,
  override?: SheetOverride,
  log?: (msg: string) => void,
): ModelSheet {
  if (!override) return sheet
  const next: ModelSheet = { ...sheet }
  if (Array.isArray(override.models)) {
    const models = sanitizeModels(override.models)
    if (models.length === 0) {
      log?.('[den-server] harness sheet: ignoring empty models override (keeping sheet list)')
    } else {
      next.models = models
    }
  }
  if (Array.isArray(override.efforts)) {
    const efforts = sanitizeEfforts(override.efforts)
    if (efforts.length === 0) {
      log?.('[den-server] harness sheet: ignoring empty efforts override (keeping sheet list)')
    } else {
      next.efforts = efforts
    }
  }
  return next
}

export function claudeSheet(): ModelSheet {
  return {
    models: [
      { id: 'fable', label: 'Fable 5.1', default: true },
      { id: 'opus', label: 'Opus 5' },
      { id: 'sonnet', label: 'Sonnet 5' },
      { id: 'haiku', label: 'Haiku 4.5' },
      { id: 'fable[1m]', label: 'Fable 5.1 1M context' },
      { id: 'opus[1m]', label: 'Opus 5 1M context' },
      { id: 'sonnet[1m]', label: 'Sonnet 5 1M context' },
    ],
    efforts: CLAUDE_EFFORTS,
    modelFlag: '--model',
    effortFlag: '--effort',
  }
}

/**
 * Parse `~/.grok/models_cache.json`. Hidden models are dropped; the first
 * remaining entry is marked default. Unreadable cache → grok-4.6 fallback.
 */
export function grokSheet(
  readJson: ReadJson = defaultReadJson,
  home: string = homedir(),
): ModelSheet {
  const fallback: ModelSheet = {
    models: [{ id: 'grok-4.6', label: 'grok-4.6', default: true, efforts: GROK_FALLBACK_EFFORTS }],
    efforts: GROK_FALLBACK_EFFORTS,
    modelFlag: '--model',
    effortFlag: '--reasoning-effort',
  }
  let raw: unknown
  try {
    raw = readJson(join(home, '.grok', 'models_cache.json'))
  } catch {
    return fallback
  }
  const bag = grokModelsBag(raw)
  if (!bag) return fallback
  const models: HarnessModelOption[] = []
  for (const [id, entry] of Object.entries(bag)) {
    if (!isRecord(entry)) continue
    const info = isRecord(entry.info) ? entry.info : entry
    if (info.hidden === true) continue
    if (!MODEL_EFFORT_TOKEN_RE.test(id)) continue
    const label = typeof info.name === 'string' && info.name.trim() ? info.name.trim() : id
    const opt: HarnessModelOption = { id, label, default: false }
    if (info.supports_reasoning_effort !== false && Array.isArray(info.reasoning_efforts)) {
      const efforts = sanitizeEfforts(info.reasoning_efforts)
      if (efforts.length > 0) opt.efforts = efforts
    }
    models.push(opt)
  }
  if (models.length === 0) return fallback
  models[0].default = true
  return {
    models,
    efforts: models[0].efforts,
    modelFlag: '--model',
    effortFlag: '--reasoning-effort',
  }
}

function grokModelsBag(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined
  if (isRecord(raw.models)) return raw.models
  // Bare id → { info } map (no `models` wrapper).
  const values = Object.values(raw)
  if (values.length > 0 && values.every((v) => isRecord(v) && (isRecord(v.info) || 'name' in v))) {
    return raw
  }
  return undefined
}

/**
 * Parse kimi's config.toml for `default_model` and `[models.<alias>]`
 * tables. Config missing → `models: []`. No effort flag.
 */
export function kimiSheet(
  readText: ReadText = defaultReadText,
  home: string = homedir(),
): ModelSheet {
  const empty: ModelSheet = { models: [], modelFlag: '--model' }
  const paths = [
    join(home, '.kimi', 'config.toml'),
    join(home, '.config', 'kimi', 'config.toml'),
    join(home, '.kimi-code', 'config.toml'),
  ]
  for (const path of paths) {
    let text: string
    try {
      text = readText(path)
    } catch {
      continue
    }
    return { models: parseKimiToml(text), modelFlag: '--model' }
  }
  return empty
}

/** Tiny line parser: `default_model = "…"` and `[models.<alias>]` headers. */
export function parseKimiToml(text: string): HarnessModelOption[] {
  let defaultModel = ''
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const def = line.match(/^default_model\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/)
    if (def) {
      defaultModel = (def[1] ?? def[2] ?? def[3] ?? '').trim()
      continue
    }
    const hdr = line.match(/^\[models(?:\.("([^"]+)"|'([^']+)'|([^.\]]+)))?\]$/)
    if (hdr) {
      const alias = (hdr[2] ?? hdr[3] ?? hdr[4] ?? '').trim()
      if (alias && MODEL_EFFORT_TOKEN_RE.test(alias) && !seen.has(alias)) {
        seen.add(alias)
        aliases.push(alias)
      }
    }
  }
  if (defaultModel && MODEL_EFFORT_TOKEN_RE.test(defaultModel) && !seen.has(defaultModel)) {
    aliases.unshift(defaultModel)
    seen.add(defaultModel)
  }
  return aliases.map((id) => ({
    id,
    label: id,
    default: defaultModel !== '' && id === defaultModel,
  }))
}

/**
 * Hermes owns its own model picker (v1: we do not advertise models).
 * Effort is `--reasoning` low/medium/high.
 */
export function hermesSheet(): ModelSheet {
  return {
    models: [],
    efforts: HERMES_EFFORTS,
    effortFlag: '--reasoning',
  }
}

/** DeepSeek Harness — no queryable list in v1. */
export function deepseekSheet(): ModelSheet {
  return {}
}

export function sheetForHarness(harnessId: HarnessId, readers?: SheetReaders): ModelSheet {
  const home = readers?.home
  const readJson = readers?.readJson
  const readText = readers?.readText
  switch (harnessId) {
    case 'claude-code':
      return claudeSheet()
    case 'grok-build':
      return grokSheet(readJson, home)
    case 'kimi-code':
      return kimiSheet(readText, home)
    case 'hermes':
      return hermesSheet()
    case 'deepseek-harness':
      return deepseekSheet()
  }
}

export function sheetForRosterCommand(
  command: string,
  overrides?: Record<string, SheetOverride | undefined>,
  readers?: SheetReaders,
): ModelSheet | undefined {
  const harnessId = ROSTER_TO_HARNESS[command]
  if (!harnessId) return undefined
  return applySheetOverride(sheetForHarness(harnessId, readers), overrides?.[harnessId])
}

function effortIdsFor(sheet: ModelSheet, modelId?: string): string[] {
  const model = modelId ? sheet.models?.find((m) => m.id === modelId) : undefined
  const efforts = model?.efforts ?? sheet.efforts
  return efforts?.map((e) => e.id) ?? []
}

/**
 * Append `[modelFlag, model]` / `[effortFlag, effort]` when the sheet has
 * that flag AND the value is a listed id. Unknown values are omitted
 * (never crash a spawn).
 */
export function appendModelEffortArgv(
  argv: string[],
  sheet: ModelSheet | undefined,
  model?: string,
  effort?: string,
  log?: (msg: string) => void,
): string[] {
  if (!sheet) return argv
  const out = [...argv]
  const modelOk =
    typeof model === 'string' &&
    MODEL_EFFORT_TOKEN_RE.test(model) &&
    !!sheet.modelFlag &&
    !!sheet.models?.some((m) => m.id === model)
  if (modelOk && sheet.modelFlag && model) {
    out.push(sheet.modelFlag, model)
  } else if (model && log) {
    log(`[den-server] spawn: omitting model ${JSON.stringify(model)} (unknown or no flag)`)
  }
  const effortOk =
    typeof effort === 'string' &&
    MODEL_EFFORT_TOKEN_RE.test(effort) &&
    !!sheet.effortFlag &&
    effortIdsFor(sheet, modelOk ? model : undefined).includes(effort)
  if (effortOk && sheet.effortFlag && effort) {
    out.push(sheet.effortFlag, effort)
  } else if (effort && log) {
    log(`[den-server] spawn: omitting effort ${JSON.stringify(effort)} (unknown or no flag)`)
  }
  return out
}
