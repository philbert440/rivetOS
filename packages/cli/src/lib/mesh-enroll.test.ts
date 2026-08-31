import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { parse as parseYaml } from 'yaml'
import {
  CERT_EXPIRY_WARN_DAYS,
  DAY_MS,
  DEFAULT_HUB_CMD,
  ENROLL_SNIPPET_MARKER,
  MeshHubError,
  classifyCertExpiry,
  decodeEnrollB64,
  defaultAdvertiseHost,
  extractTarGz,
  formatEnrollSnippet,
  hubRemoteCommand,
  leafCertExpiryCheck,
  mergeConfigFile,
  mergeConfigSnippet,
  meshNodeCount,
  meshSectionFromEnroll,
  packTarGz,
  parseCertNotAfter,
  parseEnrollArgs,
  parseEnrollTarball,
  parseRenewArgs,
  parseSyncArgs,
  parseUserHost,
  readLocalMeshNodeCount,
  renewCommand,
  renewHubTargetFromSeed,
  validateNodeName,
  writeEnrollLayout,
} from './mesh-enroll.js'

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

function enrollMembers(name = 'ct110'): Record<string, string> {
  return {
    [`${name}.crt`]: 'CERT',
    [`${name}.key`]: 'KEY',
    'ca-chain.pem': 'CHAIN',
    'mesh.json': MESH_ONE,
    'node-config-snippet.yaml': SNIPPET,
  }
}

function enrollB64(name = 'ct110'): string {
  return packTarGz(enrollMembers(name)).toString('base64')
}

const ORIGINAL_SHARED = process.env.RIVETOS_SHARED_DIR
const ORIGINAL_HOME = process.env.HOME

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mesh-enroll-'))
  process.env.RIVETOS_SHARED_DIR = join(tmp, 'shared')
  process.env.HOME = join(tmp, 'home')
  mkdirSync(process.env.HOME, { recursive: true })
  mkdirSync(process.env.RIVETOS_SHARED_DIR, { recursive: true })
})

afterEach(() => {
  if (ORIGINAL_SHARED === undefined) delete process.env.RIVETOS_SHARED_DIR
  else process.env.RIVETOS_SHARED_DIR = ORIGINAL_SHARED
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
  rmSync(tmp, { recursive: true, force: true })
})

describe('arg parsing', () => {
  it('parses enroll user@host --name and optional flags', () => {
    expect(
      parseEnrollArgs([
        'rivet@192.0.2.1',
        '--name',
        'ct110',
        '--advertise',
        '192.0.2.10',
        '--hub-cmd',
        'rivethub-hub',
      ]),
    ).toEqual({
      user: 'rivet',
      host: '192.0.2.1',
      target: 'rivet@192.0.2.1',
      name: 'ct110',
      advertise: '192.0.2.10',
      hubCmd: DEFAULT_HUB_CMD,
    })
  })

  it('accepts flags before the positional target', () => {
    const parsed = parseEnrollArgs(['--name', 'phildesk', 'philip@datahub'])
    expect(parsed.name).toBe('phildesk')
    expect(parsed.target).toBe('philip@datahub')
    expect(parsed.advertise).toBeUndefined()
  })

  it('requires --name and user@host', () => {
    expect(() => parseEnrollArgs(['rivet@datahub'])).toThrow(/--name/)
    expect(() => parseEnrollArgs(['--name', 'ct110'])).toThrow(/Usage: rivetos mesh enroll/)
  })

  it('rejects invalid node names', () => {
    expect(validateNodeName('ct110')).toBe(true)
    expect(validateNodeName('-bad')).toBe(false)
    expect(() => parseEnrollArgs(['rivet@h', '--name', 'Bad_Name'])).toThrow(/invalid node name/)
  })

  it('rejects unknown options and unsafe user@host', () => {
    expect(() => parseEnrollArgs(['rivet@h', '--name', 'n', '--nope'])).toThrow(/Unknown option/)
    expect(() => parseUserHost('host-only')).toThrow(/user@host/)
    expect(() => parseUserHost('rivet@host;rm')).toThrow(/unsafe/)
    expect(parseUserHost('rivet@2001:db8::1')).toEqual({
      user: 'rivet',
      host: '2001:db8::1',
      target: 'rivet@2001:db8::1',
    })
  })

  it('parses sync and renew', () => {
    expect(parseSyncArgs(['rivet@datahub'])).toEqual({
      user: 'rivet',
      host: 'datahub',
      target: 'rivet@datahub',
      hubCmd: DEFAULT_HUB_CMD,
    })
    expect(parseRenewArgs(['--name', 'ct110', 'rivet@datahub']).name).toBe('ct110')
    expect(() => parseRenewArgs(['rivet@datahub'])).toThrow(/--name/)
    expect(() => parseSyncArgs([])).toThrow(/mesh sync/)
  })

  it('builds a PATH-prefixed remote command with quoted args', () => {
    const cmd = hubRemoteCommand('rivethub-hub', 'enroll', 'ct110', '192.0.2.10')
    expect(cmd.startsWith('PATH=/usr/local/bin:/usr/bin:/bin:$PATH')).toBe(true)
    expect(cmd).toContain("'rivethub-hub' enroll 'ct110' '192.0.2.10'")
  })
})

