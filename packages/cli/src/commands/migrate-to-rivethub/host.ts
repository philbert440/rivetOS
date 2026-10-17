/**
 * Everything `migrate-to-rivethub` does to the machine goes through Host, so
 * the preflight, the plan and the executor are testable with a fake (the
 * same idea as the probes `detectDeployment` takes) and a dry run cannot
 * touch anything by construction.
 */

import { spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, userInfo } from 'node:os'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export type PathKind = 'dir' | 'file' | 'symlink' | 'missing' | 'other'

export interface RunOptions {
  timeoutMs?: number
  /** Extra environment for the child (merged over process.env). */
  env?: Record<string, string>
  /** Stream output to the terminal instead of capturing it. */
  inherit?: boolean
}

export interface Host {
  /** This process (written into the run lock). */
  pid: number
  home: string
  uid: number
  user: string
  platform: string
  arch: string
  env: Record<string, string | undefined>
  /** Run a bash command. Never throws; a spawn failure is code 127. */
  run(cmd: string, opts?: RunOptions): RunResult
  kind(path: string): PathKind
  readText(path: string): string | undefined
  readLink(path: string): string | undefined
  writable(path: string): boolean
  ownerUid(path: string): number | undefined
  mkdirp(path: string): void
  writeFile(path: string, data: string | Uint8Array, mode: number): void
  /** Create a file that must not exist yet; false when it already does. */
  createExclusive(path: string, data: string, mode: number): boolean
  copyExecutable(from: string, to: string): void
  rename(from: string, to: string): void
  symlink(target: string, path: string): void
  remove(path: string): void
  download(url: string): Promise<Uint8Array>
  /** Dump the PGlite memory tables (engine must be stopped); rows per table. */
  dumpPglite(configPath: string, outPath: string): Promise<Record<string, number>>
  now(): Date
  sleep(ms: number): Promise<void>
  log(line: string): void
  error(line: string): void
}

export function realHost(): Host {
  const home = process.env.HOME ?? homedir()
  let user = process.env.USER ?? ''
  try {
    user = userInfo().username
  } catch {
    // keep $USER
  }
  return {
    pid: process.pid,
    home,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    user,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    run(cmd, opts = {}) {
      const res = spawnSync('bash', ['-c', cmd], {
        encoding: 'utf-8',
        timeout: opts.timeoutMs ?? 120_000,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      })
      if (res.error) return { code: 127, stdout: '', stderr: res.error.message }
      return {
        code: res.status ?? 1,
        stdout: typeof res.stdout === 'string' ? res.stdout : '',
        stderr: typeof res.stderr === 'string' ? res.stderr : '',
      }
    },
    kind(path) {
      try {
        const st = lstatSync(path)
        if (st.isSymbolicLink()) return 'symlink'
        if (st.isDirectory()) return 'dir'
        if (st.isFile()) return 'file'
        return 'other'
      } catch {
        return 'missing'
      }
    },
    readText(path) {
      try {
        return readFileSync(path, 'utf-8')
      } catch {
        return undefined
      }
    },
    readLink(path) {
      try {
        return readlinkSync(path)
      } catch {
        return undefined
      }
    },
    writable(path) {
      try {
        accessSync(path, constants.W_OK)
        return true
      } catch {
        return false
      }
    },
    ownerUid(path) {
      try {
        return statSync(path).uid
      } catch {
        return undefined
      }
    },
    mkdirp(path) {
      mkdirSync(path, { recursive: true })
    },
    writeFile(path, data, mode) {
      writeFileSync(path, data, { mode })
      chmodSync(path, mode)
    },
    createExclusive(path, data, mode) {
      try {
        writeFileSync(path, data, { mode, flag: 'wx' })
        return true
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw err
      }
    },
    copyExecutable(from, to) {
      const tmp = `${to}.${String(process.pid)}.tmp`
      copyFileSync(from, tmp)
      chmodSync(tmp, 0o755)
      renameSync(tmp, to)
    },
    rename(from, to) {
      renameSync(from, to)
    },
    symlink(target, path) {
      symlinkSync(target, path)
    },
    remove(path) {
      rmSync(path, { force: true })
    },
    async download(url) {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${String(res.status)}`)
      return new Uint8Array(await res.arrayBuffer())
    },
    async dumpPglite(configPath, outPath) {
      const { dumpPgliteMemory } = await import('./pglite-dump.js')
      return (await dumpPgliteMemory(configPath, outPath)).rows
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => {
      console.log(line)
    },
    error: (line) => {
      console.error(line)
    },
  }
}
