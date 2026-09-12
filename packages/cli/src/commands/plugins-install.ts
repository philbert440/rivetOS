/**
 * rivetos plugins install — detect coding harnesses on this laptop and
 * install RivetOS memory capture + recall into each, using the per-harness
 * installers that already exist.
 *
 * `plugins sync` never installs new (by design). This command is the one
 * that does.
 *
 * Usage:
 *   rivetos plugins install [--harness <id>…] [--dry-run] [--root <dir>] [--force]
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { HARNESS_IDS, type HarnessId } from '@rivetos/types'
import {
  DEFAULT_EXTRA_DIRS,
  detectHarnesses,
  execFileAsync,
  expandHome,
  type DetectedHarness,
  type ExecResult,
} from '../lib/harness-detect.js'
import {
  createSyncCtx,
  findRoot,
  mergeHermesConfig,
  syncGrok,
  syncHermes,
  type Ctx,
} from './plugins-sync.js'

const HARNESS_ID_SET = new Set<string>(HARNESS_IDS)

/** Roster entries copied from den-server `term/roster.ts` `defaultRoster()`.
 *  CLI does not import den-server. `cmd[0]` is replaced with the detected
 *  absolute binary at write time. `shell` (`bash -l`) is always emitted —
 *  `createRosterProvider` uses this file *instead of* `defaultRoster()`,
 *  so omitting it deletes the Shell picker entry. */
export const DEFAULT_ROSTER_COMMANDS: Record<
  string,
  { label: string; cmd: string[]; room: boolean; cwd?: string }
> = {
  claude: { label: 'Claude Code', cmd: ['claude'], room: true },
  grok: {
    label: 'Grok Build',
    cmd: ['grok', '--permission-mode', 'bypassPermissions'],
    room: true,
  },
  hermes: { label: 'Hermes', cmd: ['hermes', '--yolo', '--accept-hooks'], room: true },
  kimi: { label: 'Kimi Code', cmd: ['kimi', '--yolo'], room: true },
  codex: { label: 'Codex', cmd: ['codex'], room: true },
  opencode: { label: 'OpenCode', cmd: ['opencode'], room: true },
  pi: { label: 'Pi', cmd: ['pi'], room: true },
  shell: { label: 'Shell', cmd: ['bash', '-l'], room: false },
}

export interface TermRosterFile {
  default: string
  commands: Record<string, { label: string; cmd: string[]; room: boolean; cwd?: string }>
  cwd: string
  env: Record<string, string>
}

export interface ParsedInstallArgs {
  dryRun: boolean
  force: boolean
  root?: string
  harnesses: HarnessId[]
}

export interface InstallAction {
  id: HarnessId
  command: string
  binary: string
  steps: string[]
}

export interface PluginsInstallDeps {
  home?: string
  detect?: (opts: {
    pathEnv?: string
    extraDirs?: string[]
    home?: string
    skipVersion?: boolean
  }) => Promise<DetectedHarness[]>
  exec?: typeof execFileAsync
  /** Override `process.platform` (tests). */
  platform?: NodeJS.Platform
  /** Override `process.getuid()` for launchd `gui/$UID` (tests). */
  uid?: number
}

/** Legacy systemd/launchd names — used only to disable + delete leftover watchers. */
const LEGACY_CAPTURE_WATCHER: Record<'codex' | 'pi' | 'opencode', { unit: string; label: string }> =
  {
    codex: { unit: 'codex-memory-capture.service', label: 'dev.rivetos.codex-capture' },
    pi: { unit: 'pi-memory-capture.service', label: 'dev.rivetos.pi-capture' },
    opencode: { unit: 'opencode-memory-capture.service', label: 'dev.rivetos.opencode-capture' },
  }

/** User-facing marker. Detection matches `codex-memory-capture.sh` and `--hook` anywhere. */
export const CODEX_HOOK_COMMAND_SUFFIX = 'codex-memory-capture.sh --hook'
export const CODEX_REQUIREMENTS_TOML = '/etc/codex/requirements.toml'

const SETUP_SCRIPTS: Partial<Record<HarnessId, string>> = {
  'kimi-code': join('integrations', 'kimi', 'rivet-memory', 'bin', 'setup-kimi-rivet-memory.sh'),
  codex: join('integrations', 'codex', 'rivet-memory', 'bin', 'setup-codex-rivet-memory.sh'),
  pi: join('integrations', 'pi', 'rivet-memory', 'bin', 'setup-pi-rivet-memory.sh'),
  opencode: join(
    'integrations',
    'opencode',
    'rivet-memory',
    'bin',
    'setup-opencode-rivet-memory.sh',
  ),
}

