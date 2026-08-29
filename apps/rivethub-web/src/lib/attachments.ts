/**
 * Composer attachment state — pure helpers so the chip lifecycle is
 * unit-testable. Files are staged through the gateway upload endpoint
 * (6h TTL, node-resolvable uri); the message references them as
 * `[attached: <uri>]` lines, which every harness reads as a path in the
 * prompt text — the one channel that works on BOTH the control-plane turn
 * path and the PTY inject path. (UserTurn.attachments exists for
 * control-plane drivers; moving bound sessions onto it needs the outbound
 * queue to carry attachments — noted follow-up, not this change.)
 */

export interface PendingAttachment {
  id: string
  name: string
  size: number
  mime: string
  status: 'uploading' | 'ready' | 'failed'
  uri?: string
}

export function markStaged(
  atts: PendingAttachment[],
  id: string,
  uri: string,
): PendingAttachment[] {
  return atts.map((a) => (a.id === id ? { ...a, status: 'ready' as const, uri } : a))
}

export function markFailed(atts: PendingAttachment[], id: string): PendingAttachment[] {
  return atts.map((a) => (a.id === id ? { ...a, status: 'failed' as const } : a))
}

export function withoutAttachment(atts: PendingAttachment[], id: string): PendingAttachment[] {
  return atts.filter((a) => a.id !== id)
}

export function anyUploading(atts: PendingAttachment[]): boolean {
  return atts.some((a) => a.status === 'uploading')
}

/** A uri interpolated into `[attached: …]` must not be able to leave the
 *  bracket line: control chars split it and `]` closes it early, smuggling
 *  arbitrary prompt text under the app's voice (the server echoes the staged
 *  file NAME into the uri, so it is not fully server-controlled). Percent-
 *  encode the closers, strip the controls. */
function sanitizeUri(uri: string): string {
  // eslint-disable-next-line no-control-regex
  return uri.replace(/[\u0000-\u001f\u007f]/g, '').replaceAll(']', '%5D')
}

/** Message text with `[attached: …]` reference lines for the staged files.
 *  Failed/uploading entries never make it into the message. */
export function withAttachmentText(text: string, atts: PendingAttachment[]): string {
  const lines = atts
    .filter((a) => a.status === 'ready' && a.uri)
    .map((a) => `[attached: ${sanitizeUri(a.uri as string)}]`)
  if (lines.length === 0) return text
  return text ? `${text}\n${lines.join('\n')}` : lines.join('\n')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}
