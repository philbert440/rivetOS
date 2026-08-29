import { describe, expect, it } from 'vitest'
import {
  anyUploading,
  formatBytes,
  markFailed,
  markStaged,
  withAttachmentText,
  withoutAttachment,
  type PendingAttachment,
} from './attachments.js'

const up = (id: string): PendingAttachment => ({
  id,
  name: `${id}.png`,
  size: 10,
  mime: 'image/png',
  status: 'uploading',
})

describe('attachment lifecycle', () => {
  it('stages, fails and removes by id without touching siblings', () => {
    let atts = [up('a'), up('b')]
    atts = markStaged(atts, 'a', '/tmp/uploads/a.png')
    expect(atts[0]).toMatchObject({ status: 'ready', uri: '/tmp/uploads/a.png' })
    expect(atts[1].status).toBe('uploading')
    atts = markFailed(atts, 'b')
    expect(atts[1].status).toBe('failed')
    expect(anyUploading(atts)).toBe(false)
    expect(withoutAttachment(atts, 'b').map((a) => a.id)).toEqual(['a'])
  })

  it('anyUploading is true while a stage is in flight', () => {
    expect(anyUploading([up('a')])).toBe(true)
  })
})

describe('withAttachmentText', () => {
  it('appends reference lines for READY files only', () => {
    const atts = [
      { ...up('a'), status: 'ready' as const, uri: '/up/a.png' },
      up('b'), // uploading — excluded
      { ...up('c'), status: 'failed' as const },
    ]
    expect(withAttachmentText('look at this', atts)).toBe('look at this\n[attached: /up/a.png]')
  })

  it('stands alone when the message is empty', () => {
    const atts = [{ ...up('a'), status: 'ready' as const, uri: '/up/a.png' }]
    expect(withAttachmentText('', atts)).toBe('[attached: /up/a.png]')
  })

  it('returns the text untouched with no ready files', () => {
    expect(withAttachmentText('hi', [up('a')])).toBe('hi')
  })
})

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(500)).toBe('500B')
    expect(formatBytes(2048)).toBe('2KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0MB')
  })
})
