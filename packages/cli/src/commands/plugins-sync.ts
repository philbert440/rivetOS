/**
 * rivetos plugins sync — refresh per-user TUI plugin installs from the
 * RivetOS source tree (issue #198, phase 1).
 *
 * `rivetos update` advances /opt/rivetos but every TUI (Claude Code, Grok
 * Build, Hermes) holds its own copies of the integration files, installed by
 * a one-time cp. This subcommand re-syncs those copies, idempotently.
 *
 * Usage:
 *   rivetos plugins sync [--dry-run] [--tui <claude-code|grok|hermes>] [--root <dir>]
 *
 * Per-TUI mapping (current install reality, not the historical cp flow):
 *   claude-code  ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
 *                refreshed from integrations/claude-code/<plugin>/ for every
 *                plugin+version ALREADY installed (sync never installs new)
 *   grok         integrations/grok/<plugin>/: skills/* and commands/*.md into
 *                ~/.grok/{skills,commands}/, hooks/hooks.json →
 *                ~/.grok/hooks/<plugin>.json, GROK.md → ~/.grok/AGENTS.md
 *   hermes       integrations/hermes/rivet-memory/ → ~/.hermes/plugins/rivet_memory/
 *                integrations/hermes/memory-recall/ → ~/.hermes/skills/memory-recall/
 *
 * Config files the user co-owns (~/.grok/config.toml, ~/.claude/settings.json)
 * are NOT written — sync prints a hint when a managed block looks missing.
 * Everything else it writes is a file we own outright; local edits to those
 * are overwritten (by design — see issue #198 "out of scope").
 *
 * The copy engine is `rsync -a -i` (one child_process spawn per mapping
 * entry): `--delete` only for the managed dirs we own outright (the entries
 * that historically removed stale files), `--exclude` for the names the old
 * engine skipped, `-n` for --dry-run. Stats and the +/~/- audit log are
 * derived from rsync's itemized output.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileAsync, type ExecResult } from '../lib/harness-detect.js'

const EXCLUDE = new Set(['node_modules', '.git', '__pycache__', '.pytest_cache'])

export interface SyncStats {
  written: string[]
  removed: string[]
  unchanged: number
}

export interface Ctx {
  dryRun: boolean
  stats: SyncStats
  exec?: typeof execFileAsync
}

export function createSyncCtx(dryRun: boolean): Ctx {
  return { dryRun, stats: { written: [], removed: [], unchanged: 0 } }
}

// ---------------------------------------------------------------------------
// copy engine: rsync argv assembly + spawn, audit log from itemized output
// ---------------------------------------------------------------------------

function rsyncExcludes(): string[] {
  return [...EXCLUDE].flatMap((name) => ['--exclude', name])
}

/** argv for a directory mirror: contents of srcDir into destDir.
 *  BOTH operands are slash-terminated: without the trailing slash on srcDir,
 *  rsync nests dest/<basename(src)> instead of mirroring contents, and a
 *  --delete scoped that way can treat siblings under dest as extraneous
 *  (data loss in shared user dirs). `--` guards paths that start with '-'. */
export function rsyncDirArgs(
  srcDir: string,
  destDir: string,
  opts: { deleteExtraneous: boolean; dryRun: boolean },
): string[] {
  return [
    '-a',
    '-i',
    ...(opts.dryRun ? ['-n'] : []),
    ...(opts.deleteExtraneous ? ['--delete'] : []),
    ...rsyncExcludes(),
    '--',
    `${srcDir}/`,
    `${destDir}/`,
  ]
}

/** argv for a single-file copy (dest may rename the file). */
export function rsyncFileArgs(src: string, dest: string, opts: { dryRun: boolean }): string[] {
  return ['-a', '-i', ...(opts.dryRun ? ['-n'] : []), '--', src, dest]
}

export interface RsyncChange {
  kind: 'written' | 'removed'
  rel: string
  isNew: boolean
}

