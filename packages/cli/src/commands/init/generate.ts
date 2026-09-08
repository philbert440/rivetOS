/**
 * Config generation — converts wizard state into config.yaml + .env files.
 *
 * Secrets (API keys, bot tokens, DB passwords) go into .env only.
 * The YAML config references them via environment variable names.
 */

import { writeFile, mkdir, access, readFile, readdir, stat, chmod } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { stringify as toYaml } from 'yaml'
import { ENROLL_SNIPPET_MARKER } from '../../lib/mesh-enroll.js'
import type { WizardState, WizardAgent, WizardLocal } from './types.js'
import { CLI_KEYLESS_PROVIDERS, PROVIDER_ENV_KEYS } from './agents.js'

export { meshSectionFromEnroll } from '../../lib/mesh-enroll.js'

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

export interface GenerateResult {
  configPath: string
  envPath: string
  workspacePath: string
}

/** Loopback agent-channel bind for mesh-of-one (avoids colliding with :3000). */
export const LOCAL_AGENT_CHANNEL_PORT = 18789
export const LOCAL_AGENT_CHANNEL_HOST = '127.0.0.1'

export async function generateConfig(
  state: WizardState,
  rivetDir: string,
): Promise<GenerateResult> {
  const configPath = resolve(rivetDir, 'config.yaml')
  const envPath = resolve(rivetDir, '.env')
  const workspacePath = resolve(rivetDir, 'workspace')

  await mkdir(rivetDir, { recursive: true })
  await mkdir(workspacePath, { recursive: true })
  await mkdir(resolve(workspacePath, 'memory'), { recursive: true })

  // Generate config.yaml (no secrets)
  const configYaml = buildConfigYaml(state)
  await writeFile(configPath, configYaml, 'utf-8')

  // Generate .env (secrets only). Local mode rewrites so re-runs cannot
  // leave a stale RIVETOS_PG_URL / API key / mux flag next to a new YAML.
  const envContent = buildEnvFile(state)
  await writeEnvFile(envPath, envContent, { replace: Boolean(state.local) })

  // Generate workspace template files
  await writeWorkspaceTemplates(workspacePath)

  return { configPath, envPath, workspacePath }
}

// ──────────────────────────────────────────────────────────────────────────────
// Config YAML builder
// ──────────────────────────────────────────────────────────────────────────────

