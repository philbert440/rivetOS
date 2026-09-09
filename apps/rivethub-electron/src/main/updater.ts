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
import * as fs from 'node:fs'
import { createWriteStream } from 'node:fs'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
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

/**
 * Resolve the install path for an AppImage update. APPIMAGE is the running
 * image's path, but if we're already running from a temp updater path (the
 * bug this fix addresses), APPIMAGE is a temp path - using it would
 * perpetuate the problem. Treat APPIMAGE as usable only if it is a
 * persistent path (not under tmpdir, not matching rivethub-update-).
 */
export function resolveInstallPath(
  appImageEnv: string | undefined,
  homeDir: string,
  tmp: string,
): string {
  const fallback = path.join(homeDir, '.local', 'bin', 'rivethub')
  if (!appImageEnv) return fallback
  const isTemp = appImageEnv.startsWith(tmp) || appImageEnv.includes('rivethub-update-')
  return isTemp ? fallback : appImageEnv
}

/** True when `dir` (or an ancestor, if it does not exist yet) is writable by
 *  this user. Pacman installs land in root-owned `/opt/rivethub` and fail this. */
export async function isDirWritableByUser(dir: string): Promise<boolean> {
  try {
    await fs.promises.access(dir, fs.constants.W_OK)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      const parent = path.dirname(dir)
      if (parent === dir) return false
      return isDirWritableByUser(parent)
    }
    return false
  }
}

/**
 * Quote a path for a freedesktop `Exec=` value (spaces / reserved chars),
 * and double `%` so the desktop parser does not treat path percents as field
 * codes. See Desktop Entry Spec "The Exec key".
 */
export function quoteDesktopExecPath(filePath: string): string {
  const withPercent = filePath.replace(/%/g, '%%')
  if (!/[ \t\n"'$\\><~|&;()*?`#]/.test(filePath)) return withPercent
  return `"${withPercent.replace(/[\\"$`]/g, '\\$&')}"`
}

/** Rewrite the `Exec=` line to launch `appImagePath` with the Wayland args. */
export function rewriteDesktopExec(contents: string, appImagePath: string): string {
  const execLine = `Exec=${quoteDesktopExecPath(appImagePath)} --ozone-platform=wayland %U`
  if (!/^Exec=/m.test(contents)) {
    return contents.endsWith('\n') ? `${contents}${execLine}\n` : `${contents}\n${execLine}\n`
  }
  return contents.replace(/^Exec=.*$/m, execLine)
}

/** First-run launcher install: skip missing/temp AppImage paths and an
 *  already-present per-user desktop entry (do not clobber). Writable check
 *  is separate (`isDirWritableByUser`). */
export function shouldAttemptFirstRunDesktopIntegration(
  appImagePath: string | undefined,
  tmp: string,
  desktopEntryExists: boolean,
): boolean {
  if (!appImagePath) return false
  if (desktopEntryExists) return false
  const isTemp = appImagePath.startsWith(tmp) || appImagePath.includes('rivethub-update-')
  return !isTemp
}

/** The node:fs/promises methods `installAppImage` actually calls. */
export interface InstallIo {
  mkdir: typeof fs.promises.mkdir
  copyFile: typeof fs.promises.copyFile
  chmod: typeof fs.promises.chmod
  rename: typeof fs.promises.rename
  rm: typeof fs.promises.rm
}

/** Copy `src` next to `installTo` as a hidden staged file, chmod 0755, then rename over `installTo`.
 *  Never opens `installTo` for writing (a running AppImage → ETXTBSY). Cleans the staged file on failure. */
export async function installAppImage(
  src: string,
  installTo: string,
  io: InstallIo = fs.promises,
): Promise<void> {
  const staged = path.join(path.dirname(installTo), `.${path.basename(installTo)}.rivethub-update`)
  await io.mkdir(path.dirname(installTo), { recursive: true })
  try {
    await io.copyFile(src, staged)
    await io.chmod(staged, 0o755)
    // If installTo is a symlink, rename replaces the link itself (copyFile
    // would write through to the target). Intentional: the link's target may
    // be the running image.
    await io.rename(staged, installTo)
  } catch (err) {
    try {
      await io.rm(staged, { force: true })
    } catch {
      /* keep the original error */
    }
    throw err
  }
}

