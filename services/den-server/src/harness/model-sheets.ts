/**
 * Per-harness model/effort capability sheets.
 *
 * Pure: file readers (and the one subprocess runner) are injected so grok's
 * models_cache.json, kimi's config.toml, codex's catalog and the rest can be
 * unit-tested without touching the real home directory or PATH.
 *
 * Each sheet says where its `models` came from (`modelsSource`): the
 * harness's own catalog when discovery found rows (`discovered`), else the
 * built-in floor (`static`). Async sources (an endpoint, a CLI listing) go
 * through `backgroundDiscovery`: the sheet is always built synchronously from
 * the last-known result and the refresh runs off the request path.
 *
 * Config overrides (`tasks.harnesses.<id>.models` / `.efforts`) combine with
 * the sheet per `models_mode`: `replace` (the meaning when `models_mode` is
 * absent and a list is set — older configs keep working), `merge` (deduped by
 * id, config wins), or `discover` (the override is ignored). Malformed
 * entries are dropped, and an empty result keeps the sheet.
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import type {
  EffortOption,
  HarnessId,
  HarnessModelOption,
  HarnessModelsSource,
} from '@rivetos/types'

/**
 * Model id on POST /term and as a sheet id.
 * `/` is allowed (kimi `provider/model`); `..` is not (`../x` is rejected).
 * `~` is allowed after the first char for OpenRouter aliases (`openrouter/~z-ai/glm-latest`).
 * A leading `~` (home-directory shorthand) is rejected; argv or quoted word, never shell-evaluated.
 */
export const MODEL_TOKEN_RE = /^(?!.*\.\.)[A-Za-z0-9._[\]:/-][A-Za-z0-9._[\]:/~-]{0,63}$/

/** Effort id — same charset as before; `/` stays out. */
export const EFFORT_TOKEN_RE = /^[A-Za-z0-9._[\]:-]{1,64}$/

export type ReadJson = (path: string) => unknown
export type ReadText = (path: string) => string

export interface SheetReaders {
  readJson?: ReadJson
  readText?: ReadText
  home?: string
  /** Environment for `$CODEX_HOME`-style lookups and the listing subprocess; tests pin it. */
  env?: NodeJS.ProcessEnv
  /** Listing-subprocess runner (codex `debug models`); tests inject a fake. */
  runCommand?: RunCommand
}

export interface ModelSheet {
  models?: HarnessModelOption[]
  /** Provenance of `models`; surfaced on `/api/harnesses` as `capabilities.modelsSource`. */
  modelsSource?: HarnessModelsSource
  efforts?: EffortOption[]
  modelFlag?: string
  /**
   * Hermes only. A listed model `custom:<provider>:<model>` is spawned as
   * `--provider <provider> -m <model>` (further colons stay in the model)
   * instead of `[modelFlag, model]`. Other sheets, including qwen-code's
   * `-m`, leave the token unchanged.
   */
  namedCustomProvider?: boolean
  effortFlag?: string
  /**
   * The CLI honors `modelFlag` at launch: a model picked before the
   * conversation's first spawn is honored for the session's life (#814).
   * Explicit by design — a sheet with `models` + `modelFlag` does NOT imply
   * this; the web's pre-spawn picker gates on the flag, while the den's
   * spawn path keeps appending `modelFlag` whenever the sheet carries one
   * and the id is listed.
   */
  launchModel?: boolean
  /**
   * The CLI honors `modelFlag` at launch, but the sheet has no rows of its
   * own yet (discovery pending or unavailable): declare `launchModel` as soon
   * as the resolved sheet — after a config override — has rows. A settled
   * `launchModel` sheet with no rows would make clients clear a stored model.
   */
  launchModelWhenListed?: boolean
  /**
   * Effort id → CLI flag value. Present + empty string omits the flag
   * (opencode medium → no `--variant`). Absent key → use the effort id.
   */
  effortArgValues?: Record<string, string>
  /**
   * Prepended to the (mapped) effort value, for CLIs whose effort is a
   * `key=value` config override rather than a dedicated flag:
   * codex `-c model_reasoning_effort=high`.
   */
  effortArgPrefix?: string
}

export interface SheetOverride {
  models?: unknown
  efforts?: unknown
  /** `discover` | `replace` | `merge`; see `resolveModelsMode`. */
  models_mode?: unknown
}

export type ModelsMode = 'discover' | 'replace' | 'merge'

/**
 * How a config override combines with the sheet. An explicit `models_mode`
 * wins; without one, a `models` / `efforts` list means `replace` (what the
 * key has always meant, so existing configs do not change) and no list means
 * `discover`.
 */
export function resolveModelsMode(override?: SheetOverride): ModelsMode {
  const raw = override?.models_mode
  if (raw === 'discover' || raw === 'replace' || raw === 'merge') return raw
  return Array.isArray(override?.models) || Array.isArray(override?.efforts)
    ? 'replace'
    : 'discover'
}

export const ROSTER_TO_HARNESS: Record<string, HarnessId> = {
  claude: 'claude-code',
  grok: 'grok-build',
  kimi: 'kimi-code',
  hermes: 'hermes',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
  qwen: 'qwen-code',
  cursor: 'cursor',
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

/**
 * Codex CLI reasoning efforts — same vocabulary as the #719 `codex-cli`
 * provider. The static floor; a discovered catalog row carries its own
 * `supported_reasoning_levels` (which can add `max` / `ultra`).
 */
const CODEX_EFFORTS: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium', default: true },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'X-High' },
]