export function buildConfigYaml(state: WizardState): string {
  const config: Record<string, unknown> = {}

  // Runtime
  config.runtime = {
    workspace: '~/.rivetos/workspace',
    default_agent: state.agents[0]?.name ?? 'rivet',
    turn_timeout: 900,
  }

  // Agents
  const agents: Record<string, Record<string, unknown>> = {}
  for (const agent of state.agents) {
    const entry: Record<string, unknown> = {
      provider: agent.provider,
    }
    if (agent.thinking !== 'off') {
      entry.default_thinking = agent.thinking
    }
    agents[agent.name] = entry
  }
  config.agents = agents

  // Providers — deduplicated by provider name
  const providers: Record<string, Record<string, unknown>> = {}
  const seen = new Set<string>()
  for (const agent of state.agents) {
    if (seen.has(agent.provider)) continue
    seen.add(agent.provider)
    providers[agent.provider] = buildProviderConfig(agent, state.local)
  }
  if (state.local) {
    for (const h of state.local.harnesses) {
      const key = h.providerKey
      if (!key || !CLI_KEYLESS_PROVIDERS.has(key)) continue
      if (seen.has(key)) continue
      seen.add(key)
      providers[key] = {}
    }
  }
  config.providers = providers

  // Local mode: an explicit plugins list so boot still works if RIVETOS_ROOT
  // is treated as production (no workspace scan). Shape is a flat array of
  // npm package names — same as config.example.yaml / validateConfig.
  if (state.local) {
    config.plugins = buildLocalPluginList(state)
  }

  // Channels: social bots removed in Phase 5. Human UX is RivetHub.
  if (state.meshSection) {
    config.mesh = state.meshSection
  } else if (state.local) {
    config.mesh = {
      enabled: true,
      node_name: state.local.hostname,
      tls: true,
      storage_dir: state.local.sharedDir,
      agent_channel_port: LOCAL_AGENT_CHANNEL_PORT,
      agent_channel_host: LOCAL_AGENT_CHANNEL_HOST,
    }
  }

  // Memory
  if (state.local) {
    const postgres: Record<string, unknown> = {
      embedded: {
        data_dir: state.local.dataDir,
        port: state.local.pgPort,
        auto_migrate: true,
        max_connections: 96,
      },
    }
    if (state.local.memory === 'full' && state.local.embedEndpoint) {
      postgres.embed_endpoint = state.local.embedEndpoint
      if (state.local.embedModel) postgres.embed_model = state.local.embedModel
    }
    config.memory = { postgres }
  } else {
    config.memory = {
      postgres: {
        // connection_string via env: RIVETOS_PG_URL
      },
    }
  }

  if (state.local) {
    config.den = buildLocalDen(state.local)
    const harnesses: Record<string, { binary: string }> = {}
    for (const h of state.local.harnesses) {
      if (!h.id || !h.binary) continue
      harnesses[h.id] = { binary: h.binary }
    }
    if (Object.keys(harnesses).length > 0) {
      config.tasks = { harnesses }
    }
  }

  // Deployment (only for docker/proxmox)
  if (state.deployment !== 'manual') {
    config.deployment = buildDeploymentConfig(state)
  }

  // Build YAML with header comment
  const header = [
    '# RivetOS Configuration',
    state.local ? '# Generated by rivetos local' : '# Generated by rivetos init',
    '# API keys and tokens are stored in .env — never in this file.',
    '',
  ].join('\n')

  let body = toYaml(config, {
    lineWidth: 120,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
  })
  // Same marker the CLI merge path keys on, so a later `mesh enroll`/`renew`
  // is a no-op instead of appending a second `mesh:` block.
  if (state.meshSection) {
    body = body.replace(
      /^mesh:/m,
      `${ENROLL_SNIPPET_MARKER}. Merge into the node's rivet.config.yaml.\nmesh:`,
    )
  }

  return header + body
}

/** npm package for each provider key we emit in local-mode config. */
const PROVIDER_PLUGIN_PACKAGES: Record<string, string> = {
  'claude-cli': '@rivetos/provider-claude-cli',
  'grok-cli': '@rivetos/provider-grok-cli',
  'codex-cli': '@rivetos/provider-codex-cli',
  'kimi-code': '@rivetos/provider-kimi-code',
  'hermes-cli': '@rivetos/provider-hermes-cli',
  anthropic: '@rivetos/provider-anthropic',
  xai: '@rivetos/provider-xai',
  google: '@rivetos/provider-google',
  ollama: '@rivetos/provider-ollama',
  vllm: '@rivetos/provider-vllm',
  'llama-server': '@rivetos/provider-llama-server',
}

/** Memory + den/gateway pieces always present in local-mode `plugins:`. */
const LOCAL_CORE_PLUGINS = [
  '@rivetos/memory-postgres',
  '@rivetos/channel-agent',
  '@rivetos/mcp-server',
] as const

/**
 * Explicit `plugins:` list for `rivetos local`. Production discovery requires
 * this (empty list → crash-loop); workspace mode unions it with a scan.
 */
export function buildLocalPluginList(state: WizardState): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    out.push(name)
  }
  for (const name of LOCAL_CORE_PLUGINS) add(name)
  for (const agent of state.agents) {
    const pkg = PROVIDER_PLUGIN_PACKAGES[agent.provider]
    if (pkg) add(pkg)
  }
  if (state.local) {
    for (const h of state.local.harnesses) {
      if (!h.providerKey) continue
      const pkg = PROVIDER_PLUGIN_PACKAGES[h.providerKey]
      if (pkg) add(pkg)
    }
  }
  return out
}

