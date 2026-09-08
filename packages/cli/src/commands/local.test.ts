import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { EMBEDDED_PG_LOCKFILE, validateConfig } from '@rivetos/boot'
import { interpretAnswers } from './init/answers.js'
import { appendOwnerDevices, seedUsersJson } from './init/users.js'
import {
  buildConfigYaml,
  buildEnvFile,
  buildLocalPluginList,
  LOCAL_AGENT_CHANNEL_HOST,
  LOCAL_AGENT_CHANNEL_PORT,
} from './init/generate.js'
import type { WizardLocal, WizardState } from './init/types.js'
import {
  assertLocalConfigReady,
  buildLocalAnswers,
  chooseProvider,
  formatBanner,
  lastNLines,
  localWizardState,
  parseLocalArgs,
  readPersistedDen,
  renderSystemdUserUnit,
  runBackup,
  runInit,
  runReset,
  runUp,
  sanitizeHostname,
  servicePathEnv,
  waitHealthz,
} from './local.js'
import { planLocalCa, localCaPaths, localNodeSans } from '../lib/local-ca.js'
import type { DetectedHarness } from '../lib/harness-detect.js'

const ORIG_SHARED = process.env.RIVETOS_SHARED_DIR

function grokHarness(): DetectedHarness {
  return {
    id: 'grok-build',
    command: 'grok',
    binary: '/home/tester/.local/bin/grok',
    providerKey: 'grok-cli',
    configHome: '/home/tester/.grok',
  }
}

function localFixture(overrides: Partial<WizardLocal> = {}): WizardLocal {
  return {
    pgPort: 5433,
    dataDir: '~/.rivetos/pglite',
    denPort: 5174,
    exposeLan: true,
    tls: true,
    harnesses: [
      { id: 'grok-build', binary: '/home/tester/.local/bin/grok', providerKey: 'grok-cli' },
    ],
    sharedDir: '/tmp/rivetos-shared',
    hostname: 'testhost',
    root: '/opt/rivetos',
    memory: 'lite',
    ...overrides,
  }
}

function stateFrom(local: WizardLocal, provider = 'grok-cli'): WizardState {
  const answers = buildLocalAnswers({
    configExists: false,
    provider,
    apiKey: provider === 'anthropic' ? 'sk-test' : undefined,
    postgresUrl: `postgres://postgres:postgres@127.0.0.1:${String(local.pgPort)}/postgres`,
  })
  const interpreted = interpretAnswers(answers, { configExists: false, dockerAvailable: false })
  return localWizardState(interpreted, local)
}

describe('parseLocalArgs', () => {
  it('bare invocation is init+up (command all)', () => {
    expect(parseLocalArgs([])).toMatchObject({
      command: 'all',
      yes: false,
      port: 5174,
      pgPort: 5433,
      exposeLan: true,
      service: true,
      devices: [],
      memory: 'lite',
    })
  })

  it('parses flags and repeated --device', () => {
    expect(
      parseLocalArgs([
        'init',
        '--yes',
        '--provider',
        'anthropic',
        '--api-key',
        'sk-test',
        '--port',
        '6000',
        '--pg-port',
        '5434',
        '--no-lan',
        '--no-service',
        '--device',
        'phone',
        '--device',
        'tablet',
        '--memory',
        'full',
      ]),
    ).toEqual({
      command: 'init',
      yes: true,
      provider: 'anthropic',
      apiKey: 'sk-test',
      port: 6000,
      portExplicit: true,
      pgPort: 5434,
      exposeLan: false,
      lanExplicit: true,
      service: false,
      devices: ['phone', 'tablet'],
      memory: 'full',
      out: undefined,
      help: false,
    })
  })
})

