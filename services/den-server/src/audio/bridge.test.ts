import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MicBridge } from './bridge.js'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function makeBridge(): MicBridge {
  const dir = mkdtempSync(join(tmpdir(), 'micbridge-test-'))
  dirs.push(dir)
  return new MicBridge({
    dir,
    deviceName: 'RivetHub Mic',
    sampleRate: 16000,
    channels: 1,
    format: 's16le',
  })
}

describe('MicBridge', () => {
  it('ensureRuntime creates FIFO under dir', () => {
    const b = makeBridge()
    const rt = b.ensureRuntime()
    expect(rt.ok).toBe(true)
    expect(existsSync(b.fifoPath)).toBe(true)
    expect(b.status().runtimeReady).toBe(true)
    expect(b.status().backend).toBe('fifo-shim')
  })

  it('exclusive acquire: second publisher is busy', () => {
    const b = makeBridge()
    expect(b.acquire('a').ok).toBe(true)
    const second = b.acquire('b')
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('busy')
    b.release('a')
    expect(b.acquire('b').ok).toBe(true)
    b.release('b')
  })

  it('same publisher re-acquire is ok', () => {
    const b = makeBridge()
    expect(b.acquire('a').ok).toBe(true)
    expect(b.acquire('a').ok).toBe(true)
    b.release('a')
  })

  it('writePcm only accepts active publisher', () => {
    const b = makeBridge()
    b.acquire('a')
    const pcm = Buffer.alloc(640, 1)
    // May return false if no reader — still must not throw
    expect(() => b.writePcm('a', pcm)).not.toThrow()
    expect(b.writePcm('other', pcm)).toBe(false)
    b.release('a')
  })

  it('audit log records arm/disarm', () => {
    const b = makeBridge()
    b.acquire('pub1', { remote: '10.0.0.1' })
    b.release('pub1', { remote: '10.0.0.1' })
    const log = readFileSync(b.auditPath, 'utf8')
    expect(log).toContain('"action":"arm"')
    expect(log).toContain('"action":"disarm"')
    expect(log).toContain('pub1')
  })

  it('status reports unarmed by default', () => {
    const b = makeBridge()
    b.ensureRuntime()
    const st = b.status()
    expect(st.armed).toBe(false)
    expect(st.publisherId).toBeNull()
    expect(st.device).toBe('RivetHub Mic')
    expect(st.sampleRate).toBe(16000)
  })
})
