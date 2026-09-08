import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtemp,
  rm,
  readFile,
  access,
  readdir,
  writeFile,
  mkdir,
  utimes,
  stat,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ENROLL_SNIPPET_MARKER } from '../../lib/mesh-enroll.js'
import {
  buildConfigYaml,
  buildEnvFile,
  buildLocalPluginList,
  generateConfig,
  meshSectionFromEnroll,
} from './generate.js'
import type { WizardLocal, WizardState } from './types.js'

const SNIPPET = `${ENROLL_SNIPPET_MARKER}. Merge into the node's rivet.config.yaml.
mesh:
  enabled: true
  node_name: "ct110"
`

const baseState = (): WizardState => ({
  deployment: 'manual',
  agents: [
    { name: 'rivet', provider: 'xai', model: 'grok-4-1-fast-reasoning', thinking: 'medium' },
  ],
  channels: [],
  postgresPassword: 'secret',
  postgresUrl: 'postgres://u:p@localhost:5432/rivetos',
  ownerId: 'owner',
})

describe('meshSectionFromEnroll', () => {
  it('builds a valid mesh section from a fixture enroll result', () => {
    const section = meshSectionFromEnroll({ name: 'ct110', snippet: SNIPPET }, '192.0.2.11')
    expect(section).toEqual({
      enabled: true,
      node_name: 'ct110',
      tls: true,
      advertise_host: '192.0.2.11',
    })
  })

  it('fills tls even when the snippet omits it', () => {
    const section = meshSectionFromEnroll({
      name: 'node-a',
      snippet: 'mesh:\n  enabled: true\n  node_name: node-a\n',
    })
    expect(section.tls).toBe(true)
    expect(section.enabled).toBe(true)
    expect(section.node_name).toBe('node-a')
    expect(section.advertise_host).toBeUndefined()
  })

  it('still produces a mesh section when the snippet is unparseable', () => {
    const section = meshSectionFromEnroll({ name: 'phildesk', snippet: 'not: [yaml' })
    expect(section.node_name).toBe('phildesk')
    expect(section.enabled).toBe(true)
    expect(section.tls).toBe(true)
  })
})

describe('buildConfigYaml mesh branch', () => {
  it('generates a valid Codex CLI node without max_tokens', () => {
    const yaml = buildConfigYaml({
      ...baseState(),
      agents: [
        {
          name: 'codex',
          provider: 'codex-cli',
          model: 'default',
          thinking: 'xhigh',
        },
      ],
    })
    expect(yaml).toMatch(/codex:\n\s+provider: codex-cli\n\s+default_thinking: xhigh/)
    expect(yaml).toMatch(/codex-cli:\n\s+model: default/)
    expect(yaml).not.toContain('max_tokens')
  })

  it('omits mesh when enroll was not requested', () => {
    const yaml = buildConfigYaml(baseState())
    expect(yaml).not.toMatch(/^mesh:/m)
    expect(yaml).not.toContain('can be added manually')
  })

  it('writes the enroll mesh section into generated config', () => {
    const meshSection = meshSectionFromEnroll({ name: 'ct110', snippet: SNIPPET }, '192.0.2.11')
    const yaml = buildConfigYaml({ ...baseState(), meshSection })
    expect(yaml).toContain(ENROLL_SNIPPET_MARKER)
    expect(yaml).toMatch(/^mesh:/m)
    expect(yaml).toMatch(/enabled:\s*true/)
    expect(yaml).toMatch(/node_name:\s*"?ct110"?/)
    expect(yaml).toMatch(/tls:\s*true/)
    expect(yaml).toMatch(/advertise_host:\s*"?192\.0\.2\.11"?/)
  })

  it('omits advertise_host when enroll did not pass an explicit one', () => {
    const meshSection = meshSectionFromEnroll({ name: 'ct110', snippet: SNIPPET })
    const yaml = buildConfigYaml({ ...baseState(), meshSection })
    expect(yaml).toContain(ENROLL_SNIPPET_MARKER)
    expect(yaml).toMatch(/tls:\s*true/)
    expect(yaml).not.toMatch(/advertise_host:/)
  })
})