describe('chooseProvider + answers object shape', () => {
  it('uses --provider when given', () => {
    expect(chooseProvider({ provider: 'anthropic', harnesses: [grokHarness()] })).toEqual({
      provider: 'anthropic',
      apiKey: undefined,
    })
  })

  it('maps grok → grok-cli', () => {
    expect(chooseProvider({ provider: 'grok', harnesses: [] }).provider).toBe('grok-cli')
  })

  it('falls back to the first detected CLI harness providerKey', () => {
    expect(chooseProvider({ harnesses: [grokHarness()] })).toEqual({
      provider: 'grok-cli',
      apiKey: undefined,
    })
  })

  it('falls back to anthropic when nothing is detected', () => {
    expect(chooseProvider({ harnesses: [], apiKey: 'sk-test' })).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-test',
    })
  })

  it('buildLocalAnswers is accepted by interpretAnswers (manual + socket URL + rivet agent)', () => {
    const answers = buildLocalAnswers({
      configExists: false,
      provider: 'grok-cli',
      postgresUrl: 'postgres://postgres:postgres@127.0.0.1:5433/postgres',
    })
    expect(answers).toMatchObject({
      deployment: 'manual',
      postgresUrl: 'postgres://postgres:postgres@127.0.0.1:5433/postgres',
      joinMesh: false,
      ownerId: 'owner',
      confirm: true,
    })
    const interpreted = interpretAnswers(answers, { configExists: false, dockerAvailable: false })
    expect(interpreted.deployment).toBe('manual')
    expect(interpreted.postgresUrl).toBe('postgres://postgres:postgres@127.0.0.1:5433/postgres')
    expect(interpreted.agents).toHaveLength(1)
    expect(interpreted.agents[0]).toMatchObject({
      name: 'rivet',
      provider: 'grok-cli',
      model: 'default',
    })
  })

  it('existing config uses overwrite + confirm so interpretAnswers continues', () => {
    const answers = buildLocalAnswers({
      configExists: true,
      provider: 'anthropic',
      apiKey: 'sk-test',
      postgresUrl: 'postgres://postgres:postgres@127.0.0.1:5433/postgres',
    })
    expect(answers.existingConfig).toBe('overwrite')
    expect(answers.overwriteConfirm).toBe(true)
    const interpreted = interpretAnswers(answers, { configExists: true, dockerAvailable: false })
    expect(interpreted.agents[0]?.provider).toBe('anthropic')
  })
})

