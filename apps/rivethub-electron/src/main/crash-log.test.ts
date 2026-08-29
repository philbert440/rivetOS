import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CrashLog, formatCrashLine, MAX_LOG_BYTES } from './crash-log.js'

// node:fs is an ESM builtin namespace — spyOn cannot redefine its exports;
// spy-mode automock wraps the real implementations so per-test
// mockImplementation works and restoreAllMocks returns to the real fs.
vi.mock('node:fs', { spy: true })

const dirs: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-log-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('formatCrashLine', () => {
  it('collapses whitespace and caps the detail', () => {
    const line = formatCrashLine('uncaughtException', `a\n  b\t c ${'x'.repeat(10_000)}`)
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T.*\[uncaughtException\] a b c x+\n$/)
    expect(line.length).toBeLessThan(4200)
  })

  it('coerces non-string detail instead of throwing', () => {
    expect(formatCrashLine('k', undefined)).toContain('[k]')
    expect(formatCrashLine('k', null)).toContain('[k]')
    expect(formatCrashLine('k', { toString: undefined })).toContain('[k]')
    expect(
      formatCrashLine('k', {
        toString() {
          throw new Error('hostile')
        },
      }),
    ).toContain('<unprintable detail>')
  })
})

describe('CrashLog.append', () => {
  it('creates the directory and appends lines', () => {
    const file = path.join(tmp(), 'logs', 'main.log')
    const log = new CrashLog(() => file)
    log.append('one', 'first')
    log.append('two', 'second')
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('[one] first')
    expect(text).toContain('[two] second')
  })

  it('rotates to .old past the size cap', () => {
    const file = path.join(tmp(), 'main.log')
    fs.writeFileSync(file, 'x'.repeat(MAX_LOG_BYTES + 1))
    new CrashLog(() => file).append('rotated', 'fresh line')
    expect(fs.statSync(`${file}.old`).size).toBe(MAX_LOG_BYTES + 1)
    expect(fs.readFileSync(file, 'utf8')).toContain('[rotated] fresh line')
  })

  it('truncates as a last resort when rotation rename fails', () => {
    const file = path.join(tmp(), 'main.log')
    fs.writeFileSync(file, 'x'.repeat(MAX_LOG_BYTES + 1))
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    new CrashLog(() => file).append('trunc', 'fresh line')
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('[trunc] fresh line')
    expect(fs.statSync(file).size).toBeLessThan(MAX_LOG_BYTES)
  })

  it('never throws when the filesystem does', () => {
    const file = path.join(tmp(), 'main.log')
    const log = new CrashLog(() => file)
    vi.mocked(fs.mkdirSync).mockImplementation(() => {
      throw new Error('mkdir denied')
    })
    expect(() => {
      log.append('kind', 'detail')
    }).not.toThrow()
    vi.restoreAllMocks()
    vi.mocked(fs.appendFileSync).mockImplementation(() => {
      throw new Error('append denied')
    })
    expect(() => {
      log.append('kind', 'detail')
    }).not.toThrow()
  })

  it('never throws when even the path getter does', () => {
    const log = new CrashLog(() => {
      throw new Error('no userData yet')
    })
    expect(() => {
      log.append('kind', 'detail')
    }).not.toThrow()
  })
})
