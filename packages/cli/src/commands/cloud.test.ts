import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLOUD_IMPORT_HINT,
  DEFAULT_EMBED_MODEL,
  NEXT_STEP,
  SSLMODE_REQUIRED_MSG,
  cloudExportApiUrl,
  cloudImportApiUrl,
  describePgUrl,
  formatCloudHttpError,
  harnessLineFromEvent,
  isRivetCloudPgUrl,
  parseCloudExportArgs,
  parseCloudImportArgs,
  parseConnectArgs,
  redactEmbedUrl,
  redactSecret,
  renderChecklist,
  resolveCloudApi,
  runCloudConnect,
  runCloudExport,
  runCloudImport,
  validateEmbedUrl,
  validatePgUrl,
} from './cloud.js'

const PG = 'postgres://tenant_demo:s3cret@rivetos.cloud:5432/tenant_demo?sslmode=require'
const EMBED = 'https://rivetos.cloud/embed/aabbccddeeff00112233445566778899'
const tmpDirs: string[] = []

afterEach(() => {
  tmpDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  vi.restoreAllMocks()
})

describe('validatePgUrl', () => {
  it('accepts postgres and postgresql with sslmode=', () => {
    expect(validatePgUrl(PG).hostname).toBe('rivetos.cloud')
    expect(
      validatePgUrl('postgresql://tenant_demo:x@203.0.113.10:5432/tenant_demo?sslmode=require')
        .hostname,
    ).toBe('203.0.113.10')
  })

  it('rejects a missing sslmode with the specified message', () => {
    expect(() => validatePgUrl('postgres://tenant_demo:x@rivetos.cloud:5432/tenant_demo')).toThrow(
      SSLMODE_REQUIRED_MSG,
    )
  })

  it('rejects a non-postgres scheme and an unparseable URL', () => {
    expect(() => validatePgUrl('https://rivetos.cloud/db')).toThrow(/scheme/)
    expect(() => validatePgUrl('not a url')).toThrow(/invalid postgres URL/)
  })
})

describe('validateEmbedUrl', () => {
  it('requires https', () => {
    expect(validateEmbedUrl(EMBED).protocol).toBe('https:')
    expect(() => validateEmbedUrl('http://rivetos.cloud/embed/token')).toThrow(
      /embed URL must be https/,
    )
    expect(() => validateEmbedUrl('not-a-url')).toThrow(/invalid embed URL/)
  })
})

describe('parseConnectArgs', () => {
  it('parses the positional URL plus flags', () => {
    const flags = parseConnectArgs([
      PG,
      '--embed-url',
      EMBED,
      '--embed-model',
      'qwen3-embedding-0.6b',
      '--harness',
      'grok-build',
      '--root',
      '/opt/rivetos',
      '--dry-run',
      '--yes',
    ])
    expect(flags).toEqual({
      pgUrl: PG,
      embedUrl: EMBED,
      embedModel: 'qwen3-embedding-0.6b',
      harnesses: ['grok-build'],
      root: '/opt/rivetos',
      dryRun: true,
      yes: true,
      token: undefined,
    })
  })

  it('parses --token', () => {
    expect(parseConnectArgs([PG, '--embed-url', EMBED, '--token', 'tok_abc']).token).toBe('tok_abc')
  })

  it('defaults the embed model and requires pg-url + --embed-url', () => {
    expect(parseConnectArgs([PG, '--embed-url', EMBED]).embedModel).toBe(DEFAULT_EMBED_MODEL)
    expect(() => parseConnectArgs(['--embed-url', EMBED])).toThrow(/postgres URL/)
    expect(() => parseConnectArgs([PG])).toThrow(/--embed-url/)
  })
})