export function parseInstallArgs(args: string[]): ParsedInstallArgs {
  const parsed: ParsedInstallArgs = { dryRun: false, force: false, harnesses: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--force') parsed.force = true
    else if (arg === '--root') parsed.root = args[++i]
    else if (arg === '--harness') {
      const id = args[++i]
      if (!id || !HARNESS_ID_SET.has(id)) {
        throw new Error(
          `unknown --harness: ${id ?? '(missing)'} (known: ${HARNESS_IDS.join(', ')})`,
        )
      }
      parsed.harnesses.push(id as HarnessId)
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('HELP')
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return parsed
}

function showHelp(): void {
  console.log(`Usage: rivetos plugins install [options]

Detect coding harnesses on PATH and install RivetOS memory capture + recall
into each, using the existing per-harness installers.

Options:
  --harness <id>   Limit to one harness (repeatable). ids: ${HARNESS_IDS.join(', ')}
  --dry-run        Print the plan and touch nothing
  --root <dir>     RivetOS source tree (or set RIVETOS_ROOT)
  --force          Overwrite den-term.json, Hermes scalars, and setup-script artefacts
  -h, --help       Show this help
`)
}

/** Append `[mcp_servers.rivetos]` to a Grok config.toml iff the marker is
 *  absent. Pure: returns the new contents (caller writes). */
const BASH = '/bin/bash'

/** Invoke MCP launchers via bash, never as argv0 — git mode is 100755 on
 *  main, but mode bits do not survive every copy path. */
export function rivetosMcpServer(scriptPath: string): { command: string; args: string[] } {
  return { command: BASH, args: [scriptPath] }
}

export function ensureGrokMcpBlock(configToml: string, root: string): string {
  if (tomlHasUncommentedTable(configToml, 'mcp_servers.rivetos')) return configToml
  const command = join(root, 'integrations', 'grok', 'rivet-memory', 'bin', 'rivet-memory-mcp.sh')
  const block = `[mcp_servers.rivetos]\ncommand = "${BASH}"\nargs = ["${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]\n`
  const trimmed = configToml.replace(/\s*$/, '')
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block
}

/** Same shape as kimi-transcript-backfill `resolvePgUrl` plus optional `export`. */
function envLineRe(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=\\s*(.*)$`)
}

function parseEnvValue(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '')
}

export function ensureEnvKey(envText: string, key: string, value: string): string {
  const re = envLineRe(key)
  for (const line of envText.split('\n')) {
    if (re.test(line)) return envText
  }
  const trimmed = envText.replace(/\s*$/, '')
  const line = `${key}=${value}`
  return trimmed.length > 0 ? `${trimmed}\n${line}\n` : `${line}\n`
}

export function readEnvKey(envText: string, key: string): string | undefined {
  const re = envLineRe(key)
  for (const line of envText.split('\n')) {
    const m = re.exec(line)
    if (m) return parseEnvValue(m[1])
  }
  return undefined
}

/** Like ensureEnvKey, but replaces an existing empty assignment. */
export function ensureNonEmptyEnvKey(envText: string, key: string, value: string): string {
  const re = envLineRe(key)
  const lines = envText.split('\n')
  let found = false
  const out = lines.map((line) => {
    const m = re.exec(line)
    if (!m) return line
    found = true
    const current = parseEnvValue(m[1] ?? '')
    if (current.length > 0) return line
    return `${key}=${value}`
  })
  if (found) return out.join('\n')
  return ensureEnvKey(envText, key, value)
}

function nonemptyEnv(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}

/** Source PG URL: RIVETOS_ENV_FILE (or ~/.rivetos/.env), then process.env. */
export function sourcePgUrl(home: string): string | undefined {
  const envFile = process.env.RIVETOS_ENV_FILE || join(home, '.rivetos', '.env')
  const fromFile = existsSync(envFile)
    ? nonemptyEnv(readEnvKey(readFileSync(envFile, 'utf-8'), 'RIVETOS_PG_URL'))
    : undefined
  return fromFile ?? nonemptyEnv(process.env.RIVETOS_PG_URL)
}

export function planPluginsInstall(harnesses: DetectedHarness[], root: string): InstallAction[] {
  return harnesses.map((h) => ({
    id: h.id,
    command: h.command,
    binary: h.binary,
    steps: stepsFor(h, root),
  }))
}

function stepsFor(h: DetectedHarness, root: string): string[] {
  switch (h.id) {
    case 'claude-code':
      return [
        `claude plugin marketplace add ${root}`,
        'claude plugin install rivet-memory@rivetos (skip if listed)',
        `fallback: node ${join(root, 'plugins/providers/claude-cli/dist/hooks.js')} --install + claude mcp add rivetos`,
      ]
    case 'grok-build':
      return [
        'sync grok skills/commands/hooks/AGENTS.md',
        'ensure [mcp_servers.rivetos] in ~/.grok/config.toml',
      ]
    case 'kimi-code':
      return [`run ${SETUP_SCRIPTS['kimi-code']} --apply`]
    case 'codex':
      return [`run ${SETUP_SCRIPTS.codex} --apply`, 'register Codex hooks (hooks.json)']
    case 'hermes':
      return [
        'sync hermes plugin + memory-recall skill + den hooks',
        h.venv
          ? `pip install -r integrations/hermes/rivet-memory/requirements.txt into ${h.venv}`
          : 'skip pip (no ~/.hermes/hermes-agent/venv)',
        'merge memory.provider: rivet_memory into ~/.hermes/config.yaml',
        'ensure RIVETOS_PG_URL in ~/.hermes/.env (from ~/.rivetos/.env)',
      ]
    case 'opencode':
      return [`run ${SETUP_SCRIPTS.opencode} --apply`, 'install OpenCode plugin']
    case 'pi':
      return [`run ${SETUP_SCRIPTS.pi} --apply`, 'install pi extension']
  }
}

export function buildDenTermRoster(
  harnesses: DetectedHarness[],
  home: string,
): TermRosterFile | null {
  const commands: TermRosterFile['commands'] = {}
  for (const h of harnesses) {
    const entry = DEFAULT_ROSTER_COMMANDS[h.command]
    if (!entry) continue
    const built: TermRosterFile['commands'][string] = {
      label: entry.label,
      room: entry.room,
      cmd: [h.binary, ...entry.cmd.slice(1)],
    }
    if (h.command === 'opencode') built.cwd = join(home, '.rivetos', 'workspace')
    else if (entry.cwd) built.cwd = entry.cwd
    commands[h.command] = built
  }
  const keys = Object.keys(commands)
  if (keys.length === 0) return null
  const shell = DEFAULT_ROSTER_COMMANDS.shell
  commands.shell = {
    label: shell.label,
    room: shell.room,
    cmd: [...shell.cmd],
  }
  return {
    default: 'claude' in commands ? 'claude' : keys[0],
    commands,
    cwd: home,
    env: {},
  }
}

function oneLine(id: HarnessId, ok: boolean, detail: string, dryRun: boolean): void {
  const icon = dryRun ? '📋' : ok ? '✅' : '❌'
  console.log(`${icon} ${id}  ${detail}`)
}

async function runClaudeInstall(
  h: DetectedHarness,
  root: string,
  exec: typeof execFileAsync,
): Promise<{ ok: boolean; detail: string }> {
  const listed = await exec(h.binary, ['plugin', 'list'], { timeoutMs: 15_000 })
  const pluginCmdOk = listed.code === 0
  if (pluginCmdOk && /rivet-memory/i.test(listed.stdout + listed.stderr)) {
    return { ok: true, detail: 'already installed (claude plugin list)' }
  }
  if (pluginCmdOk) {
    const add = await exec(h.binary, ['plugin', 'marketplace', 'add', root], { timeoutMs: 30_000 })
    const inst = await exec(h.binary, ['plugin', 'install', 'rivet-memory@rivetos'], {
      timeoutMs: 30_000,
    })
    if (inst.code === 0) {
      return { ok: true, detail: 'claude plugin install rivet-memory@rivetos' }
    }
    return {
      ok: false,
      detail: `claude plugin install failed (marketplace add exit ${add.code ?? 'n/a'}): ${(inst.stderr || inst.stdout).trim().slice(0, 200)}`,
    }
  }
  // `claude plugin` unavailable — fallback hooks.js --install + claude mcp add
  const hooksJs = join(root, 'plugins', 'providers', 'claude-cli', 'dist', 'hooks.js')
  if (!existsSync(hooksJs)) {
    return { ok: false, detail: `fallback hooks.js missing at ${hooksJs} (build the tree)` }
  }
  const hooks = await exec(process.execPath, [hooksJs, '--install'], { timeoutMs: 15_000 })
  const mcpSh = join(
    root,
    'integrations',
    'claude-code',
    'rivet-memory',
    'bin',
    'rivet-memory-mcp.sh',
  )
  const mcp = await exec(h.binary, ['mcp', 'add', 'rivetos', '--', mcpSh], { timeoutMs: 15_000 })
  const hooksOk = hooks.code === 0
  const mcpOk = mcp.code === 0
  const ok = hooksOk && mcpOk
  if (ok) {
    return { ok: true, detail: 'fallback hooks.js --install + claude mcp add' }
  }
  const failed: string[] = []
  if (!hooksOk) failed.push('hooks.js --install')
  if (!mcpOk) failed.push('claude mcp add')
  return { ok: false, detail: `fallback failed: ${failed.join(' and ')}` }
}

/** Warn when marketplace add would register a worktree, not the installed root. */
export function marketplaceRootWarning(root: string): string | null {
  const resolved = resolve(root)
  if (resolved === resolve('/opt/rivetos')) return null
  for (const envKey of ['RIVETOS_INSTALL_ROOT', 'RIVETOS_ROOT'] as const) {
    const v = process.env[envKey]
    if (v && resolved === resolve(v)) return null
  }
  return (
    `marketplace add ${root} is not /opt/rivetos (or RIVETOS_INSTALL_ROOT/RIVETOS_ROOT) — ` +
    `a dev tree registered as the rivetos marketplace will shadow the installed plugin`
  )
}

function skipTomlWs(s: string, i: number): number {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r')) i += 1
  return i
}

const TOML_BASIC_ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
}

function parseTomlKey(s: string, i: number): { key: string; next: number } | null {
  if (i >= s.length) return null
  const q = s[i]
  if (q === '"' || q === "'") {
    let key = ''
    let j = i + 1
    while (j < s.length) {
      const c = s[j]
      if (c === q) return { key, next: j + 1 }
      if (q === '"' && c === '\\') {
        j += 1
        if (j >= s.length) return null
        const e = s[j]
        if (e === 'u' || e === 'U') {
          const width = e === 'u' ? 4 : 8
          const hex = s.slice(j + 1, j + 1 + width)
          if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) return null
          const cp = Number.parseInt(hex, 16)
          if (!Number.isFinite(cp) || cp > 0x10ffff) return null
          key += String.fromCodePoint(cp)
          j += 1 + width
          continue
        }
        const mapped = TOML_BASIC_ESCAPES[e]
        if (mapped === undefined) return null
        key += mapped
        j += 1
        continue
      }
      key += c
      j += 1
    }
    return null
  }
  let j = i
  while (j < s.length && /[A-Za-z0-9_-]/.test(s[j])) j += 1
  if (j === i) return null
  return { key: s.slice(i, j), next: j }
}

/** Decode a TOML table header into its key path, or null if the line is not
 *  a well-formed table (`[a.b]`, `[a."b"]`). Rejects array tables and
 *  trailing garbage after `]`. */
export function parseTomlTableKeys(line: string): string[] | null {
  let i = skipTomlWs(line, 0)
  if (line[i] !== '[') return null
  i += 1
  if (line[i] === '[') return null
  const keys: string[] = []
  i = skipTomlWs(line, i)
  for (;;) {
    const parsed = parseTomlKey(line, i)
    if (!parsed) return null
    keys.push(parsed.key)
    i = skipTomlWs(line, parsed.next)
    if (line[i] === '.') {
      i = skipTomlWs(line, i + 1)
      continue
    }
    if (line[i] === ']') {
      i = skipTomlWs(line, i + 1)
      if (i < line.length && line[i] !== '#') return null
      return keys.length > 0 ? keys : null
    }
    return null
  }
}

function skipTomlBasicString(text: string, i: number): number {
  const n = text.length
  while (i < n && text[i] !== '"' && text[i] !== '\n') {
    i += text[i] === '\\' ? 2 : 1
  }
  return i < n && text[i] === '"' ? i + 1 : i
}

function skipTomlLiteralString(text: string, i: number): number {
  const n = text.length
  while (i < n && text[i] !== "'" && text[i] !== '\n') i += 1
  return i < n && text[i] === "'" ? i + 1 : i
}

function skipTomlMlBasic(text: string, i: number): number {
  const n = text.length
  while (i < n) {
    if (text.startsWith('"""', i)) return i + 3
    i += text[i] === '\\' ? 2 : 1
  }
  return n
}

function skipTomlMlLiteral(text: string, i: number): number {
  const n = text.length
  while (i < n) {
    if (text.startsWith("'''", i)) return i + 3
    i += 1
  }
  return n
}

export function tomlHasUncommentedTable(text: string, table: string): boolean {
  const want = table.split('.')
  let i = 0
  const n = text.length
  let arrayDepth = 0
  while (i < n) {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r')) i += 1
    if (i >= n) break
    if (text[i] === '\n') {
      i += 1
      continue
    }
    if (text[i] === '#') {
      while (i < n && text[i] !== '\n') i += 1
      continue
    }
    if (text.startsWith('"""', i)) {
      i = skipTomlMlBasic(text, i + 3)
      continue
    }
    if (text.startsWith("'''", i)) {
      i = skipTomlMlLiteral(text, i + 3)
      continue
    }
    if (text[i] === '"') {
      i = skipTomlBasicString(text, i + 1)
      continue
    }
    if (text[i] === "'") {
      i = skipTomlLiteralString(text, i + 1)
      continue
    }
    if (text[i] === '[') {
      if (arrayDepth === 0) {
        const nl = text.indexOf('\n', i)
        const line = nl === -1 ? text.slice(i) : text.slice(i, nl)
        const keys = parseTomlTableKeys(line)
        if (keys && keys.length === want.length && keys.every((k, idx) => k === want[idx])) {
          return true
        }
      }
      arrayDepth += 1
      i += 1
      continue
    }
    if (text[i] === ']') {
      if (arrayDepth > 0) arrayDepth -= 1
      i += 1
      continue
    }
    i += 1
  }
  return false
}

export function uncommentedLineContains(text: string, needle: string): boolean {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.includes(needle)) return true
  }
  return false
}

export function mcpJsonHasRivetos(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers?: unknown }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const servers = parsed.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false
    return Boolean((servers as Record<string, unknown>).rivetos)
  } catch {
    return false
  }
}

/** OpenCode `opencode.json` / `opencode.jsonc` MCP block (`mcp.rivetos`). */
export function opencodeJsonHasRivetos(cfgPath: string): boolean {
  const candidates = new Set<string>([cfgPath])
  if (cfgPath.endsWith('.jsonc')) candidates.add(cfgPath.slice(0, -1))
  else if (cfgPath.endsWith('.json')) candidates.add(`${cfgPath}c`)
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { mcp?: unknown }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const mcp = parsed.mcp
      if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) continue
      if ((mcp as Record<string, unknown>).rivetos) return true
    } catch {
      // missing or non-JSON (comments-only jsonc) — try the sibling
    }
  }
  return false
}

export function tomlFileHasRivetosTable(path: string): boolean {
  try {
    return tomlHasUncommentedTable(readFileSync(path, 'utf-8'), 'mcp_servers.rivetos')
  } catch {
    return false
  }
}

/** Config homes the setup scripts actually write. An explicit
 *  CODEX_HOME / KIMI_CODE_HOME is the script's effective home
 *  — do not also repair or validate the defaults. */
export function artefactConfigHomes(id: HarnessId, home: string, configHome: string): string[] {
  const envHome = nonemptyEnv(
    (id === 'kimi-code'
      ? process.env.KIMI_CODE_HOME
      : id === 'codex'
        ? process.env.CODEX_HOME
        : id === 'pi'
          ? process.env.PI_AGENT_HOME
          : id === 'opencode'
            ? process.env.OPENCODE_CONFIG_DIR
            : undefined
    )?.trim(),
  )
  if (envHome) return [envHome]
  const defaults =
    id === 'kimi-code'
      ? [configHome, join(home, '.kimi-code'), join(home, '.kimi')]
      : id === 'codex'
        ? [configHome, join(home, '.codex')]
        : id === 'pi'
          ? [configHome, join(home, '.pi', 'agent')]
          : id === 'opencode'
            ? [configHome, join(home, '.config', 'opencode')]
            : [configHome]
  return [...new Set(defaults.filter((d) => d.length > 0))]
}

export function kimiConfigHomes(home: string, configHome: string): string[] {
  return artefactConfigHomes('kimi-code', home, configHome)
}

/** True when a hook command contains both the capture script and `--hook` (quoted paths included). */
function commandHasCodexCapture(command: string): boolean {
  return command.includes('codex-memory-capture.sh') && command.includes('--hook')
}

function jsonCommandHasCodexCapture(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(jsonCommandHasCodexCapture)
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (typeof rec.command === 'string' && commandHasCodexCapture(rec.command)) return true
    return Object.values(rec).some(jsonCommandHasCodexCapture)
  }
  return false
}

function uncommentedLineHasCodexCapture(text: string): boolean {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (commandHasCodexCapture(trimmed)) return true
  }
  return false
}

/** True when hooks.json has a command entry containing `codex-memory-capture.sh` and `--hook`. */
export function hooksJsonHasCodexCapture(path: string): boolean {
  try {
    return jsonCommandHasCodexCapture(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return false
  }
}

export function requirementsTomlHasCodexHook(path: string): boolean {
  try {
    return uncommentedLineHasCodexCapture(readFileSync(path, 'utf-8'))
  } catch {
    return false
  }
}

export interface NativeCaptureOpts {
  /** Override `/etc/codex/requirements.toml` (tests). */
  codexRequirementsPath?: string
}

/** Null when the native capture trigger is registered; otherwise a short missing-reason. */
export function nativeCaptureArtefactMissing(
  id: HarnessId,
  home: string,
  configHome: string,
  opts: NativeCaptureOpts = {},
): string | null {
  const homes = artefactConfigHomes(id, home, configHome)
  switch (id) {
    case 'codex': {
      const hooks = homes.some((dir) => hooksJsonHasCodexCapture(join(dir, 'hooks.json')))
      const managed = requirementsTomlHasCodexHook(
        opts.codexRequirementsPath ?? CODEX_REQUIREMENTS_TOML,
      )
      return hooks || managed ? null : 'hooks.json missing codex-memory-capture.sh --hook'
    }
    case 'pi': {
      const ext = homes.some((dir) => existsSync(join(dir, 'extensions', 'rivet-memory.ts')))
      return ext ? null : 'pi extension missing (extensions/rivet-memory.ts)'
    }
    case 'opencode': {
      const plugin = homes.some((dir) => existsSync(join(dir, 'plugins', 'rivet-memory.ts')))
      return plugin ? null : 'OpenCode plugin missing (plugins/rivet-memory.ts)'
    }
    default:
      return null
  }
}

/** Null when the harness artefact is present; otherwise a short missing-reason. */
export function setupArtefactMissing(
  id: HarnessId,
  home: string,
  configHome: string,
  opts: NativeCaptureOpts = {},
): string | null {
  const homes = artefactConfigHomes(id, home, configHome)
  switch (id) {
    case 'kimi-code': {
      const mcp = homes.some((dir) => mcpJsonHasRivetos(join(dir, 'mcp.json')))
      return mcp ? null : 'mcp.json missing rivetos server'
    }
    case 'codex': {
      const mcp = homes.some(
        (dir) =>
          mcpJsonHasRivetos(join(dir, 'mcp.json')) ||
          tomlFileHasRivetosTable(join(dir, 'config.toml')),
      )
      if (!mcp) return 'mcp.json / config.toml missing rivetos MCP block'
      return nativeCaptureArtefactMissing(id, home, configHome, opts)
    }
    case 'pi': {
      const mcp = homes.some((dir) => mcpJsonHasRivetos(join(dir, 'mcp.json')))
      if (!mcp) return 'mcp.json missing rivetos server'
      return nativeCaptureArtefactMissing(id, home, configHome, opts)
    }
    case 'opencode': {
      const mcp = homes.some((dir) => opencodeJsonHasRivetos(join(dir, 'opencode.json')))
      if (!mcp) return 'opencode.json / opencode.jsonc missing rivetos MCP block'
      return nativeCaptureArtefactMissing(id, home, configHome, opts)
    }
    default:
      return null
  }
}

function mergeOpencodeMcpJson(cfgPath: string, command: string): boolean {
  if (!existsSync(cfgPath)) return false
  let parsed: { mcp?: Record<string, unknown> }
  try {
    parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { mcp?: Record<string, unknown> }
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object') return false
  if (!parsed.mcp || typeof parsed.mcp !== 'object' || Array.isArray(parsed.mcp)) {
    parsed.mcp = {}
  }
  if (parsed.mcp.rivetos) return true
  parsed.mcp.rivetos = {
    type: 'local',
    command: [BASH, command],
    enabled: true,
  }
  writeFileSync(cfgPath, `${JSON.stringify(parsed, null, 2)}\n`)
  return true
}

function mergeRivetosMcpJson(mcpPath: string, command: string): boolean {
  if (!existsSync(mcpPath)) return false
  let parsed: { mcpServers?: Record<string, unknown> }
  try {
    parsed = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers?: Record<string, unknown> }
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object') return false
  if (
    !parsed.mcpServers ||
    typeof parsed.mcpServers !== 'object' ||
    Array.isArray(parsed.mcpServers)
  ) {
    parsed.mcpServers = {}
  }
  const servers = parsed.mcpServers
  if (servers.rivetos) return true
  servers.rivetos = rivetosMcpServer(command)
  writeFileSync(mcpPath, `${JSON.stringify(parsed, null, 2)}\n`)
  return true
}

function mcpTomlBlock(command: string): string {
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `[mcp_servers.rivetos]\ncommand = "${BASH}"\nargs = ["${escaped}"]\n`
}

function ensureSetupArtefact(id: HarnessId, h: DetectedHarness, root: string, home: string): void {
  if (id === 'kimi-code') {
    const command = join(root, 'integrations', 'kimi', 'rivet-memory', 'bin', 'rivet-memory-mcp.sh')
    for (const dir of artefactConfigHomes(id, home, h.configHome)) {
      const mcp = join(dir, 'mcp.json')
      if (existsSync(mcp)) mergeRivetosMcpJson(mcp, command)
    }
    return
  }
  if (id === 'codex') {
    const command = join(
      root,
      'integrations',
      'codex',
      'rivet-memory',
      'bin',
      'rivet-memory-mcp.sh',
    )
    for (const dir of artefactConfigHomes(id, home, h.configHome)) {
      const mcp = join(dir, 'mcp.json')
      if (existsSync(mcp)) mergeRivetosMcpJson(mcp, command)
      const toml = join(dir, 'config.toml')
      if (existsSync(toml) && !tomlFileHasRivetosTable(toml)) {
        const block = mcpTomlBlock(command)
        const before = readFileSync(toml, 'utf-8')
        const trimmed = before.replace(/\s*$/, '')
        writeFileSync(toml, trimmed.length > 0 ? `${trimmed}\n\n${block}` : block)
      }
    }
    return
  }
  if (id === 'pi') {
    const command = join(root, 'integrations', 'pi', 'rivet-memory', 'bin', 'rivet-memory-mcp.sh')
    for (const dir of artefactConfigHomes(id, home, h.configHome)) {
      const mcp = join(dir, 'mcp.json')
      if (existsSync(mcp)) mergeRivetosMcpJson(mcp, command)
    }
    return
  }
  if (id === 'opencode') {
    const command = join(
      root,
      'integrations',
      'opencode',
      'rivet-memory',
      'bin',
      'rivet-memory-mcp.sh',
    )
    for (const dir of artefactConfigHomes(id, home, h.configHome)) {
      mergeOpencodeMcpJson(join(dir, 'opencode.json'), command)
    }
  }
}

function unlinkExisting(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function legacyStopAlreadyDone(kind: 'systemctl' | 'launchctl', result: ExecResult): boolean {
  if (result.timedOut) return false
  if (result.code === 0) return true
  if (kind === 'systemctl') {
    if (result.code === 5) return true
    return /not loaded|could not be found|No such file/.test(result.stderr)
  }
  return /No such process|Could not find/.test(result.stderr)
}

export type LegacyWatcherRemoval =
  { ok: true; removed: boolean } | { ok: false; removed: false; detail: string }

function legacyStopFailed(name: string, result: ExecResult): LegacyWatcherRemoval {
  const exit = result.code ?? 'n/a'
  const first = result.stderr.split('\n')[0]
  return {
    ok: false,
    removed: false,
    detail: `legacy capture watcher ${name} could not be stopped (exit ${exit}): ${first}`,
  }
}

/** Stop + disable + delete leftover capture-watcher units/plists. Idempotent. */
export async function removeLegacyCaptureWatcher(opts: {
  id: 'codex' | 'pi' | 'opencode'
  home: string
  exec: typeof execFileAsync
  platform: NodeJS.Platform
  uid?: number
}): Promise<LegacyWatcherRemoval> {
  const { unit, label } = LEGACY_CAPTURE_WATCHER[opts.id]
  const unitPath = join(opts.home, '.config', 'systemd', 'user', unit)
  const plistPath = join(opts.home, 'Library', 'LaunchAgents', `${label}.plist`)
  let removed = false

  if (existsSync(unitPath)) {
    if (opts.platform === 'linux') {
      const result = await opts.exec('systemctl', ['--user', 'disable', '--now', unit], {
        timeoutMs: 15_000,
      })
      if (!legacyStopAlreadyDone('systemctl', result)) return legacyStopFailed(unit, result)
    }
    if (!unlinkExisting(unitPath)) {
      return {
        ok: false,
        removed: false,
        detail: `legacy capture watcher ${unit} could not be removed`,
      }
    }
    removed = true
  }

  if (existsSync(plistPath)) {
    if (opts.platform === 'darwin') {
      const uid = opts.uid ?? process.getuid?.()
      if (uid !== undefined) {
        const result = await opts.exec('launchctl', ['bootout', `gui/${uid}/${label}`], {
          timeoutMs: 15_000,
        })
        if (!legacyStopAlreadyDone('launchctl', result)) return legacyStopFailed(label, result)
      }
    }
    if (!unlinkExisting(plistPath)) {
      return {
        ok: false,
        removed: false,
        detail: `legacy capture watcher ${label} could not be removed`,
      }
    }
    removed = true
  }

  return { ok: true, removed }
}

const SETUP_BIN_ENV: Partial<Record<HarnessId, string>> = {
  codex: 'CODEX_BIN',
  'kimi-code': 'KIMI_BIN',
  pi: 'PI_BIN',
  opencode: 'OPENCODE_BIN',
}

/** PATH + `CODEX_BIN`/`KIMI_BIN`/`PI_BIN`/`OPENCODE_BIN` so a harness found only in a
 *  mise shim / extra dir is visible to `command -v` inside setup scripts. */
export function setupScriptEnv(h: DetectedHarness, root: string, home: string): NodeJS.ProcessEnv {
  const extra = DEFAULT_EXTRA_DIRS.map((d) => expandHome(d, home))
  const seen = new Set<string>()
  const parts: string[] = []
  for (const dir of [dirname(h.binary), ...extra, ...(process.env.PATH ?? '').split(delimiter)]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    parts.push(dir)
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RIVETOS_ROOT: root,
    PATH: parts.join(delimiter),
  }
  const binKey = SETUP_BIN_ENV[h.id]
  if (binKey) env[binKey] = h.binary
  return env
}

async function runSetupScript(
  id: HarnessId,
  h: DetectedHarness,
  scriptRel: string,
  root: string,
  home: string,
  exec: typeof execFileAsync,
  force: boolean,
  watcher: { platform: NodeJS.Platform; uid?: number },
): Promise<{ ok: boolean; detail: string }> {
  const script = join(root, scriptRel)
  if (!existsSync(script)) {
    return { ok: false, detail: `setup script missing: ${script}` }
  }
  const applyArgs = force ? [script, '--apply', '--force'] : [script, '--apply']
  const result: ExecResult = await exec('bash', applyArgs, {
    timeoutMs: 60_000,
    env: setupScriptEnv(h, root, home),
    cwd: root,
  })
  if (result.code !== 0) {
    return {
      ok: false,
      detail: `${scriptRel} --apply failed (exit ${result.code ?? 'n/a'}${result.timedOut ? ', timed out' : ''}): ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
    }
  }
  ensureSetupArtefact(id, h, root, home)
  const missing = setupArtefactMissing(id, home, h.configHome)
  if (missing) {
    return { ok: false, detail: `${scriptRel} --apply exited 0 but ${missing}` }
  }
  const bits = [`${scriptRel} --apply`]
  if (id === 'codex' || id === 'pi' || id === 'opencode') {
    const migration = await removeLegacyCaptureWatcher({
      id,
      home,
      exec,
      platform: watcher.platform,
      uid: watcher.uid,
    })
    if (!migration.ok) return { ok: false, detail: migration.detail }
    if (migration.removed) bits.push('removed legacy capture watcher')
  }
  return { ok: true, detail: bits.join('; ') }
}

