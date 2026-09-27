import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LockTimeout, withFileLock } from './lock.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'capture-lock-'))
  dirs.push(dir)
  return join(dir, 'state.json.lock')
}

it('excludes a second caller until the holder returns', async () => {
  const lockDir = lockPath()
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let firstEntered = false
  const first = withFileLock(lockDir, async () => {
    firstEntered = true
    await held
    return 'first'
  })
  while (!firstEntered) await new Promise((resolve) => setTimeout(resolve, 10))
  let secondEntered = false
  const second = withFileLock(
    lockDir,
    () => {
      secondEntered = true
      return 'second'
    },
    { waitMs: 2_000, pollMs: 20, staleMs: 60_000 },
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(secondEntered).toBe(false)
  release()
  await expect(second).resolves.toBe('second')
  await expect(first).resolves.toBe('first')
  expect(existsSync(lockDir)).toBe(false)
})

it('takes over a stale lock and removes it', async () => {
  const lockDir = lockPath()
  mkdirSync(lockDir)
  writeFileSync(join(lockDir, 'owner.json'), '{"pid":1}')
  const old = new Date(Date.now() - 120_000 - 5_000)
  utimesSync(lockDir, old, old)
  let sawOwner = false
  await withFileLock(
    lockDir,
    () => {
      const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')) as {
        pid: number
        host: string
        ts: string
      }
      sawOwner = owner.pid === process.pid && owner.host.length > 0 && owner.ts.length > 0
    },
    { staleMs: 120_000, waitMs: 1_000, pollMs: 20 },
  )
  expect(sawOwner).toBe(true)
  expect(existsSync(lockDir)).toBe(false)
  const parent = lockDir.slice(0, lockDir.lastIndexOf('/'))
  expect(readdirSync(parent).some((name) => name.includes('.stale-'))).toBe(false)
})

it('removes the lock when fn throws', async () => {
  const lockDir = lockPath()
  await expect(
    withFileLock(lockDir, () => {
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')
  expect(existsSync(lockDir)).toBe(false)
})

it('throws LockTimeout when the lock stays busy', async () => {
  const lockDir = lockPath()
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = withFileLock(lockDir, () => held, { staleMs: 60_000 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const pending = withFileLock(lockDir, () => 'nope', {
    waitMs: 150,
    pollMs: 20,
    staleMs: 60_000,
  })
  await expect(pending).rejects.toBeInstanceOf(LockTimeout)
  release()
  await first
  expect(existsSync(lockDir)).toBe(false)
})