/** Parse `rsync -i` itemized output into write/remove events. */
export function parseItemized(output: string): RsyncChange[] {
  const changes: RsyncChange[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    if (line.startsWith('*deleting')) {
      changes.push({ kind: 'removed', rel: line.replace(/^\*deleting\s+/, ''), isNew: false })
      continue
    }
    // %i is an 11-char change string (YXcstpoguax), then a space, then the
    // path. Y = update type, X = file type. Only files/symlinks carry content
    // we track; directory lines (cd+++++++++ etc.) are implied by their files.
    const yx = line.slice(0, 2)
    if ('>.c'.includes(yx[0]) && (yx[1] === 'f' || yx[1] === 'L')) {
      changes.push({
        kind: 'written',
        rel: line.slice(12),
        isNew: line.slice(0, 11).includes('+++++++++'),
      })
    }
  }
  return changes
}

/** Count sync-managed source files (EXCLUDE-filtered) for the unchanged stat. */
function countFiles(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) n += countFiles(p)
    else if (e.isFile()) n++
  }
  return n
}

/** Bound so `plugins sync` / install cannot hang the event loop on a stuck rsync. */
export const RSYNC_TIMEOUT_MS = 60_000

/**
 * Async rsync via `execFileAsync` (never `execFileSync`). Same errors as the
 * old sync helper so `plugins sync` behaviour stays identical aside from
 * not blocking the event loop.
 */
export async function execRsync(
  args: string[],
  opts: { timeoutMs?: number; exec?: typeof execFileAsync; label?: string } = {},
): Promise<string> {
  const exec = opts.exec ?? execFileAsync
  const label = opts.label ?? 'rsync'
  let result: ExecResult
  try {
    result = await exec('rsync', args, { timeoutMs: opts.timeoutMs ?? RSYNC_TIMEOUT_MS })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      throw new Error('rsync not found on PATH — install rsync (expected on every fleet node)', {
        cause: err,
      })
    }
    throw err
  }
  if (result.code === null && /ENOENT/i.test(result.stderr)) {
    throw new Error('rsync not found on PATH — install rsync (expected on every fleet node)')
  }
  if (result.timedOut || result.code !== 0) {
    const stderr = result.stderr.trim()
    throw new Error(
      `rsync failed for ${label} (exit ${result.timedOut ? 'timeout' : (result.code ?? 'unknown')})${stderr ? `: ${stderr}` : ''}`,
    )
  }
  return result.stdout
}

async function runRsync(
  ctx: Ctx,
  args: string[],
  label: string,
  singleFile: boolean,
  srcFiles: number,
): Promise<void> {
  const output = await execRsync(args, { exec: ctx.exec, label })
  let written = 0
  for (const change of parseItemized(output)) {
    const path = singleFile ? label : `${label}/${change.rel}`
    if (change.kind === 'removed') {
      console.log(`  - ${ctx.dryRun ? '(dry-run) ' : ''}${path} (stale)`)
      ctx.stats.removed.push(path)
    } else {
      written++
      console.log(`  ${change.isNew ? '+' : '~'} ${ctx.dryRun ? '(dry-run) ' : ''}${path}`)
      ctx.stats.written.push(path)
    }
  }
  ctx.stats.unchanged += Math.max(0, srcFiles - written)
}

/** Mirror srcDir into destDir, removing stale files (--delete).
 *  Only use for directories we own outright. */
async function syncManagedDir(
  ctx: Ctx,
  srcDir: string,
  destDir: string,
  label: string,
): Promise<void> {
  if (!ctx.dryRun) mkdirSync(destDir, { recursive: true })
  await runRsync(
    ctx,
    rsyncDirArgs(srcDir, destDir, { deleteExtraneous: true, dryRun: ctx.dryRun }),
    label,
    false,
    countFiles(srcDir),
  )
}

/** Copy our files from srcDir into a shared destDir; never delete others'. */
async function syncSharedDir(
  ctx: Ctx,
  srcDir: string,
  destDir: string,
  label: string,
): Promise<void> {
  if (!ctx.dryRun) mkdirSync(destDir, { recursive: true })
  await runRsync(
    ctx,
    rsyncDirArgs(srcDir, destDir, { deleteExtraneous: false, dryRun: ctx.dryRun }),
    label,
    false,
    countFiles(srcDir),
  )
}