async function installGrok(
  h: DetectedHarness,
  root: string,
  home: string,
  dryRun: boolean,
  exec: typeof execFileAsync,
): Promise<{ ok: boolean; detail: string }> {
  if (dryRun) return { ok: true, detail: 'would sync + ensure MCP block' }
  mkdirSync(h.configHome, { recursive: true })
  const tomlPath = join(h.configHome, 'config.toml')
  const before = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf-8') : ''
  const after = ensureGrokMcpBlock(before, root)
  if (after !== before) writeFileSync(tomlPath, after)
  const ctx: Ctx = createSyncCtx(false)
  ctx.exec = exec
  await syncGrok(ctx, root, home)
  const mcp = tomlHasUncommentedTable(after, 'mcp_servers.rivetos')
  return {
    ok: true,
    detail: mcp ? 'synced + MCP block present' : 'synced (MCP block missing)',
  }
}

async function installHermes(
  h: DetectedHarness,
  root: string,
  home: string,
  exec: typeof execFileAsync,
  dryRun: boolean,
  force: boolean,
): Promise<{ ok: boolean; detail: string }> {
  if (dryRun) {
    return {
      ok: true,
      detail: h.venv
        ? 'would sync + pip + memory.provider + .env'
        : 'would sync + memory.provider + .env (no venv)',
    }
  }
  mkdirSync(h.configHome, { recursive: true })
  const ctx = createSyncCtx(false)
  ctx.exec = exec
  await syncHermes(ctx, root, home)
  mergeHermesConfig(
    ctx,
    h.configHome,
    { memory: { provider: 'rivet_memory' } },
    '~/.hermes/config.yaml (memory.provider)',
    { force },
  )

  const bits: string[] = ['synced']
  let ok = true
  if (h.venv) {
    const pip = join(h.venv, 'bin', 'pip')
    const req = join(root, 'integrations', 'hermes', 'rivet-memory', 'requirements.txt')
    if (existsSync(pip) && existsSync(req)) {
      const r = await exec(pip, ['install', '-r', req], { timeoutMs: 120_000 })
      if (r.code === 0) bits.push('pip ok')
      else {
        bits.push(`pip failed (exit ${r.code ?? 'n/a'})`)
        ok = false
      }
    } else {
      bits.push('pip missing (no pip or requirements.txt)')
      ok = false
    }
  } else {
    bits.push('pip missing (no venv)')
    ok = false
  }

  const hermesEnv = join(h.configHome, '.env')
  const before = existsSync(hermesEnv) ? readFileSync(hermesEnv, 'utf-8') : ''
  const existing = readEnvKey(before, 'RIVETOS_PG_URL')
  const destNonEmpty = existing && existing.length > 0 ? existing : undefined
  const pgUrl = destNonEmpty ?? sourcePgUrl(home)
  if (destNonEmpty) {
    bits.push('RIVETOS_PG_URL already in ~/.hermes/.env')
  } else if (pgUrl) {
    const after = ensureNonEmptyEnvKey(before, 'RIVETOS_PG_URL', pgUrl)
    if (after !== before) writeFileSync(hermesEnv, after)
    bits.push('RIVETOS_PG_URL → ~/.hermes/.env')
  } else {
    bits.push(
      'RIVETOS_PG_URL missing (set in ~/.rivetos/.env or RIVETOS_ENV_FILE / RIVETOS_PG_URL)',
    )
    ok = false
  }

  return { ok, detail: bits.join('; ') }
}