describe('buildConfigYaml / buildEnvFile local branch', () => {
  const local = (): WizardLocal => ({
    pgPort: 5433,
    dataDir: '~/.rivetos/pglite',
    denPort: 5174,
    exposeLan: true,
    tls: true,
    harnesses: [
      { id: 'grok-build', binary: '/usr/bin/grok', providerKey: 'grok-cli' },
      { id: 'codex', binary: '/usr/bin/codex', providerKey: 'codex-cli' },
    ],
    sharedDir: '/tmp/rivetos-shared',
    hostname: 'testhost',
    root: '/opt/rivetos',
    memory: 'lite',
  })

  const localState = (): WizardState => ({
    ...baseState(),
    agents: [{ name: 'rivet', provider: 'grok-cli', model: 'default', thinking: 'off' }],
    postgresUrl: 'postgres://postgres:postgres@127.0.0.1:5433/postgres',
    local: local(),
  })

  it('emits plugins for memory, den/gateway, and detected harness providers', () => {
    const state = localState()
    expect(buildLocalPluginList(state)).toEqual([
      '@rivetos/memory-postgres',
      '@rivetos/channel-agent',
      '@rivetos/mcp-server',
      '@rivetos/provider-grok-cli',
      '@rivetos/provider-codex-cli',
    ])
    const yaml = buildConfigYaml(state)
    expect(yaml).toMatch(/^plugins:/m)
    expect(yaml).toContain('@rivetos/memory-postgres')
    expect(yaml).toContain('@rivetos/channel-agent')
    expect(yaml).toContain('@rivetos/mcp-server')
    expect(yaml).toContain('@rivetos/provider-grok-cli')
    expect(yaml).toContain('@rivetos/provider-codex-cli')
  })

  it('does not emit plugins or RIVETOS_MODE for a non-local wizard', () => {
    const yaml = buildConfigYaml(baseState())
    expect(yaml).not.toMatch(/^plugins:/m)
    const entries = buildEnvFile(baseState())
    expect(entries.some((e) => e.key === 'RIVETOS_MODE')).toBe(false)
  })

  it('emits RIVETOS_MODE=workspace next to RIVETOS_ROOT', () => {
    const entries = buildEnvFile(localState())
    const map = Object.fromEntries(entries.map((e) => [e.key, e.value]))
    expect(map.RIVETOS_ROOT).toBe('/opt/rivetos')
    expect(map.RIVETOS_MODE).toBe('workspace')
    expect(entries.find((e) => e.key === 'RIVETOS_MODE')?.comment).toBe(
      'local mode runs from a source checkout; RIVETOS_ROOT is for the harness launchers',
    )
  })

  it('rewrites local-mode .env keys and sets mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rivetos-local-env-'))
    try {
      await writeFile(
        join(dir, '.env'),
        'RIVETOS_PG_URL=postgres://old:5433/postgres\nEXTRA=keep\n',
      )
      await generateConfig(localState(), dir)
      const env = await readFile(join(dir, '.env'), 'utf-8')
      expect(env).toContain('RIVETOS_PG_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres')
      expect(env).not.toContain('postgres://old:5433')
      expect(env).not.toContain('EXTRA=keep')
      expect(env).toContain('RIVETOS_EMBED_URL=')
      expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('generateConfig workspace templates', () => {
  const banner = '<!-- generated from AGENT.md by rivetos init — edit AGENT.md instead -->'
  let rivetDir: string

  beforeEach(async () => {
    rivetDir = await mkdtemp(join(tmpdir(), 'rivetos-init-workspace-'))
  })

  afterEach(async () => {
    await rm(rivetDir, { recursive: true, force: true })
  })

  it('seeds AGENT.md, MEMORY.md, users/, and CLAUDE.md', async () => {
    const result = await generateConfig(baseState(), rivetDir)
    const ws = result.workspacePath

    const agent = await readFile(join(ws, 'AGENT.md'), 'utf-8')
    const memory = await readFile(join(ws, 'MEMORY.md'), 'utf-8')
    expect(agent.length).toBeGreaterThan(0)
    expect(memory.length).toBeGreaterThan(0)

    await access(join(ws, 'users', 'profiles.json'))
    await access(join(ws, 'users', 'USER-TEMPLATE.md'))

    const claude = await readFile(join(ws, 'CLAUDE.md'), 'utf-8')
    expect(claude.startsWith(banner)).toBe(true)
    expect(claude.slice(banner.length)).toBe(`\n${agent}`)
  })

  it('does not seed retired workspace files', async () => {
    const result = await generateConfig(baseState(), rivetDir)
    const names = await readdir(result.workspacePath)
    for (const retired of [
      'CORE.md',
      'USER.md',
      'WORKSPACE.md',
      'CAPABILITIES.md',
      'FILESYSTEM.md',
      'README.md',
      'HEARTBEAT.md',
    ]) {
      expect(names).not.toContain(retired)
    }
  })

  it('does not overwrite pre-existing AGENT.md, MEMORY.md, users/, or CLAUDE.md', async () => {
    const ws = join(rivetDir, 'workspace')
    await mkdir(join(ws, 'users'), { recursive: true })
    await writeFile(join(ws, 'AGENT.md'), 'custom agent')
    await writeFile(join(ws, 'MEMORY.md'), 'custom memory')
    await writeFile(join(ws, 'CLAUDE.md'), 'custom claude')
    await writeFile(join(ws, 'users', 'profiles.json'), '{"_owner":"me"}')

    await generateConfig(baseState(), rivetDir)

    expect(await readFile(join(ws, 'AGENT.md'), 'utf-8')).toBe('custom agent')
    expect(await readFile(join(ws, 'MEMORY.md'), 'utf-8')).toBe('custom memory')
    expect(await readFile(join(ws, 'CLAUDE.md'), 'utf-8')).toBe('custom claude')
    expect(await readFile(join(ws, 'users', 'profiles.json'), 'utf-8')).toBe('{"_owner":"me"}')
  })

  it('regenerates CLAUDE.md when AGENT.md is newer', async () => {
    const ws = join(rivetDir, 'workspace')
    await mkdir(ws, { recursive: true })
    await writeFile(join(ws, 'AGENT.md'), 'updated agent')
    await writeFile(join(ws, 'CLAUDE.md'), 'stale claude')
    const past = new Date(Date.now() - 60_000)
    await utimes(join(ws, 'CLAUDE.md'), past, past)

    await generateConfig(baseState(), rivetDir)

    const claude = await readFile(join(ws, 'CLAUDE.md'), 'utf-8')
    expect(claude.startsWith(banner)).toBe(true)
    expect(claude).toContain('updated agent')
    expect(claude).not.toContain('stale claude')
  })
})
