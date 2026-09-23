import { afterEach, beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeCliProvider, PROBE_TIMEOUT_MS } from './index.js'

let dir: string

function stub(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-cli-probe-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ClaudeCliProvider.isAvailable', () => {
  it('is true when --version exits 0', async () => {
    const p = new ClaudeCliProvider({ binary: stub('ok', 'echo "2.1.0 (Claude Code)"') })
    expect(await p.isAvailable()).toBe(true)
  })

  it('is false when --version exits non-zero', async () => {
    const p = new ClaudeCliProvider({ binary: stub('fail', 'echo boom >&2; exit 1') })
    expect(await p.isAvailable()).toBe(false)
  })

  it('is false for a missing binary (cached)', async () => {
    const p = new ClaudeCliProvider({ binary: '/nonexistent/claude' })
    expect(await p.isAvailable()).toBe(false)
    expect(await p.isAvailable()).toBe(false)
  })

  it('times out a binary that never exits instead of hanging', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // A backgrounded grandchild holds the pipes open, like a wrapper script's
    // helper process would: settling must not wait for `close`.
    const p = new ClaudeCliProvider({ binary: stub('hang', 'sleep 60 & exec sleep 60') })
    const result = p.isAvailable()
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS)
    expect(await result).toBe(false)
  })

  it('shares one probe between concurrent callers', async () => {
    const count = join(dir, 'count')
    writeFileSync(count, '')
    const p = new ClaudeCliProvider({ binary: stub('counted', `echo x >> "${count}"`) })
    const results = await Promise.all([p.isAvailable(), p.isAvailable(), p.isAvailable()])
    expect(results).toEqual([true, true, true])
    expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})
