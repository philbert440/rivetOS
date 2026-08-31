import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../lib/ssh.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/ssh.js')>()
  return {
    ...real,
    sshExecCapture: vi.fn(),
    checkSshReachable: vi.fn(() => true),
  }
})

import { sshExecCapture } from '../lib/ssh.js'
import { ENROLL_SNIPPET_MARKER, MeshHubError, packTarGz } from '../lib/mesh-enroll.js'
import mesh, { meshEnroll, meshRenew, meshSync } from './mesh.js'

const sshExecCaptureMock = vi.mocked(sshExecCapture)

const SNIPPET = `${ENROLL_SNIPPET_MARKER}. Merge into the node's rivet.config.yaml.
mesh:
  enabled: true
  node_name: "ct110"
`

const MESH_ONE = `{
  "version": 1,
  "updatedAt": 1,
  "nodes": {
    "ct110": {
      "id": "ct110",
      "name": "ct110",
      "host": "192.0.2.10",
      "port": 3000,
      "status": "offline"
    }
  }
}
`

const MESH_TWO = `{
  "version": 1,
  "updatedAt": 2,
  "nodes": {
    "ct110": {
      "id": "ct110",
      "name": "ct110",
      "host": "192.0.2.10",
      "port": 3000,
      "status": "offline"
    },
    "phildesk": {
      "id": "phildesk",
      "name": "phildesk",
      "host": "192.0.2.20",
      "port": 3000,
      "status": "offline"
    }
  }
}
`

function enrollB64(): string {
  return packTarGz({
    'ct110.crt': 'CERT',
    'ct110.key': 'KEY',
    'ca-chain.pem': 'CHAIN',
    'mesh.json': MESH_ONE,
    'node-config-snippet.yaml': SNIPPET,
  }).toString('base64')
}

function failSsh(
  message: string,
  extra: { stderr?: string; status?: number | null } = {},
): Error & { stdout: string; stderr: string; status: number | null } {
  const err = new Error(message) as Error & { stdout: string; stderr: string; status: number | null }
  err.stdout = ''
  err.stderr = extra.stderr ?? ''
  err.status = extra.status ?? 1
  return err
}

const ORIGINAL_SHARED = process.env.RIVETOS_SHARED_DIR
const ORIGINAL_HOME = process.env.HOME

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mesh-cmd-'))
  process.env.RIVETOS_SHARED_DIR = join(tmp, 'shared')
  process.env.HOME = join(tmp, 'home')
  mkdirSync(process.env.HOME, { recursive: true })
  mkdirSync(process.env.RIVETOS_SHARED_DIR, { recursive: true })
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  sshExecCaptureMock.mockResolvedValue({ stdout: 'ok\n', stderr: '' })
})

