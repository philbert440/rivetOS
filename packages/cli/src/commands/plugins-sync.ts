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

import { execFileSync } from 'node:child_process'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXCLUDE = new Set(['node_modules', '.git', '__pycache__', '.pytest_cache'])

interface SyncStats {
  written: string[]
  removed: string[]
  unchanged: number
}

interface Ctx {
  dryRun: boolean
  stats: SyncStats
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

function runRsync(ctx: Ctx, args: string[], label: string, singleFile: boolean, srcFiles: number) {
  let output: string
  try {
    output = execFileSync('rsync', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stderr?: Buffer | string }
    if (e.code === 'ENOENT') {
      throw new Error('rsync not found on PATH — install rsync (expected on every fleet node)', {
        cause: err,
      })
    }
    const stderr = e.stderr ? String(e.stderr).trim() : ''
    throw new Error(
      `rsync failed for ${label} (exit ${e.status ?? 'unknown'})${stderr ? `: ${stderr}` : ''}`,
      { cause: err },
    )
  }
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
function syncManagedDir(ctx: Ctx, srcDir: string, destDir: string, label: string): void {
  if (!ctx.dryRun) mkdirSync(destDir, { recursive: true })
  runRsync(
    ctx,
    rsyncDirArgs(srcDir, destDir, { deleteExtraneous: true, dryRun: ctx.dryRun }),
    label,
    false,
    countFiles(srcDir),
  )
}

/** Copy our files from srcDir into a shared destDir; never delete others'. */
function syncSharedDir(ctx: Ctx, srcDir: string, destDir: string, label: string): void {
  if (!ctx.dryRun) mkdirSync(destDir, { recursive: true })
  runRsync(
    ctx,
    rsyncDirArgs(srcDir, destDir, { deleteExtraneous: false, dryRun: ctx.dryRun }),
    label,
    false,
    countFiles(srcDir),
  )
}

/** Copy a single managed file (dest may rename it). */
function syncFile(ctx: Ctx, src: string, dest: string, label: string): void {
  if (!ctx.dryRun) mkdirSync(dirname(dest), { recursive: true })
  runRsync(ctx, rsyncFileArgs(src, dest, { dryRun: ctx.dryRun }), label, true, 1)
}

// ---------------------------------------------------------------------------
// root + marketplace discovery
// ---------------------------------------------------------------------------

function findRoot(explicit?: string): string | null {
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

function syncClaudeCode(ctx: Ctx, root: string, home: string): void {
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
      syncManagedDir(
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
      syncManagedDir(ctx, src, dest, `${mktDir}/integrations/claude-code/${plugin}`)
    }
  }
  if (!any) console.log('  (no rivetos plugins installed in the Claude Code plugin cache)')
}

function syncGrok(ctx: Ctx, root: string, home: string): void {
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
        syncManagedDir(
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
      syncSharedDir(ctx, commandsDir, join(grokDir, 'commands'), '~/.grok/commands')
    }
    // hooks: whole-file ours, named per plugin
    const hooksSrc = join(src, 'hooks', 'hooks.json')
    if (existsSync(hooksSrc)) {
      syncFile(
        ctx,
        hooksSrc,
        join(grokDir, 'hooks', `${plugin}.json`),
        `~/.grok/hooks/${plugin}.json`,
      )
    }
    // always-on reflex
    const grokMd = join(src, 'GROK.md')
    if (existsSync(grokMd)) {
      syncFile(ctx, grokMd, join(grokDir, 'AGENTS.md'), '~/.grok/AGENTS.md')
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

function syncHermes(ctx: Ctx, root: string, home: string): void {
  const hermesDir = join(home, '.hermes')
  if (!existsSync(hermesDir)) {
    console.log('⚪ hermes not detected, skipping')
    return
  }
  console.log('🔄 hermes:')
  const pluginSrc = join(root, 'integrations', 'hermes', 'rivet-memory')
  if (existsSync(pluginSrc)) {
    syncManagedDir(
      ctx,
      pluginSrc,
      join(hermesDir, 'plugins', 'rivet_memory'),
      '~/.hermes/plugins/rivet_memory',
    )
  }
  const skillSrc = join(root, 'integrations', 'hermes', 'memory-recall')
  if (existsSync(skillSrc)) {
    syncManagedDir(
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
    syncFile(
      ctx,
      denHook,
      join(hermesDir, 'agent-hooks', 'hermes-den-hook.mjs'),
      '~/.hermes/agent-hooks/hermes-den-hook.mjs',
    )
    mergeHermesDenHooks(ctx, root, hermesDir)
  }
}

/**
 * Merge the rivet-den hook entries into ~/.hermes/config.yaml — additively and
 * idempotently. config.yaml is user-co-owned, so we only ADD our
 * hermes-den-hook.mjs entries (keyed by command) and leave everything else
 * alone. Rewrites only when an entry is actually added (so a redeploy is a
 * no-op); the first add does reformat the file via yaml round-trip (comments
 * on the machine-managed config are not preserved).
 */
function mergeHermesDenHooks(ctx: Ctx, root: string, hermesDir: string): void {
  const srcHooks = join(root, 'integrations', 'hermes', 'rivet-den', 'config.hooks.yaml')
  if (!existsSync(srcHooks)) return
  const cfgPath = join(hermesDir, 'config.yaml')
  const denHooks =
    (
      parseYaml(readFileSync(srcHooks, 'utf-8')) as {
        hooks?: Record<string, Array<{ command?: string }>>
      } | null
    )?.hooks ?? {}
  const cfg = existsSync(cfgPath)
    ? ((parseYaml(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>) ?? {})
    : {}
  const hooks = (cfg.hooks ?? {}) as Record<string, Array<{ command?: string }>>
  let changed = false
  for (const [event, entries] of Object.entries(denHooks)) {
    const list = hooks[event] ?? []
    for (const e of entries) {
      if (!list.some((x) => x.command === e.command)) {
        list.push(e)
        changed = true
      }
    }
    hooks[event] = list
  }
  const label = '~/.hermes/config.yaml (rivet-den hooks)'
  if (!changed) {
    ctx.stats.unchanged++
    return
  }
  console.log(`  ~ ${ctx.dryRun ? '(dry-run) ' : ''}${label}`)
  ctx.stats.written.push(label)
  if (ctx.dryRun) return
  cfg.hooks = hooks
  writeFileSync(cfgPath, stringifyYaml(cfg))
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export default function pluginsSync(args: string[]): void {
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
  if (want('claude-code')) syncClaudeCode(ctx, root, home)
  if (want('grok')) syncGrok(ctx, root, home)
  if (want('hermes')) syncHermes(ctx, root, home)

  const { written, removed, unchanged } = ctx.stats
  console.log(
    `\n${dryRun ? 'Would write' : 'Wrote'} ${written.length}, ` +
      `${dryRun ? 'would remove' : 'removed'} ${removed.length}, ` +
      `${unchanged} unchanged.`,
  )
  if (written.length === 0 && removed.length === 0) console.log('✅ everything in sync')
}