/** Copy a single managed file (dest may rename it). */
async function syncFile(ctx: Ctx, src: string, dest: string, label: string): Promise<void> {
  if (!ctx.dryRun) mkdirSync(dirname(dest), { recursive: true })
  await runRsync(ctx, rsyncFileArgs(src, dest, { dryRun: ctx.dryRun }), label, true, 1)
}

// ---------------------------------------------------------------------------
// root + marketplace discovery
// ---------------------------------------------------------------------------

export function findRoot(explicit?: string): string | null {
  if (explicit) return existsSync(join(explicit, 'integrations')) ? resolve(explicit) : null
  if (process.env.RIVETOS_ROOT && existsSync(join(process.env.RIVETOS_ROOT, 'integrations')))
    return resolve(process.env.RIVETOS_ROOT)
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'integrations')) && existsSync(join(dir, '.claude-plugin'))) return dir
    const next = dirname(dir)
    if (next === dir) break
    dir = next
  }
  return null
}

function marketplacePlugins(root: string): { marketplace: string; plugins: string[] } {
  try {
    const m = JSON.parse(
      readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    ) as { name?: string; plugins?: { name?: string }[] }
    return {
      marketplace: m.name ?? 'rivetos',
      plugins: (m.plugins ?? []).map((p) => p.name ?? '').filter(Boolean),
    }
  } catch {
    return { marketplace: 'rivetos', plugins: [] }
  }
}

// ---------------------------------------------------------------------------
// per-TUI sync
// ---------------------------------------------------------------------------

/**
 * When the rivetos marketplace is a `directory` source (the dev-tree testing
 * workflow), Claude loads plugins from THAT tree — not the version cache — so a
 * deploy's cache sync never reaches the live plugin, and a stale dev tree runs
 * old hooks silently. Return that directory when it's a *different* tree than
 * the deploy root, so sync can refresh it too. Null when github-sourced, when
 * it points at the deploy root already, or when it's missing.
 */
function directoryMarketplaceDir(
  claudeDir: string,
  marketplace: string,
  root: string,
): string | null {
  try {
    const mk = JSON.parse(
      readFileSync(join(claudeDir, 'plugins', 'known_marketplaces.json'), 'utf-8'),
    ) as Record<string, { source?: { source?: string; path?: string }; installLocation?: string }>
    const entry = mk[marketplace]
    if (entry?.source?.source !== 'directory') return null
    const dir = entry.source.path ?? entry.installLocation
    if (!dir) return null
    const resolved = resolve(dir)
    if (resolved === resolve(root) || !existsSync(resolved)) return null
    return resolved
  } catch {
    return null
  }
}

async function syncClaudeCode(ctx: Ctx, root: string, home: string): Promise<void> {
  const claudeDir = join(home, '.claude')
  if (!existsSync(claudeDir)) {
    console.log('⚪ claude-code not detected, skipping')
    return
  }
  console.log('🔄 claude-code:')
  const { marketplace, plugins } = marketplacePlugins(root)
  let any = false
  for (const plugin of plugins) {
    const src = join(root, 'integrations', 'claude-code', plugin)
    if (!existsSync(src)) continue
    const cacheBase = join(claudeDir, 'plugins', 'cache', marketplace, plugin)
    if (!existsSync(cacheBase)) continue // not installed here — sync never installs
    for (const ver of readdirSync(cacheBase, { withFileTypes: true })) {
      if (!ver.isDirectory()) continue
      any = true
      await syncManagedDir(
        ctx,
        src,
        join(cacheBase, ver.name),
        `~/.claude/plugins/cache/${marketplace}/${plugin}/${ver.name}`,
      )
    }
  }
  // A directory-source marketplace is the ACTUAL live plugin location (Claude
  // ignores the cache for it). Refresh it from the deploy root so a deploy
  // reaches the running hooks — otherwise the live plugin runs whatever stale
  // commit that tree is pinned at (a silent, hard-to-spot trap).
  const mktDir = directoryMarketplaceDir(claudeDir, marketplace, root)
  if (mktDir) {
    console.log(`  ↪ marketplace loads from ${mktDir} (directory source) — syncing it too`)
    for (const plugin of plugins) {
      const src = join(root, 'integrations', 'claude-code', plugin)
      const dest = join(mktDir, 'integrations', 'claude-code', plugin)
      if (!existsSync(src) || !existsSync(dest)) continue
      any = true
      await syncManagedDir(ctx, src, dest, `${mktDir}/integrations/claude-code/${plugin}`)
    }
  }
  if (!any) console.log('  (no rivetos plugins installed in the Claude Code plugin cache)')
}