describe('tarball unpack', () => {
  it('round-trips gzip ustar members', () => {
    const gz = packTarGz(enrollMembers())
    const files = extractTarGz(gz)
    expect(files.get('ct110.crt')?.toString()).toBe('CERT')
    expect(files.get('mesh.json')?.toString()).toContain('"ct110"')
  })

  it('places certs on the issued/ layout mtls.ts expects', async () => {
    const unpacked = parseEnrollTarball(enrollB64(), 'ct110')
    await writeEnrollLayout(unpacked)
    const shared = process.env.RIVETOS_SHARED_DIR!
    const crt = join(shared, 'rivet-ca', 'issued', 'ct110.crt')
    const key = join(shared, 'rivet-ca', 'issued', 'ct110.key')
    const chain = join(shared, 'rivet-ca', 'intermediate', 'ca-chain.pem')
    const chainAlias = join(shared, 'rivet-ca', 'intermediate', 'chain.pem')
    const mesh = join(shared, 'mesh.json')
    expect(readFileSync(crt, 'utf-8')).toBe('CERT')
    expect(readFileSync(key, 'utf-8')).toBe('KEY')
    expect(statSync(key).mode & 0o777).toBe(0o600)
    expect(statSync(join(shared, 'rivet-ca', 'issued')).mode & 0o777).toBe(0o700)
    expect(readFileSync(chain, 'utf-8')).toBe('CHAIN')
    expect(readFileSync(chainAlias, 'utf-8')).toBe('CHAIN')
    expect(JSON.parse(readFileSync(mesh, 'utf-8')).nodes.ct110.host).toBe('192.0.2.10')
  })

  it('rejects missing members, bad base64, non-gzip, and path traversal', () => {
    expect(() => decodeEnrollB64('   ')).toThrow(MeshHubError)
    expect(() => extractTarGz(Buffer.from('not-gzip'))).toThrow(/not gzip/)
    const incomplete = packTarGz({ 'ct110.crt': 'CERT', 'mesh.json': MESH_ONE })
    expect(() => parseEnrollTarball(incomplete.toString('base64'), 'ct110')).toThrow(
      /missing ct110.key/,
    )
    const sneaky = packTarGz({ '../etc/passwd': 'nope' })
    expect(() => extractTarGz(sneaky)).toThrow(/unsafe path/)
  })

  it('rejects subdir members and `..` paths (flat-member contract)', () => {
    expect(() => extractTarGz(packTarGz({ 'sub/ct110.crt': 'nope' }))).toThrow(/unsafe path/)
    expect(() => extractTarGz(packTarGz({ 'a/b/../c': 'nope' }))).toThrow(/unsafe path/)
  })

  it('rejects a header whose checksum does not match', () => {
    const tar = gunzipSync(packTarGz({ 'hello.txt': 'hi' }))
    tar[0] ^= 0xff
    expect(() => extractTarGz(gzipSync(tar))).toThrow(/checksum/)
  })

  it('rejects a decompressed payload over the cap', () => {
    const gz = gzipSync(Buffer.alloc(1000, 1))
    expect(() => extractTarGz(gz, { maxDecodedBytes: 100 })).toThrow(/exceeds \d+ bytes decompressed/)
  })

  it('rejects a member whose header size exceeds the per-member cap', () => {
    expect(() => extractTarGz(packTarGz({ 'big.txt': 'hello world' }), { maxMemberBytes: 4 })).toThrow(
      /member exceeds/,
    )
  })

  it('rejects garbage-but-nonempty stdout as invalid base64, not "not gzip"', () => {
    try {
      decodeEnrollB64('Welcome to Ubuntu\nnot-valid-base64-$$$')
      throw new Error('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(MeshHubError)
      expect((err as Error).message).toMatch(/not valid base64/)
      expect((err as Error).message).not.toMatch(/not gzip/)
    }
  })

  it('accepts base64 with wrapping whitespace', () => {
    const b64 = enrollB64()
    const wrapped = b64.slice(0, 40) + '\n' + b64.slice(40)
    expect(parseEnrollTarball(wrapped, 'ct110').name).toBe('ct110')
  })
})

describe('config-snippet merge', () => {
  it('is idempotent when the hub marker is already present', () => {
    const first = mergeConfigSnippet(null, SNIPPET)
    expect(first.changed).toBe(true)
    expect(first.next).toContain(ENROLL_SNIPPET_MARKER)
    const second = mergeConfigSnippet(first.next, SNIPPET + '\nextra: true\n')
    expect(second.changed).toBe(false)
    expect(second.next).toBe(first.next)
    expect(second.next.match(/node_name/g)?.length).toBe(1)
  })

  it('warns when a later --name would change node_name under the marker no-op', () => {
    const first = mergeConfigSnippet(null, SNIPPET)
    const renamed = SNIPPET.replace('ct110', 'phildesk')
    const second = mergeConfigSnippet(first.next, renamed)
    expect(second.changed).toBe(false)
    expect(second.warning).toMatch(/node_name "ct110".*incoming "phildesk"/)
    expect(second.next).toBe(first.next)
  })

  it('appends to existing config after a backup, then no-ops', async () => {
    const path = join(process.env.HOME!, '.rivetos', 'config.yaml')
    mkdirSync(join(process.env.HOME!, '.rivetos'), { recursive: true })
    writeFileSync(path, 'runtime:\n  default_agent: claude\n')
    chmodSync(path, 0o600)
    expect((await mergeConfigFile(SNIPPET, path)).result).toBe('appended')
    expect(readFileSync(`${path}.bak`, 'utf-8')).toContain('default_agent')
    const once = readFileSync(path, 'utf-8')
    expect(once).toContain('default_agent')
    expect(once).toContain(ENROLL_SNIPPET_MARKER)
    expect((await mergeConfigFile(SNIPPET, path)).result).toBe('unchanged')
    expect(readFileSync(path, 'utf-8')).toBe(once)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('meshSectionFromEnroll / formatEnrollSnippet', () => {
  const unpacked = { name: 'ct110', snippet: SNIPPET }

  it('fills tls when the hub snippet omits it', () => {
    const section = meshSectionFromEnroll(unpacked)
    expect(section).toEqual({
      enabled: true,
      node_name: 'ct110',
      tls: true,
    })
    expect(section.advertise_host).toBeUndefined()
  })

  it('writes advertise_host only when the caller passes one', () => {
    expect(meshSectionFromEnroll(unpacked, '192.0.2.11').advertise_host).toBe('192.0.2.11')
    expect(meshSectionFromEnroll(unpacked).advertise_host).toBeUndefined()
  })

  it('serializes the same mapping the wizard builder produces', () => {
    const section = meshSectionFromEnroll(unpacked, '192.0.2.11')
    const text = formatEnrollSnippet(unpacked, '192.0.2.11')
    expect(text).toContain(ENROLL_SNIPPET_MARKER)
    expect(parseYaml(text)).toEqual({ mesh: section })
  })
})

describe('cert expiry math', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')

  it('warns on the 30-day boundary and is ok just after it', () => {
    expect(CERT_EXPIRY_WARN_DAYS).toBe(30)
    const exact = new Date(now.getTime() + 30 * DAY_MS)
    expect(classifyCertExpiry(exact, now)).toBe('warn')
    const justAfter = new Date(now.getTime() + 30 * DAY_MS + 1)
    expect(classifyCertExpiry(justAfter, now)).toBe('ok')
  })

  it('treats notAfter == now as expired and 90-day leaves as ok', () => {
    expect(classifyCertExpiry(now, now)).toBe('expired')
    expect(classifyCertExpiry(new Date(now.getTime() - 1), now)).toBe('expired')
    expect(classifyCertExpiry(new Date(now.getTime() + 90 * DAY_MS), now)).toBe('ok')
  })

  it('leafCertExpiryCheck names the exact renew command', () => {
    // Self-signed fixture from packages/core test-ca (notAfter ~2036).
    const pem = `-----BEGIN CERTIFICATE-----
MIIDSzCCAjOgAwIBAgIUMY//jFXapWEg8fVopMlJ6olNaxcwDQYJKoZIhvcNAQEL
BQAwMDEWMBQGA1UEAwwNUml2ZXQgVGVzdCBDQTEWMBQGA1UECgwNUml2ZXRPUyBU
ZXN0czAeFw0yNjA0MjUxMjU0MjBaFw0zNjA0MjIxMjU0MjBaMCgxDjAMBgNVBAMM
BWN0MTEwMRYwFAYDVQQKDA1SaXZldE9TIFRlc3RzMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAujSxgITi69+jFL4C4PA7KO25WWNaGpXJm/6OnTxx6vju
OV35s3puciHdSl22IC8R5Z0xvwRJ5pG+sPKHZsUXni4Fm50W5WnIiNM11srB5pEG
MHxvQYo0qX+CHUquPMDuwdW75QhOtGjzI77088nWffkLbqa7QRTYtyOyzraQmfm3
HS2+0AK6/RI7Lh/wcNFeffmO2HMkfLcBKENboRC3Q8SGHT4LSPJsU3QyHCJM5x4D
xisTo8NWKhPE7JxKVA6JCw4pK3XrcNV3XZBScJNrcOqtWcOg1hfVw1GxoMPjNOom
Jq1RoNfwnnqMQN9Ktrct6OEmeU6RcVjmEIn4NpnklwIDAQABo2UwYzAhBgNVHREE
GjAYggpjdDExMC5tZXNohwTAqApuhwR/AAABMB0GA1UdDgQWBBR3dlMVV/QnCzZ8
jlRsy6BAbIi7PjAfBgNVHSMEGDAWgBTHUm4muhW3rsM2a0oBRQRMPct9wjANBgkq
hkiG9w0BAQsFAAOCAQEAjWPaHbFnypGW+tOUn12zt8c+9ieOtdPzImQ91T054alv
LU6WmmKiAHHHXHmPSf7/CnTvIAmi7Gek56w7GtsSngSaB+yJ0OCldcBUtlYNaY3n
Hn50XRUighl7R2Ig9c5yvxr9CEP+91yNpNaqo2R9B3Q78MMxk48Dr5O6l/SUjH8Z
p6hyWFBLXi0EOwu11zoqawaHG4aGDmZu1o0TI267c+qOsdlmRZIP6TK5a8ICeoWI
v+x+WZjBjrxj+NYUU8zyS30Qx0w37eqq2gBMQmfFr2iBfgAzehsvd18AzSKD88qO
Qzs19HE9iP8ob0KohiNo1wyWKJNWgAv0olFoqGKOEg==
-----END CERTIFICATE-----
`
    const notAfter = parseCertNotAfter(pem)
    expect(notAfter.getUTCFullYear()).toBe(2036)
    const warn = leafCertExpiryCheck({
      certPem: pem,
      nodeName: 'ct110',
      hubTarget: 'rivet@datahub',
      now: new Date(notAfter.getTime() - 30 * DAY_MS),
    })
    expect(warn.status).toBe('warn')
    expect(warn.detail).toBe(`Run: ${renewCommand('rivet@datahub', 'ct110')}`)
    expect(warn.detail).toBe('Run: rivetos mesh renew rivet@datahub --name ct110')
    const expired = leafCertExpiryCheck({
      certPem: pem,
      nodeName: 'ct110',
      hubTarget: 'user@datahub',
      now: notAfter,
    })
    expect(expired.status).toBe('fail')
    expect(expired.detail).toBe('Run: rivetos mesh renew user@datahub --name ct110')
    expect(renewHubTargetFromSeed('192.0.2.1')).toBe('rivet@192.0.2.1')
    expect(renewHubTargetFromSeed(undefined)).toBe('user@datahub')
  })

  it('classifies expiry against a hardcoded UTC now (not derived from parsed notAfter)', () => {
    const pem = `-----BEGIN CERTIFICATE-----
MIIDSzCCAjOgAwIBAgIUMY//jFXapWEg8fVopMlJ6olNaxcwDQYJKoZIhvcNAQEL
BQAwMDEWMBQGA1UEAwwNUml2ZXQgVGVzdCBDQTEWMBQGA1UECgwNUml2ZXRPUyBU
ZXN0czAeFw0yNjA0MjUxMjU0MjBaFw0zNjA0MjIxMjU0MjBaMCgxDjAMBgNVBAMM
BWN0MTEwMRYwFAYDVQQKDA1SaXZldE9TIFRlc3RzMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAujSxgITi69+jFL4C4PA7KO25WWNaGpXJm/6OnTxx6vju
OV35s3puciHdSl22IC8R5Z0xvwRJ5pG+sPKHZsUXni4Fm50W5WnIiNM11srB5pEG
MHxvQYo0qX+CHUquPMDuwdW75QhOtGjzI77088nWffkLbqa7QRTYtyOyzraQmfm3
HS2+0AK6/RI7Lh/wcNFeffmO2HMkfLcBKENboRC3Q8SGHT4LSPJsU3QyHCJM5x4D
xisTo8NWKhPE7JxKVA6JCw4pK3XrcNV3XZBScJNrcOqtWcOg1hfVw1GxoMPjNOom
Jq1RoNfwnnqMQN9Ktrct6OEmeU6RcVjmEIn4NpnklwIDAQABo2UwYzAhBgNVHREE
GjAYggpjdDExMC5tZXNohwTAqApuhwR/AAABMB0GA1UdDgQWBBR3dlMVV/QnCzZ8
jlRsy6BAbIi7PjAfBgNVHSMEGDAWgBTHUm4muhW3rsM2a0oBRQRMPct9wjANBgkq
hkiG9w0BAQsFAAOCAQEAjWPaHbFnypGW+tOUn12zt8c+9ieOtdPzImQ91T054alv
LU6WmmKiAHHHXHmPSf7/CnTvIAmi7Gek56w7GtsSngSaB+yJ0OCldcBUtlYNaY3n
Hn50XRUighl7R2Ig9c5yvxr9CEP+91yNpNaqo2R9B3Q78MMxk48Dr5O6l/SUjH8Z
p6hyWFBLXi0EOwu11zoqawaHG4aGDmZu1o0TI267c+qOsdlmRZIP6TK5a8ICeoWI
v+x+WZjBjrxj+NYUU8zyS30Qx0w37eqq2gBMQmfFr2iBfgAzehsvd18AzSKD88qO
Qzs19HE9iP8ob0KohiNo1wyWKJNWgAv0olFoqGKOEg==
-----END CERTIFICATE-----
`
    const notAfter = parseCertNotAfter(pem)
    expect(notAfter.toISOString().endsWith('Z')).toBe(true)
    const now = new Date('2026-04-22T12:54:20.000Z')
    expect(classifyCertExpiry(notAfter, now)).toBe('ok')
    const warnNow = new Date('2036-04-01T00:00:00.000Z')
    expect(classifyCertExpiry(notAfter, warnNow)).toBe('warn')
  })
})

describe('defaultAdvertiseHost', () => {
  it('prefers a non-localhost hostname that passes isSafeArg', () => {
    expect(defaultAdvertiseHost('phildesk', {})).toBe('phildesk')
  })

  it('skips localhost and uses the first non-internal IPv4', () => {
    expect(
      defaultAdvertiseHost('localhost', {
        eth0: [{ family: 'IPv4', internal: false, address: '192.0.2.10' }],
      } as Parameters<typeof defaultAdvertiseHost>[1]),
    ).toBe('192.0.2.10')
  })

  it('falls back to 127.0.0.1 when hostname is unsafe and no IPv4 is available', () => {
    expect(defaultAdvertiseHost('localhost', {})).toBe('127.0.0.1')
    expect(defaultAdvertiseHost('host;rm', {})).toBe('127.0.0.1')
  })
})

describe('mesh node count', () => {
  it('counts Record-format nodes', () => {
    expect(meshNodeCount(MESH_ONE)).toBe(1)
  })

  it('treats a missing local mesh.json as 0 and surfaces a corrupt file', async () => {
    expect(await readLocalMeshNodeCount()).toBe(0)
    writeFileSync(join(process.env.RIVETOS_SHARED_DIR!, 'mesh.json'), '{not json')
    await expect(readLocalMeshNodeCount()).rejects.toThrow(MeshHubError)
    await expect(readLocalMeshNodeCount()).rejects.toThrow(/local mesh.json/)
  })
})
