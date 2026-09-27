import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LockTimeout, withFileLock } from './lock.js'

const enospc = vi.hoisted(() => ({ armed: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: (async (...args: Parameters<typeof actual.writeFile>) => {
      const path = args[0]
      if (enospc.armed && typeof path === 'string') {
        enospc.armed = false
        const { writeFileSync } = await import('node:fs')
        writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
        const error = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
        error.code = 'ENOSPC'
        throw error
      }
      return actual.writeFile(...args)
    }) as typeof actual.writeFile,
  }
})

const dirs: string[] = []
afterEach(() => {
  enospc.armed = false
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'capture-lock-'))
  dirs.push(dir)
  return join(dir, 'state.json.lock')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function ownerNames(lockDir: string): string[] {
  return readdirSync(lockDir).filter((name) => name.startsWith('owner.'))
}

function writeOwner(
  lockDir: string,
  owner: { pid: number; host: string; token: string },
  mtime?: Date,
): string {
  mkdirSync(lockDir, { recursive: true })
  const full = join(lockDir, `owner.${owner.token}`)
  writeFileSync(
    full,
    JSON.stringify({
      pid: owner.pid,
      host: owner.host,
      ts: new Date().toISOString(),
      token: owner.token,
    }),
    { mode: 0o600 },
  )
  if (mtime) utimesSync(full, mtime, mtime)
  return full
}