const CODEX_EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
  ultra: 'Ultra',
}

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
 * Combine a config override with the sheet per `resolveModelsMode`:
 * - `discover`: the sheet as discovered; a stray list is ignored and logged.
 * - `replace`: the override's models and/or efforts, when that key is an
 *   array (`modelsSource: 'config'`).
 * - `merge`: sheet rows plus override rows, deduped by id; an override row
 *   wins on label / default / efforts, and an override `default` clears the
 *   sheet's (`modelsSource: 'merged'`).
 * A non-array value is ignored (keep the sheet). An array that sanitizes to
 * empty is also ignored (keep the sheet) and logged when a sink is provided.
 */
export function applySheetOverride(
  sheet: ModelSheet,
  override?: SheetOverride,
  log?: (msg: string) => void,
): ModelSheet {
  if (!override) return withLaunchModel(sheet)
  const mode = resolveModelsMode(override)
  const next: ModelSheet = { ...sheet }
  if (mode === 'discover') {
    if (Array.isArray(override.models) || Array.isArray(override.efforts)) {
      log?.(
        '[den-server] harness sheet: models_mode is discover — ignoring the models/efforts override',
      )
    }
    return withLaunchModel(next)
  }
  if (Array.isArray(override.models)) {
    const models = sanitizeModels(override.models)
    if (models.length === 0) {
      log?.('[den-server] harness sheet: ignoring empty models override (keeping sheet list)')
    } else if (mode === 'replace') {
      next.models = models
      next.modelsSource = 'config'
    } else {
      next.models = mergeRows(sheet.models ?? [], models)
      next.modelsSource = 'merged'
    }
  }
  if (Array.isArray(override.efforts)) {
    const efforts = sanitizeEfforts(override.efforts)
    if (efforts.length === 0) {
      log?.('[den-server] harness sheet: ignoring empty efforts override (keeping sheet list)')
    } else if (mode === 'replace') {
      next.efforts = efforts
    } else {
      next.efforts = mergeRows(sheet.efforts ?? [], efforts)
    }
  }
  return withLaunchModel(next, sheet)
}

/**
 * `launchModelWhenListed` → `launchModel` once the list is settled: a
 * discovered list, or a config `replace` list (synchronous, complete). A
 * `merge` over a still-empty discovery holds only the config rows, and
 * declaring the sheet settled then would make a client clear a stored
 * discovered-only model seconds before discovery lands.
 */
function withLaunchModel(sheet: ModelSheet, base: ModelSheet = sheet): ModelSheet {
  if (!sheet.launchModelWhenListed || (sheet.models?.length ?? 0) === 0) return sheet
  const settled =
    sheet.modelsSource === 'config' ||
    sheet.modelsSource === 'discovered' ||
    (sheet.modelsSource === 'merged' && base.modelsSource === 'discovered')
  return settled ? { ...sheet, launchModel: true } : sheet
}

/**
 * Discovered rows plus config rows, deduped by id. A config row overlays the
 * discovered one (label / default / efforts win); a config row with
 * `default: true` makes it the only default.
 */
function mergeRows<T extends { id: string; default?: boolean }>(discovered: T[], config: T[]): T[] {
  const out: T[] = discovered.map((row) => ({ ...row }))
  for (const row of config) {
    const i = out.findIndex((m) => m.id === row.id)
    if (i >= 0) out[i] = { ...out[i], ...row }
    else out.push({ ...row })
  }
  if (config.some((row) => row.default === true)) {
    for (const row of out) {
      if (!config.some((c) => c.id === row.id && c.default === true)) delete row.default
    }
  }
  return out
}

/**
 * Claude Code's global config file: `~/.claude.json`, or
 * `$CLAUDE_CONFIG_DIR/.claude.json` when set (non-empty after trim).
 */
export function claudeGlobalConfigPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim()
  return configDir ? join(configDir, '.claude.json') : join(home, '.claude.json')
}

/**
 * Claude Code's model list. The base models (Opus/Sonnet/Haiku and their 1M
 * variants, Fable) are baked into the installed CLI version, so the static list
 * is the floor and no config file can drop below it. On top of that we merge
 * Claude Code's own `additionalModelOptionsCache` from `~/.claude.json`, or
 * `$CLAUDE_CONFIG_DIR/.claude.json` when set: the CLI writes account-specific
 * extras it advertises (a new model can appear before this static list is
 * bumped) and update-gated entries flagged `disabled`. The
 * gated rows are skipped — never offered — so the picker cannot spawn a model
 * this install can't run. Cache rows whose id already exists in the base are
 * dropped; an unreadable file leaves the static list untouched.
 *
 * `--model` is Claude Code's launch-time model switch and this list is the
 * alias set the CLI accepts, so a pre-spawn pick is honored for the session's
 * life → `launchModel` (#814). The 1M-context variants are request-side
 * context flags on the same models, kept as first-class rows.
 */
