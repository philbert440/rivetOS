import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpretAnswers } from './init/answers.js'
import { appendOwnerDevices, seedUsersJson } from './init/users.js'
import { buildConfigYaml, buildEnvFile } from './init/generate.js'
import type { WizardLocal, WizardState } from './init/types.js'
import {
  buildLocalAnswers,
  chooseProvider,
  localWizardState,
  parseLocalArgs,
  sanitizeHostname,
} from './local.js'
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
      pgPort: 5434,
      exposeLan: false,
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
    expect(yaml).toContain('/tmp/rivetos-shared/rivet-ca/issued/local.crt')
    expect(yaml).toContain('/tmp/rivetos-shared/rivet-ca/issued/local.key')
    expect(yaml).toContain('~/.rivetos/pglite')
    expect(yaml).toMatch(/auto_migrate:\s*true/)
    expect(yaml).toMatch(/max_connections:\s*96/)
    expect(yaml).toContain('/home/tester/.local/bin/grok')
    expect(yaml).toContain('grok-build:')
    expect(yaml).toMatch(/grok-cli:\s*\{\}/)
    expect(yaml).toContain('testhost')
    expect(yaml).toContain('/tmp/rivetos-shared')
    expect(yaml).not.toContain('connection_string')
  })

  it('no-lan binds 127.0.0.1; tls omitted when local.tls is false', () => {
    const yaml = buildConfigYaml(stateFrom(localFixture({ exposeLan: false, tls: false })))
    expect(yaml).toMatch(/host:\s*127\.0\.0\.1/)
    expect(yaml).not.toContain('tls_cert')
    expect(yaml).not.toContain('tls_key')
    expect(yaml).toMatch(/advertise_mdns:\s*true/)
  })

  it('env file has socket URL, shared dir, root', () => {
    const entries = buildEnvFile(stateFrom(localFixture()))
    const map = Object.fromEntries(entries.map((e) => [e.key, e.value]))
    expect(map.RIVETOS_PG_URL).toBe('postgres://postgres:postgres@127.0.0.1:5433/postgres')
    expect(map.RIVETOS_SHARED_DIR).toBe('/tmp/rivetos-shared')
    expect(map.RIVETOS_ROOT).toBe('/opt/rivetos')
  })

  it('muxNone writes RIVETOS_DEN_TERM_MUX=none', () => {
    const entries = buildEnvFile(stateFrom(localFixture({ muxNone: true })))
    expect(entries.some((e) => e.key === 'RIVETOS_DEN_TERM_MUX' && e.value === 'none')).toBe(true)
  })

  it('anthropic agent keeps model; still emits empty CLI harness providers', () => {
    const yaml = buildConfigYaml(stateFrom(localFixture(), 'anthropic'))
    expect(yaml).toMatch(/anthropic:\s*\n\s+model:/)
    expect(yaml).toMatch(/grok-cli:\s*\{\}/)
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
      expect(argvs[2]).toContain('IP:192.0.2.10')
      expect(argvs[2]).toContain('DNS:testhost.local')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
