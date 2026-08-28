/**
 * Pure validation for the in-app update request (electron-free so it unit
 * tests without an electron runtime). The renderer chose the URL; main
 * re-validates everything — loopback-pipe-only URL, semver, sha256 shape —
 * before a byte is downloaded. See updater.ts for the download/verify/launch.
 */

export interface UpdateRequest {
  /** Loopback mTLS-pipe URL of the artifact (http://127.0.0.1:<port>/api/files/download?...). */
  url: string
  /** Target version, plain semver — used only for the temp filename. */
  version: string
  /** Hex sha256 of the artifact, from the mesh manifest. */
  sha256: string
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const SHA256_RE = /^[0-9a-f]{64}$/

export function validateUpdateRequest(raw: unknown): UpdateRequest {
  const r = raw as Partial<UpdateRequest> | null
  if (!r || typeof r !== 'object') throw new Error('installUpdate: request must be an object')
  if (typeof r.url !== 'string' || r.url.length > 2048)
    throw new Error('installUpdate: url must be a string')
  let u: URL
  try {
    u = new URL(r.url)
  } catch {
    throw new Error('installUpdate: url is not a URL')
  }
  // Only the shell's own loopback pipes: plain http anywhere else would be an
  // unauthenticated, unencrypted fetch the shell refuses to make.
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1')
    throw new Error('installUpdate: url must target a loopback mTLS pipe')
  if (typeof r.version !== 'string' || !VERSION_RE.test(r.version))
    throw new Error('installUpdate: version must be semver')
  if (typeof r.sha256 !== 'string' || !SHA256_RE.test(r.sha256))
    throw new Error('installUpdate: sha256 must be a hex digest')
  return { url: r.url, version: r.version, sha256: r.sha256 }
}