export function claudeSheet(
  readJson: ReadJson = defaultReadJson,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ModelSheet {
  const models: HarnessModelOption[] = [
    { id: 'fable', label: 'Fable 5.1', default: true },
    { id: 'opus', label: 'Opus 5' },
    { id: 'sonnet', label: 'Sonnet 5' },
    { id: 'haiku', label: 'Haiku 4.5' },
    { id: 'fable[1m]', label: 'Fable 5.1 1M context' },
    { id: 'opus[1m]', label: 'Opus 5 1M context' },
    { id: 'sonnet[1m]', label: 'Sonnet 5 1M context' },
  ]
  let discovered = false
  for (const extra of claudeCacheModelsFor(readJson, home, env)) {
    if (models.some((m) => m.id === extra.id)) continue
    models.push(extra)
    discovered = true
  }
  return {
    models,
    modelsSource: discovered ? 'discovered' : 'static',
    efforts: CLAUDE_EFFORTS,
    modelFlag: '--model',
    effortFlag: '--effort',
    launchModel: true,
  }
}

/**
 * Non-`disabled` `additionalModelOptionsCache` rows from `~/.claude.json`, or
 * `$CLAUDE_CONFIG_DIR/.claude.json` when set, mapped to model options. Efforts
 * are left off so each inherits the sheet's shared Claude effort set, exactly
 * like the base rows. Malformed rows, gated (`disabled`) rows, invalid ids, and
 * duplicates are dropped; an unreadable or unshaped file yields none.
 */
function claudeCacheModels(
  readJson: ReadJson,
  home: string,
  env: NodeJS.ProcessEnv,
): HarnessModelOption[] {
  let raw: unknown
  try {
    raw = readJson(claudeGlobalConfigPath(home, env))
  } catch {
    return []
  }
  if (!isRecord(raw) || !Array.isArray(raw.additionalModelOptionsCache)) return []
  const out: HarnessModelOption[] = []
  const seen = new Set<string>()
  for (const entry of raw.additionalModelOptionsCache) {
    if (!isRecord(entry) || entry.disabled === true) continue
    if (typeof entry.value !== 'string') continue
    const id = entry.value.trim()
    if (!MODEL_TOKEN_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id
    out.push({ id, label })
  }
  return out
}

/**
 * Memoized `claudeCacheModels`. `~/.claude.json` accumulates per-project
 * history and can be several MB, and the sheet is rebuilt on every terminal
 * CREATE, so parsing it synchronously each spawn is wasteful. The resolved
 * path keys the memo and the file's `mtimeMs`+`size` stand in for its content;
 * a stat error means "no cache rows", matching an unreadable file even though
 * nothing was read. Only the real file reader takes this path — an injected
 * reader always runs so tests/DI stay deterministic.
 */
function claudeCacheModelsFor(
  readJson: ReadJson,
  home: string,
  env: NodeJS.ProcessEnv,
): HarnessModelOption[] {
  if (readJson !== defaultReadJson) return claudeCacheModels(readJson, home, env)
  const path = claudeGlobalConfigPath(home, env)
  let mtimeMs: number
  let size: number
  try {
    const stat = statSync(path)
    mtimeMs = stat.mtimeMs
    size = stat.size
  } catch {
    claudeCacheMemo.delete(path)
    return []
  }
  const memo = claudeCacheMemo.get(path)
  if (memo && memo.mtimeMs === mtimeMs && memo.size === size) return memo.models
  const models = claudeCacheModels(defaultReadJson, home, env)
  claudeCacheMemo.set(path, { mtimeMs, size, models })
  return models
}

interface ClaudeCacheMemo {
  mtimeMs: number
  size: number
  models: HarnessModelOption[]
}

/** One entry per resolved config path; a fresh file stat replaces it. */
const claudeCacheMemo = new Map<string, ClaudeCacheMemo>()

/** Drop the `~/.claude.json` and per-file row memos (tests only). */
export function __resetClaudeCacheMemoForTests(): void {
  claudeCacheMemo.clear()
  fileRowsMemo.clear()
}

interface FileRowsMemo {
  mtimeMs: number
  size: number
  rows: HarnessModelOption[]
}

/** One entry per catalog file; a fresh stat replaces it. */
const fileRowsMemo = new Map<string, FileRowsMemo>()

/**
 * `parse(readJson(path))`, stat-memoized (`mtimeMs` + `size`) when the real
 * file reader is in use — same idea as `claudeCacheModelsFor`, for any
 * harness whose CLI keeps a catalog file (codex's `models_cache.json` is
 * a few hundred KB). Unreadable / unparseable → no rows. An injected reader
 * always runs so tests stay deterministic.
 */
function fileRowsFor(
  readJson: ReadJson,
  path: string,
  parse: (raw: unknown) => HarnessModelOption[],
): HarnessModelOption[] {
  const parseSafe = (read: ReadJson): HarnessModelOption[] => {
    try {
      return parse(read(path))
    } catch {
      return []
    }
  }
  if (readJson !== defaultReadJson) return parseSafe(readJson)
  let mtimeMs: number
  let size: number
  try {
    const stat = statSync(path)
    mtimeMs = stat.mtimeMs
    size = stat.size
  } catch {
    fileRowsMemo.delete(path)
    return []
  }
  const memo = fileRowsMemo.get(path)
  if (memo && memo.mtimeMs === mtimeMs && memo.size === size) return memo.rows
  const rows = parseSafe(defaultReadJson)
  fileRowsMemo.set(path, { mtimeMs, size, rows })
  return rows
}

// ---------------------------------------------------------------------------
// Background discovery — async catalog sources, read synchronously.
// ---------------------------------------------------------------------------

interface DiscoveryEntry<T> {
  value: T | undefined
  at: number
  inflight?: Promise<void>
  /** A failure was already logged for the current outage. */
  failing: boolean
}

const discoveryCache = new Map<string, DiscoveryEntry<unknown>>()

/** Forget every background-discovered catalog (tests only). */
export function __resetDiscoveryCacheForTests(): void {
  discoveryCache.clear()
}

/**
 * Last-known result of an async catalog source (`run`), refreshing in the
 * background once `ttlMs` has passed since the last attempt. Never blocks and
 * never throws: the first read (and any read during an outage) returns what
 * the cache has, possibly `undefined`, so the caller falls back to its static
 * rows. A failure keeps the last-known value and logs ONE line per outage —
 * the next success re-arms the log. Sheets are re-read on the driver's TTL,
 * so a completed run lands on the next read and is announced as a capability
 * change.
 */
export function backgroundDiscovery<T>(
  key: string,
  run: () => Promise<T>,
  opts: { ttlMs: number; now: number; timeoutMs?: number; log?: (msg: string) => void },
): T | undefined {
  const entry = (discoveryCache.get(key) as DiscoveryEntry<T> | undefined) ?? {
    value: undefined,
    at: Number.NEGATIVE_INFINITY,
    failing: false,
  }
  discoveryCache.set(key, entry)
  if (!entry.inflight && opts.now - entry.at >= opts.ttlMs) {
    // Our own deadline, independent of `run`: a runner that never settles
    // (a child that ignores SIGTERM, a grandchild holding the pipe) must not
    // pin `inflight` forever, or the source would never be retried or logged.
    let timer: NodeJS.Timeout | undefined
    const deadline =
      opts.timeoutMs === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`timed out after ${String(opts.timeoutMs)} ms`)),
              opts.timeoutMs,
            )
            timer.unref?.()
          })
    const attempt = Promise.resolve().then(run)
    entry.inflight = (deadline ? Promise.race([attempt, deadline]) : attempt)
      .then((value) => {
        entry.value = value
        entry.failing = false
      })
      .catch((err: unknown) => {
        // One line per outage — but only a caller with a sink can claim it.
        // A sink-less caller (term spawn, preset save) must not latch
        // `failing` or the driver's own refresh would stay silent.
        if (opts.log) {
          if (!entry.failing) {
            const msg = err instanceof Error ? err.message : String(err)
            const kept = entry.value === undefined ? 'static sheet' : 'last-known list'
            opts.log(`[den-server] model discovery ${key}: ${msg} — serving the ${kept}`)
          }
          entry.failing = true
        }
      })
      .finally(() => {
        if (timer) clearTimeout(timer)
        entry.at = opts.now
        entry.inflight = undefined
      })
  }
  return entry.value
}

