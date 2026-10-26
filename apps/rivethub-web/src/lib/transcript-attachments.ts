import type { TranscriptAttachment } from '@rivetos/types'

export type AttachmentView =
  { kind: 'image'; src: string; label: string } | { kind: 'file'; label: string; image: boolean }

/**
 * How a sent file shows in its user bubble. An image the node still holds
 * renders as a thumbnail from its upload; once the upload has expired (the
 * <img> fails, `failed`) or for any other file, a chip with the name the
 * node recorded. A turn the node did not send itself has no name, so the
 * chip falls back to the media type.
 */
export function attachmentView(
  attachment: TranscriptAttachment,
  uploadUrl: (id: string) => string,
  failed: boolean,
): AttachmentView {
  const label = attachment.name || attachment.mediaType
  const image = attachment.mediaType.startsWith('image/')
  if (image && attachment.uploadId && !failed) {
    return { kind: 'image', src: uploadUrl(attachment.uploadId), label }
  }
  return { kind: 'file', label, image }
}
