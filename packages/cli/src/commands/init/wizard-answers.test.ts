import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { validateConfig } from '@rivetos/boot'
import { ENROLL_SNIPPET_MARKER } from '../../lib/mesh-enroll.js'
import type { EnvDetection } from './types.js'

vi.mock('./detect.js', () => ({
  detectEnvironment: vi.fn(),
}))

vi.mock('../mesh.js', () => ({
  runMeshEnroll: vi.fn(),
}))

vi.mock('../doctor.js', () => ({
  default: vi.fn(async () => undefined),
}))

import { detectEnvironment } from './detect.js'
import { runMeshEnroll } from '../mesh.js'
import doctor from '../doctor.js'
import { runInitFromAnswersFile } from './wizard.js'

const detectEnvironmentMock = vi.mocked(detectEnvironment)
const runMeshEnrollMock = vi.mocked(runMeshEnroll)

const ORIGINAL_HOME = process.env.HOME
const ORIGINAL_SHARED = process.env.RIVETOS_SHARED_DIR

let tmp: string

function detection(overrides: Partial<EnvDetection> = {}): EnvDetection {
  const rivetDir = join(homedir(), '.rivetos')
  return {
    nodeVersion: '24.0.0',
    nodeOk: true,
    dockerAvailable: true,
    dockerVersion: '24.0.0',
    configExists: false,
    configPath: join(rivetDir, 'config.yaml'),
    rivetDir,
    ...overrides,
  }
}

function happyAnswers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deployment: 'manual',
    agents: [
      {
        name: 'rivet',
        provider: 'xai',
        apiKey: 'xai-test-key',
        model: 'grok-4-1-fast-reasoning',
        thinking: 'medium',
      },
    ],
    postgresUrl: 'postgres://u:p@localhost:5432/rivetos',
    joinMesh: false,
    ownerId: 'owner',
    confirm: true,
    ...overrides,
  }
}

function writeAnswers(obj: Record<string, unknown>): string {
  const path = join(tmp, 'answers.json')
  writeFileSync(path, `${JSON.stringify(obj)}\n`)
  return path
}

function stubExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${String(code ?? 0)}`)
  }) as never)
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'init-answers-'))
  process.env.HOME = join(tmp, 'home')
  process.env.RIVETOS_SHARED_DIR = join(tmp, 'shared')
  mkdirSync(process.env.HOME, { recursive: true })
  mkdirSync(process.env.RIVETOS_SHARED_DIR, { recursive: true })
  detectEnvironmentMock.mockReset()
  runMeshEnrollMock.mockReset()
  vi.mocked(doctor).mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
  if (ORIGINAL_SHARED === undefined) delete process.env.RIVETOS_SHARED_DIR
  else process.env.RIVETOS_SHARED_DIR = ORIGINAL_SHARED
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('runInitFromAnswersFile', () => {
  it('generate+seed happy path writes config, .env, and users.json', async () => {
    detectEnvironmentMock.mockResolvedValue(detection())
    const answersFile = writeAnswers(happyAnswers())

    await runInitFromAnswersFile({ answersFile })

    const rivetDir = join(homedir(), '.rivetos')
    const yaml = readFileSync(join(rivetDir, 'config.yaml'), 'utf-8')
    expect(yaml).toMatch(/default_agent:\s*rivet/)
    expect(yaml).not.toMatch(/^mesh:/m)
    const parsed = parseYaml(yaml) as Record<string, unknown>
    const result = validateConfig(parsed)
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)

    const envFile = readFileSync(join(rivetDir, '.env'), 'utf-8')
    expect(envFile).toContain('XAI_API_KEY=xai-test-key')
    expect(envFile).toContain('RIVETOS_PG_URL=postgres://u:p@localhost:5432/rivetos')

    const usersPath = join(process.env.RIVETOS_SHARED_DIR!, 'rivetos', 'users.json')
    const users = JSON.parse(readFileSync(usersPath, 'utf-8')) as {
      ownerUserId: string
      unmappedIsOwner: boolean
    }
    expect(users.ownerUserId).toBe('owner')
    expect(users.unmappedIsOwner).toBe(false)
    expect(runMeshEnrollMock).not.toHaveBeenCalled()
  })

  it('mesh join round-trips a tls-filled mesh section through the boot validator', async () => {
    detectEnvironmentMock.mockResolvedValue(detection())
    runMeshEnrollMock.mockResolvedValue({
      unpacked: {
        name: 'node-a',
        cert: Buffer.from('CERT'),
        key: Buffer.from('KEY'),
        caChain: Buffer.from('CHAIN'),
        meshJson: '{"version":1,"updatedAt":1,"nodes":{}}\n',
        snippet: `${ENROLL_SNIPPET_MARKER}. Merge into the node's rivet.config.yaml.
mesh:
  enabled: true
  node_name: "node-a"
