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

it('keeps a single holder when a taker pauses after the validating stat', async () => {
  const lockDir = lockPath()
  mkdirSync(lockDir)
  writeFileSync(join(lockDir, 'owner.json'), '{"pid":1}')
  const old = new Date(Date.now() - 10_000)
  utimesSync(lockDir, old, old)

  let validated = false
  let releaseValidated: () => void = () => undefined
  const validatedGate = new Promise<void>((resolve) => {
    releaseValidated = resolve
  })
  let inside = 0
  let maxInside = 0
  const track = async (who: string): Promise<string> => {
    inside += 1
    maxInside = Math.max(maxInside, inside)
    await new Promise((resolve) => setTimeout(resolve, 30))
    inside -= 1
    return who
  }

  const delayed = withFileLock(lockDir, () => track('B'), {
    staleMs: 1_000,
    waitMs: 4_000,
    pollMs: 10,
    afterValidatingStat: async () => {
      validated = true
      await validatedGate
    },
  })
  const started = Date.now()
  while (!validated && Date.now() - started < 1_000) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(validated).toBe(true)

  const contenders = ['A', 'C'].map((who) =>
    withFileLock(lockDir, () => track(who), { staleMs: 1_000, waitMs: 4_000, pollMs: 10 }),
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(maxInside).toBe(0)
  releaseValidated()
  const results = await Promise.all([delayed, ...contenders])
  expect(maxInside).toBe(1)
  expect(results.sort()).toEqual(['A', 'B', 'C'])
  expect(existsSync(lockDir)).toBe(false)
  expect(existsSync(`${lockDir}.reclaim`)).toBe(false)
  const parent = lockDir.slice(0, lockDir.lastIndexOf('/'))
  expect(readdirSync(parent).some((name) => name.includes('.stale-'))).toBe(false)
})

it('does not let a delayed abandoned-reclaim observer steal the recovered mutex', async () => {
  const lockDir = lockPath()
  mkdirSync(lockDir)
  writeFileSync(join(lockDir, 'owner.json'), '{"pid":1}')
  const old = new Date(Date.now() - 10_000)
  utimesSync(lockDir, old, old)
  const reclaim = `${lockDir}.reclaim`
  mkdirSync(reclaim)
  const abandoned = new Date(Date.now() - 31_000)
  utimesSync(reclaim, abandoned, abandoned)

  let observed = false
  let releaseObserved: () => void = () => undefined
  const observedGate = new Promise<void>((resolve) => {
    releaseObserved = resolve
  })
  let validated = false
  let releaseValidated: () => void = () => undefined
  const validatedGate = new Promise<void>((resolve) => {
    releaseValidated = resolve
  })
  let inside = 0
  let maxInside = 0
  const track = async (who: string): Promise<string> => {
    inside += 1
    maxInside = Math.max(maxInside, inside)
    await new Promise((resolve) => setTimeout(resolve, 40))
    inside -= 1
    return who
  }

  const delayed = withFileLock(lockDir, () => track('B'), {
    staleMs: 1_000,
    waitMs: 4_000,
    pollMs: 10,
    afterAbandonedReclaimStat: async () => {
      observed = true
      await observedGate
    },
  })
  const started = Date.now()
  while (!observed && Date.now() - started < 1_000) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(observed).toBe(true)

  const recoverer = withFileLock(lockDir, () => track('A'), {
    staleMs: 1_000,
    waitMs: 4_000,
    pollMs: 10,
    afterValidatingStat: async () => {
      validated = true
      await validatedGate
    },
  })
  const startedA = Date.now()
  while (!validated && Date.now() - startedA < 1_000) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(validated).toBe(true)
  expect(maxInside).toBe(0)

  releaseObserved()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(maxInside).toBe(0)
  expect(inside).toBe(0)

  releaseValidated()
  const results = await Promise.all([delayed, recoverer])
  expect(maxInside).toBe(1)
  expect(results.sort()).toEqual(['A', 'B'])
  expect(existsSync(lockDir)).toBe(false)
  expect(existsSync(reclaim)).toBe(false)
  const parent = lockDir.slice(0, lockDir.lastIndexOf('/'))
  expect(readdirSync(parent).some((name) => name.includes('.stale-'))).toBe(false)
  expect(readdirSync(parent).some((name) => name.includes('.abandoned-'))).toBe(false)
})

it('recovers an abandoned reclaim mutex', async () => {
  const lockDir = lockPath()
  mkdirSync(lockDir)
  const old = new Date(Date.now() - 10_000)
  utimesSync(lockDir, old, old)
  const reclaim = `${lockDir}.reclaim`
  mkdirSync(reclaim)
  const abandoned = new Date(Date.now() - 31_000)
  utimesSync(reclaim, abandoned, abandoned)
  let entered = false
  await withFileLock(
    lockDir,
    () => {
      entered = true
    },
    { staleMs: 1_000, waitMs: 2_000, pollMs: 20 },
  )
  expect(entered).toBe(true)
  expect(existsSync(reclaim)).toBe(false)
  expect(existsSync(lockDir)).toBe(false)
})

it('waits on a fresh reclaim mutex instead of removing it', async () => {
  const lockDir = lockPath()
  mkdirSync(lockDir)
  const old = new Date(Date.now() - 10_000)
  utimesSync(lockDir, old, old)
  const reclaim = `${lockDir}.reclaim`
  mkdirSync(reclaim)
  await expect(
    withFileLock(lockDir, () => 'entered', { staleMs: 1_000, waitMs: 250, pollMs: 20 }),
  ).rejects.toBeInstanceOf(LockTimeout)
  expect(existsSync(reclaim)).toBe(true)
  expect(existsSync(lockDir)).toBe(true)
})