/** Runs a listing command; resolves with stdout. Injected so tests never spawn. */
export type RunCommand = (
  argv: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<string>

/** A catalog render can be large (codex: ~600 KB); well under this cap. */
const RUN_COMMAND_MAX_BUFFER = 32 * 1024 * 1024

export const defaultRunCommand: RunCommand = (argv, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      argv[0],
      argv.slice(1),
      {
        timeout: opts.timeoutMs,
        // execFile waits for `close` after its signal; a CLI that ignores
        // SIGTERM would otherwise hold the callback past the timeout.
        killSignal: 'SIGKILL',
        maxBuffer: RUN_COMMAND_MAX_BUFFER,
        env: opts.env,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err?.killed)
          reject(new Error(`${argv.join(' ')}: timed out after ${String(opts.timeoutMs)} ms`))
        else if (err) reject(err instanceof Error ? err : new Error('listing failed'))
        else resolve(stdout)
      },
    )
  })

/**
 * PATH for a listing subprocess: the den's own PATH plus `~/.local/bin`, the
 * same augmentation the spawn path applies (a user-installed CLI is found
 * even when the service PATH lacks it).
 */
function discoveryEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const localBin = join(home, '.local', 'bin')
  const parts = (env.PATH ?? '').split(':').filter(Boolean)
  if (!parts.includes(localBin)) parts.push(localBin)
  return { ...env, PATH: parts.join(':') }
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
    modelsSource: 'static',
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
    modelsSource: 'discovered',
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
  const empty: ModelSheet = { models: [], modelsSource: 'static', modelFlag: '--model' }
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
    const models = parseKimiToml(text)
    return {
      models,
      modelsSource: models.length > 0 ? 'discovered' : 'static',
      modelFlag: '--model',
    }
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

/** `model:` block of `~/.hermes/config.yaml` — the only part the sheet needs. */
export interface HermesModelConfig {
  default?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
}

function yamlScalar(raw: string): string {
  let v = raw.trim()
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0]
    const end = v.indexOf(q, 1)
    return end > 0 ? v.slice(1, end) : v.slice(1)
  }
  const hash = v.search(/\s#/)
  if (hash >= 0) v = v.slice(0, hash)
  return v.trim()
}

