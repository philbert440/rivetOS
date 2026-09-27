import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDen } from './doctor.js'

const TLS_CONFIG = 'mesh:\n  node_name: tnode\nden:\n  enabled: true\n  port: 5174\n'
const PLAIN_CONFIG = 'den:\n  enabled: true\n  port: 5174\n'
const issued = (name: string) => `/rivet-shared/rivet-ca/issued/${name}`
const tlsFiles = (p: string) => p === issued('tnode.crt') || p === issued('tnode.key')

describe('checkDen', () => {
  let home: string
  let spoolDir: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'den-doctor-home-'))
    spoolDir = join(home, '.rivetos', 'capture-spool')
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const up = async (url: string): Promise<number> => (url.startsWith('https://') ? 200 : Promise.reject(new Error('ECONNRESET')))

  function probe(overrides: Partial<Parameters<typeof checkDen>[1]> = {}) {
    return { home, env: {}, dotEnv: null, exists: tlsFiles, fetchHealth: up, spoolDir, now: () => 0, ...overrides }
  }

  const byName = (results: Awaited<ReturnType<typeof checkDen>>, name: string) =>
    results.find((r) => r.name === name)!

  it('derives https from the mesh issue-node files and passes a clean node', async () => {
    const results = await checkDen(TLS_CONFIG, probe())
    expect(byName(results, 'url').status).toBe('pass')
    expect(byName(results, 'url').message).toContain('https://127.0.0.1:5174')
    expect(byName(results, 'healthz').status).toBe('pass')
    expect(byName(results, 'capture-spool').status).toBe('pass')
  })

  it('fails a plain-http loopback RIVET_DEN_URL when the den serves https, and names the scheme mismatch on dial', async () => {
    // fetchHealth here answers only https; the row must show the guarded dial succeeded
    // while the env row still fails — the env line is wrong even though guards paper over it.
    const results = await checkDen(TLS_CONFIG, probe({ dotEnv: 'RIVET_DEN_URL=http://127.0.0.1:5174\n' }))
    const url = byName(results, 'url')
    expect(url.status).toBe('fail')
    expect(url.message).toMatch(/serves https only/)
    expect(url.detail).toContain('RIVET_DEN_URL=https://127.0.0.1:5174')
    expect(byName(results, 'healthz').status).toBe('pass')
  })

  it('reports a scheme mismatch when the dialed scheme is down and the other answers', async () => {
    // No TLS material known locally (explicit http is trusted), but the den actually serves https.
    const results = await checkDen(PLAIN_CONFIG, probe({ exists: () => false, dotEnv: 'RIVET_DEN_URL=http://127.0.0.1:5174\n' }))
    const health = byName(results, 'healthz')
    expect(health.status).toBe('fail')
    expect(health.message).toMatch(/unreachable but https:\/\/127\.0\.0\.1:5174 answers — scheme mismatch/)
  })

  it('fails a comma list and dials its first origin', async () => {
    const seen: string[] = []
    const fetchHealth = async (url: string): Promise<number> => {
      seen.push(url)
      return 200
    }
    const results = await checkDen(TLS_CONFIG, probe({ fetchHealth, dotEnv: 'RIVET_DEN_URL="https://127.0.0.1:5174, http://192.0.2.15:5174"\n' }))
    expect(byName(results, 'url').status).toBe('fail')
    expect(byName(results, 'url').message).toMatch(/several origins/)
    expect(seen).toEqual(['https://127.0.0.1:5174'])
  })

  it('warns when the env line merely duplicates the derived URL', async () => {
    const results = await checkDen(TLS_CONFIG, probe({ dotEnv: 'RIVET_DEN_URL=https://127.0.0.1:5174\n' }))
    expect(byName(results, 'url').status).toBe('warn')
    expect(byName(results, 'url').message).toMatch(/redundant/)
  })

  it('warns on an override that differs without a scheme conflict', async () => {
    const results = await checkDen(TLS_CONFIG, probe({ dotEnv: 'export RIVET_DEN_URL=https://den.example:9999\n' }))
    expect(byName(results, 'url').status).toBe('warn')
    expect(byName(results, 'url').message).toMatch(/differs from this den's https:\/\/127\.0\.0\.1:5174/)
  })

  it('reports both schemes down as unreachable with the service hint', async () => {
    const down = (): Promise<number> => Promise.reject(new Error('ECONNREFUSED'))
    const results = await checkDen(TLS_CONFIG, probe({ fetchHealth: down }))
    const health = byName(results, 'healthz')
    expect(health.status).toBe('fail')
    expect(health.message).toMatch(/unreachable \(ECONNREFUSED\)/)
    expect(health.detail).toMatch(/rivetos\.service/)
  })

  it('skips the URL and dial rows when den is disabled but still reports the spool', async () => {
    const results = await checkDen('den:\n  enabled: false\n', probe())
    expect(results.map((r) => r.name)).toEqual(['capture-spool'])
  })

  it('warns on a fresh spool backlog and fails once the oldest batch is over an hour old', async () => {
    mkdirSync(spoolDir, { recursive: true })
    const nowMs = 10 * 60 * 60 * 1000
    writeFileSync(join(spoolDir, `${String(nowMs - 5 * 60 * 1000)}-a.json`), '{}')
    writeFileSync(join(spoolDir, `${String(nowMs - 2 * 60 * 1000)}-b.json`), '{}')
    writeFileSync(join(spoolDir, 'ignored.tmp'), '')
    let results = await checkDen(TLS_CONFIG, probe({ now: () => nowMs }))
    let spool = byName(results, 'capture-spool')
    expect(spool.status).toBe('warn')
    expect(spool.message).toBe('Capture spool: 2 batch(es) waiting (oldest 5m)')

    writeFileSync(join(spoolDir, `${String(nowMs - 4 * 60 * 60 * 1000)}-c.json`), '{}')
    mkdirSync(join(spoolDir, 'dead'))
    writeFileSync(join(spoolDir, 'dead', `${String(nowMs - 9 * 60 * 60 * 1000)}-d.json`), '{}')
    results = await checkDen(TLS_CONFIG, probe({ now: () => nowMs }))
    spool = byName(results, 'capture-spool')
    expect(spool.status).toBe('fail')
    expect(spool.message).toBe('Capture spool: 3 batch(es) waiting (oldest 4h), 1 dead-lettered')
  })

  it('warns on dead-lettered batches alone', async () => {
    mkdirSync(join(spoolDir, 'dead'), { recursive: true })
    writeFileSync(join(spoolDir, 'dead', '1-d.json'), '{}')
    const results = await checkDen(TLS_CONFIG, probe())
    const spool = byName(results, 'capture-spool')
    expect(spool.status).toBe('warn')
    expect(spool.message).toMatch(/1 dead-lettered batch\(es\)/)
  })
})
