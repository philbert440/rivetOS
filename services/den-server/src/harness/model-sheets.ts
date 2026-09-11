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

/**
 * Model id on POST /term and as a sheet id.
 * `/` is allowed (kimi `provider/model`); `..` is not (`../x` is rejected).
 */
export const MODEL_TOKEN_RE = /^(?!.*\.\.)[A-Za-z0-9._[\]:/-]{1,64}$/

/** Effort id — same charset as before; `/` stays out. */
export const EFFORT_TOKEN_RE = /^[A-Za-z0-9._[\]:-]{1,64}$/

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
  /**
   * Effort id → CLI flag value. Present + empty string omits the flag
   * (opencode medium → no `--variant`). Absent key → use the effort id.
   */
  effortArgValues?: Record<string, string>
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
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
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

/** Codex CLI reasoning efforts — same vocabulary as the #719 `codex-cli` provider. */
const CODEX_EFFORTS: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium', default: true },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'X-High' },
]

/** RivetOS effort ids for OpenCode `--variant`. medium omits the flag. */
const OPENCODE_EFFORTS: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium', default: true },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
]

const OPENCODE_EFFORT_ARGS: Record<string, string> = {
  low: 'minimal',
  medium: '',
  high: 'high',
  max: 'max',
  xhigh: 'max',
}

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
    if (!EFFORT_TOKEN_RE.test(id)) continue
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
    if (!MODEL_TOKEN_RE.test(id)) continue
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
    if (!MODEL_TOKEN_RE.test(id)) continue
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
 * Parse kimi's config.toml for `default_model` and `[models.<alias>]` /
 * `[models."<alias>"]` tables (alias may contain `/`). Config missing →
 * `models: []`. No effort flag.
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

/**
 * Tiny line parser: `default_model = "…"`, `[models.<bare>]` /
 * `[models."<alias>"]` (alias is anything except `"`), and `display_name`
 * inside those tables. `[[hooks]]`, `[providers.*]`, and other tables are
 * ignored.
 */