/** Install .desktop file and hicolor icons for Linux desktop integration. */
export async function installDesktopIntegration(
  appImagePath: string,
  homeDir: string,
): Promise<void> {
  const dataHome = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share')
  const applicationsDir = path.join(dataHome, 'applications')
  const iconsDir = path.join(dataHome, 'icons', 'hicolor')

  try {
    // Extract .desktop file and icons from the AppImage using --appimage-extract
    const tmpExtract = await mkdtemp(join(tmpdir(), 'rivethub-desktop-extract-'))
    try {
      const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' }

      // Extract .desktop file
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          appImagePath,
          ['--appimage-extract', 'rivethub.desktop'],
          { cwd: tmpExtract, stdio: 'ignore', env }
        )
        child.on('error', reject)
        child.on('exit', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`desktop extract failed: ${String(code)}`))
        })
      })

      // Extract icons
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          appImagePath,
          ['--appimage-extract', 'usr/share/icons/hicolor/*'],
          { cwd: tmpExtract, stdio: 'ignore', env }
        )
        child.on('error', reject)
        child.on('exit', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`icon extract failed: ${String(code)}`))
        })
      })

      // Install .desktop file. The AppImage's embedded Exec=rivethub does
      // not resolve for a manually-located image (and can launch a pacman
      // /usr/bin/rivethub instead). Rewrite to the actual absolute path.
      const desktopSrc = path.join(tmpExtract, 'squashfs-root', 'rivethub.desktop')
      const desktopDest = path.join(applicationsDir, 'rivethub.desktop')
      if (fs.existsSync(desktopSrc)) {
        await fs.promises.mkdir(applicationsDir, { recursive: true })
        const desktopText = await fs.promises.readFile(desktopSrc, 'utf8')
        await fs.promises.writeFile(
          desktopDest,
          rewriteDesktopExec(desktopText, appImagePath),
          'utf8',
        )
        await fs.promises.chmod(desktopDest, 0o644)
      }

      // Install hicolor icons
      const extractedIconsBase = path.join(tmpExtract, 'squashfs-root', 'usr', 'share', 'icons', 'hicolor')
      if (fs.existsSync(extractedIconsBase)) {
        const sizes = ['16x16', '24x24', '32x32', '48x48', '64x64', '128x128', '256x256', '512x512']
        for (const size of sizes) {
          const srcIcon = path.join(extractedIconsBase, size, 'apps', 'rivethub.png')
          if (fs.existsSync(srcIcon)) {
            const destDir = path.join(iconsDir, size, 'apps')
            await fs.promises.mkdir(destDir, { recursive: true })
            await fs.promises.copyFile(srcIcon, path.join(destDir, 'rivethub.png'))
          }
        }
      }

      // Update desktop database and icon cache. spawn() itself does not
      // throw on ENOENT — the child emits `error` later — so each child
      // needs an error listener or the miss escapes to uncaughtException.
      spawnUnrefBestEffort('update-desktop-database', [applicationsDir])
      spawnUnrefBestEffort('gtk-update-icon-cache', [iconsDir])
    } finally {
      await rm(tmpExtract, { recursive: true, force: true })
    }
  } catch (err) {
    // Desktop integration is best-effort: log but don't fail the update
    console.warn('Failed to install desktop integration:', err)
  }
}

function spawnUnrefBestEffort(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {
      /* missing binary (ENOENT) — contained no-op */
    })
    child.unref()
  } catch {
    /* spawn itself threw — still best-effort */
  }
}

/** Best-effort first-run .desktop + icons for a user-writable AppImage.
 *  No-op when APPIMAGE is unset/temp, the install dir is not writable
 *  (pacman `/opt/rivethub`), or a per-user entry already exists. Failures
 *  are swallowed by `installDesktopIntegration`. */
