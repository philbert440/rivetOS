import { describe, it, expect, vi } from 'vitest'
import {
  DOWNLOAD_BLOB_MAX,
  baseName,
  downloadTooLargeError,
  joinRel,
  parentRel,
  parseContentLength,
  previewKind,
  readBlobBounded,
  type BoundedBodyResponse,
} from './files-ui.js'

function fakeStreamRes(opts: {
  contentLength?: string
  chunks: Array<Uint8Array | { byteLength: number }>
  cancel?: () => Promise<void>
}): { res: BoundedBodyResponse; cancel: () => Promise<void>; blob: () => Promise<Blob> } {
  const cancel = vi.fn(opts.cancel ?? (async () => undefined))
  const blob = vi.fn(async () => new Blob([]))
  const queue = [...opts.chunks]
  const body = {
    getReader: () => ({
      read: async () =>
        queue.length > 0 ? { done: false, value: queue.shift() } : { done: true, value: undefined },
      cancel,
    }),
  } as unknown as ReadableStream<Uint8Array>
  return {
    res: {
      headers: { get: (n: string) => (n === 'content-length' ? (opts.contentLength ?? null) : null) },
      body,
      blob,
    },
    cancel,
    blob,
  }
}

describe('downloadTooLargeError', () => {
  it('accepts unknown and in-bound sizes', () => {
    expect(downloadTooLargeError(undefined)).toBeUndefined()
    expect(downloadTooLargeError(0)).toBeUndefined()
    expect(downloadTooLargeError(DOWNLOAD_BLOB_MAX)).toBeUndefined()
  })

  it('refuses past the blob bound with the limit in the message', () => {
    const err = downloadTooLargeError(DOWNLOAD_BLOB_MAX + 1)
    expect(err).toContain('64 MB')
  })
})

describe('parseContentLength', () => {
  it('treats absent/empty/NaN/negative as UNKNOWN, never 0', () => {
    expect(parseContentLength(null)).toBeNull()
    expect(parseContentLength('')).toBeNull()
    expect(parseContentLength('  ')).toBeNull()
    expect(parseContentLength('banana')).toBeNull()
    expect(parseContentLength('-5')).toBeNull()
  })

  it('parses real lengths', () => {
    expect(parseContentLength('0')).toBe(0)
    expect(parseContentLength('12345')).toBe(12345)
  })
})

describe('readBlobBounded', () => {
  it('aborts a streamed body the moment the byte count passes the cap', async () => {
    // Chunked/lying response: no content-length, chunks past the limit.
    const half = { byteLength: Math.ceil(DOWNLOAD_BLOB_MAX / 2) + 1 }
    const { res, cancel } = fakeStreamRes({ chunks: [half, half, half] })
    await expect(readBlobBounded(res)).rejects.toThrow(/64 MB/)
    expect(cancel).toHaveBeenCalled()
  })

  it('treats a missing content-length as unknown but still capped', async () => {
    const { res, blob } = fakeStreamRes({
      chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
    })
    const out = await readBlobBounded(res)
    expect(out.size).toBe(5)
    expect(blob).not.toHaveBeenCalled() // streamed path, not res.blob()
  })

  it('refuses on a declared oversize header without reading the body', async () => {
    const { res, cancel } = fakeStreamRes({
      contentLength: String(DOWNLOAD_BLOB_MAX + 1),
      chunks: [new Uint8Array([1])],
    })
    await expect(readBlobBounded(res)).rejects.toThrow(/64 MB/)
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('joinRel / parentRel / baseName', () => {
  it('joins and splits paths', () => {
    expect(joinRel('', 'a.txt')).toBe('a.txt')
    expect(joinRel('plans', 'a.txt')).toBe('plans/a.txt')
    expect(parentRel('plans/a.txt')).toBe('plans')
    expect(parentRel('a.txt')).toBe('')
    expect(baseName('plans/a.txt')).toBe('a.txt')
  })
})

describe('previewKind', () => {
  it('classifies text and images under size caps', () => {
    expect(previewKind('notes.md', 100)).toBe('text')
    expect(previewKind('pic.png', 1000)).toBe('image')
    expect(previewKind('big.md', 2 * 1024 * 1024)).toBe('none')
    expect(previewKind('bin.dat', 10)).toBe('none')
  })
})