/** A pid that is not running. Prefer a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' })
  if (child.pid && child.status === 0) {
    try {
      process.kill(child.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return child.pid
    }
  }
  for (let pid = 2 ** 22 - 1; pid > 2 ** 22 - 50; pid -= 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('no unused pid for the dead-owner test')
}

it('runs two contenders one at a time', async () => {
  const lockDir = lockPath()
  let inside = 0
  let maxInside = 0
  const run = async (who: string): Promise<string> => {
    inside += 1
    maxInside = Math.max(maxInside, inside)
    await delay(40)
    inside -= 1
    return who
  }
  const results = await Promise.all([
    withFileLock(lockDir, () => run('a'), { waitMs: 3_000, pollMs: 10, staleMs: 60_000 }),
    withFileLock(lockDir, () => run('b'), { waitMs: 3_000, pollMs: 10, staleMs: 60_000 }),
  ])
  expect(results.sort()).toEqual(['a', 'b'])
  expect(maxInside).toBe(1)
  expect(existsSync(lockDir)).toBe(true)
  expect(ownerNames(lockDir)).toEqual([])
})

it('keeps a single holder when one contender is paused before readdir', async () => {
  const lockDir = lockPath()
  let inside = 0
  let maxInside = 0
  const track = async (who: string): Promise<string> => {
    inside += 1
    maxInside = Math.max(maxInside, inside)
    await delay(30)
    inside -= 1
    return who
  }

  let releaseDelayed: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    releaseDelayed = resolve
  })
  let paused = false
  let seamUsed = false
  const delayed = withFileLock(lockDir, () => track('delayed'), {
    waitMs: 4_000,
    pollMs: 10,
    staleMs: 60_000,
    beforeReaddir: async () => {
      if (seamUsed) return
      seamUsed = true
      paused = true
      await gate
    },
  })

  const started = Date.now()
  while (!paused && Date.now() - started < 1_000) await delay(10)
  expect(paused).toBe(true)

  const others = ['a', 'b'].map((who) =>
    withFileLock(lockDir, () => track(who), {
      waitMs: 4_000,
      pollMs: 10,
      staleMs: 60_000,
    }),
  )
  await delay(80)
  expect(maxInside).toBeLessThanOrEqual(1)
  releaseDelayed()
  const results = await Promise.all([delayed, ...others])
  expect(results.sort()).toEqual(['a', 'b', 'delayed'])
  expect(maxInside).toBe(1)
  expect(inside).toBe(0)
  expect(existsSync(lockDir)).toBe(true)
  expect(ownerNames(lockDir)).toEqual([])
})

it('acquires immediately when the only other owner is dead', async () => {
  const lockDir = lockPath()
  const pid = deadPid()
  const token = `${hostname()}.${String(pid)}.1.dead`
  const dead = writeOwner(lockDir, { pid, host: hostname(), token })
  const started = Date.now()
  let sawDead = true
  await withFileLock(
    lockDir,
    () => {
      sawDead = existsSync(dead)
      const names = ownerNames(lockDir)
      expect(names).toHaveLength(1)
      const name = names[0]
      if (!name) throw new Error('expected the live owner file')
      const body = JSON.parse(readFileSync(join(lockDir, name), 'utf8')) as {
        pid: number
        host: string
        ts: string
        token: string
      }
      expect(body.pid).toBe(process.pid)
      expect(body.host).toBe(hostname())
      expect(name).toBe(`owner.${body.token}`)
      expect(body.ts.length).toBeGreaterThan(0)
    },
    { waitMs: 1_000, pollMs: 20, staleMs: 60_000 },
  )
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(sawDead).toBe(false)
  expect(existsSync(dead)).toBe(false)
  expect(existsSync(lockDir)).toBe(true)
  expect(ownerNames(lockDir)).toEqual([])
})

it('times out on a live owner instead of taking it', async () => {
  const lockDir = lockPath()
  const token = `${hostname()}.${String(process.pid)}.1.other`
  const live = writeOwner(lockDir, { pid: process.pid, host: hostname(), token })
  let entered = false
  await expect(
    withFileLock(
      lockDir,
      () => {
        entered = true
      },
      { waitMs: 250, pollMs: 20, staleMs: 60_000 },
    ),
  ).rejects.toBeInstanceOf(LockTimeout)
  expect(entered).toBe(false)
  expect(existsSync(live)).toBe(true)
  expect(readFileSync(live, 'utf8')).toContain(`"pid":${String(process.pid)}`)
  expect(ownerNames(lockDir)).toEqual([`owner.${token}`])
})

it('times out on a foreign-host owner however old and leaves the file', async () => {
  const freshDir = lockPath()
  const freshToken = 'remote-host.99.1.fresh'
  const fresh = writeOwner(freshDir, { pid: 99, host: 'remote-host', token: freshToken })
  const freshBytes = readFileSync(fresh)
  let entered = false
  await expect(
    withFileLock(
      freshDir,
      () => {
        entered = true
      },
      { waitMs: 200, pollMs: 20, staleMs: 1_000 },
    ),
  ).rejects.toBeInstanceOf(LockTimeout)
  expect(entered).toBe(false)
  expect(readFileSync(fresh).equals(freshBytes)).toBe(true)
  expect(ownerNames(freshDir)).toEqual([`owner.${freshToken}`])

  const ancientDir = lockPath()
  const ancientToken = 'remote-host.99.1.ancient'
  mkdirSync(ancientDir, { recursive: true })
  const ancient = join(ancientDir, `owner.${ancientToken}`)
  writeFileSync(ancient, '', { mode: 0o600 })
  const ancientBytes = readFileSync(ancient)
  const old = new Date(Date.now() - 86_400_000)
  utimesSync(ancient, old, old)
  entered = false
  await expect(
    withFileLock(
      ancientDir,
      () => {
        entered = true
      },
      { waitMs: 200, pollMs: 20, staleMs: 1_000 },
    ),
  ).rejects.toBeInstanceOf(LockTimeout)
  expect(entered).toBe(false)
  expect(readFileSync(ancient).equals(ancientBytes)).toBe(true)
  expect(statSync(ancient).mtimeMs).toBeLessThan(Date.now() - 60_000)
  expect(ownerNames(ancientDir)).toEqual([`owner.${ancientToken}`])
})

it('gives the first turn to the lexicographically smaller token', async () => {
  const lockDir = lockPath()
  let releaseBoth: () => void = () => undefined
  const both = new Promise<void>((resolve) => {
    releaseBoth = resolve
  })
  let arrived = 0
  let smaller = ''
  let larger = ''
  const seam = async (): Promise<void> => {
    arrived += 1
    if (arrived === 2) {
      const tokens = ownerNames(lockDir)
        .map((name) => name.slice('owner.'.length))
        .sort()
      smaller = tokens[0] ?? ''
      larger = tokens[1] ?? ''
      releaseBoth()
    }
    if (arrived <= 2) await both
  }

  let inside = 0
  let maxInside = 0
  let releaseHolder: () => void = () => undefined
  const hold = new Promise<void>((resolve) => {
    releaseHolder = resolve
  })
  const order: string[] = []
  const run = (label: string) =>
    withFileLock(
      lockDir,
      async () => {
        inside += 1
        maxInside = Math.max(maxInside, inside)
        const present = ownerNames(lockDir)
          .map((name) => name.slice('owner.'.length))
          .sort()
        order.push(present[0] ?? label)
        if (order.length === 1) {
          expect(present).toEqual([smaller])
          await hold
        }
        inside -= 1
        return label
      },
      { beforeReaddir: seam, waitMs: 4_000, pollMs: 15, staleMs: 60_000 },
    )

  const first = run('a')
  const second = run('b')
  const started = Date.now()
  while (arrived < 2 && Date.now() - started < 1_000) await delay(10)
  expect(arrived).toBe(2)
  expect(smaller < larger).toBe(true)

  const sawHolder = Date.now()
  while (order.length < 1 && Date.now() - sawHolder < 2_000) await delay(10)
  expect(order).toEqual([smaller])
  expect(maxInside).toBe(1)
  releaseHolder()
  const results = await Promise.all([first, second])
  expect(results.sort()).toEqual(['a', 'b'])
  expect(order).toHaveLength(2)
  expect(order[0]).toBe(smaller)
  expect(maxInside).toBe(1)
  expect(existsSync(lockDir)).toBe(true)
})

it('advances the holder file mtime while fn runs', async () => {
  const lockDir = lockPath()
  const staleMs = 300
  let advanced = false
  await withFileLock(
    lockDir,
    async () => {
      const name = ownerNames(lockDir)[0]
      if (!name) throw new Error('expected the holder file')
      const full = join(lockDir, name)
      const before = statSync(full).mtimeMs
      await delay(staleMs)
      advanced = statSync(full).mtimeMs > before
    },
    { staleMs, waitMs: 2_000, pollMs: 20 },
  )
  expect(advanced).toBe(true)
  expect(existsSync(lockDir)).toBe(true)
  expect(ownerNames(lockDir)).toEqual([])
})

it('removes a same-host dead owner even when the body is empty or invalid', async () => {
  for (const body of ['', '{']) {
    const lockDir = lockPath()
    const pid = deadPid()
    const token = `${hostname()}.${String(pid)}.1.incomplete`
    mkdirSync(lockDir, { recursive: true })
    const dead = join(lockDir, `owner.${token}`)
    writeFileSync(dead, body, { mode: 0o600 })
    let entered = false
    await withFileLock(
      lockDir,
      () => {
        entered = true
        expect(existsSync(dead)).toBe(false)
      },
      { waitMs: 1_000, pollMs: 20 },
    )
    expect(entered).toBe(true)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(lockDir)).toBe(true)
  }
})

it('times out on an empty same-host owner whose pid is live', async () => {
  const lockDir = lockPath()
  const token = `${hostname()}.${String(process.pid)}.1.empty-live`
  mkdirSync(lockDir, { recursive: true })
  const live = join(lockDir, `owner.${token}`)
  writeFileSync(live, '', { mode: 0o600 })
  let entered = false
  await expect(
    withFileLock(
      lockDir,
      () => {
        entered = true
      },
      { waitMs: 250, pollMs: 20 },
    ),
  ).rejects.toBeInstanceOf(LockTimeout)
  expect(entered).toBe(false)
  expect(existsSync(live)).toBe(true)
  expect(readFileSync(live, 'utf8')).toBe('')
  expect(ownerNames(lockDir)).toEqual([`owner.${token}`])
})

it('removes an orphan publish file for a dead same-host pid', async () => {
  const lockDir = lockPath()
  const pid = deadPid()
  const token = `${hostname()}.${String(pid)}.1.partial`
  mkdirSync(lockDir, { recursive: true })
  const partial = join(lockDir, `.publish.${token}`)
  writeFileSync(partial, '', { mode: 0o600 })
  let entered = false
  await withFileLock(
    lockDir,
    () => {
      entered = true
      expect(existsSync(partial)).toBe(false)
    },
    { waitMs: 1_000, pollMs: 20 },
  )
  expect(entered).toBe(true)
  expect(existsSync(partial)).toBe(false)
  expect(ownerNames(lockDir)).toEqual([])
})

it('leaves a live same-host publish temp in place and still acquires', async () => {
  const lockDir = lockPath()
  const token = `${hostname()}.${String(process.pid)}.1.publishing`
  mkdirSync(lockDir, { recursive: true })
  const partial = join(lockDir, `.publish.${token}`)
  writeFileSync(partial, 'partial', { mode: 0o600 })
  await withFileLock(
    lockDir,
    () => {
      expect(existsSync(partial)).toBe(true)
      expect(readFileSync(partial, 'utf8')).toBe('partial')
    },
    { waitMs: 1_000, pollMs: 20 },
  )
  expect(existsSync(partial)).toBe(true)
  expect(ownerNames(lockDir)).toEqual([])
})

it('rethrows ENOSPC from writeFile and leaves no owner or publish file', async () => {
  const lockDir = lockPath()
  enospc.armed = true
  let entered = false
  await expect(
    withFileLock(
      lockDir,
      () => {
        entered = true
      },
      { waitMs: 1_000, pollMs: 20 },
    ),
  ).rejects.toMatchObject({ code: 'ENOSPC' })
  expect(entered).toBe(false)
  expect(enospc.armed).toBe(false)
  const names = readdirSync(lockDir).filter(
    (name) => name.startsWith('owner.') || name.startsWith('.publish.'),
  )
  expect(names).toEqual([])
})

it('removes the owner file when fn throws and keeps the directory', async () => {
  const lockDir = lockPath()
  await expect(
    withFileLock(lockDir, () => {
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')
  expect(existsSync(lockDir)).toBe(true)
  expect(ownerNames(lockDir)).toEqual([])

  let entered = false
  await withFileLock(lockDir, () => {
    entered = true
  })
  expect(entered).toBe(true)
  expect(existsSync(lockDir)).toBe(true)
})