describe('config/env emission lan vs no-lan', () => {
  it('lan binds 0.0.0.0, emits TLS paths, advertise_mdns, embedded postgres, harness binary', () => {
    const yaml = buildConfigYaml(stateFrom(localFixture({ exposeLan: true, tls: true })))
    expect(yaml).toContain('Generated by rivetos local')
    expect(yaml).toMatch(/host:\s*0\.0\.0\.0/)
    expect(yaml).toMatch(/port:\s*5174/)
    expect(yaml).toMatch(/advertise_mdns:\s*true/)
    expect(yaml).toContain('/tmp/rivetos-shared/rivet-ca/issued/testhost.crt')
    expect(yaml).toContain('/tmp/rivetos-shared/rivet-ca/issued/testhost.key')
    expect(yaml).toMatch(/agent_channel_port:\s*18789/)
    expect(yaml).toMatch(/agent_channel_host:\s*127\.0\.0\.1/)
    expect(yaml).toContain('~/.rivetos/pglite')
    expect(yaml).toMatch(/auto_migrate:\s*true/)
    expect(yaml).toMatch(/max_connections:\s*96/)
    expect(yaml).toContain('/home/tester/.local/bin/grok')
    expect(yaml).toContain('grok-build:')
    expect(yaml).toMatch(/grok-cli:\s*\{\}/)
    expect(yaml).toContain('testhost')
    expect(yaml).toContain('/tmp/rivetos-shared')
    expect(yaml).not.toContain('connection_string')
    expect(yaml).toMatch(/^plugins:/m)
    expect(yaml).toContain('@rivetos/memory-postgres')
    expect(yaml).toContain('@rivetos/channel-agent')
    expect(yaml).toContain('@rivetos/mcp-server')
    expect(yaml).toContain('@rivetos/provider-grok-cli')
    const parsed = parseYaml(yaml)
    expect(validateConfig(parsed).valid).toBe(true)
    expect(validateConfig(parsed).errors).toEqual([])
    assertLocalConfigReady(parsed)
  })

  it('no-lan binds 127.0.0.1; tls omitted when local.tls is false', () => {
    const yaml = buildConfigYaml(stateFrom(localFixture({ exposeLan: false, tls: false })))
    expect(yaml).toMatch(/host:\s*127\.0\.0\.1/)
    expect(yaml).not.toContain('tls_cert')
    expect(yaml).not.toContain('tls_key')
    expect(yaml).toMatch(/advertise_mdns:\s*false/)
  })

  it('issued node leaf id equals mesh.node_name and den.tls_* (config↔CA boundary)', () => {
    const local = localFixture({ hostname: 'testhost', tls: true })
    const parsed = parseYaml(buildConfigYaml(stateFrom(local))) as {
      mesh: { node_name: string }
      den: { tls_cert: string; tls_key: string }
    }
    expect(parsed.mesh.node_name).toBe('testhost')
    expect(parsed.den.tls_cert).toContain(`issued/${parsed.mesh.node_name}.crt`)
    expect(parsed.den.tls_key).toContain(`issued/${parsed.mesh.node_name}.key`)
    const plan = planLocalCa({
      home: '/tmp/rivetos-local-ca-home',
      hostname: parsed.mesh.node_name,
      sans: localNodeSans({ hostname: parsed.mesh.node_name, lanAddrs: ['192.0.2.10'] }),
      scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
      exists: () => false,
    })
    expect(plan.steps[2].argv[1]).toBe(parsed.mesh.node_name)
    expect(plan.nodeCert).toBe(join(plan.sharedDir, 'issued', `${parsed.mesh.node_name}.crt`))
    expect(plan.nodeKey).toBe(join(plan.sharedDir, 'issued', `${parsed.mesh.node_name}.key`))
    expect(LOCAL_AGENT_CHANNEL_PORT).toBe(18789)
    expect(LOCAL_AGENT_CHANNEL_HOST).toBe('127.0.0.1')
  })

  it('env file has socket URL, shared dir, root', () => {
    const entries = buildEnvFile(stateFrom(localFixture()))
    const map = Object.fromEntries(entries.map((e) => [e.key, e.value]))
    expect(map.RIVETOS_PG_URL).toBe('postgres://postgres:postgres@127.0.0.1:5433/postgres')
    expect(map.RIVETOS_SHARED_DIR).toBe('/tmp/rivetos-shared')
    expect(map.RIVETOS_ROOT).toBe('/opt/rivetos')
    expect(map.RIVETOS_MODE).toBe('workspace')
    const mode = entries.find((e) => e.key === 'RIVETOS_MODE')
    expect(mode?.comment).toBe(
      'local mode runs from a source checkout; RIVETOS_ROOT is for the harness launchers',
    )
  })

  it('muxNone writes RIVETOS_DEN_TERM_MUX=none', () => {
    const entries = buildEnvFile(stateFrom(localFixture({ muxNone: true })))
    expect(entries.some((e) => e.key === 'RIVETOS_DEN_TERM_MUX' && e.value === 'none')).toBe(true)
  })

  it('anthropic agent keeps model; still emits empty CLI harness providers', () => {
    const yaml = buildConfigYaml(stateFrom(localFixture(), 'anthropic'))
    expect(yaml).toMatch(/anthropic:\s*\n\s+model:/)
    expect(yaml).toMatch(/grok-cli:\s*\{\}/)
    expect(yaml).toContain('@rivetos/provider-anthropic')
    expect(yaml).toContain('@rivetos/provider-grok-cli')
  })

  it('plugins list covers every detected harness provider', () => {
    const local = localFixture({
      harnesses: [
        { id: 'claude-code', binary: '/usr/bin/claude', providerKey: 'claude-cli' },
        { id: 'grok-build', binary: '/usr/bin/grok', providerKey: 'grok-cli' },
        { id: 'codex', binary: '/usr/bin/codex', providerKey: 'codex-cli' },
        { id: 'kimi-code', binary: '/usr/bin/kimi', providerKey: 'kimi-code' },
        { id: 'hermes', binary: '/usr/bin/hermes', providerKey: 'hermes-cli' },
      ],
    })
    const state = stateFrom(local, 'claude-cli')
    const plugins = buildLocalPluginList(state)
    expect(plugins).toEqual([
      '@rivetos/memory-postgres',
      '@rivetos/channel-agent',
      '@rivetos/mcp-server',
      '@rivetos/provider-claude-cli',
      '@rivetos/provider-grok-cli',
      '@rivetos/provider-codex-cli',
      '@rivetos/provider-kimi-code',
      '@rivetos/provider-hermes-cli',
    ])
    const yaml = buildConfigYaml(state)
    for (const name of plugins) {
      expect(yaml).toContain(name)
    }
    assertLocalConfigReady(parseYaml(yaml))
  })
})