export async function maybeInstallFirstRunDesktopIntegration(
  appImagePath: string | undefined,
  homeDir: string,
  tmp: string = tmpdir(),
): Promise<void> {
  if (!appImagePath) return
  const dataHome = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share')
  const desktopDest = path.join(dataHome, 'applications', 'rivethub.desktop')
  if (
    !shouldAttemptFirstRunDesktopIntegration(
      appImagePath,
      tmp,
      fs.existsSync(desktopDest),
    )
  ) {
    return
  }
  if (!(await isDirWritableByUser(path.dirname(appImagePath)))) return
  await installDesktopIntegration(appImagePath, homeDir)
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
  if (!res.ok) throw new Error(`no update manifest on this node (${String(res.status)})`)
  if (!res.body) throw new Error('update manifest response had an empty body')
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
 *  downloads, verifies, launches, then quits the app.
 *  @returns true if an install/relaunch was started; false if this install
 *  is package-managed (install dir not user-writable) and in-app update
 *  was skipped without throwing. */
export async function downloadAndInstall(pipes: PipeState, gatewayBase: string): Promise<boolean> {
  if (process.platform !== 'win32' && process.platform !== 'linux')
    throw new Error(`in-app update is not supported on ${process.platform}`)

  if (process.platform === 'linux') {
    const installTo = resolveInstallPath(process.env.APPIMAGE, app.getPath('home'), tmpdir())
    if (!(await isDirWritableByUser(path.dirname(installTo)))) {
      console.info(
        'RivetHub is managed by your package manager — update with your package manager',
      )
      return false
    }
  }

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

    if (process.platform === 'win32') {
      // openPath (ShellExecute) is the right primitive here: the NSIS
      // installer needs elevation, which ShellExecute prompts for while a
      // Node spawn of the exe just fails with EACCES. The residual: openPath
      // resolving '' means the launch STARTED, not that the user passed the
      // UAC prompt — a cancel after this point loses the running hub for
      // nothing. Acknowledged; the alternative (no quit) leaves two hubs
      // fighting after a successful install.
      const openErr = await shell.openPath(dest)
      if (openErr) throw new Error(`could not launch installer: ${openErr}`)
      // NSIS relaunches the app when the install finishes; if that copy
      // starts inside our quit window while we still hold the singleton, it
      // loses the lock and exits — the user sees the update "close the app".
      app.releaseSingleInstanceLock()
      setTimeout(() => {
        app.quit()
      }, 1500)
      return true
    }
    await chmod(dest, 0o755)

    // Install by sibling copy + rename. Linux refuses an in-place write to
    // the running AppImage (ETXTBSY); rename over it is allowed and the old
    // process keeps its inode. Writable check already ran at the top of
    // this function; re-resolve so the path cannot drift.
    const installTo = resolveInstallPath(process.env.APPIMAGE, app.getPath('home'), tmpdir())
    await installAppImage(dest, installTo)

    // Install .desktop file and hicolor icons for launcher integration
    await installDesktopIntegration(installTo, app.getPath('home'))

    // Run the INSTALLED AppImage, not the temp download. Strip the RUNNING
    // AppImage's runtime vars, or the new image's runtime resolves against
    // the OLD mount (review, PR #562).
    const env = { ...process.env }
    delete env.APPIMAGE
    delete env.APPDIR
    delete env.ARGV0
    // APPIMAGE_EXTRACT_AND_RUN is inherited on purpose: a FUSE-less host
    // cannot launch without it. The cost: the new image extracts into the
    // SAME /tmp/appimage_extracted_<md5 of path> this process runs from,
    // and this process's runtime rm -rf's it on quit ~1s later. The new
    // instance survives that because serve-dist snapshots the web dist at
    // startup (PR #675); the asar stays readable through its open fd.
    // Release the single-instance lock BEFORE spawning: the new copy of
    // this app would otherwise lose the lock to the still-running old
    // process and exit immediately (review round 2). With the lock
    // released, an exit INSIDE the 1s window is a true launch failure
    // (missing FUSE, broken payload, failed inner exec — those are `exit`,
    // not `error`; review round 3), so both signals are watched. A death
    // after the window is the acknowledged residual.
    app.releaseSingleInstanceLock()
    try {
      const child = spawn(installTo, [], { detached: true, stdio: 'ignore', env })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          resolve()
        }, 1000)
        const cleanup = (): void => {
          clearTimeout(timer)
          child.removeAllListeners('error')
          child.removeAllListeners('exit')
          child.unref()
        }
        child.once('error', (err) => {
          cleanup()
          reject(new Error(`could not launch update: ${err.message}`))
        })
        child.once('exit', (code, signal) => {
          cleanup()
          reject(new Error(`update exited immediately (${String(code ?? signal)})`))
        })
      })
    } catch (err) {
      // The old hub keeps running on a failed launch — it must be the
      // singleton again, or a second copy could start unnoticed. If the
      // lock is already gone, something else took over: get out of its way.
      if (!app.requestSingleInstanceLock()) {
        setTimeout(() => {
          app.quit()
        }, 1500)
        throw new Error(
          `${err instanceof Error ? err.message : String(err)} — and another instance took the lock; quitting`,
        )
      }
      throw err
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
  return true
}
