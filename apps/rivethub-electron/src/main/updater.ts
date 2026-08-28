/**
 * In-app update — download an installer/AppImage the hub found on the mesh
 * filestore and hand it to the OS.
 *
 * The renderer (settings page) reads `builds/rivethub/latest.json` off any
 * gateway's /api/files surface through its mTLS loopback pipe, compares
 * versions, and calls `rivetShell.installUpdate` with a download URL on that
 * same pipe. Main validates everything again: loopback-only URL (the pipe is
 * the only place a plain-http fetch is legitimate), version and sha256
 * shapes, then streams to a temp file, verifies the digest, and opens the
 * artifact. A digest mismatch deletes the file and throws — never install
 * unverified bytes.
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, shell } from 'electron'
import type { UpdateRequest } from './update-validate.js'

export { validateUpdateRequest, type UpdateRequest } from './update-validate.js'

/** Download, verify, launch. Resolves once the artifact has been handed to
 *  the OS; the app quits shortly after so the installer can replace it. */
export async function downloadAndInstall(req: UpdateRequest): Promise<void> {
  const ext = process.platform === 'win32' ? 'exe' : 'AppImage'
  const dest = join(app.getPath('temp'), `RivetHub-update-${req.version}.${ext}`)

  const res = await fetch(req.url)
  if (!res.ok || !res.body) throw new Error(`installUpdate: download failed (${res.status})`)

  const hash = createHash('sha256')
  const file = createWriteStream(dest, { mode: 0o755 })
  await pipeline(
    res.body as unknown as NodeJS.ReadableStream,
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk)
        file.write(chunk, cb)
      },
      final(cb) {
        file.end(cb)
      },
    }),
  )

  const digest = hash.digest('hex')
  if (digest !== req.sha256) {
    await rm(dest, { force: true })
    throw new Error('installUpdate: sha256 mismatch — refusing to run the artifact')
  }

  const openErr = await shell.openPath(dest)
  if (openErr) throw new Error(`installUpdate: could not launch installer: ${openErr}`)
  // Give the installer a beat to start, then get out of its way.
  setTimeout(() => {
    app.quit()
  }, 1500)
}