describe('redaction', () => {
  it('never includes the password in host/db descriptions', () => {
    expect(describePgUrl(PG)).toBe('rivetos.cloud:5432/tenant_demo (sslmode=require)')
    expect(describePgUrl(PG)).not.toContain('s3cret')
    expect(redactSecret(PG)).not.toContain('s3cret')
    expect(redactEmbedUrl(EMBED)).toBe('https://rivetos.cloud/embed/***')
    expect(redactEmbedUrl(EMBED)).not.toContain('aabbcc')
  })

  it('replaces colon-containing userinfo and password= query values; malformed → <redacted>', () => {
    const colon = redactSecret('postgres://user:alpha:beta@rivetos.cloud/db?sslmode=require')
    expect(colon).not.toContain('alpha')
    expect(colon).not.toContain('beta')
    expect(colon).toContain('***')
    const q = redactSecret('postgres://rivetos.cloud/db?password=example-secret&sslmode=require')
    expect(q).not.toContain('example-secret')
    expect(q).toMatch(/password=\*\*\*/)
    expect(redactSecret('not a url')).toBe('<redacted>')
  })
})

describe('cloud API target', () => {
  it('uses the URL hostname (not postgres port) and strips tenant_ from the db name', () => {
    expect(resolveCloudApi(PG)).toEqual({
      origin: 'https://rivetos.cloud',
      slug: 'demo',
    })
    expect(cloudExportApiUrl(PG)).toBe('https://rivetos.cloud/api/t/demo/export')
    expect(cloudImportApiUrl(PG)).toBe('https://rivetos.cloud/api/t/demo/import')
    expect(isRivetCloudPgUrl(PG)).toBe(true)
    expect(isRivetCloudPgUrl('postgres://u:p@127.0.0.1:5432/local')).toBe(false)
    expect(CLOUD_IMPORT_HINT).toMatch(/rivetos cloud import/)
  })
})

describe('parseCloudExportArgs / parseCloudImportArgs', () => {
  it('parses --out and requires an import file', () => {
    expect(parseCloudExportArgs(['--out', 'mem.ndjson.gz'])).toEqual({ out: 'mem.ndjson.gz' })
    expect(parseCloudExportArgs([])).toEqual({})
    expect(parseCloudImportArgs(['dump.ndjson.gz'])).toEqual({ file: 'dump.ndjson.gz' })
    expect(() => parseCloudImportArgs([])).toThrow(/import requires a file path/)
  })
})

describe('renderChecklist', () => {
  it('prints DB, embed, per-harness status, and the next-step line', () => {
    const text = renderChecklist({
      db: { ok: true, messages: 12 },
      embed: { ok: true, dims: 1024 },
      harnesses: [
        { id: 'claude-code', status: 'installed' },
        { id: 'grok-build', status: 'skipped', reason: 'not found' },
        { id: 'kimi-code', status: 'failed', reason: 'setup script missing' },
      ],
    })
    expect(text).toContain('DB ok (12 messages)')
    expect(text).toContain('embed ok (1024 dims)')
    expect(text).toContain('claude-code: installed')
    expect(text).toContain('grok-build: skipped (not found)')
    expect(text).toContain('kimi-code: failed (setup script missing)')
    expect(text).toContain(NEXT_STEP)
  })

  it('maps not-detected install events to skipped (not found)', () => {
    expect(harnessLineFromEvent({ id: 'pi', ok: false, detail: 'not detected on PATH' })).toEqual({
      id: 'pi',
      status: 'skipped',
      reason: 'not found',
    })
  })
})

