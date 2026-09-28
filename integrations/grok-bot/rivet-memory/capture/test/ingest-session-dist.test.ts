import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CAPTURE = join(HERE, '..')
const REPO = join(CAPTURE, '../../../..')
const BIN = join(CAPTURE, '..', 'bin', 'ingest-session.mjs')
const MEMORY = join(REPO, 'plugins/memory/postgres')

function buildPkg(pkgDir: string) {
  execFileSync('npm', ['run', 'build'], { cwd: pkgDir, encoding: 'utf8', stdio: 'pipe' })
}

describe('ingest-session against built dist', () => {
  it('builds capture + memory-postgres, then imports ingestGrokbotSession from dist', () => {
    buildPkg(CAPTURE)
    buildPkg(MEMORY)
    expect(existsSync(join(CAPTURE, 'dist/ingest-rows.js'))).toBe(true)
    expect(existsSync(join(MEMORY, 'dist/index.js'))).toBe(true)

    const dir = mkdtempSync(join(tmpdir(), 'gb-ingest-dist-'))
    const fixture = join(dir, 'one.jsonl')
    writeFileSync(
      fixture,
      `${JSON.stringify({
        role: 'user',
        content: 'ci guard',
        ordinal: 0,
        event_id: 'evt-ci-guard',
        createdAt: '2026-09-01T12:00:00.000Z',
      })}\n`,
    )

    let err = ''
    let code = 0
    try {
      execFileSync(process.execPath, [BIN, '--session-id=grokbot-ci-guard-v4', '--agent=grokbot-alpha', fixture], {
        encoding: 'utf8',
        env: {
          ...process.env,
          RIVETOS_ROOT: REPO,
          RIVETOS_PG_URL: 'postgres://rivet:rivet@127.0.0.1:1/rivetos',
          RIVETOS_ENV_FILE: join(dir, 'missing.env'),
          RIVETOS_DATAHUB_URL: '',
        },
      })
    } catch (caught) {
      const fail = caught as { status?: number; stdout?: string; stderr?: string; message?: string }
      code = fail.status ?? 1
      err = `${fail.stdout ?? ''}\n${fail.stderr ?? ''}\n${fail.message ?? ''}`
    }

    expect(code).not.toBe(0)
    expect(err).not.toMatch(/is not a function/)
    expect(err).toMatch(/ECONNREFUSED|connect|connection|timeout|ENOTFOUND|EHOSTUNREACH/i)
  }, 120_000)
})
