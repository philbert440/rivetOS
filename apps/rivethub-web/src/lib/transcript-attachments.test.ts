import { describe, expect, it } from 'vitest'
import { attachmentView } from './transcript-attachments.js'

const url = (id: string): string => `https://node/api/uploads/${id}`

describe('attachmentView', () => {
  const shot = { mediaType: 'image/png', name: 'shot.png', uploadId: '0a' }

  it('shows a held image as a thumbnail from its upload', () => {
    expect(attachmentView(shot, url, false)).toEqual({
      kind: 'image',
      src: 'https://node/api/uploads/0a',
      label: 'shot.png',
    })
  })

  it('keeps the name once the upload has expired', () => {
    expect(attachmentView(shot, url, true)).toEqual({
      kind: 'file',
      label: 'shot.png',
      image: true,
    })
  })

  it('shows other files as a named chip', () => {
    expect(
      attachmentView({ mediaType: 'text/markdown', name: 'notes.md', uploadId: '0b' }, url, false),
    ).toEqual({ kind: 'file', label: 'notes.md', image: false })
  })

  it('falls back to the media type for an image the node did not send', () => {
    expect(attachmentView({ mediaType: 'image/png' }, url, false)).toEqual({
      kind: 'file',
      label: 'image/png',
      image: true,
    })
  })
})