function buildProviderConfig(agent: WizardAgent, local?: WizardLocal): Record<string, unknown> {
  // Local mode: CLI harness providers need no `model` (CLI_HARNESS_PROVIDERS).
  if (local && CLI_KEYLESS_PROVIDERS.has(agent.provider)) {
    return {}
  }

  const config: Record<string, unknown> = {
    model: agent.model,
  }

  // CLI harnesses don't accept max_tokens — their binaries own generation params.
  // Every other provider gets the default cap.
  if (!CLI_KEYLESS_PROVIDERS.has(agent.provider)) {
    config.max_tokens = 8192
  }

  if (agent.baseUrl) {
    config.base_url = agent.baseUrl
  }

  return config
}

function buildLocalDen(local: WizardLocal): Record<string, unknown> {
  const emitTls = local.tls ?? local.exposeLan
  const den: Record<string, unknown> = {
    enabled: true,
    host: local.exposeLan ? '0.0.0.0' : '127.0.0.1',
    port: local.denPort,
    terminal: { enabled: true },
    files_root: local.sharedDir,
    advertise_mdns: local.exposeLan,
  }
  if (emitTls) {
    den.tls_cert = join(local.sharedDir, 'rivet-ca', 'issued', `${local.hostname}.crt`)
    den.tls_key = join(local.sharedDir, 'rivet-ca', 'issued', `${local.hostname}.key`)
  }
  return den
}

function buildDeploymentConfig(state: WizardState): Record<string, unknown> {
  // Only `target` is read anywhere at runtime; nested keys were write-only.
  return { target: state.deployment }
}

// ──────────────────────────────────────────────────────────────────────────────
// .env file builder
// ──────────────────────────────────────────────────────────────────────────────

export interface EnvEntry {
  key: string
  value: string
  comment?: string
}

export function buildEnvFile(state: WizardState): EnvEntry[] {
  const entries: EnvEntry[] = []

  // Provider API keys
  const seenProviders = new Set<string>()
  for (const agent of state.agents) {
    if (seenProviders.has(agent.provider)) continue
    seenProviders.add(agent.provider)

    if (agent.apiKey) {
      const envKey = PROVIDER_ENV_KEYS[agent.provider]
      if (envKey) {
        entries.push({ key: envKey, value: agent.apiKey, comment: `${agent.provider} provider` })
      }
    }
  }

  // Postgres
  const pgPass = state.postgresPassword
  if (state.deployment === 'manual') {
    // BYO postgres — the user supplied the connection string directly.
    if (state.postgresUrl) {
      entries.push({
        key: 'RIVETOS_PG_URL',
        value: state.postgresUrl,
        comment: 'Postgres connection (agents use this)',
      })
    }
  } else {
    // Docker / Proxmox deployments ship a bundled datahub container. The
    // hostname `datahub` is resolved on the deployment-managed network.
    entries.push({
      key: 'POSTGRES_PASSWORD',
      value: pgPass,
      comment: 'Datahub postgres password',
    })
    entries.push({
      key: 'RIVETOS_PG_URL',
      value: `postgresql://rivetos:${pgPass}@datahub:5432/rivetos`,
      comment: 'Postgres connection (agents use this)',
    })
  }

  if (state.local) {
    entries.push({
      key: 'RIVETOS_SHARED_DIR',
      value: state.local.sharedDir,
      comment: 'Local-mode shared dir (mesh of one)',
    })
    if (state.local.root) {
      entries.push({
        key: 'RIVETOS_ROOT',
        value: state.local.root,
        comment: 'RivetOS source checkout',
      })
    }
    // Boot treats a set RIVETOS_ROOT as production unless this is workspace
    // (packages/boot/src/index.ts plugin discovery). Systemd loads this via
    // EnvironmentFile; launchd copies the parsed .env into the plist.
    entries.push({
      key: 'RIVETOS_MODE',
      value: 'workspace',
      comment: 'local mode runs from a source checkout; RIVETOS_ROOT is for the harness launchers',
    })
    if (state.local.muxNone) {
      entries.push({
        key: 'RIVETOS_DEN_TERM_MUX',
        value: 'none',
        comment: 'tmux not on PATH — den PTY without a multiplexer',
      })
    }
    if (state.local.memory === 'full' && state.local.embedEndpoint) {
      entries.push({
        key: 'RIVETOS_EMBED_URL',
        value: state.local.embedEndpoint,
        comment: 'embed endpoint (memory full)',
      })
      entries.push({
        key: 'RIVETOS_EMBED_MODEL',
        value: state.local.embedModel ?? '',
        comment: 'embed model id (memory full)',
      })
    } else {
      entries.push({
        key: 'RIVETOS_EMBED_URL',
        value: '',
        comment: 'lite memory — no embed endpoint',
      })
    }
  }

  return entries
}

