import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLeafCert } from './doctor.js'
import { DAY_MS, parseCertNotAfter } from '../lib/mesh-enroll.js'

const NODE_CRT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../core/src/runtime/__fixtures__/test-ca/node.crt',
)

const ORIGINAL_SHARED = process.env.RIVETOS_SHARED_DIR
const ORIGINAL_HOME = process.env.HOME
const ORIGINAL_NODE = process.env.RIVETOS_NODE_NAME

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'doctor-leaf-'))
  process.env.RIVETOS_SHARED_DIR = join(tmp, 'shared')
  process.env.HOME = join(tmp, 'home')
  mkdirSync(process.env.HOME, { recursive: true })
  mkdirSync(process.env.RIVETOS_SHARED_DIR, { recursive: true })
  delete process.env.RIVETOS_NODE_NAME
})

afterEach(() => {
  if (ORIGINAL_SHARED === undefined) delete process.env.RIVETOS_SHARED_DIR
  else process.env.RIVETOS_SHARED_DIR = ORIGINAL_SHARED
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
  if (ORIGINAL_NODE === undefined) delete process.env.RIVETOS_NODE_NAME
  else process.env.RIVETOS_NODE_NAME = ORIGINAL_NODE
  rmSync(tmp, { recursive: true, force: true })
})

function writeIssuedCert(name: string): string {
  const pem = readFileSync(NODE_CRT, 'utf-8')
  const issued = join(process.env.RIVETOS_SHARED_DIR!, 'rivet-ca', 'issued')
  mkdirSync(issued, { recursive: true })
  writeFileSync(join(issued, `${name}.crt`), pem)
  return pem
}

describe('doctor leaf-cert check', () => {
  it('skips when this node has no name (not enrolled)', async () => {
    expect(await checkLeafCert(null)).toEqual([])
  })

  it('skips when the node is named but has no issued cert', async () => {
    process.env.RIVETOS_NODE_NAME = 'ct110'
    expect(await checkLeafCert(null)).toEqual([])
  })

  it('passes with a far-future leaf and default user@datahub renew target', async () => {
    process.env.RIVETOS_NODE_NAME = 'ct110'
    const pem = writeIssuedCert('ct110')
    const now = new Date('2026-04-22T12:54:20.000Z')
    const results = await checkLeafCert(null, now)
    expect(results).toHaveLength(1)
    expect(results[0]?.category).toBe('mesh')
    expect(results[0]?.name).toBe('leaf-cert')
    expect(results[0]?.status).toBe('pass')
    expect(results[0]?.detail).toBeUndefined()
    expect(parseCertNotAfter(pem).getUTCFullYear()).toBe(2036)
  })

  it('warns within 30 days and renders the 5th check() arg as detail with seed_host', async () => {
    process.env.RIVETOS_NODE_NAME = 'ct110'
    const pem = writeIssuedCert('ct110')
    const notAfter = parseCertNotAfter(pem)
    const results = await checkLeafCert(
      'mesh:\n  discovery:\n    seed_host: 192.0.2.1\n',
      new Date(notAfter.getTime() - 30 * DAY_MS),
    )
    expect(results[0]?.status).toBe('warn')
    expect(results[0]?.detail).toBe('Run: rivetos mesh renew rivet@192.0.2.1 --name ct110')
  })

  it('accepts camelCase seedHost', async () => {
    process.env.RIVETOS_NODE_NAME = 'ct110'
    const pem = writeIssuedCert('ct110')
    const notAfter = parseCertNotAfter(pem)
    const results = await checkLeafCert(
      'mesh:\n  discovery:\n    seedHost: datahub.example\n',
      new Date(notAfter.getTime() - 1),
    )
    expect(results[0]?.status).toBe('warn')
    expect(results[0]?.detail).toMatch(/rivet@datahub.example/)
  })

  it('fails when the leaf is expired (doctor maps any fail to exit 1)', async () => {
    process.env.RIVETOS_NODE_NAME = 'ct110'
    const pem = writeIssuedCert('ct110')
    const notAfter = parseCertNotAfter(pem)
    const results = await checkLeafCert(null, notAfter)
    expect(results[0]?.status).toBe('fail')
    expect(results[0]?.detail).toBe('Run: rivetos mesh renew user@datahub --name ct110')
  })
})