/**
 * Read the top-level `model:` mapping (or the legacy `model: <id>` scalar)
 * from Hermes's config.yaml. Deliberately tiny — no YAML dependency: only
 * the first-level keys under `model:` are read, the rest of the file is
 * skipped. Nested `model:` keys elsewhere (auxiliary slots) are not top-level
 * and never match.
 */
export function parseHermesModelConfig(text: string): HermesModelConfig {
  const out: HermesModelConfig = {}
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^model:/.test(l))
  if (start < 0) return out
  const inline = yamlScalar(lines[start].slice('model:'.length))
  if (inline) {
    out.default = inline
    return out
  }
  let indent: number | undefined
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const lead = line.length - line.trimStart().length
    if (lead === 0) break
    indent ??= lead
    if (lead !== indent) continue
    const m = /^\s*([A-Za-z_]+):(.*)$/.exec(line)
    if (!m) continue
    const value = yamlScalar(m[2])
    if (!value) continue
    if (m[1] === 'default') out.default = value
    else if (m[1] === 'provider') out.provider = value
    else if (m[1] === 'base_url') out.baseUrl = value
    else if (m[1] === 'api_key') out.apiKey = value
  }
  return out
}

/** Fetches an OpenAI-compatible `GET <base>/models` → model ids. */
export type FetchModelIds = (baseUrl: string, apiKey?: string) => Promise<string[]>

const HERMES_ENDPOINT_TTL_MS = 60_000
const HERMES_ENDPOINT_TIMEOUT_MS = 3_000

export const fetchOpenAiModelIds: FetchModelIds = async (baseUrl, apiKey) => {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(HERMES_ENDPOINT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : []
  return data.flatMap((row) => (isRecord(row) && typeof row.id === 'string' ? [row.id] : []))
}

export function __resetHermesEndpointCacheForTests(): void {
  __resetDiscoveryCacheForTests()
}

/** Last-known ids served at `baseUrl` (see `backgroundDiscovery`). */
function hermesEndpointModels(
  baseUrl: string,
  apiKey: string | undefined,
  fetchIds: FetchModelIds,
  now: number,
  log?: (msg: string) => void,
): string[] {
  return (
    backgroundDiscovery(
      `hermes:${baseUrl}`,
      () => fetchIds(baseUrl, apiKey).then((ids) => ids.filter((id) => MODEL_TOKEN_RE.test(id))),
      { ttlMs: HERMES_ENDPOINT_TTL_MS, now, log },
    ) ?? []
  )
}

/**
 * Hermes is a client of whatever provider its config names, so the model list
 * comes from there: the configured default from `~/.hermes/config.yaml`, plus
 * — when the provider has a `base_url` (custom / local OpenAI-compatible
 * servers such as vLLM) — the ids that endpoint serves at `GET /models`.
 * Launch flag `-m`; effort is `--reasoning` low/medium/high.
 * `custom:<provider>:<model>` is `--provider <provider> -m <model>`
 * (the model keeps further colons). Other sheets are not rewritten.
 */
export function hermesSheet(
  readText: ReadText = defaultReadText,
  home: string = homedir(),
  fetchIds: FetchModelIds = fetchOpenAiModelIds,
  now: number = Date.now(),
  log?: (msg: string) => void,
): ModelSheet {
  let config: HermesModelConfig = {}
  try {
    config = parseHermesModelConfig(readText(join(home, '.hermes', 'config.yaml')))
  } catch {
    /* no config — no models, Hermes launches its own default */
  }
  const ids: string[] = []
  const defaultId =
    config.default && MODEL_TOKEN_RE.test(config.default) ? config.default : undefined
  if (defaultId) ids.push(defaultId)
  if (config.baseUrl && /^https?:\/\//.test(config.baseUrl)) {
    for (const id of hermesEndpointModels(config.baseUrl, config.apiKey, fetchIds, now, log)) {
      if (!ids.includes(id)) ids.push(id)
    }
  }
  return {
    models: ids.map((id) => ({ id, label: id, ...(id === defaultId ? { default: true } : {}) })),
    modelsSource: ids.length > 0 ? 'discovered' : 'static',
    efforts: HERMES_EFFORTS,
    modelFlag: '-m',
    effortFlag: '--reasoning',
    launchModel: true,
    namedCustomProvider: true,
  }
}

/** `$CODEX_HOME`, else `~/.codex` — where the CLI keeps `config.toml` and `models_cache.json`. */
export function codexHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CODEX_HOME?.trim()
  return dir ? dir : join(home, '.codex')
}

/**
 * The Codex model catalog, as `codex debug models` renders it and as the CLI
 * caches it in `models_cache.json`: `{ models: [{ slug, display_name,
 * visibility, priority, default_reasoning_level, supported_reasoning_levels:
 * [{ effort }], input_modalities }] }`. Rows whose `visibility` is not `list`
 * (hidden / retired) are dropped; the rest are ordered by `priority`.
 */
