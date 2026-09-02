/**
 * Tests for updater.ts — Linux AppImage install path resolution.
 */

import { afterEach, describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { installAppImage, resolveInstallPath, type InstallIo } from './updater.js'

describe('resolveInstallPath', () => {
  const homeDir = '/home/user'
  const tmpDir = '/tmp'
  const fallback = '/home/user/.local/bin/rivethub'

  it('uses fallback when APPIMAGE is unset', () => {
    expect(resolveInstallPath(undefined, homeDir, tmpDir)).toBe(fallback)
  })

  it('uses APPIMAGE when it is a persistent path', () => {
    const persistent = '/home/user/.local/bin/rivethub-0.5.4'
    expect(resolveInstallPath(persistent, homeDir, tmpDir)).toBe(persistent)
  })

  it('uses fallback when APPIMAGE is under tmpdir', () => {
    const tempPath = '/tmp/rivethub-update-abc123/RivetHub-0.5.5.AppImage'
    expect(resolveInstallPath(tempPath, homeDir, tmpDir)).toBe(fallback)
  })

  it('uses fallback when APPIMAGE contains rivethub-update-', () => {
    const tempPath = '/var/tmp/rivethub-update-xyz/RivetHub-0.5.5.AppImage'
    expect(resolveInstallPath(tempPath, homeDir, tmpDir)).toBe(fallback)
  })

  it('uses APPIMAGE from /opt even if it contains "rivethub"', () => {
    const optPath = '/opt/rivethub/RivetHub-0.5.4.AppImage'
    expect(resolveInstallPath(optPath, homeDir, tmpDir)).toBe(optPath)
  })

  it('uses APPIMAGE from /usr/local/bin', () => {
    const binPath = '/usr/local/bin/rivethub'
    expect(resolveInstallPath(binPath, homeDir, tmpDir)).toBe(binPath)
  })

  it('rejects temp path even when tmpdir has trailing slash', () => {
    const tempPath = '/tmp/rivethub-update-abc/RivetHub.AppImage'
    expect(resolveInstallPath(tempPath, homeDir, '/tmp/')).toBe(fallback)
  })
})

describe('installAppImage', () => {
  const dirs: string[] = []

  async function tempDir(): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rivethub-install-'))
    dirs.push(dir)
    return dir
  }

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
    )
  })

  function stagedPath(installTo: string): string {
    return path.join(path.dirname(installTo), `.${path.basename(installTo)}.rivethub-update`)
  }

  function realIo(overrides: Partial<InstallIo> = {}): InstallIo {
    return {
      mkdir: fs.promises.mkdir,
      copyFile: fs.promises.copyFile,
      chmod: fs.promises.chmod,
      rename: fs.promises.rename,
      rm: fs.promises.rm,
      ...overrides,
    }
  }

  it('replaces installTo by rename (new content, 0755 bits, new inode, no staged leftover)', async () => {
    const dir = await tempDir()
    const installTo = path.join(dir, 'rivethub')
    const src = path.join(dir, 'RivetHub-new.AppImage')
    await fs.promises.writeFile(installTo, 'old-bytes')
    await fs.promises.writeFile(src, 'new-bytes')
    const oldIno = fs.statSync(installTo).ino

    await installAppImage(src, installTo)

    expect(await fs.promises.readFile(installTo, 'utf8')).toBe('new-bytes')
    expect(fs.statSync(installTo).mode & 0o755).toBe(0o755)
    expect(fs.statSync(installTo).ino).not.toBe(oldIno)
    expect(fs.readdirSync(dir)).not.toContain('.rivethub.rivethub-update')
    expect(fs.existsSync(stagedPath(installTo))).toBe(false)
  })

  it('does not copy onto installTo (ETXTBSY on dest=installTo still succeeds)', async () => {
    const dir = await tempDir()
    const installTo = path.join(dir, 'rivethub')
    const src = path.join(dir, 'RivetHub-new.AppImage')
    await fs.promises.writeFile(installTo, 'old-bytes')
    await fs.promises.writeFile(src, 'new-bytes')

    const io = realIo({
      copyFile: async (copySrc, copyDest, mode) => {
        if (copyDest === installTo) {
          throw Object.assign(new Error('ETXTBSY'), { code: 'ETXTBSY' })
        }
        return fs.promises.copyFile(copySrc, copyDest, mode)
      },
    })

    await expect(installAppImage(src, installTo, io)).resolves.toBeUndefined()
    expect(await fs.promises.readFile(installTo, 'utf8')).toBe('new-bytes')
  })

  it('removes the staged file when rename fails', async () => {
    const dir = await tempDir()
    const installTo = path.join(dir, 'rivethub')
    const src = path.join(dir, 'RivetHub-new.AppImage')
    await fs.promises.writeFile(installTo, 'old-bytes')
    await fs.promises.writeFile(src, 'new-bytes')
    const renameErr = new Error('rename failed')
    const rmCalls: Array<{ path: fs.PathLike; options?: fs.RmOptions }> = []

    const io = realIo({
      rename: async () => {
        throw renameErr
      },
      rm: async (rmPath, options) => {
        rmCalls.push({ path: rmPath, options })
        return fs.promises.rm(rmPath, options)
      },
    })

    await expect(installAppImage(src, installTo, io)).rejects.toBe(renameErr)
    expect(rmCalls).toEqual([{ path: stagedPath(installTo), options: { force: true } }])
    expect(fs.existsSync(stagedPath(installTo))).toBe(false)
    expect(fs.readdirSync(dir)).not.toContain('.rivethub.rivethub-update')
    expect(await fs.promises.readFile(installTo, 'utf8')).toBe('old-bytes')
  })

  it('replaces a symlink at installTo with a regular file; former target is unchanged', async () => {
    const dir = await tempDir()
    const otherDir = path.join(dir, 'other')
    await fs.promises.mkdir(otherDir)
    const target = path.join(otherDir, 'rivethub-real')
    const installTo = path.join(dir, 'rivethub')
    const src = path.join(dir, 'RivetHub-new.AppImage')
    await fs.promises.writeFile(target, 'old-target-bytes')
    await fs.promises.symlink(target, installTo)
    await fs.promises.writeFile(src, 'new-bytes')

    await installAppImage(src, installTo)

    expect(fs.lstatSync(installTo).isSymbolicLink()).toBe(false)
    expect(await fs.promises.readFile(installTo, 'utf8')).toBe('new-bytes')
    expect(await fs.promises.readFile(target, 'utf8')).toBe('old-target-bytes')
  })

  it('creates a missing install dir', async () => {
    const dir = await tempDir()
    const installTo = path.join(dir, 'nested', 'bin', 'rivethub')
    const src = path.join(dir, 'RivetHub-new.AppImage')
    await fs.promises.writeFile(src, 'new-bytes')

    await installAppImage(src, installTo)

    expect(await fs.promises.readFile(installTo, 'utf8')).toBe('new-bytes')
    expect(fs.statSync(installTo).mode & 0o755).toBe(0o755)
  })
})