const GROK_ROOT_PLACEHOLDER = '${RIVETOS_ROOT:-/opt/rivetos}'

/** POSIX single-quote so a baked root with spaces or quotes stays one argv. */
export function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function bakeGrokCommand(command: string, root: string): string {
  if (!command.includes(GROK_ROOT_PLACEHOLDER)) return command
  let out = ''
  let rest = command
  while (rest.length > 0) {
    const idx = rest.indexOf(GROK_ROOT_PLACEHOLDER)
    if (idx < 0) {
      out += rest
      break
    }
    out += rest.slice(0, idx)
    rest = rest.slice(idx + GROK_ROOT_PLACEHOLDER.length)
    const rel = rest.match(/^\S*/)?.[0] ?? ''
    rest = rest.slice(rel.length)
    out += posixShellQuote(root + rel)
  }
  return out
}

function bakeGrokValue(value: unknown, root: string): unknown {
  if (typeof value === 'string') return bakeGrokCommand(value, root)
  if (Array.isArray(value)) return value.map((v) => bakeGrokValue(v, root))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = bakeGrokValue(v, root)
    }
    return out
  }
  return value
}

/** Rewrite copied Grok hook commands so a custom --root does not fall back
 *  to /opt/rivetos when Grok's environment has no RIVETOS_ROOT. Parses JSON
 *  and shell-quotes the baked executable so spaces/`"` in the root stay one
 *  argv and the hook file remains valid JSON. */
export function bakeGrokHookCommands(path: string, root: string): boolean {
  if (!existsSync(path)) return false
  const before = readFileSync(path, 'utf-8')
  if (!before.includes(GROK_ROOT_PLACEHOLDER)) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(before)
  } catch {
    return false
  }
  const baked = bakeGrokValue(parsed, root)
  writeFileSync(path, `${JSON.stringify(baked, null, 2)}\n`)
  return true
}

export async function syncGrok(ctx: Ctx, root: string, home: string): Promise<void> {
  const grokDir = join(home, '.grok')
  if (!existsSync(grokDir)) {
    console.log('⚪ grok not detected, skipping')
    return
  }
  console.log('🔄 grok:')
  const grokIntegrations = join(root, 'integrations', 'grok')
  if (!existsSync(grokIntegrations)) return
  for (const entry of readdirSync(grokIntegrations, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const plugin = entry.name
    const src = join(grokIntegrations, plugin)
    // skills: each skill dir is fully ours
    const skillsDir = join(src, 'skills')
    if (existsSync(skillsDir)) {
      for (const s of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!s.isDirectory()) continue
        await syncManagedDir(
          ctx,
          join(skillsDir, s.name),
          join(grokDir, 'skills', s.name),
          `~/.grok/skills/${s.name}`,
        )
      }
    }
    // commands: copy our files into the shared dir; never delete others'
    const commandsDir = join(src, 'commands')
    if (existsSync(commandsDir)) {
      await syncSharedDir(ctx, commandsDir, join(grokDir, 'commands'), '~/.grok/commands')
    }
    // hooks: whole-file ours, named per plugin
    const hooksSrc = join(src, 'hooks', 'hooks.json')
    if (existsSync(hooksSrc)) {
      const dest = join(grokDir, 'hooks', `${plugin}.json`)
      await syncFile(ctx, hooksSrc, dest, `~/.grok/hooks/${plugin}.json`)
      if (!ctx.dryRun) bakeGrokHookCommands(dest, root)
    }
    // always-on reflex
    const grokMd = join(src, 'GROK.md')
    if (existsSync(grokMd)) {
      await syncFile(ctx, grokMd, join(grokDir, 'AGENTS.md'), '~/.grok/AGENTS.md')
    }
  }
  // co-owned config: hint only, never write
  const configToml = join(grokDir, 'config.toml')
  if (
    existsSync(configToml) &&
    !readFileSync(configToml, 'utf-8').includes('[mcp_servers.rivetos]')
  ) {
    console.log(
      '  ⚠️  ~/.grok/config.toml has no [mcp_servers.rivetos] block — run the grok setup script or `grok mcp add rivetos …`',
    )
  }
}

