import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CrashLog, formatCrashLine, MAX_LOG_BYTES } from './crash-log.js'

const dirs: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-log-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('formatCrashLine', () => {
  it('collapses whitespace and caps the detail', () => {
    const line = formatCrashLine('uncaughtException', `a\n  b\t c ${'x'.repeat(10_000)}`)
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T.*\[uncaughtException\] a b c x+\n$/)
    expect(line.length).toBeLessThan(4200)
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

  it('never throws when the path is unwritable', () => {
    const locked = tmp()
    fs.chmodSync(locked, 0o000)
    const log = new CrashLog(() => path.join(locked, 'sub', 'main.log'))
    expect(() => {
      log.append('kind', 'detail')
    }).not.toThrow()
    fs.chmodSync(locked, 0o700)
  })
})