describe('runCloudConnect', () => {
  it('upserts env into a temp dir and renders the checklist with mocked smoke', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-connect-'))
    tmpDirs.push(dir)
    const envPath = join(dir, '.env')
    const logs: string[] = []
    const smokeDb = vi.fn(async () => ({ ok: true as const, messages: 7 }))
    const smokeEmbed = vi.fn(async () => ({ ok: true as const, dims: 1024 }))
    const runInstall = vi.fn(
      async (_parsed: unknown, deps: { onHarness?: (e: unknown) => void }) => {
        deps.onHarness?.({ id: 'grok-build', ok: true, detail: 'synced' })
      },
    )

    const checklist = await runCloudConnect([PG, '--embed-url', EMBED, '--yes'], {
      envPath,
      home: dir,
      smokeDb,
      smokeEmbed,
      runInstall: runInstall as never,
      log: (m) => logs.push(m),
      error: (m) => logs.push(m),
    })

    const body = readFileSync(envPath, 'utf8')
    expect(body).toContain(`RIVETOS_PG_URL=${PG}`)
    expect(body).toContain(`RIVETOS_EMBED_URL=${EMBED}`)
    expect(body).toContain(`RIVETOS_EMBED_MODEL=${DEFAULT_EMBED_MODEL}`)
    expect(smokeDb).toHaveBeenCalledWith(PG)
    expect(smokeEmbed).toHaveBeenCalledWith(EMBED, DEFAULT_EMBED_MODEL)
    expect(runInstall).toHaveBeenCalled()
    const installDeps = runInstall.mock.calls[0]?.[1] as { overrideEnv?: boolean }
    expect(installDeps.overrideEnv).toBe(true)
    expect(checklist.db).toEqual({ ok: true, messages: 7 })
    expect(logs.join('\n')).toContain('DB ok (7 messages)')
    expect(logs.join('\n')).toContain('grok-build: installed')
    expect(logs.join('\n')).not.toContain('s3cret')
  })

  it('dry-run prints the env diff and does not write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-dry-'))
    tmpDirs.push(dir)
    const envPath = join(dir, '.env')
    const logs: string[] = []
    await runCloudConnect([PG, '--embed-url', EMBED, '--dry-run'], {
      envPath,
      home: dir,
      smokeDb: async () => ({ ok: true, messages: 0 }),
      smokeEmbed: async () => ({ ok: true, dims: 1024 }),
      runInstall: async () => undefined,
      log: (m) => logs.push(m),
    })
    expect(() => readFileSync(envPath, 'utf8')).toThrow()
    expect(logs.join('\n')).toMatch(/dry-run env/)
    expect(logs.join('\n')).toMatch(/RIVETOS_PG_URL/)
    expect(logs.join('\n')).not.toContain('s3cret')
  })

  it('does not install hooks when DB smoke fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-fail-'))
    tmpDirs.push(dir)
    const runInstall = vi.fn()
    await expect(
      runCloudConnect([PG, '--embed-url', EMBED], {
        envPath: join(dir, '.env'),
        home: dir,
        smokeDb: async () => ({ ok: false, error: 'DB unmigrated (ros_messages missing)' }),
        smokeEmbed: async () => ({ ok: true, dims: 1024 }),
        runInstall: runInstall as never,
        log: () => undefined,
        error: () => undefined,
      }),
    ).rejects.toThrow(/smoke failed/)
    expect(runInstall).not.toHaveBeenCalled()
  })

  it('writes RIVETOS_CLOUD_TOKEN when --token is passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-token-'))
    tmpDirs.push(dir)
    const envPath = join(dir, '.env')
    await runCloudConnect([PG, '--embed-url', EMBED, '--token', 'tok_live'], {
      envPath,
      home: dir,
      smokeDb: async () => ({ ok: true, messages: 0 }),
      smokeEmbed: async () => ({ ok: true, dims: 1024 }),
      runInstall: async () => undefined,
      log: () => undefined,
    })
    expect(readFileSync(envPath, 'utf8')).toContain('RIVETOS_CLOUD_TOKEN=tok_live')
  })
})

