/**
 * Tests for updater.ts — Linux AppImage install path, desktop Exec rewrite,
 * first-run skip rules, and writable-dir detection.
 */

import { afterEach, describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  installAppImage,
  isDirWritableByUser,
  quoteDesktopExecPath,
  resolveInstallPath,
  rewriteDesktopExec,
  shouldAttemptFirstRunDesktopIntegration,
  type InstallIo,
} from './updater.js'

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

describe('quoteDesktopExecPath / rewriteDesktopExec', () => {
  it('leaves a simple path unquoted', () => {
    expect(quoteDesktopExecPath('/home/user/.local/bin/rivethub')).toBe(
      '/home/user/.local/bin/rivethub',
    )
  })

  it('quotes a path with spaces and keeps Wayland args', () => {
    const quoted = quoteDesktopExecPath('/home/user/My Apps/RivetHub.AppImage')
    expect(quoted).toBe('"/home/user/My Apps/RivetHub.AppImage"')
    const rewritten = rewriteDesktopExec(
      'Exec=rivethub --ozone-platform=wayland %U\n',
      '/home/user/My Apps/RivetHub.AppImage',
    )
    expect(rewritten).toBe(
      'Exec="/home/user/My Apps/RivetHub.AppImage" --ozone-platform=wayland %U\n',
    )
  })

  it('escapes quotes and doubles percent signs in the path', () => {
    expect(quoteDesktopExecPath('/tmp/foo"bar%baz')).toBe('"/tmp/foo\\"bar%%baz"')
  })

  it('rewrites an embedded rivethub Exec to the absolute AppImage path', () => {
    const src = [
      '[Desktop Entry]',
      'Name=RivetHub',
      'Exec=rivethub --ozone-platform=wayland %U',
      'Icon=rivethub',
      '',
    ].join('\n')
    expect(rewriteDesktopExec(src, '/home/user/.local/bin/rivethub')).toBe(
      [
        '[Desktop Entry]',
        'Name=RivetHub',
        'Exec=/home/user/.local/bin/rivethub --ozone-platform=wayland %U',
        'Icon=rivethub',
        '',
      ].join('\n'),
    )
  })
})

describe('shouldAttemptFirstRunDesktopIntegration', () => {
  const tmp = '/tmp'

  it('skips when APPIMAGE is unset', () => {
    expect(shouldAttemptFirstRunDesktopIntegration(undefined, tmp, false)).toBe(false)
  })

  it('skips when a per-user desktop entry already exists', () => {
    expect(
      shouldAttemptFirstRunDesktopIntegration('/home/user/.local/bin/rivethub', tmp, true),
    ).toBe(false)
  })

  it('skips a temp updater path', () => {
    expect(
      shouldAttemptFirstRunDesktopIntegration(
        '/tmp/rivethub-update-abc/RivetHub.AppImage',
        tmp,
        false,
      ),
    ).toBe(false)
  })

  it('attempts a persistent user-writable AppImage with no existing entry', () => {
    expect(
      shouldAttemptFirstRunDesktopIntegration('/home/user/.local/bin/rivethub', tmp, false),
    ).toBe(true)
  })
})

describe('isDirWritableByUser', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
    )
  })

  it('returns true for a writable directory', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rivethub-writable-'))
    dirs.push(dir)
    expect(await isDirWritableByUser(dir)).toBe(true)
  })

  it('returns true for a missing nested dir whose parent is writable', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rivethub-writable-'))
    dirs.push(dir)
    expect(await isDirWritableByUser(path.join(dir, 'nested', 'bin'))).toBe(true)
  })

  it('returns false for a directory without write permission', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rivethub-writable-'))
    dirs.push(dir)
    const locked = path.join(dir, 'locked')
    await fs.promises.mkdir(locked, { mode: 0o555 })
    await fs.promises.chmod(locked, 0o555)
    try {
      expect(await isDirWritableByUser(locked)).toBe(false)
    } finally {
      await fs.promises.chmod(locked, 0o755)
    }
  })
})
