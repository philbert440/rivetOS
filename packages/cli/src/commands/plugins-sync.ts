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
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
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
// tiny copy engine: content-compared, audit-logged, delete-in-managed-dirs
// ---------------------------------------------------------------------------

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p, base))
    else if (e.isFile()) out.push(relative(base, p))
  }
  return out
}

function sameContent(a: string, b: string): boolean {
  try {
    const sa = statSync(a)
    const sb = statSync(b)
    if (sa.size !== sb.size) return false
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

function copyFile(ctx: Ctx, src: string, dest: string, label: string): void {
  if (sameContent(src, dest)) {
    ctx.stats.unchanged++
    return
  }
  const verb = existsSync(dest) ? '~' : '+'
  console.log(`  ${verb} ${ctx.dryRun ? '(dry-run) ' : ''}${label}`)
  ctx.stats.written.push(label)
  if (ctx.dryRun) return
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync(src))
}

/** Mirror srcDir into destDir: copy changed files, remove stale ones.
 *  Only use for directories we own outright. */
function syncManagedDir(ctx: Ctx, srcDir: string, destDir: string, label: string): void {
  const srcFiles = new Set(listFiles(srcDir))
  for (const rel of srcFiles) {
    copyFile(ctx, join(srcDir, rel), join(destDir, rel), `${label}/${rel}`)
  }
  if (!existsSync(destDir)) return
  for (const rel of listFiles(destDir)) {
    if (srcFiles.has(rel)) continue
    console.log(`  - ${ctx.dryRun ? '(dry-run) ' : ''}${label}/${rel} (stale)`)
    ctx.stats.removed.push(`${label}/${rel}`)
    if (!ctx.dryRun) rmSync(join(destDir, rel), { force: true })
  }
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
      for (const rel of listFiles(commandsDir)) {
        copyFile(
          ctx,
          join(commandsDir, rel),
          join(grokDir, 'commands', rel),
          `~/.grok/commands/${rel}`,
        )
      }
    }
    // hooks: whole-file ours, named per plugin
    const hooksSrc = join(src, 'hooks', 'hooks.json')
    if (existsSync(hooksSrc)) {
      copyFile(
        ctx,
        hooksSrc,
        join(grokDir, 'hooks', `${plugin}.json`),
        `~/.grok/hooks/${plugin}.json`,
      )
    }
    // always-on reflex
    const grokMd = join(src, 'GROK.md')
    if (existsSync(grokMd)) {
      copyFile(ctx, grokMd, join(grokDir, 'AGENTS.md'), '~/.grok/AGENTS.md')
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
