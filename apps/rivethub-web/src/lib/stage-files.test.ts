import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  expiresInLabel,
  filesFrom,
  pathsToPasteText,
  shellQuotePath,
  stageFiles,
  type StageGateway,
} from './stage-files.js'

function file(name: string, body = 'x', type = 'text/plain'): File {
  return new File([body], name, { type })
}

describe('shellQuotePath', () => {
  it('leaves a plain path unchanged', () => {
    expect(shellQuotePath('/home/rivet/.rivetos/den/uploads/abc.png')).toBe(
      '/home/rivet/.rivetos/den/uploads/abc.png',
    )
    expect(shellQuotePath('/tmp/foo.png')).toBe('/tmp/foo.png')
    expect(shellQuotePath('/tmp/foo_bar.@:+-/=x')).toBe('/tmp/foo_bar.@:+-/=x')
  })

  it('single-quotes paths with spaces, quotes, and $', () => {
    expect(shellQuotePath('/tmp/foo bar.png')).toBe("'/tmp/foo bar.png'")
    expect(shellQuotePath("/tmp/foo'bar.png")).toBe("'/tmp/foo'\\''bar.png'")
    expect(shellQuotePath('/tmp/foo$bar.png')).toBe("'/tmp/foo$bar.png'")
  })

  it('quotes the empty path as empty single quotes', () => {
    expect(shellQuotePath('')).toBe("''")
  })

  it('strips control characters before quoting', () => {
    const p = '/tmp/x\x1b[201~\ny'
    const quoted = shellQuotePath(p)
    const joined = pathsToPasteText([p])
    expect(quoted).not.toMatch(/[\x00-\x1f\x7f]/)
    expect(joined).not.toMatch(/[\x00-\x1f\x7f]/)
    expect(quoted).toBe("'/tmp/x[201~y'")
  })
})

describe('pathsToPasteText', () => {
  it('joins quoted paths with spaces and no trailing newline', () => {
    expect(pathsToPasteText(['/a', '/b c'])).toBe("/a '/b c'")
    expect(pathsToPasteText(['/a'])).toBe('/a')
    expect(pathsToPasteText(['/a']).endsWith('\n')).toBe(false)
    expect(pathsToPasteText([])).toBe('')
  })
})

describe('filesFrom', () => {
  it('reads File[] / FileList-shaped files', () => {
    const a = file('a.txt')
    const b = file('b.txt')
    expect(filesFrom({ files: [a, b] })).toEqual([a, b])
  })

  it('falls back to items with kind===file', () => {
    const fromItem = file('from-item.txt')
    const items = [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => fromItem },
      { kind: 'file', getAsFile: () => null },
    ] as unknown as DataTransferItemList
    expect(filesFrom({ files: null, items })).toEqual([fromItem])
  })

  it('prefers non-empty files over items', () => {
    const a = file('a.txt')
    const fromItem = file('from-item.txt')
    const items = [{ kind: 'file', getAsFile: () => fromItem }] as unknown as DataTransferItemList
    expect(filesFrom({ files: [a], items })).toEqual([a])
  })

  it('returns [] for null / empty', () => {
    expect(filesFrom(null)).toEqual([])
    expect(filesFrom(undefined)).toEqual([])
    expect(filesFrom({ files: [], items: null })).toEqual([])
  })

  it('skips the items fallback when text/plain is non-empty', () => {
    const fromItem = file('chart.png', 'x', 'image/png')
    const items = [{ kind: 'file', getAsFile: () => fromItem }] as unknown as DataTransferItemList
    expect(
      filesFrom({
        files: [],
        items,
        getText: (t) => (t === 'text/plain' ? 'A1\tB1' : ''),
      }),
    ).toEqual([])
    expect(
      filesFrom({
        files: null,
        items,
        getData: (t) => (t === 'text/plain' ? 'copied cells' : ''),
      }),
    ).toEqual([])
  })

  it('falls back to items when text/plain is absent or empty', () => {
    const fromItem = file('from-item.txt')
    const items = [{ kind: 'file', getAsFile: () => fromItem }] as unknown as DataTransferItemList
    expect(filesFrom({ files: null, items, getText: () => '' })).toEqual([fromItem])
    expect(filesFrom({ files: [], items })).toEqual([fromItem])
  })
})