export function parseCodexCatalog(raw: unknown): HarnessModelOption[] {
  if (!isRecord(raw) || !Array.isArray(raw.models)) return []
  const rows: { opt: HarnessModelOption; priority: number }[] = []
  const seen = new Set<string>()
  for (const entry of raw.models) {
    if (!isRecord(entry) || typeof entry.slug !== 'string') continue
    const id = entry.slug.trim()
    if (!MODEL_TOKEN_RE.test(id) || seen.has(id)) continue
    if (entry.visibility !== undefined && entry.visibility !== 'list') continue
    seen.add(id)
    const label =
      typeof entry.display_name === 'string' && entry.display_name.trim()
        ? entry.display_name.trim()
        : id
    const opt: HarnessModelOption = { id, label }
    const defaultEffort =
      typeof entry.default_reasoning_level === 'string' ? entry.default_reasoning_level.trim() : ''
    if (Array.isArray(entry.supported_reasoning_levels)) {
      const efforts: EffortOption[] = []
      for (const level of entry.supported_reasoning_levels) {
        const effort =
          isRecord(level) && typeof level.effort === 'string'
            ? level.effort.trim()
            : typeof level === 'string'
              ? level.trim()
              : ''
        if (!EFFORT_TOKEN_RE.test(effort) || efforts.some((e) => e.id === effort)) continue
        const row: EffortOption = { id: effort, label: CODEX_EFFORT_LABELS[effort] ?? effort }
        if (effort === defaultEffort) row.default = true
        efforts.push(row)
      }
      if (efforts.length > 0) opt.efforts = efforts
    }
    if (Array.isArray(entry.input_modalities)) {
      const modalities = entry.input_modalities.filter((m): m is string => typeof m === 'string')
      if (modalities.length > 0) opt.inputModalities = modalities
    }
    rows.push({
      opt,
      priority: typeof entry.priority === 'number' ? entry.priority : Number.POSITIVE_INFINITY,
    })
  }
  rows.sort((a, b) => a.priority - b.priority)
  return rows.map((r) => r.opt)
}

/** Top-level `model = "…"` of `config.toml` (before the first `[table]`). */
export function parseCodexConfigModel(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('[')) break
    const m = /^model\s*=\s*["']([^"']+)["']/.exec(t)
    if (m) return m[1].trim()
  }
  return undefined
}

export interface CodexSheetDeps {
  readJson?: ReadJson
  readText?: ReadText
  home?: string
  env?: NodeJS.ProcessEnv
  runCommand?: RunCommand
  now?: number
  log?: (msg: string) => void
}

const CODEX_CATALOG_TTL_MS = 5 * 60_000
const CODEX_CATALOG_TIMEOUT_MS = 5_000

/**
 * Codex — discovered from the CLI itself. Two sources:
 * 1. `codex debug models`, the catalog rendered by the installed binary, run
 *    in the background with a bounded timeout (~150 ms, no network of its
 *    own). Once it has landed it is the list: labels, efforts and retirements
 *    come from it.
 * 2. `<codex home>/models_cache.json`, the catalog the CLI last fetched
 *    (stat-memoized) — the synchronous floor until the listing lands, and the
 *    only source on a node where the binary cannot be run.
 * The default is `config.toml`'s top-level `model` when set — added as a row
 * if the catalog does not know it, which is the custom-gateway case — else the
 * catalog's top-priority row. Effort ids per row come from the catalog
 * (`max` / `ultra` on the models that support them); the floor is the #719
 * vocabulary. Spawn flags: `--model <id>` and `-c model_reasoning_effort=<e>`
 * (`effortArgPrefix`), the CLI's own documented forms. Nothing discovered →
 * no models (a picker with a fake `default` row would spawn `--model default`).
 */
export function codexSheet(deps: CodexSheetDeps = {}): ModelSheet {
  const readJson = deps.readJson ?? defaultReadJson
  const readText = deps.readText ?? defaultReadText
  const home = deps.home ?? homedir()
  const env = deps.env ?? process.env
  const runCommand = deps.runCommand ?? defaultRunCommand
  const now = deps.now ?? Date.now()
  const root = codexHome(home, env)
  // `launchModel` only with rows: the web treats a settled launchModel sheet
  // with no matching id as stale and clears the conversation's stored model.
  const base: ModelSheet = {
    models: [],
    modelsSource: 'static',
    efforts: CODEX_EFFORTS,
    modelFlag: '--model',
    effortFlag: '-c',
    effortArgPrefix: 'model_reasoning_effort=',
    launchModelWhenListed: true,
  }
  const models: HarnessModelOption[] = []
  const add = (rows: HarnessModelOption[]): void => {
    for (const row of rows) {
      if (models.some((m) => m.id === row.id)) continue
      // copies: the memo / discovery cache keep the originals
      models.push({
        ...row,
        ...(row.efforts ? { efforts: row.efforts.map((e) => ({ ...e })) } : {}),
      })
    }
  }
  const listed = backgroundDiscovery(
    `codex:debug-models:${root}`,
    () =>
      runCommand(['codex', 'debug', 'models'], {
        timeoutMs: CODEX_CATALOG_TIMEOUT_MS,
        env: discoveryEnv(env, home),
      }).then((out) => {
        // An empty parse means the JSON shape drifted, not that Codex has no
        // models: fail the run so the last-known listing is kept and logged.
        const rows = parseCodexCatalog(JSON.parse(out))
        if (rows.length === 0) throw new Error('codex debug models returned no listed models')
        return rows
      }),
    {
      ttlMs: CODEX_CATALOG_TTL_MS,
      now,
      timeoutMs: CODEX_CATALOG_TIMEOUT_MS + 1_000,
      log: deps.log,
    },
  )
  if (listed) add(listed)
  else add(fileRowsFor(readJson, join(root, 'models_cache.json'), parseCodexCatalog))
  let configured: string | undefined
  try {
    configured = parseCodexConfigModel(readText(join(root, 'config.toml')))
  } catch {
    /* no config — the catalog's own order picks the default */
  }
  if (configured && MODEL_TOKEN_RE.test(configured) && !models.some((m) => m.id === configured)) {
    models.push({ id: configured, label: configured })
  }
  if (models.length === 0) return base
  for (const m of models) delete m.default
  const marked = models.find((m) => m.id === configured) ?? models[0]
  marked.default = true
  return { ...base, models, modelsSource: 'discovered', launchModel: true }
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
  const empty: ModelSheet = { models: [], modelsSource: 'static', ...flags }
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
    const models = parseOpencodeConfig(raw)
    return { models, modelsSource: models.length > 0 ? 'discovered' : 'static', ...flags }
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
    modelsSource: fromStore.length > 0 ? 'discovered' : 'static',
    efforts: PI_EFFORTS,
    modelFlag: '--model',
    effortFlag: '--thinking',
  }
}

