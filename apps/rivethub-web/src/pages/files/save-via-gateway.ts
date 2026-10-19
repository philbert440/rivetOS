import { downloadTooLargeError, readBlobBounded } from '../../lib/files-ui.js'

/** The previous save's object URL. Kept alive until the NEXT save rather
 *  than revoked on a timer — a timed revoke can race a still-writing
 *  download, and one retained blob per session is bounded (≤64 MB). */
let lastObjectUrl: string | undefined

/** In-shell file save: the OS browser sits outside the shell's mTLS pipe and
 *  cannot authenticate to the gateway, so pull the bytes over the app's own
 *  transport and hand them to Chromium as a blob-anchor download. What the
 *  shell does with that download (dialog vs default dir) is its policy, not
 *  ours — callers surface their own "download started" notice. */
export async function saveViaGateway(url: string, name: string, sizeBytes?: number): Promise<void> {
  const preErr = downloadTooLargeError(sizeBytes)
  if (preErr) throw new Error(preErr)
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`download failed (HTTP ${String(res.status)})`)
  // Bounded on the actual bytes read (header alone can lie or be absent).
  const blob = await readBlobBounded(res)
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl)
  const objectUrl = URL.createObjectURL(blob)
  lastObjectUrl = objectUrl
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}