async function chmod0600(path: string): Promise<void> {
  try {
    await chmod(path, 0o600)
  } catch {
    // Windows may ignore mode bits
  }
}

async function writeEnvFile(
  envPath: string,
  entries: EnvEntry[],
  opts: { replace?: boolean } = {},
): Promise<void> {
  if (opts.replace) {
    const lines = [
      '# RivetOS Environment — secrets and credentials',
      '# Generated by rivetos local — DO NOT commit this file.',
      '',
    ]
    for (const entry of entries) {
      if (entry.comment) lines.push(`# ${entry.comment}`)
      lines.push(`${entry.key}=${entry.value}`)
      lines.push('')
    }
    await writeFile(envPath, lines.join('\n'), { encoding: 'utf-8', mode: 0o600 })
    await chmod0600(envPath)
    return
  }

  // Read existing .env to avoid duplicating keys (non-local init)
  let existing = ''
  try {
    existing = await readFile(envPath, 'utf-8')
  } catch {
    // File doesn't exist — that's fine
  }

  const existingKeys = new Set(
    existing
      .split('\n')
      .filter((line) => line.includes('=') && !line.startsWith('#'))
      .map((line) => line.split('=')[0].trim()),
  )

  const lines: string[] = []

  if (!existing) {
    lines.push('# RivetOS Environment — secrets and credentials')
    lines.push('# Generated by rivetos init — DO NOT commit this file.')
    lines.push('')
  }

  let addedAny = false
  for (const entry of entries) {
    if (existingKeys.has(entry.key)) continue
    if (entry.comment) lines.push(`# ${entry.comment}`)
    lines.push(`${entry.key}=${entry.value}`)
    lines.push('')
    addedAny = true
  }

  if (addedAny) {
    const content = existing ? existing.trimEnd() + '\n\n' + lines.join('\n') : lines.join('\n')
    await writeFile(envPath, content, { encoding: 'utf-8', mode: 0o600 })
  } else if (!existing) {
    await writeFile(envPath, lines.join('\n'), { encoding: 'utf-8', mode: 0o600 })
  }
  await chmod0600(envPath)
}

// ──────────────────────────────────────────────────────────────────────────────
// Workspace templates
//
// Canonical template files live in `workspace-templates/` at the repo root.
// Init seeds AGENT.md, MEMORY.md, and users/, then generates CLAUDE.md from
// AGENT.md. The inline `FALLBACK_TEMPLATES` below are used only if the
// `workspace-templates/` directory cannot be located (e.g. if the CLI is
// running from an unusual install layout); they are intentionally minimal
// and should not be relied on.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Locate the `workspace-templates/` directory.
 *
 * Two layouts to support:
 *
 *   1. Source checkout (dev):
 *      <repo-root>/
 *        workspace-templates/          ← target
 *        packages/cli/
 *          src/commands/init/          ← src path
 *          dist/commands/init/         ← built path
 *
 *   2. Global npm install:
 *      <prefix>/lib/node_modules/@rivetos/cli/
 *        workspace-templates/          ← target (shipped via prepublish copy)
 *        dist/commands/init/           ← built path
 *
 * Strategy: walk up from this file's dir, try each candidate. The first hit
 * wins. Source checkout matches at depth 5; npm install matches at depth 3.
 */
async function findTemplatesDir(): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dirname may be undefined in older Node
  const here = import.meta.dirname ?? '.'
  for (let up = 2; up <= 6; up++) {
    const candidate = resolve(here, ...Array<string>(up).fill('..'), 'workspace-templates')
    try {
      await access(candidate)
      return candidate
    } catch {
      // try next depth
    }
  }
  return null
}