describe('dry boot check + service env', () => {
  it('assertLocalConfigReady rejects an empty plugins list', () => {
    const yaml = buildConfigYaml(stateFrom(localFixture()))
    const parsed = parseYaml(yaml) as Record<string, unknown>
    parsed.plugins = []
    expect(() => assertLocalConfigReady(parsed)).toThrow(/empty `plugins:` list/)
  })

  it('assertLocalConfigReady rejects missing plugins', () => {
    const yaml = buildConfigYaml(stateFrom(localFixture()))
    const parsed = parseYaml(yaml) as Record<string, unknown>
    delete parsed.plugins
    expect(() => assertLocalConfigReady(parsed)).toThrow(/empty `plugins:` list/)
  })

  it('systemd user unit still loads EnvironmentFile (RIVETOS_MODE from .env)', () => {
    const unit = renderSystemdUserUnit({
      workingDir: '/opt/rivetos',
      envFile: '/home/tester/.rivetos/.env',
      execStart: '/usr/bin/node /opt/rivetos/packages/cli/dist/index.js start',
    })
    expect(unit).toContain('EnvironmentFile=/home/tester/.rivetos/.env')
  })

  it('lastNLines keeps the tail', () => {
    const text = Array.from({ length: 25 }, (_, i) => `line-${String(i + 1)}`).join('\n')
    expect(lastNLines(text, 20).split('\n')).toEqual(
      Array.from({ length: 20 }, (_, i) => `line-${String(i + 6)}`),
    )
  })
})

describe('users devices append', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'local-users-'))
    process.env.RIVETOS_SHARED_DIR = tmp
  })

  afterEach(() => {
    if (ORIG_SHARED === undefined) delete process.env.RIVETOS_SHARED_DIR
    else process.env.RIVETOS_SHARED_DIR = ORIG_SHARED
    rmSync(tmp, { recursive: true, force: true })
  })

  it('seeds the owner then appends desktop-<host> and --device names (idempotent)', async () => {
    const seed = await seedUsersJson('owner')
    expect(seed.written).toBe(true)
    const first = await appendOwnerDevices(['desktop-testhost', 'phone'], 'owner')
    expect(first.added).toEqual(['desktop-testhost', 'phone'])
    const second = await appendOwnerDevices(['desktop-testhost', 'tablet'], 'owner')
    expect(second.added).toEqual(['tablet'])
    const parsed = JSON.parse(readFileSync(first.path, 'utf-8')) as {
      ownerUserId: string
      unmappedIsOwner: boolean
      users: Record<string, { devices: string[] }>
    }
    expect(parsed.ownerUserId).toBe('owner')
    expect(parsed.unmappedIsOwner).toBe(false)
    expect(parsed.users.owner.devices).toEqual(['desktop-testhost', 'phone', 'tablet'])
  })
})

describe('sanitizeHostname', () => {
  it('lowercases, strips .local, and keeps [a-z0-9-]', () => {
    expect(sanitizeHostname('Test-Host.local')).toBe('test-host')
    expect(sanitizeHostname('***')).toBe('local')
  })
})