`,
      },
      advertise: '192.0.2.99',
    })
    const answersFile = writeAnswers(
      happyAnswers({
        joinMesh: true,
        meshHub: 'rivet@192.0.2.10',
        meshName: 'node-a',
      }),
    )

    await runInitFromAnswersFile({ answersFile })

    const yaml = readFileSync(join(homedir(), '.rivetos', 'config.yaml'), 'utf-8')
    expect(yaml).toContain(ENROLL_SNIPPET_MARKER)
    expect(yaml).toMatch(/tls:\s*true/)
    expect(yaml).toMatch(/node_name:\s*"?node-a"?/)
    expect(yaml).not.toMatch(/advertise_host:/)

    const parsed = parseYaml(yaml) as Record<string, unknown>
    const mesh = parsed.mesh as Record<string, unknown>
    expect(mesh.enabled).toBe(true)
    expect(mesh.tls).toBe(true)
    expect(mesh.advertise_host).toBeUndefined()
    const result = validateConfig(parsed)
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('pins advertise_host when meshAdvertise is explicit', async () => {
    detectEnvironmentMock.mockResolvedValue(detection())
    runMeshEnrollMock.mockResolvedValue({
      unpacked: {
        name: 'node-a',
        cert: Buffer.from('CERT'),
        key: Buffer.from('KEY'),
        caChain: Buffer.from('CHAIN'),
        meshJson: '{"version":1,"updatedAt":1,"nodes":{}}\n',
        snippet: `${ENROLL_SNIPPET_MARKER}. Merge into the node's rivet.config.yaml.
mesh:
  enabled: true
  node_name: "node-a"
`,
      },
      advertise: '192.0.2.99',
    })
    const answersFile = writeAnswers(
      happyAnswers({
        joinMesh: true,
        meshHub: 'rivet@192.0.2.10',
        meshName: 'node-a',
        meshAdvertise: '192.0.2.11',
      }),
    )

    await runInitFromAnswersFile({ answersFile })

    const yaml = readFileSync(join(homedir(), '.rivetos', 'config.yaml'), 'utf-8')
    expect(yaml).toMatch(/advertise_host:\s*"?192\.0\.2\.11"?/)
    expect(yaml).not.toContain('192.0.2.99')
    const parsed = parseYaml(yaml) as Record<string, unknown>
    expect(validateConfig(parsed).valid).toBe(true)
  })

  it('existingConfig cancel exits 0 without generating', async () => {
    detectEnvironmentMock.mockResolvedValue(detection({ configExists: true }))
    stubExit()
    const answersFile = writeAnswers({ existingConfig: 'cancel' })

    await expect(runInitFromAnswersFile({ answersFile })).rejects.toThrow(/exit 0/)
    expect(runMeshEnrollMock).not.toHaveBeenCalled()
    try {
      readFileSync(join(homedir(), '.rivetos', 'config.yaml'))
      throw new Error('config.yaml should not exist')
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
    }
  })

  it('existingConfig validate runs doctor then exits 0', async () => {
    detectEnvironmentMock.mockResolvedValue(detection({ configExists: true }))
    stubExit()
    const answersFile = writeAnswers({ existingConfig: 'validate' })

    await expect(runInitFromAnswersFile({ answersFile })).rejects.toThrow(/exit 0/)
    expect(doctor).toHaveBeenCalledTimes(1)
  })

  it('existingConfig deploy does not seed users.json', async () => {
    detectEnvironmentMock.mockResolvedValue(detection({ configExists: true }))
    stubExit()
    const answersFile = writeAnswers({ existingConfig: 'deploy', deployNow: false })

    await expect(runInitFromAnswersFile({ answersFile })).rejects.toThrow(/exit 0/)
    try {
      readFileSync(join(process.env.RIVETOS_SHARED_DIR!, 'rivetos', 'users.json'))
      throw new Error('users.json should not be seeded on deploy')
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
    }
  })

  it('existingConfig overwrite with overwriteConfirm false exits without regen', async () => {
    detectEnvironmentMock.mockResolvedValue(detection({ configExists: true }))
    stubExit()
    const answersFile = writeAnswers({
      existingConfig: 'overwrite',
      overwriteConfirm: false,
    })

    await expect(runInitFromAnswersFile({ answersFile })).rejects.toThrow(/exit 0/)
    try {
      readFileSync(join(homedir(), '.rivetos', 'config.yaml'))
      throw new Error('config.yaml should not exist')
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
    }
  })

  it('existingConfig overwrite+confirm and reconfigure both fall through to generate', async () => {
    for (const extra of [
      { existingConfig: 'overwrite', overwriteConfirm: true },
      { existingConfig: 'reconfigure' },
    ]) {
      rmSync(join(homedir(), '.rivetos'), { recursive: true, force: true })
      detectEnvironmentMock.mockResolvedValue(detection({ configExists: true }))
      const answersFile = writeAnswers(happyAnswers(extra))
      await runInitFromAnswersFile({ answersFile })
      const yaml = readFileSync(join(homedir(), '.rivetos', 'config.yaml'), 'utf-8')
      expect(yaml).toMatch(/default_agent:\s*rivet/)
      expect(validateConfig(parseYaml(yaml) as Record<string, unknown>).valid).toBe(true)
      const usersPath = join(process.env.RIVETOS_SHARED_DIR!, 'rivetos', 'users.json')
      expect(JSON.parse(readFileSync(usersPath, 'utf-8')).ownerUserId).toBe('owner')
    }
  })

  it('confirm false exits 0 without generating', async () => {
    detectEnvironmentMock.mockResolvedValue(detection())
    stubExit()
    const answersFile = writeAnswers(happyAnswers({ confirm: false }))

    await expect(runInitFromAnswersFile({ answersFile })).rejects.toThrow(/exit 0/)
    try {
      readFileSync(join(homedir(), '.rivetos', 'config.yaml'))
      throw new Error('config.yaml should not exist')
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
    }
  })
})
