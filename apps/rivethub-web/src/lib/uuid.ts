/** UUIDv4 that works in insecure contexts (plain-HTTP LAN heads), where
 *  crypto.randomUUID is undefined. Callers that feed harness session ids
 *  (claude --session-id) need a real v4, so the fallback builds one from
 *  getRandomValues rather than a Math.random string. */
export function uuidv4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