describe('spawn/exec mocked', () => {
  it('ensureLocalCa runs only non-skipped steps via injected exec', async () => {
    const { ensureLocalCa } = await import('../lib/local-ca.js')
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }))
    const home = mkdtempSync(join(tmpdir(), 'local-ca-exec-'))
    try {
      await ensureLocalCa({
        home,
        hostname: 'testhost',
        lanAddrs: ['192.0.2.10'],
        exec,
        scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
        exists: () => false,
      })
      const argvs = exec.mock.calls.map((c) => c[1] as string[])
      expect(argvs.map((a) => a[1])).toEqual([
        'init',
        'issue-intermediate',
        'issue-node',
        'issue-client',
      ])
      expect(argvs[2][2]).toBe('testhost')
      expect(argvs[2]).toContain('IP:192.0.2.10')
      expect(argvs[2]).toContain('DNS:testhost.local')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('parseLocalArgs error paths', () => {
  it('rejects unknown flags, unknown --memory, and extra args', () => {
    expect(() => parseLocalArgs(['--nope'])).toThrow(/unknown flag/)
    expect(() => parseLocalArgs(['--memory', 'huge'])).toThrow(/lite or full/)
    expect(() => parseLocalArgs(['init', 'extra'])).toThrow(/unexpected argument/)
  })

  it('backup positional fills --out', () => {
    expect(parseLocalArgs(['backup', '/tmp/rivetos-pglite.tar.gz']).out).toBe(
      '/tmp/rivetos-pglite.tar.gz',
    )
  })

  it('chooseProvider rejects unknown providers', () => {
    expect(() => chooseProvider({ provider: 'not-a-provider', harnesses: [] })).toThrow(
      /not a known provider/,
    )
  })
})

describe('service PATH + systemd unit', () => {
  it('servicePathEnv puts node dir and ~/.local/bin first', () => {
    const path = servicePathEnv({
      home: '/home/tester',
      nodePath: '/usr/bin/node',
      pathEnv: '/usr/bin:/bin',
    })
    expect(path.startsWith('/usr/bin:/home/tester/.local/bin:')).toBe(true)
    expect(path).toContain('/opt/homebrew/bin')
  })

  it('systemd unit quotes PATH and EnvironmentFile', () => {
    const unit = renderSystemdUserUnit({
      workingDir: '/opt/rivetos',
      envFile: '/home/tester/.rivetos/.env',
      execStart: '"/usr/bin/node" "/opt/rivetos/packages/cli/dist/index.js" start',
      path: '/usr/bin:/home/tester/.local/bin:/bin',
    })
    expect(unit).toContain('EnvironmentFile=/home/tester/.rivetos/.env')
    expect(unit).toContain('Environment="PATH=/usr/bin:/home/tester/.local/bin:/bin"')
    expect(unit).toContain('ExecStart="/usr/bin/node"')
  })
})

describe('formatBanner + readPersistedDen + waitHealthz', () => {
  it('formatBanner omits LAN lines when exposeLan is false', () => {
    const text = formatBanner({
      port: 6000,
      exposeLan: false,
      lanAddrs: ['192.0.2.10'],
      p12Paths: ['/tmp/phone.p12'],
    })
    expect(text).toContain('https://localhost:6000')
    expect(text).not.toContain('192.0.2.10')
    expect(text).toContain('/tmp/phone.p12')
  })

  it('readPersistedDen reads den.port and loopback host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-den-'))
    try {
      const configPath = join(dir, 'config.yaml')
      writeFileSync(
        configPath,
        [
          'memory:',
          '  postgres:',
          '    embedded:',
          `      data_dir: ${dir}/pglite`,
          '      port: 5433',
          'den:',
          '  host: 127.0.0.1',
          '  port: 6000',
          '',
        ].join('\n'),
      )
      expect(readPersistedDen(configPath)).toEqual({ port: 6000, exposeLan: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('waitHealthz returns true on HTTP 200 and false on timeout', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      expect(await waitHealthz({ port, https: false, timeoutMs: 3_000 })).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
    expect(await waitHealthz({ port: 61999, https: false, timeoutMs: 200 })).toBe(false)
  })
})

describe('runInit / runUp / runBackup / runReset', () => {
  const origEmbed = process.env.RIVETOS_EMBED_URL

  beforeEach(() => {
    delete process.env.RIVETOS_EMBED_URL
  })

  afterEach(() => {
    if (origEmbed === undefined) delete process.env.RIVETOS_EMBED_URL
    else process.env.RIVETOS_EMBED_URL = origEmbed
    if (ORIG_SHARED === undefined) delete process.env.RIVETOS_SHARED_DIR
    else process.env.RIVETOS_SHARED_DIR = ORIG_SHARED
  })

  function writeFakeCa(home: string, hostname: string): void {
    const paths = localCaPaths(home, hostname)
    mkdirSync(join(paths.rootDir), { recursive: true })
    mkdirSync(join(paths.sharedDir, 'issued'), { recursive: true })
    mkdirSync(join(paths.sharedDir, 'intermediate'), { recursive: true })
    writeFileSync(join(paths.rootDir, 'ca.key'), 'k')
    writeFileSync(join(paths.rootDir, 'ca.crt'), 'c')
    writeFileSync(join(paths.sharedDir, 'intermediate', 'int.key'), 'k')
    writeFileSync(join(paths.sharedDir, 'intermediate', 'int.crt'), 'c')
    writeFileSync(paths.chainPem, 'chain')
    writeFileSync(paths.caChainPem, 'chain')
    writeFileSync(paths.nodeCert, 'node')
    writeFileSync(paths.nodeKey, 'node-key')
    const desktop = `device-desktop-${hostname}`
    writeFileSync(join(paths.sharedDir, 'issued', `${desktop}.crt`), 'd')
    writeFileSync(join(paths.sharedDir, 'issued', `${desktop}.key`), 'dk')
  }

  it('runInit writes hostname-named node cert paths and errors --memory full without embed URL', async () => {
    const home = mkdtempSync(join(tmpdir(), 'local-init-'))
    try {
      await expect(
        runInit(parseLocalArgs(['init', '--yes', '--no-lan', '--memory', 'full', '--no-service']), {
          home,
          hostname: 'testhost',
          platform: 'linux',
          detectEnv: async () => ({
            nodeVersion: '22.0.0',
            nodeOk: true,
            dockerAvailable: false,
            configExists: false,
            configPath: '',
            rivetDir: '',
          }),
          detectHarnesses: async () => [grokHarness()],
          findRoot: () => null,
          exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, timedOut: false })),
          withEmbeddedPg: async (_cfg, fn) =>
            fn({
              pgUrl: 'postgres://postgres:postgres@127.0.0.1:5433/postgres',
              owned: false,
              close: async () => undefined,
              backup: async () => undefined,
            }),
          pluginsInstall: async () => undefined,
        }),
      ).rejects.toThrow(/RIVETOS_EMBED_URL/)

      const exec = vi.fn(async () => {
        writeFakeCa(home, 'testhost')
        return { stdout: '', stderr: '', code: 0, timedOut: false }
      })
      const result = await runInit(parseLocalArgs(['init', '--yes', '--no-lan', '--no-service']), {
        home,
        hostname: 'testhost',
        platform: 'linux',
        detectEnv: async () => ({
          nodeVersion: '22.0.0',
          nodeOk: true,
          dockerAvailable: false,
          configExists: false,
          configPath: '',
          rivetDir: '',
        }),
        detectHarnesses: async () => [grokHarness()],
        findRoot: () => null,
        scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
        exec,
        withEmbeddedPg: async (_cfg, fn) =>
          fn({
            pgUrl: 'postgres://postgres:postgres@127.0.0.1:5433/postgres',
            owned: false,
            close: async () => undefined,
            backup: async () => undefined,
          }),
        pluginsInstall: async () => undefined,
      })
      expect(result.port).toBe(5174)
      expect(result.exposeLan).toBe(false)
      const yaml = readFileSync(join(home, '.rivetos', 'config.yaml'), 'utf-8')
      expect(yaml).toContain(`issued/testhost.crt`)
      expect(yaml).toMatch(/node_name:\s*testhost/)
      expect(yaml).toMatch(/advertise_mdns:\s*false/)
      const env = readFileSync(join(home, '.rivetos', '.env'), 'utf-8')
      expect(env).toContain('RIVETOS_MODE=workspace')
      expect(statSync(join(home, '.rivetos', '.env')).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('runUp uses persisted den.port, restarts Linux, and injects PATH', async () => {
    const home = mkdtempSync(join(tmpdir(), 'local-up-'))
    try {
      mkdirSync(join(home, '.rivetos'), { recursive: true })
      writeFileSync(
        join(home, '.rivetos', 'config.yaml'),
        buildConfigYaml(stateFrom(localFixture({ denPort: 6000, exposeLan: false, tls: true }))),
      )
      writeFileSync(join(home, '.rivetos', '.env'), 'RIVETOS_MODE=workspace\n', { mode: 0o600 })
      const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }))
      const probed: number[] = []
      await runUp(parseLocalArgs(['up', '--no-lan']), {
        home,
        platform: 'linux',
        findRoot: () => null,
        exec,
        waitHealthz: async (opts) => {
          probed.push(opts.port)
          return true
        },
      })
      expect(probed).toEqual([6000])
      const restart = exec.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('restart'),
      )
      expect(restart).toBeTruthy()
      const unit = readFileSync(
        join(home, '.config', 'systemd', 'user', 'rivetos.service'),
        'utf-8',
      )
      expect(unit).toContain('Environment="PATH=')
      expect(unit).toContain(`${home}/.local/bin`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('runBackup writes 0600 and runReset stops+disables without touching RivetHub mtls', async () => {
    const home = mkdtempSync(join(tmpdir(), 'local-reset-'))
    try {
      const dir = join(home, '.rivetos')
      const pglite = join(dir, 'pglite')
      mkdirSync(pglite, { recursive: true })
      writeFileSync(
        join(dir, 'config.yaml'),
        [
          'memory:',
          '  postgres:',
          '    embedded:',
          `      data_dir: ${pglite}`,
          '      port: 5433',
          'den:',
          '  port: 5174',
          '  host: 127.0.0.1',
          '',
        ].join('\n'),
      )
      writeFileSync(join(dir, '.env'), 'RIVETOS_PG_URL=old\n')
      writeFileSync(join(pglite, 'PG_VERSION'), '16')
      const mtls = join(home, '.config', 'RivetHub', 'mtls')
      mkdirSync(mtls, { recursive: true })
      writeFileSync(join(mtls, 'device.crt'), 'keep-me')
      const outside = join(home, 'not-rivetos.txt')
      writeFileSync(outside, 'stay')

      const backupCalls: string[] = []
      await runBackup(parseLocalArgs(['backup']), {
        home,
        now: () => new Date('2026-01-02T03:04:05.000Z'),
        withEmbeddedPg: async (_cfg, fn) =>
          fn({
            pgUrl: 'postgres://x',
            owned: true,
            close: async () => undefined,
            backup: async (out) => {
              backupCalls.push(out)
              mkdirSync(join(home, '.rivetos', 'backups'), { recursive: true })
              writeFileSync(out, 'gz')
            },
          }),
      })
      expect(backupCalls[0]).toContain('pglite-2026-01-02T03-04-05.tar.gz')
      expect(statSync(backupCalls[0]!).mode & 0o777).toBe(0o600)

      const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }))
      await runReset(parseLocalArgs(['reset', '--yes']), {
        home,
        platform: 'linux',
        confirm: async () => true,
        exec,
      })
      const sys = exec.mock.calls.map((c) => (c[1] as string[]).join(' '))
      expect(sys.some((s) => s.includes('stop'))).toBe(true)
      expect(sys.some((s) => s.includes('disable'))).toBe(true)
      expect(existsSync(join(dir, 'config.yaml'))).toBe(false)
      expect(existsSync(join(dir, '.env'))).toBe(false)
      expect(existsSync(join(mtls, 'device.crt'))).toBe(true)
      expect(existsSync(outside)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('runReset refuses to delete while the embedded owner lock is alive', async () => {
    const home = mkdtempSync(join(tmpdir(), 'local-lock-'))
    try {
      const pglite = join(home, '.rivetos', 'pglite')
      mkdirSync(pglite, { recursive: true })
      writeFileSync(
        join(home, '.rivetos', 'config.yaml'),
        [
          'memory:',
          '  postgres:',
          '    embedded:',
          `      data_dir: ${pglite}`,
          '      port: 5433',
          '',
        ].join('\n'),
      )
      writeFileSync(
        join(pglite, EMBEDDED_PG_LOCKFILE),
        JSON.stringify({ pid: process.pid, port: 5433, startedAt: new Date().toISOString() }),
      )
      await expect(
        runReset(parseLocalArgs(['reset', '--yes']), {
          home,
          platform: 'linux',
          exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, timedOut: false })),
        }),
      ).rejects.toThrow(/still running/)
      expect(existsSync(join(home, '.rivetos', 'config.yaml'))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