describe('runCloudExport / runCloudImport', () => {
  const prevPg = process.env.RIVETOS_PG_URL
  const prevTok = process.env.RIVETOS_CLOUD_TOKEN

  afterEach(() => {
    if (prevPg === undefined) delete process.env.RIVETOS_PG_URL
    else process.env.RIVETOS_PG_URL = prevPg
    if (prevTok === undefined) delete process.env.RIVETOS_CLOUD_TOKEN
    else process.env.RIVETOS_CLOUD_TOKEN = prevTok
  })

  it('GET /api/t/<slug>/export with the bearer token', async () => {
    process.env.RIVETOS_PG_URL = PG
    process.env.RIVETOS_CLOUD_TOKEN = 'tok_abc'
    const dir = mkdtempSync(join(tmpdir(), 'cloud-export-'))
    tmpDirs.push(dir)
    const out = join(dir, 'dump.ndjson.gz')
    const payload = Buffer.from('gzip-bytes')
    const cloudHttpsRequest = vi.fn(
      async (url: string, init: { method: string; headers: Record<string, string> }) => {
        expect(url).toBe('https://rivetos.cloud/api/t/demo/export')
        expect(init.method).toBe('GET')
        expect(init.headers.Authorization).toBe('Bearer tok_abc')
        return { statusCode: 200, stream: Readable.from([payload]) }
      },
    )
    await runCloudExport(['--out', out], {
      cloudHttpsRequest,
      envPath: join(dir, 'nope'),
      log: () => undefined,
    })
    expect(readFileSync(out)).toEqual(payload)
    expect(cloudHttpsRequest).toHaveBeenCalled()
  })

  it('POST /api/t/<slug>/import with application/gzip', async () => {
    process.env.RIVETOS_PG_URL = PG
    process.env.RIVETOS_CLOUD_TOKEN = 'tok_abc'
    const dir = mkdtempSync(join(tmpdir(), 'cloud-import-'))
    tmpDirs.push(dir)
    const file = join(dir, 'dump.ndjson.gz')
    writeFileSync(file, 'gzip-bytes')
    const logs: string[] = []
    const cloudHttpsRequest = vi.fn(
      async (
        url: string,
        init: { method: string; headers: Record<string, string>; body?: Readable },
      ) => {
        expect(url).toBe('https://rivetos.cloud/api/t/demo/import')
        expect(init.method).toBe('POST')
        expect(init.headers.Authorization).toBe('Bearer tok_abc')
        expect(init.headers['Content-Type']).toBe('application/gzip')
        expect(init.headers['Content-Length']).toBe(String(Buffer.byteLength('gzip-bytes')))
        const body = init.body
        const chunks: Buffer[] = []
        if (body) {
          for await (const chunk of body) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          }
        }
        expect(Buffer.concat(chunks).toString()).toBe('gzip-bytes')
        return { statusCode: 200, stream: Readable.from(['{"ok":true}']) }
      },
    )
    await runCloudImport([file], {
      cloudHttpsRequest,
      envPath: join(dir, 'nope'),
      log: (m) => logs.push(m),
    })
    expect(logs.join('\n')).toContain('{"ok":true}')
    expect(logs.join('\n')).toMatch(/bytes/)
  })

  it('prints server committed counts on import HTTP error', async () => {
    process.env.RIVETOS_PG_URL = PG
    process.env.RIVETOS_CLOUD_TOKEN = 'tok_abc'
    const dir = mkdtempSync(join(tmpdir(), 'cloud-import-err-'))
    tmpDirs.push(dir)
    const file = join(dir, 'dump.ndjson.gz')
    writeFileSync(file, 'gzip-bytes')
    const payload = {
      error: 'The operation was aborted',
      committed: { ros_conversations: 34, ros_messages: 2305, orphan_messages: 120 },
    }
    const cloudHttpsRequest = vi.fn(async (_url: string, init: { body?: Readable }) => {
      const body = init.body
      if (body) {
        for await (const _chunk of body) {
          // drain the upload so the file stream does not linger
        }
      }
      return { statusCode: 500, stream: Readable.from([JSON.stringify(payload)]) }
    })
    await expect(
      runCloudImport([file], {
        cloudHttpsRequest,
        envPath: join(dir, 'nope'),
        log: () => undefined,
      }),
    ).rejects.toThrow(/committed.*orphan_messages/)
  })
})

describe('formatCloudHttpError', () => {
  it('surfaces committed counts from a JSON error body', () => {
    const msg = formatCloudHttpError(
      'cloud import',
      500,
      JSON.stringify({
        error: 'The operation was aborted',
        committed: { ros_messages: 2305, orphan_messages: 120 },
      }),
    )
    expect(msg).toContain('cloud import HTTP 500')
    expect(msg).toContain('The operation was aborted')
    expect(msg).toContain('orphan_messages')
    expect(msg).toContain('2305')
  })
})