/**
 * Map qwen `capabilities.reasoning.efforts` (`low|medium|high|xhigh|max`)
 * onto the RivetOS effort ids the other sheets use. Unknown tokens dropped.
 * Qwen has no CLI effort flag (`Unknown argument: effort`) — effort lives
 * on the model entry only.
 */
const QWEN_EFFORT_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}

function qwenEffortsFromCapabilities(raw: unknown): EffortOption[] | undefined {
  if (!isRecord(raw) || !isRecord(raw.reasoning) || !Array.isArray(raw.reasoning.efforts)) {
    return undefined
  }
  const defaultEffort =
    typeof raw.reasoning.defaultEffort === 'string' ? raw.reasoning.defaultEffort.trim() : ''
  const out: EffortOption[] = []
  const seen = new Set<string>()
  for (const token of raw.reasoning.efforts) {
    if (typeof token !== 'string') continue
    const id = token.trim()
    if (!QWEN_EFFORT_LABEL[id] || seen.has(id)) continue
    seen.add(id)
    const opt: EffortOption = { id, label: QWEN_EFFORT_LABEL[id] }
    if (defaultEffort !== '' && id === defaultEffort) opt.default = true
    out.push(opt)
  }
  return out.length > 0 ? out : undefined
}

/**
 * Qwen Code — models from `~/.qwen/settings.json` `modelProviders.<authType>[]`.
 * Default is `model.name`. Efforts only on entries that declare
 * `capabilities.reasoning.efforts`. Spawn flag is `-m`; there is no
 * `effortFlag`. Missing settings → empty sheet (qwen's own default applies;
 * we do not invent a `QWEN_CODE_DEFAULT_MODEL`).
 */
export function qwenCodeSheet(
  readJson: ReadJson = defaultReadJson,
  home: string = homedir(),
): ModelSheet {
  const empty: ModelSheet = { models: [], modelsSource: 'static', modelFlag: '-m' }
  let raw: unknown
  try {
    raw = readJson(join(home, '.qwen', 'settings.json'))
  } catch {
    return empty
  }
  if (!isRecord(raw)) return empty
  const providers = raw.modelProviders
  if (!isRecord(providers)) return empty
  const defaultId =
    isRecord(raw.model) && typeof raw.model.name === 'string' ? raw.model.name.trim() : ''
  const models: HarnessModelOption[] = []
  const seen = new Set<string>()
  for (const entries of Object.values(providers)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.id !== 'string') continue
      const id = entry.id.trim()
      if (!id || !MODEL_TOKEN_RE.test(id) || seen.has(id)) continue
      seen.add(id)
      const label = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id
      const opt: HarnessModelOption = { id, label }
      if (defaultId !== '' && id === defaultId) opt.default = true
      const efforts = qwenEffortsFromCapabilities(entry.capabilities)
      if (efforts) opt.efforts = efforts
      models.push(opt)
    }
  }
  if (defaultId && MODEL_TOKEN_RE.test(defaultId)) {
    const marked = models.find((m) => m.id === defaultId)
    if (marked) {
      for (const m of models) delete m.default
      marked.default = true
    }
  }
  return { models, modelsSource: models.length > 0 ? 'discovered' : 'static', modelFlag: '-m' }
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

/**
 * The built-in sheet for a harness. `log` receives the one-line discovery
 * failure notices (a listing that timed out, an endpoint that is down).
 */