describe('stageFiles', () => {
  it('calls the gateway sequentially with name/mime fallbacks and collects failures', async () => {
    const order: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const gw: StageGateway = {
      stageUpload: vi.fn(async (name, _body, opts) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        order.push(name)
        await Promise.resolve()
        inFlight--
        if (name === 'bad.txt') throw new Error('nope')
        return {
          uri: `/up/${name}`,
          name,
          mime: opts?.mime,
          size: 3,
        }
      }),
    }

    const namelessImage = new File(['png'], '', { type: 'image/png' })
    const namelessBin = new File(['bin'], '', { type: '' })
    const { staged, failed } = await stageFiles(gw, [
      file('a.txt'),
      file('bad.txt'),
      namelessImage,
      namelessBin,
    ])

    expect(order).toEqual(['a.txt', 'bad.txt', 'pasted-image.png', 'pasted-file'])
    expect(maxInFlight).toBe(1)
    expect(failed).toEqual(['bad.txt'])
    expect(staged.map((s) => s.uri)).toEqual([
      '/up/a.txt',
      '/up/pasted-image.png',
      '/up/pasted-file',
    ])
    expect(staged[1]).toMatchObject({
      name: 'pasted-image.png',
      mime: 'image/png',
    })
    expect(staged[2]).toMatchObject({
      name: 'pasted-file',
      mime: 'application/octet-stream',
    })
    expect(gw.stageUpload).toHaveBeenCalledTimes(4)
    expect(gw.stageUpload).toHaveBeenNthCalledWith(3, 'pasted-image.png', namelessImage, {
      mime: 'image/png',
    })
    expect(gw.stageUpload).toHaveBeenNthCalledWith(4, 'pasted-file', namelessBin, {
      mime: 'application/octet-stream',
    })
  })

  it('normalizes an ISO-string expiresAt to epoch ms', async () => {
    const iso = '2026-09-03T18:00:00.000Z'
    const gw: StageGateway = {
      stageUpload: async () => ({ uri: '/up/a.png', expiresAt: iso }),
    }
    const { staged } = await stageFiles(gw, [file('a.png')])
    expect(staged[0]?.expiresAt).toBe(Date.parse(iso))
  })

  it('passes a numeric expiresAt through as-is', async () => {
    const ms = 1_700_000_000_000
    const gw: StageGateway = {
      stageUpload: async () => ({ uri: '/up/a.png', expiresAt: ms }),
    }
    const { staged } = await stageFiles(gw, [file('a.png')])
    expect(staged[0]?.expiresAt).toBe(ms)
  })

  it('drops a bogus expiresAt', async () => {
    const gw: StageGateway = {
      stageUpload: async () => ({ uri: '/up/a.png', expiresAt: 'not-a-date' }),
    }
    const { staged } = await stageFiles(gw, [file('a.png')])
    expect(staged[0]?.expiresAt).toBeUndefined()
  })
})

describe('expiresInLabel', () => {
  it('defaults to 6h when undefined or NaN', () => {
    expect(expiresInLabel(undefined)).toBe('6h')
    expect(expiresInLabel(Number.NaN)).toBe('6h')
  })

  it('rounds a 6h-ahead timestamp to 6h', () => {
    const now = 1_000_000
    expect(expiresInLabel(now + 6 * 3600000, now)).toBe('6h')
  })

  it('clamps 20 minutes ahead to 1h', () => {
    const now = 1_000_000
    expect(expiresInLabel(now + 20 * 60 * 1000, now)).toBe('1h')
  })

  it('clamps a past timestamp to 1h', () => {
    const now = 1_000_000
    expect(expiresInLabel(now - 3600000, now)).toBe('1h')
  })
})

describe('xterm-attach source guard', () => {
  it('registers paste/drop/dragover and calls pathsToPasteText', () => {
    const src = readFileSync(new URL('../components/xterm-attach.tsx', import.meta.url), 'utf8')
    expect(src).toContain("'paste'")
    expect(src).toContain("'drop'")
    expect(src).toContain("'dragover'")
    expect(src).toContain('pathsToPasteText')
  })
})
