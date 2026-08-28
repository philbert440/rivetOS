/**
 * In-app update — MAIN IS THE TRUST ROOT (review, PR #562).
 *
 * The renderer names the gateway base it is connected to; everything else
 * happens here: main resolves its OWN mTLS pipe for that gateway
 * (PipeState.proxyPort — parseTarget enforces https + host shape), fetches
 * `builds/rivethub/latest.json` itself (no redirects), validates the entry
 * (semver / hex digest / basename fence — update-manifest.ts), builds the
 * download URL itself, streams to an exclusive 0600 file in a fresh mkdtemp
 * dir with a byte cap and timeout, verifies the digest main read from the
 * manifest, and only then marks executable and launches. The renderer can
 * never supply a URL or a digest, so a compromised renderer can at worst
 * install the artifact the mesh manifest already names.
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { app, shell } from 'electron'
import type { PipeState } from './mtls-pipe.js'
import {
  BUILDS_PREFIX,
  MANIFEST_PATH,
  newerVersion,
  validateManifestEntry,
  type ManifestEntry,
} from './update-manifest.js'

export interface UpdateCheckResult {
  current: string
  platform: string
  /** Present when the manifest names a strictly newer build. */
  available?: { version: string; sizeBytes?: number }
}

const MANIFEST_TIMEOUT_MS = 15_000
const MANIFEST_MAX_BYTES = 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
/** Absolute cap regardless of manifest claims — an installer is ~120MB. */
const HARD_MAX_BYTES = 1024 * 1024 * 1024

function pipeBaseUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`
}

async function fetchManifestEntry(pipes: PipeState, gatewayBase: string): Promise<ManifestEntry> {
  // proxyPort re-validates the target (https-only, host shape) and returns
  // the shell's own loopback pipe — the only URL family main will fetch.
  const port = await pipes.proxyPort(gatewayBase)
  const url = `${pipeBaseUrl(port)}/api/files/download?path=${encodeURIComponent(MANIFEST_PATH)}`
  const res = await fetch(url, {
    redirect: 'error',
    headers: { 'cache-control': 'no-store' },
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  })
  if (!res.ok || !res.body)
    throw new Error(`no update manifest on this node (${String(res.status)})`)
  // Cap the manifest ON THE WIRE — res.text()/json() materialize the whole
  // body first, so a huge (or decompression-bombed) latest.json would OOM
  // main before any length check (review round 2).
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MANIFEST_MAX_BYTES) {
      await reader.cancel()
      throw new Error('update manifest is implausibly large')
    }
    chunks.push(value)
  }
  const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  return validateManifestEntry(manifest[process.platform], process.platform)
}

export async function checkForUpdate(
  pipes: PipeState,
  gatewayBase: string,
): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const entry = await fetchManifestEntry(pipes, gatewayBase)
  return {
    current,
    platform: process.platform,
    ...(newerVersion(entry.version, current)
      ? { available: { version: entry.version, sizeBytes: entry.sizeBytes } }
      : {}),
  }
}

/** Re-fetches the manifest at install time (no stale check-time state),
 *  downloads, verifies, launches, then quits the app. */
export async function downloadAndInstall(pipes: PipeState, gatewayBase: string): Promise<void> {
  if (process.platform !== 'win32' && process.platform !== 'linux')
    throw new Error(`in-app update is not supported on ${process.platform}`)

  const entry = await fetchManifestEntry(pipes, gatewayBase)
  if (!newerVersion(entry.version, app.getVersion()))
    throw new Error(`manifest version ${entry.version} is not newer than ${app.getVersion()}`)

  const port = await pipes.proxyPort(gatewayBase)
  const url = `${pipeBaseUrl(port)}/api/files/download?path=${encodeURIComponent(
    `${BUILDS_PREFIX}/${entry.file}`,
  )}`

  const dir = await mkdtemp(join(tmpdir(), 'rivethub-update-'))
  const dest = join(dir, entry.file)
  const cap = Math.min(
    entry.sizeBytes ? Math.ceil(entry.sizeBytes * 1.05) : HARD_MAX_BYTES,
    HARD_MAX_BYTES,
  )
  try {
    const res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (!res.ok || !res.body) throw new Error(`download failed (${String(res.status)})`)

    const hash = createHash('sha256')
    // Exclusive create, private mode: no symlink following, no clobber, and
    // nothing can exec a half-written artifact (0600 until verified).
    const file = createWriteStream(dest, { flags: 'wx', mode: 0o600 })
    let received = 0
    await pipeline(
      res.body as unknown as NodeJS.ReadableStream,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          received += chunk.length
          if (received > cap) {
            cb(new Error(`download exceeded ${String(cap)} bytes — refusing`))
            return
          }
          hash.update(chunk)
          file.write(chunk, cb)
        },
        final(cb) {
          file.end(cb)
        },
      }),
    )

    const digest = hash.digest('hex')
    if (digest !== entry.sha256) throw new Error('sha256 mismatch — refusing to run the artifact')

    await chmod(dest, 0o755)
    if (process.platform === 'win32') {
      const openErr = await shell.openPath(dest)
      if (openErr) throw new Error(`could not launch installer: ${openErr}`)
    } else {
      // xdg-open on an AppImage is unreliable (exec bit vs handler); run it
      // directly — but strip the RUNNING AppImage's runtime vars, or the new
      // image's runtime resolves against the OLD mount (review, PR #562).
      const env = { ...process.env }
      delete env.APPIMAGE
      delete env.APPDIR
      delete env.ARGV0
      // Release the single-instance lock BEFORE spawning: the new copy of
      // this app would otherwise lose the lock to the still-running old
      // process and exit immediately (review round 2 — an `exit` watch here
      // false-failed every linux update for exactly that reason, so only
      // `error` is watched: it reliably reports execve failures like a
      // missing loader or EACCES, and a launch that dies later is the
      // installer's problem, not a reason to keep the old hub hostage).
      app.releaseSingleInstanceLock()
      const child = spawn(dest, [], { detached: true, stdio: 'ignore', env })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          resolve()
        }, 1000)
        const cleanup = (): void => {
          clearTimeout(timer)
          child.removeAllListeners('error')
          child.unref()
        }
        child.once('error', (err) => {
          cleanup()
          reject(new Error(`could not launch update: ${err.message}`))
        })
      })
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
  // Give the installer a beat to start, then get out of its way. The temp
  // dir is left for the running installer; the OS owns cleanup.
  setTimeout(() => {
    app.quit()
  }, 1500)
}