export async function syncHermes(ctx: Ctx, root: string, home: string): Promise<void> {
  const hermesDir = join(home, '.hermes')
  if (!existsSync(hermesDir)) {
    console.log('⚪ hermes not detected, skipping')
    return
  }
  console.log('🔄 hermes:')
  const pluginSrc = join(root, 'integrations', 'hermes', 'rivet-memory')
  if (existsSync(pluginSrc)) {
    await syncManagedDir(
      ctx,
      pluginSrc,
      join(hermesDir, 'plugins', 'rivet_memory'),
      '~/.hermes/plugins/rivet_memory',
    )
  }
  const skillSrc = join(root, 'integrations', 'hermes', 'memory-recall')
  if (existsSync(skillSrc)) {
    await syncManagedDir(
      ctx,
      skillSrc,
      join(hermesDir, 'skills', 'memory-recall'),
      '~/.hermes/skills/memory-recall',
    )
  }
  // rivet-den: the hook script is a managed file; its hooks: block is MERGED
  // into the user-co-owned config.yaml (never clobbered — see mergeHermesDenHooks).
  const denHook = join(root, 'integrations', 'hermes', 'rivet-den', 'hooks', 'hermes-den-hook.mjs')
  if (existsSync(denHook)) {
    await syncFile(
      ctx,
      denHook,
      join(hermesDir, 'agent-hooks', 'hermes-den-hook.mjs'),
      '~/.hermes/agent-hooks/hermes-den-hook.mjs',
    )
    mergeHermesDenHooks(ctx, root, hermesDir)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function mergeHookEvents(
  existing: Record<string, Array<{ command?: string }>>,
  incoming: Record<string, Array<{ command?: string }>>,
): boolean {
  let changed = false
  for (const [event, entries] of Object.entries(incoming)) {
    const list = existing[event] ?? []
    for (const e of entries) {
      if (!list.some((x) => x.command === e.command)) {
        list.push(e)
        changed = true
      }
    }
    existing[event] = list
  }
  return changed
}

function hasOwnKey(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

/** Deep-merge `patch` into `target`. `hooks` is additive (keyed by command);
 *  nested objects merge by key; a *present* key is user-owned and is not
 *  overwritten (even `''` / `null`) unless `force`. */
function applyHermesPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  opts: { force?: boolean; kept: string[] },
  path = '',
): boolean {
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    const here = path ? `${path}.${key}` : key
    if (key === 'hooks' && isPlainObject(value)) {
      const hooks = (isPlainObject(target.hooks) ? target.hooks : {}) as Record<
        string,
        Array<{ command?: string }>
      >
      if (mergeHookEvents(hooks, value as Record<string, Array<{ command?: string }>>)) {
        target.hooks = hooks
        changed = true
      }
      continue
    }
    if (isPlainObject(value) && isPlainObject(target[key])) {
      if (applyHermesPatch(target[key], value, opts, here)) changed = true
      continue
    }
    if (isPlainObject(value) && target[key] == null) {
      if (!opts.force && hasOwnKey(target, key)) {
        opts.kept.push(here)
        continue
      }
      target[key] = { ...value }
      changed = true
      continue
    }
    if (target[key] !== value) {
      if (!opts.force && hasOwnKey(target, key)) {
        opts.kept.push(here)
        continue
      }
      target[key] = value
      changed = true
    }
  }
  return changed
}

/**
 * Merge a YAML patch into ~/.hermes/config.yaml — additively and
 * idempotently. config.yaml is user-co-owned: hooks are keyed by command
 * (never replaced wholesale) and nested objects keep sibling keys.
 * Rewrites only when something actually changes. An existing key is kept
 * (⚪) regardless of value (`''`, `null`, …) unless `opts.force`.
 */
export function mergeHermesConfig(
  ctx: Ctx,
  hermesDir: string,
  patch: Record<string, unknown>,
  label: string,
  opts: { force?: boolean } = {},
): void {
  const cfgPath = join(hermesDir, 'config.yaml')
  const cfg = existsSync(cfgPath)
    ? ((parseYaml(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>) ?? {})
    : {}
  const kept: string[] = []
  const changed = applyHermesPatch(cfg, patch, { force: opts.force, kept })
  for (const key of kept) {
    console.log(`⚪ ${label}  kept existing ${key} (pass --force to overwrite)`)
  }
  if (!changed) {
    ctx.stats.unchanged++
    return
  }
  console.log(`  ~ ${ctx.dryRun ? '(dry-run) ' : ''}${label}`)
  ctx.stats.written.push(label)
  if (ctx.dryRun) return
  writeFileSync(cfgPath, stringifyYaml(cfg))
}

/**
 * Merge the rivet-den hook entries into ~/.hermes/config.yaml — additively and
 * idempotently. config.yaml is user-co-owned, so we only ADD our
 * hermes-den-hook.mjs entries (keyed by command) and leave everything else
 * alone. Rewrites only when an entry is actually added (so a redeploy is a
 * no-op); the first add does reformat the file via yaml round-trip (comments
 * on the machine-managed config are not preserved).
 */
export function mergeHermesDenHooks(ctx: Ctx, root: string, hermesDir: string): void {
  const srcHooks = join(root, 'integrations', 'hermes', 'rivet-den', 'config.hooks.yaml')
  if (!existsSync(srcHooks)) return
  const denHooks =
    (
      parseYaml(readFileSync(srcHooks, 'utf-8')) as {
        hooks?: Record<string, Array<{ command?: string }>>
      } | null
    )?.hooks ?? {}
  mergeHermesConfig(ctx, hermesDir, { hooks: denHooks }, '~/.hermes/config.yaml (rivet-den hooks)')
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export default async function pluginsSync(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run')
  let rootArg: string | undefined
  const tuis: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') rootArg = args[++i]
    if (args[i] === '--tui') tuis.push(args[++i])
  }
  const known = ['claude-code', 'grok', 'hermes']
  for (const t of tuis) {
    if (!known.includes(t)) {
      console.error(`❌ unknown --tui: ${t} (known: ${known.join(', ')})`)
      process.exit(1)
    }
  }
  const want = (t: string) => tuis.length === 0 || tuis.includes(t)

  const root = findRoot(rootArg)
  if (!root) {
    console.error('❌ cannot locate the RivetOS source tree (no integrations/ found)')
    console.error('   pass --root <dir> or set RIVETOS_ROOT')
    process.exit(1)
  }
  console.log(`Syncing TUI plugin installs from ${root}${dryRun ? ' (dry-run)' : ''}\n`)

  const ctx: Ctx = { dryRun, stats: { written: [], removed: [], unchanged: 0 } }
  const home = homedir()
  if (want('claude-code')) await syncClaudeCode(ctx, root, home)
  if (want('grok')) await syncGrok(ctx, root, home)
  if (want('hermes')) await syncHermes(ctx, root, home)

  const { written, removed, unchanged } = ctx.stats
  console.log(
    `\n${dryRun ? 'Would write' : 'Wrote'} ${written.length}, ` +
      `${dryRun ? 'would remove' : 'removed'} ${removed.length}, ` +
      `${unchanged} unchanged.`,
  )
  if (written.length === 0 && removed.length === 0) console.log('✅ everything in sync')
}