function writeDenTerm(
  harnesses: DetectedHarness[],
  home: string,
  force: boolean,
  dryRun: boolean,
): void {
  const roster = buildDenTermRoster(harnesses, home)
  const dest = join(home, '.rivetos', 'den-term.json')
  if (!roster) {
    console.log('⚪ den-term.json  no detected harnesses — not writing')
    return
  }
  const keys = Object.keys(roster.commands).join(', ')
  if (dryRun) {
    console.log(`📋 den-term.json  would write {${keys}} → ${dest}`)
    return
  }
  if (existsSync(dest) && !force) {
    console.log(`⚪ den-term.json  exists (pass --force to overwrite) — ${dest}`)
    return
  }
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, `${JSON.stringify(roster, null, 2)}\n`)
  console.log(`✅ den-term.json  wrote {${keys}} → ${dest}`)
}

export async function runPluginsInstall(
  parsed: ParsedInstallArgs,
  deps: PluginsInstallDeps = {},
): Promise<void> {
  const home = deps.home ?? homedir()
  const exec = deps.exec ?? execFileAsync
  const detect = deps.detect ?? detectHarnesses

  const root = findRoot(parsed.root)
  if (!root) {
    console.error('❌ cannot locate the RivetOS source tree (no integrations/ found)')
    console.error('   pass --root <dir> or set RIVETOS_ROOT')
    throw new Error('cannot locate the RivetOS source tree')
  }

  const detected = await detect({ home, skipVersion: true })
  const want = parsed.harnesses
  const selected = want.length === 0 ? detected : detected.filter((h) => want.includes(h.id))
  const platform = deps.platform ?? process.platform

  let failed = 0
  if (want.length > 0) {
    for (const id of want) {
      if (!detected.some((h) => h.id === id)) {
        oneLine(id, false, 'not detected on PATH', parsed.dryRun)
        failed++
      }
    }
  }

  if (selected.length === 0 && want.length === 0) {
    console.log('No coding harnesses detected on PATH.')
    console.log('Install claude, grok, kimi, hermes, codex, or opencode and re-run.')
    writeDenTerm([], home, parsed.force, parsed.dryRun)
    return
  }

  const gotcha = marketplaceRootWarning(root)
  if (gotcha) console.log(`⚠️  ${gotcha}`)

  console.log(
    `${parsed.dryRun ? 'Would install' : 'Installing'} memory plugins from ${root} for ${selected.map((h) => h.id).join(', ') || '(none)'}${parsed.dryRun ? ' (dry-run)' : ''}\n`,
  )

  if (parsed.dryRun) {
    for (const action of planPluginsInstall(selected, root)) {
      oneLine(action.id, true, action.steps.join('; '), true)
    }
    writeDenTerm(selected, home, parsed.force, true)
    return
  }

  for (const h of selected) {
    try {
      let result: { ok: boolean; detail: string }
      switch (h.id) {
        case 'claude-code':
          result = await runClaudeInstall(h, root, exec)
          break
        case 'grok-build':
          result = await installGrok(h, root, home, false, exec)
          break
        case 'hermes':
          result = await installHermes(h, root, home, exec, false, parsed.force)
          break
        case 'opencode':
        case 'kimi-code':
        case 'codex':
        case 'pi':
          result = await runSetupScript(
            h.id,
            h,
            SETUP_SCRIPTS[h.id]!,
            root,
            home,
            exec,
            parsed.force,
            {
              platform,
              uid: deps.uid,
            },
          )
          break
      }
      oneLine(h.id, result.ok, result.detail, false)
      if (!result.ok) failed++
    } catch (err) {
      oneLine(h.id, false, (err as Error).message, false)
      failed++
    }
  }

  writeDenTerm(selected, home, parsed.force, false)
  if (failed > 0) throw new Error(`${failed} harness install(s) failed`)
}

export default async function pluginsInstall(args: string[]): Promise<void> {
  let parsed: ParsedInstallArgs
  try {
    parsed = parseInstallArgs(args)
  } catch (err) {
    if ((err as Error).message === 'HELP') {
      showHelp()
      return
    }
    console.error(`❌ ${(err as Error).message}`)
    showHelp()
    throw err
  }
  try {
    await runPluginsInstall(parsed)
  } catch (err) {
    const msg = (err as Error).message
    if (/\d+ harness install\(s\) failed/.test(msg)) {
      console.error(`❌ ${msg}`)
      process.exitCode = 1
      return
    }
    throw err
  }
}
