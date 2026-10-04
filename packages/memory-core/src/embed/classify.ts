/**
 * Classify content that should never be sent to the embedding API.
 *
 * Returns a short reason string if the content is unembeddable, or null
 * if it should be embedded normally.
 *
 * Media payloads (base64 PNG dumps, "[media attached: ...]" markers) produce
 * no semantically useful embedding and frequently cause the chunker to return
 * all-null vectors, burning retry budget forever. Pre-filter them so they
 * exit the queue cleanly.
 */

export function classifyUnembeddable(content: string | null | undefined): string | null {
  if (!content || typeof content !== 'string') return null

  const trimmed = content.trimStart()

  if (/^\[media attached:/i.test(trimmed)) return 'media-marker'
  if (/^MEDIA:/i.test(trimmed)) return 'media-prefix'

  // Require a substantial base64 payload after the marker — otherwise a bare
  // `data:image/png;base64,` mentioned in quoted code/discussion false-positives.
  if (/data:image\/[a-z]+;base64,[A-Za-z0-9+/]{200,}={0,2}/i.test(content)) return 'base64-data-url'
  if (/iVBORw0KGgo[A-Za-z0-9+/=]{200,}/.test(content)) return 'base64-png'
  if (/\/9j\/[A-Za-z0-9+/=]{500,}/.test(content)) return 'base64-jpeg'

  const longBase64Run = /[A-Za-z0-9+/]{1500,}={0,2}/
  if (longBase64Run.test(content)) {
    const sample = content.slice(0, 4000)
    const b64Chars = (sample.match(/[A-Za-z0-9+/=]/g) ?? []).length
    if (b64Chars / sample.length > 0.95) return 'base64-blob'
  }

  return null
}
