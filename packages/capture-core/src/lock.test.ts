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
import { afterEach, expect, it, vi } from 'vitest'
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

it('lets exactly one of two delayed stale takers enter', async () => {
  const lockDir = lockPath()
  mkdirSync(lockDir)
  writeFileSync(
    join(lockDir, 'owner.json'),
    JSON.stringify({ pid: 1, host: 'old', ts: '2000-01-01T00:00:00.000Z' }),
  )
  const old = new Date(Date.now() - 10_000)
  utimesSync(lockDir, old, old)

  let observed = false
  let releaseObserved: () => void = () => undefined
  const observedGate = new Promise<void>((resolve) => {
    releaseObserved = resolve
  })
  let holderInside = false
  let overlapped = false
  let inside = 0
  let maxInside = 0

  const track = async (who: 'holder' | 'delayed'): Promise<string> => {
    inside += 1
    maxInside = Math.max(maxInside, inside)
    if (who === 'holder') {
      holderInside = true
      releaseObserved()
      await new Promise((resolve) => setTimeout(resolve, 40))
      holderInside = false
    } else if (holderInside) {
      overlapped = true
    }
    inside -= 1
    return who
  }

  const delayed = withFileLock(lockDir, () => track('delayed'), {
    staleMs: 1_000,
    waitMs: 3_000,
    pollMs: 10,
    afterStaleStat: async () => {
      observed = true
      await observedGate
    },
  })
  const started = Date.now()
  while (!observed && Date.now() - started < 1_000) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(observed).toBe(true)
  const holder = withFileLock(lockDir, () => track('holder'), {
    staleMs: 1_000,
    waitMs: 3_000,
    pollMs: 10,
  })
  await expect(holder).resolves.toBe('holder')
  await expect(delayed).resolves.toBe('delayed')
  expect(overlapped).toBe(false)
  expect(maxInside).toBe(1)
  expect(existsSync(lockDir)).toBe(false)
})

it('does not steal a holder that runs longer than staleMs', async () => {
  // Heartbeat is staleMs/3. Fake timers deadlock on the lock's fs promises,
  // so this uses a short real staleMs and holds past it.
  const lockDir = lockPath()
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = false
  const staleMs = 400
  const holder = withFileLock(
    lockDir,
    async () => {
      entered = true
      await held
      return 'held'
    },
    { staleMs, waitMs: 2_000, pollMs: 20 },
  )
  const started = Date.now()
  while (!entered && Date.now() - started < 1_000) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(entered).toBe(true)
  let stolen = false
  const waiter = withFileLock(
    lockDir,
    () => {
      stolen = true
      return 'stolen'
    },
    { staleMs, waitMs: 1_000, pollMs: 40 },
  )
  await new Promise((resolve) => setTimeout(resolve, staleMs + 250))
  expect(stolen).toBe(false)
  release()
  await expect(holder).resolves.toBe('held')
  await expect(waiter).resolves.toBe('stolen')
  expect(existsSync(lockDir)).toBe(false)
})

it('does not remove a foreign lock', async () => {
  const lockDir = lockPath()
  const log = vi.fn()
  await withFileLock(
    lockDir,
    () => {
      writeFileSync(
        join(lockDir, 'owner.json'),
        JSON.stringify({ pid: 999, host: 'other', ts: '1999-01-01T00:00:00.000Z' }),
      )
    },
    { log },
  )
  expect(existsSync(lockDir)).toBe(true)
  expect(readFileSync(join(lockDir, 'owner.json'), 'utf8')).toContain('"pid":999')
  expect(log).toHaveBeenCalledWith(expect.stringContaining('not releasing'))
})