export function sheetForHarness(
  harnessId: HarnessId,
  readers?: SheetReaders,
  log?: (msg: string) => void,
): ModelSheet {
  const home = readers?.home
  const readJson = readers?.readJson
  const readText = readers?.readText
  switch (harnessId) {
    case 'claude-code':
      return claudeSheet(readJson, home)
    case 'grok-build':
      return grokSheet(readJson, home)
    case 'kimi-code':
      return kimiSheet(readText, home)
    case 'hermes':
      return hermesSheet(readText, home, undefined, undefined, log)
    case 'codex':
      return codexSheet({
        readJson,
        readText,
        home,
        env: readers?.env,
        runCommand: readers?.runCommand,
        log,
      })
    case 'opencode':
      return opencodeSheet(readJson, home)
    case 'pi':
      return piSheet(readJson, home)
    case 'qwen-code':
      return qwenCodeSheet(readJson, home)
    case 'cursor':
      return cursorSheet()
  }
}

/**
 * Cursor CLI accepts `--model`, but this node has no Cursor model catalog.
 * An empty list leaves the picker blank; a sheet override can add ids later
 * and `appendModelEffortArgv` will pass `--model` only for a listed id.
 */
export function cursorSheet(): ModelSheet {
  return { modelFlag: '--model', models: [], modelsSource: 'static' }
}

export function sheetForRosterCommand(
  command: string,
  overrides?: Record<string, SheetOverride | undefined>,
  readers?: SheetReaders,
  log?: (msg: string) => void,
): ModelSheet | undefined {
  const harnessId = ROSTER_TO_HARNESS[command]
  if (!harnessId) return undefined
  // The override log lines belong to the driver's TTL refresh, not to every spawn.
  return applySheetOverride(sheetForHarness(harnessId, readers, log), overrides?.[harnessId])
}

/**
 * The model list a preset is vetted against: the same resolved sheet the
 * spawn path appends `--model` from. `strict` is true only when config
 * actually replaced the list (`modelsSource: 'config'`) — a `replace` mode
 * whose list was empty or malformed keeps the discovered rows and must not
 * turn an operator's non-pin into a 400.
 */
export function presetModelList(
  harnessId: HarnessId,
  override?: SheetOverride,
  log?: (msg: string) => void,
): { ids: string[]; strict: boolean; source: HarnessModelsSource } {
  const sheet = applySheetOverride(sheetForHarness(harnessId, undefined, log), override)
  return {
    ids: (sheet.models ?? []).map((m) => m.id),
    strict: sheet.modelsSource === 'config',
    source: sheet.modelsSource ?? 'static',
  }
}

/**
 * Effort ids for a spawn: the named model's own list, else (no model named,
 * the harness runs its default) the default row's list, else the sheet's.
 */
function effortIdsFor(sheet: ModelSheet, modelId?: string): string[] {
  const model = modelId
    ? sheet.models?.find((m) => m.id === modelId)
    : sheet.models?.find((m) => m.default)
  const efforts = model?.efforts ?? sheet.efforts
  return efforts?.map((e) => e.id) ?? []
}

/**
 * The pre-discovery Codex sheet's only row was the placeholder `default`, and
 * the clients' `defaultModel()` stored it on Codex presets. For Codex it means
 * "the CLI's own default": no flag, no warning. Other harnesses may really
 * serve an id named `default`, so the exemption is Codex-only.
 */
export const CODEX_DEFAULT_MODEL = 'default'

export function isCodexDefaultModel(
  harness: string | undefined,
  model: string | undefined,
): boolean {
  // the roster key and the HarnessId are both the literal 'codex'
  return harness === 'codex' && model === CODEX_DEFAULT_MODEL
}

/**
 * Append `[modelFlag, model]` / `[effortFlag, effort]` when the sheet has
 * that flag AND the value is a listed id. Unknown values are omitted (never
 * crash a spawn) and logged with the harness and the list's provenance, so a
 * preset that names a model the resolved list dropped fails visibly in the
 * log rather than silently running the harness default. Hermes
 * (`namedCustomProvider`) rewrites `custom:<provider>:<model>` to
 * `--provider <provider> -m <model>`.
 */
export function appendModelEffortArgv(
  argv: string[],
  sheet: ModelSheet | undefined,
  model?: string,
  effort?: string,
  log?: (msg: string) => void,
  harness?: string,
): string[] {
  if (!sheet) return argv
  const out = [...argv]
  const where = harness ? ` for ${harness}` : ''
  if (isCodexDefaultModel(harness, model)) model = undefined
  const modelOk =
    typeof model === 'string' &&
    MODEL_TOKEN_RE.test(model) &&
    !!sheet.modelFlag &&
    !!sheet.models?.some((m) => m.id === model)
  if (modelOk && sheet.modelFlag && model) {
    const named = sheet.namedCustomProvider === true ? HERMES_NAMED_PROVIDER_RE.exec(model) : null
    if (named) out.push('--provider', named[1], sheet.modelFlag, named[2])
    else out.push(sheet.modelFlag, model)
  } else if (model && log) {
    const why = sheet.modelFlag
      ? `not on the ${sheet.modelsSource ?? 'resolved'} model list — the harness will run its own default`
      : 'the harness takes no model flag'
    log(`[den-server] spawn: omitting model ${JSON.stringify(model)}${where} (${why})`)
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
    if (mapped) out.push(sheet.effortFlag, `${sheet.effortArgPrefix ?? ''}${mapped}`)
  } else if (effort && log) {
    log(
      `[den-server] spawn: omitting effort ${JSON.stringify(effort)}${where} (unknown or no flag)`,
    )
  }
  return out
}