afterEach(() => {
  if (ORIGINAL_SHARED === undefined) delete process.env.RIVETOS_SHARED_DIR
  else process.env.RIVETOS_SHARED_DIR = ORIGINAL_SHARED
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('mesh join demotion', () => {
  it('prints a pointer to mesh enroll at exit 0 when invoked with no host', async () => {
    await mesh(['join'])
    const text = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(text).toMatch(/rivetos mesh enroll <user@host> --name <node>/)
    expect(text).toMatch(/mesh join --manual/)
    expect(sshExecCaptureMock).not.toHaveBeenCalled()
  })

  it('exits non-zero when a positional host is present without --manual', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${String(code)}`)
    }) as never)
    await expect(mesh(['join', '192.0.2.1'])).rejects.toThrow(/exit 1/)
    expect(exit).toHaveBeenCalledWith(1)
    const text = [
      ...vi.mocked(console.log).mock.calls.flat(),
      ...vi.mocked(console.error).mock.calls.flat(),
    ].join('\n')
    expect(text).toMatch(/rivetos mesh enroll/)
    expect(text).toMatch(/no longer a join/)
    expect(sshExecCaptureMock).not.toHaveBeenCalled()
  })
})

describe('mesh enroll (mocked ssh)', () => {
  it('probes BatchMode then captures ONLY stdout of hub enroll', async () => {
    const b64 = enrollB64()
    sshExecCaptureMock.mockImplementation(async (_host, command) => {
      if (command === 'echo ok') return { stdout: 'ok\n', stderr: '' }
      if (command.includes('enroll')) {
        return { stdout: b64, stderr: 'rivethub-hub: enrolled ct110\n' }
      }
      throw new Error(`unexpected ssh command: ${command}`)
    })

    await meshEnroll(['rivet@192.0.2.1', '--name', 'ct110', '--advertise', '192.0.2.10'])

    expect(sshExecCaptureMock.mock.calls[0]?.[1]).toBe('echo ok')
    const enrollCmd = sshExecCaptureMock.mock.calls[1]?.[1] ?? ''
    expect(enrollCmd).toContain("enroll 'ct110' '192.0.2.10'")
    expect(enrollCmd).toContain('PATH=/usr/local/bin:/usr/bin:/bin:$PATH')

    const shared = process.env.RIVETOS_SHARED_DIR!
    expect(readFileSync(join(shared, 'rivet-ca', 'issued', 'ct110.crt'), 'utf-8')).toBe('CERT')
    expect(readFileSync(join(shared, 'mesh.json'), 'utf-8')).toContain('ct110')
    const config = readFileSync(join(process.env.HOME!, '.rivetos', 'config.yaml'), 'utf-8')
    expect(config).toContain(ENROLL_SNIPPET_MARKER)
    expect(config).toMatch(/tls:\s*true/)
    expect(config).toMatch(/advertise_host:\s*"?192\.0\.2\.10"?/)
  })

  it('fills tls without pinning advertise_host when --advertise is omitted', async () => {
    const b64 = enrollB64()
    sshExecCaptureMock.mockImplementation(async (_host, command) => {
      if (command === 'echo ok') return { stdout: 'ok\n', stderr: '' }
      if (command.includes('enroll')) {
        return { stdout: b64, stderr: '' }
      }
      throw new Error(`unexpected ssh command: ${command}`)
    })

    await meshEnroll(['rivet@192.0.2.1', '--name', 'ct110'])

    const config = readFileSync(join(process.env.HOME!, '.rivetos', 'config.yaml'), 'utf-8')
    expect(config).toContain(ENROLL_SNIPPET_MARKER)
    expect(config).toMatch(/tls:\s*true/)
    expect(config).toMatch(/node_name:\s*"?ct110"?/)
    expect(config).not.toMatch(/advertise_host:/)
  })

  it('refreshes certs on re-enroll without duplicating the config snippet', async () => {
    const b64 = enrollB64()
    sshExecCaptureMock.mockImplementation(async (_host, command) => {
      if (command === 'echo ok') return { stdout: 'ok\n', stderr: '' }
      return { stdout: b64, stderr: '' }
    })
    const args = ['rivet@192.0.2.1', '--name', 'ct110', '--advertise', '192.0.2.10']
    await meshEnroll(args)
    await meshEnroll(args)
    const config = readFileSync(join(process.env.HOME!, '.rivetos', 'config.yaml'), 'utf-8')
    expect(config.split(ENROLL_SNIPPET_MARKER).length - 1).toBe(1)
  })

  it('coaches ssh-copy-id on BatchMode auth failure', async () => {
    sshExecCaptureMock.mockRejectedValue(
      failSsh('ssh probe exited with code 255', {
        stderr: 'Permission denied (publickey).',
        status: 255,
      }),
    )
    await expect(
      meshEnroll(['rivet@192.0.2.1', '--name', 'ct110', '--advertise', '192.0.2.10']),
    ).rejects.toThrow(/ssh-copy-id rivet@192.0.2.1/)
    expect(sshExecCaptureMock).toHaveBeenCalledTimes(1)
  })

  it('errors clearly when the hub helper is missing', async () => {
    sshExecCaptureMock.mockImplementation(async (_host, command) => {
      if (command === 'echo ok') return { stdout: 'ok\n', stderr: '' }
      throw failSsh('mesh enroll exited with code 127', {
        stderr: "bash: rivethub-hub: command not found",
        status: 127,
      })
    })
    await expect(
      meshEnroll(['rivet@192.0.2.1', '--name', 'ct110', '--advertise', '192.0.2.10']),
    ).rejects.toThrow(/hub helper rivethub-hub not found/)
  })

  it('rejects a malformed tarball', async () => {
    sshExecCaptureMock.mockImplementation(async (_host, command) => {
      if (command === 'echo ok') return { stdout: 'ok\n', stderr: '' }
      return { stdout: 'not-valid-base64-$$$', stderr: '' }
    })
    await expect(
      meshEnroll(['rivet@192.0.2.1', '--name', 'ct110', '--advertise', '192.0.2.10']),
    ).rejects.toThrow(/tarball/)
  })

  it('does not label a generic remote failure as helper-missing', async () => {
    sshExecCaptureMock.mockImplementation(async (_host, command) => {
      if (command === 'echo ok') return { stdout: 'ok\n', stderr: '' }
      throw failSsh('mesh enroll exited with code 1', {
        stderr: 'No such file or directory: /var/lib/rivethub/mesh.json',
        status: 1,
      })
    })
    try {
      await meshEnroll(['rivet@192.0.2.1', '--name', 'ct110', '--advertise', '192.0.2.10'])
      throw new Error('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(MeshHubError)
      expect((err as MeshHubError).code).toBe('ssh-failed')
      expect((err as Error).message).toMatch(/failed/)
      expect((err as Error).message).not.toMatch(/hub helper rivethub-hub not found/)
    }
  })
})

describe('mesh sync / renew (mocked ssh)', () => {
  it('atomically replaces mesh.json and prints a node-count delta', async () => {
    writeFileSync(join(process.env.RIVETOS_SHARED_DIR!, 'mesh.json'), MESH_ONE)
    sshExecCaptureMock.mockImplementation(async (_host, command) => {
      if (command === 'echo ok') return { stdout: 'ok\n', stderr: '' }
      if (command.includes('mesh-export')) return { stdout: MESH_TWO, stderr: '' }
      throw new Error(`unexpected ssh command: ${command}`)
    })
    await meshSync(['rivet@datahub'])
    const written = readFileSync(join(process.env.RIVETOS_SHARED_DIR!, 'mesh.json'), 'utf-8')
    expect(JSON.parse(written).nodes.phildesk.name).toBe('phildesk')
    const text = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(text).toMatch(/1 → 2 nodes \(\+1\)/)
  })

  it('rejects a malformed mesh-export as malformed-mesh', async () => {
    sshExecCaptureMock.mockImplementation(async (_host, command) => {
      if (command === 'echo ok') return { stdout: 'ok\n', stderr: '' }
      if (command.includes('mesh-export')) return { stdout: '{not-a-mesh', stderr: '' }
      throw new Error(`unexpected ssh command: ${command}`)
    })
    try {
      await meshSync(['rivet@datahub'])
      throw new Error('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(MeshHubError)
      expect((err as MeshHubError).code).toBe('malformed-mesh')
    }
  })

  it('renew uses hub renew and refreshes the leaf', async () => {
    const b64 = enrollB64()
    sshExecCaptureMock.mockImplementation(async (_host, command) => {
      if (command === 'echo ok') return { stdout: 'ok\n', stderr: '' }
      if (command.includes('renew')) return { stdout: b64, stderr: '' }
      throw new Error(`unexpected ssh command: ${command}`)
    })
    await meshRenew(['rivet@datahub', '--name', 'ct110'])
    const enrollCmd = sshExecCaptureMock.mock.calls[1]?.[1] ?? ''
    expect(enrollCmd).toContain("renew 'ct110'")
    expect(enrollCmd).not.toContain('enroll')
    expect(
      readFileSync(join(process.env.RIVETOS_SHARED_DIR!, 'rivet-ca', 'issued', 'ct110.crt'), 'utf-8'),
    ).toBe('CERT')
  })
})