export function parseKimiToml(text: string): HarnessModelOption[] {
  let defaultModel = ''
  const aliases: string[] = []
  const labels = new Map<string, string>()
  const seen = new Set<string>()
  let current: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const def = line.match(/^default_model\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/)
    if (def) {
      defaultModel = (def[1] ?? def[2] ?? def[3] ?? '').trim()
      continue
    }
    const hdr = line.match(/^\[models\.("([^"]+)"|'([^']+)'|([^.\]]+))\]$/)
    if (hdr) {
      const alias = (hdr[2] ?? hdr[3] ?? hdr[4] ?? '').trim()
      if (alias && MODEL_TOKEN_RE.test(alias)) {
        current = alias
        if (!seen.has(alias)) {
          seen.add(alias)
          aliases.push(alias)
        }
      } else {
        current = null
      }
      continue
    }
    if (line.startsWith('[')) {
      current = null
      continue
    }
    if (!current) continue
    const dn = line.match(/^display_name\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/)
    if (dn) {
      const label = (dn[1] ?? dn[2] ?? '').trim()
      if (label) labels.set(current, label)
    }
  }
  if (defaultModel && MODEL_TOKEN_RE.test(defaultModel) && !seen.has(defaultModel)) {
    aliases.unshift(defaultModel)
    seen.add(defaultModel)
  }
  return aliases.map((id) => ({
    id,
    label: labels.get(id) ?? id,
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

/**
 * Codex — static sheet. The CLI's model list is not queryable here; `default`
 * is the picker placeholder. Effort ids match #719 (`low|medium|high|xhigh`).
 * No spawn flags: Codex effort is `-c model_reasoning_effort=…`, which does
 * not fit the two-token `[flag, value]` append, and `--model default` would
 * be a lie. Lane A2 / spawn follow-up can add real flags.
 */
export function codexSheet(): ModelSheet {
  return {
    models: [{ id: 'default', label: 'Default', default: true }],
    efforts: CODEX_EFFORTS,
  }
}

/**
 * Parse OpenCode's config JSON for a default `model` plus any
 * `provider.<id>.models` keys. Config lives at
 * `$XDG_CONFIG_HOME/opencode/opencode.json` else `~/.config/opencode/opencode.json`.
 * Spawn flags: `--model`, `--variant` (effort).
 */
export function opencodeSheet(
  readJson: ReadJson = defaultReadJson,
  home: string = homedir(),
): ModelSheet {
  const flags: Pick<ModelSheet, 'modelFlag' | 'effortFlag' | 'efforts' | 'effortArgValues'> = {
    modelFlag: '--model',
    effortFlag: '--variant',
    efforts: OPENCODE_EFFORTS,
    effortArgValues: OPENCODE_EFFORT_ARGS,
  }
  const empty: ModelSheet = { models: [], ...flags }
  const configRoot = process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  const paths = [
    join(configRoot, 'opencode', 'opencode.json'),
    join(configRoot, 'opencode', 'opencode.jsonc'),
  ]
  for (const path of paths) {
    let raw: unknown
    try {
      raw = readJson(path)
    } catch {
      continue
    }
    return { models: parseOpencodeConfig(raw), ...flags }
  }
  return empty
}

/** Top-level `model` (`provider/model`) plus `provider.<id>.models` keys. */
export function parseOpencodeConfig(raw: unknown): HarnessModelOption[] {
  if (!isRecord(raw)) return []
  const out: HarnessModelOption[] = []
  const seen = new Set<string>()
  const add = (id: string, isDefault: boolean): void => {
    const trimmed = id.trim()
    if (!trimmed || !MODEL_TOKEN_RE.test(trimmed) || seen.has(trimmed)) return
    seen.add(trimmed)
    const opt: HarnessModelOption = { id: trimmed, label: trimmed }
    if (isDefault) opt.default = true
    out.push(opt)
  }
  const defaultModel = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (defaultModel) add(defaultModel, true)
  if (isRecord(raw.provider)) {
    for (const [providerId, prov] of Object.entries(raw.provider)) {
      if (!isRecord(prov)) continue
      const models = prov.models
      if (isRecord(models)) {
        for (const modelId of Object.keys(models)) {
          add(`${providerId}/${modelId}`, `${providerId}/${modelId}` === defaultModel)
        }
      } else if (Array.isArray(models)) {
        for (const modelId of models) {
          if (typeof modelId === 'string') {
            add(`${providerId}/${modelId}`, `${providerId}/${modelId}` === defaultModel)
          }
        }
      }
    }
  }
  return out
}

/**
 * pi `--thinking` levels `off|minimal|low|medium|high|xhigh|max` mapped onto
 * RivetOS effort ids `low|medium|high|xhigh|max`. `off` is dropped; `minimal`
 * collapses to `low`. Spawn passes the RivetOS id (`--thinking high`), which
 * pi accepts natively.
 */
const PI_EFFORTS: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'X-High' },
  { id: 'max', label: 'Max' },
]

const PI_DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'

/**
 * Pi — default model from `~/.pi/agent/settings.json`
 * (`defaultProvider`/`defaultModel` → `provider/model`). If
 * `models-store.json` lists models, those are exposed; otherwise the settings
 * default (fleet: `deepseek/deepseek-v4-flash`) is the only row.
 */
export function piSheet(
  readJson: ReadJson = defaultReadJson,
  home: string = homedir(),
): ModelSheet {
  const agent = join(home, '.pi', 'agent')
  let defaultId = PI_DEFAULT_MODEL
  try {
    const settings = readJson(join(agent, 'settings.json'))
    if (isRecord(settings)) {
      const provider =
        typeof settings.defaultProvider === 'string' ? settings.defaultProvider.trim() : ''
      const model = typeof settings.defaultModel === 'string' ? settings.defaultModel.trim() : ''
      if (provider && model) defaultId = `${provider}/${model}`
      else if (model.includes('/')) defaultId = model
      else if (model) defaultId = provider ? `${provider}/${model}` : model
    }
  } catch {
    /* missing settings → fleet default */
  }

  const fromStore = piModelsFromStore(readJson, join(agent, 'models-store.json'))
  const models: HarnessModelOption[] =
    fromStore.length > 0
      ? fromStore
      : MODEL_TOKEN_RE.test(defaultId)
        ? [{ id: defaultId, label: defaultId, default: true, efforts: PI_EFFORTS }]
        : []
  const marked = models.find((m) => m.id === defaultId)
  if (marked) {
    for (const m of models) delete m.default
    marked.default = true
  } else if (models.length > 0) {
    models[0].default = true
  }
  for (const m of models) {
    if (!m.efforts) m.efforts = PI_EFFORTS
  }
  return {
    models,
    efforts: PI_EFFORTS,
    modelFlag: '--model',
    effortFlag: '--thinking',
  }
}

/** One models-store.json row: a model token or a loosely-shaped object. */
type PiModelEntry = string | Record<string, unknown>

function isPiModelEntryList(value: unknown): value is PiModelEntry[] {
  return Array.isArray(value)
}

function piModelsFromStore(readJson: ReadJson, path: string): HarnessModelOption[] {
  let raw: unknown
  try {
    raw = readJson(path)
  } catch {
    return []
  }
  const items: unknown[] = []
  if (isPiModelEntryList(raw)) items.push(...raw)
  else if (isRecord(raw) && isPiModelEntryList(raw.models)) items.push(...raw.models)
  else if (isRecord(raw)) {
    for (const [id, entry] of Object.entries(raw)) {
      if (id === 'models' || id === 'version') continue
      items.push(isRecord(entry) ? { id, ...entry } : { id })
    }
  }
  const out: HarnessModelOption[] = []
  for (const entry of items) {
    if (typeof entry === 'string') {
      if (MODEL_TOKEN_RE.test(entry)) out.push({ id: entry, label: entry })
      continue
    }
    if (!isRecord(entry)) continue
    const provider =
      typeof entry.provider === 'string'
        ? entry.provider
        : typeof entry.providerID === 'string'
          ? entry.providerID
          : ''
    const modelId =
      typeof entry.modelId === 'string'
        ? entry.modelId
        : typeof entry.model === 'string'
          ? entry.model
          : ''
    const rawId = typeof entry.id === 'string' ? entry.id.trim() : ''
    const id = rawId.includes('/')
      ? rawId
      : provider && modelId
        ? `${provider}/${modelId}`
        : rawId || modelId
    if (!id || !MODEL_TOKEN_RE.test(id)) continue
    const label =
      (typeof entry.name === 'string' && entry.name.trim()) ||
      (typeof entry.label === 'string' && entry.label.trim()) ||
      id
    out.push({ id, label })
  }
  return out
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
    case 'codex':
      return codexSheet()
    case 'opencode':
      return opencodeSheet(readJson, home)
    case 'pi':
      return piSheet(readJson, home)
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
    MODEL_TOKEN_RE.test(model) &&
    !!sheet.modelFlag &&
    !!sheet.models?.some((m) => m.id === model)
  if (modelOk && sheet.modelFlag && model) {
    out.push(sheet.modelFlag, model)
  } else if (model && log) {
    log(`[den-server] spawn: omitting model ${JSON.stringify(model)} (unknown or no flag)`)
  }
  const effortOk =
    typeof effort === 'string' &&
    EFFORT_TOKEN_RE.test(effort) &&
    !!sheet.effortFlag &&
    effortIdsFor(sheet, modelOk ? model : undefined).includes(effort)
  if (effortOk && sheet.effortFlag && effort) {
    const mapped =
      sheet.effortArgValues && Object.prototype.hasOwnProperty.call(sheet.effortArgValues, effort)
        ? sheet.effortArgValues[effort]
        : effort
    if (mapped) out.push(sheet.effortFlag, mapped)
  } else if (effort && log) {
    log(`[den-server] spawn: omitting effort ${JSON.stringify(effort)} (unknown or no flag)`)
  }
  return out
}