const SEEDED_MD = ['AGENT.md', 'MEMORY.md'] as const

const CLAUDE_MD_BANNER = '<!-- generated from AGENT.md by rivetos init — edit AGENT.md instead -->'

const FALLBACK_TEMPLATES: Record<string, string> = {
  'AGENT.md': `# AGENT.md

Define who you are — identity, operating contract, and who you serve.
This is the first file your agent reads every session.

When you don't have context on something, **search memory first**. See MEMORY.md.
`,
  'MEMORY.md': `# MEMORY.md — Context Index

Lightweight index into the memory system. Run the referenced queries
to pull context on demand, rather than dumping everything here.

Every past conversation with your human is searchable via \`memory_search\`.
When you need context on a topic, query it.
`,
  'users/profiles.json': `{
  "_owner": "",
  "_comment": "Shape: flat { string: string } map. Reserved keys start with _. Routed user ids never start with _. _owner = the node owner's user id. Non-_ keys map user ids to profile basenames (users/<profile>.md)."
}
`,
  'users/USER-TEMPLATE.md': `# USER — <id>

Replace \`<id>\` in the heading with the real user id. Then set/create
\`"<id>": "<id>"\` in \`users/profiles.json\`.
`,
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await access(filePath)
    return
  } catch {
    // missing — write
  }
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf-8')
}

async function copyIfMissing(srcPath: string, destPath: string): Promise<void> {
  try {
    await access(destPath)
    return
  } catch {
    // missing — copy
  }
  try {
    const content = await readFile(srcPath, 'utf-8')
    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, content, 'utf-8')
  } catch {
    // source missing — tolerate
  }
}

async function seedUsersDir(templatesDir: string | null, workspacePath: string): Promise<void> {
  const destDir = resolve(workspacePath, 'users')
  await mkdir(destDir, { recursive: true })

  if (templatesDir) {
    const srcDir = resolve(templatesDir, 'users')
    let entries: string[]
    try {
      entries = await readdir(srcDir)
    } catch {
      entries = []
    }
    for (const name of entries) {
      await copyIfMissing(resolve(srcDir, name), resolve(destDir, name))
    }
    return
  }

  for (const [name, content] of Object.entries(FALLBACK_TEMPLATES)) {
    if (!name.startsWith('users/')) continue
    await writeIfMissing(resolve(workspacePath, name), content)
  }
}

async function writeClaudeMdFromAgent(workspacePath: string): Promise<void> {
  const claudePath = resolve(workspacePath, 'CLAUDE.md')
  const agentPath = resolve(workspacePath, 'AGENT.md')

  let agentMtime: number
  try {
    agentMtime = (await stat(agentPath)).mtimeMs
  } catch {
    return
  }

  try {
    const claudeMtime = (await stat(claudePath)).mtimeMs
    // User-edited CLAUDE.md (same age or newer than AGENT.md) — never overwrite.
    if (claudeMtime >= agentMtime) return
  } catch {
    // CLAUDE.md missing — generate
  }

  let agentContent: string
  try {
    agentContent = await readFile(agentPath, 'utf-8')
  } catch {
    return
  }
  await writeFile(claudePath, `${CLAUDE_MD_BANNER}\n${agentContent}`, 'utf-8')
}

async function writeWorkspaceTemplates(workspacePath: string): Promise<void> {
  const templatesDir = await findTemplatesDir()

  if (templatesDir) {
    for (const name of SEEDED_MD) {
      await copyIfMissing(resolve(templatesDir, name), resolve(workspacePath, name))
    }
  } else {
    // Fallback path — use the minimal inline templates. This should only
    // trigger if the CLI is installed without the repo's workspace-templates
    // directory alongside it.
    for (const name of SEEDED_MD) {
      const content = FALLBACK_TEMPLATES[name]
      if (content) await writeIfMissing(resolve(workspacePath, name), content)
    }
  }

  await seedUsersDir(templatesDir, workspacePath)
  await writeClaudeMdFromAgent(workspacePath)
}
