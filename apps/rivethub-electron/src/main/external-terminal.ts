/**
 * Launch the user's real terminal emulator onto a den PTY's tmux session
 * ("Open in your terminal").
 *
 * The renderer sends TermAttachInfo only — never argv. MAIN validates the
 * fields and builds the attach argv (same shape as the web attachArgv).
 * Resolution is pure given (platform, env, which, exists) so tests can
 * drive it with a fake PATH / Applications tree.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir as osTmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** $TERMINAL names/paths that may be used as the emulator binary. */
export const SAFE_ARGV_TOKEN = /^[A-Za-z0-9._@:=/-]+$/

export const SOCKET_RE = /^[\w.-]{1,64}$/
export const SESSION_RE = /^[\w.-]{1,128}$/
export const SSH_USER_RE = /^[a-z_][\w-]{0,31}$/
/** Hostname or IPv4; no `@`, no leading `-` (leading dash rejected below). */
export const HOST_RE = /^[\w.-]{1,253}$/

/** macOS .command is unlinked this long after spawn — enough for `open` to read it. */
export const MAC_COMMAND_UNLINK_MS = 60_000

/**
 * Same fields as `@rivetos/types` TermAttachInfo. Duplicated here because
 * the Electron shell does not depend on that package.
 */
export interface TermAttachInfo {
  socket: string
  session: string
  host: string
  sshUser: string
  local: boolean
}

export type WhichFn = (cmd: string) => string | undefined
export type ExistsFn = (path: string) => boolean

export type Launcher =
  | {
      kind: 'argv'
      /** Program path or name (from `which`, or $TERMINAL if absolute). */
      command: string
      /** Per-emulator exec flags inserted before the user argv. */
      prefix: string[]
    }
  | {
      kind: 'mac-command'
      /** App name for `open -a`. */
      app: string
    }
  | {
      /** `cmd /c start "" <argv>` when Windows Terminal is absent. */
      kind: 'win-cmd-start'
    }

/** Linux candidate list after $TERMINAL / xdg-terminal-exec / x-terminal-emulator. */
export const LINUX_TERMINAL_CANDIDATES = [
  'ghostty',
  'kitty',
  'wezterm',
  'alacritty',
  'foot',
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'xterm',
] as const

function field(raw: Record<string, unknown>, name: string, re: RegExp): string {
  const v = raw[name]
  if (typeof v !== 'string' || v.startsWith('-') || !re.test(v)) {
    throw new Error(`invalid attach field: ${name}`)
  }
  return v
}

/** Validate a renderer-supplied attach descriptor. Rejects argv arrays. */
export function parseTermAttach(raw: unknown): TermAttachInfo {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('attach must be a TermAttachInfo object')
  }
  const o = raw as Record<string, unknown>
  const socket = field(o, 'socket', SOCKET_RE)
  const session = field(o, 'session', SESSION_RE)
  const host = field(o, 'host', HOST_RE)
  const sshUser = field(o, 'sshUser', SSH_USER_RE)
  if (typeof o.local !== 'boolean') {
    throw new Error('invalid attach field: local')
  }
  return { socket, session, host, sshUser, local: o.local }
}

/** Same argv the web `attachArgv` builds. The `=` session prefix is added here. */
export function attachArgv(attach: TermAttachInfo): string[] {
  const tmux = ['tmux', '-L', attach.socket, 'attach-session', '-t', '=' + attach.session]
  if (attach.local) return tmux
  return ['ssh', '-t', attach.sshUser + '@' + attach.host, ...tmux]
}

function binBasename(bin: string): string {
  const base = bin.split(/[/\\]/).pop() ?? bin
  return base.replace(/\.exe$/i, '').toLowerCase()
}

/**
 * Exec flags for a terminal binary. Unknown names get `-e` (the common
 * xterm-ish convention) so a custom $TERMINAL still runs the attach argv.
 */
export function execPrefixFor(bin: string): string[] {
  switch (binBasename(bin)) {
    case 'kitty':
    case 'foot':
    case 'xdg-terminal-exec':
      return []
    case 'wezterm':
      return ['start', '--']
    case 'gnome-terminal':
      return ['--']
    case 'xfce4-terminal':
      return ['-x']
    case 'ghostty':
    case 'alacritty':
    case 'konsole':
    case 'xterm':
    case 'x-terminal-emulator':
    default:
      return ['-e']
  }
}

/**
 * Pick a launcher. `which` / `exists` are injected (PATH + app-bundle
 * lookup in production).
 * Linux: $TERMINAL → xdg-terminal-exec → x-terminal-emulator → candidates.
 * macOS: /Applications/Ghostty.app → iTerm.app → Terminal.app.
 * Windows: wt.exe `new-tab --` argv, else cmd /c start "" argv.
 */
export function resolveTerminalLauncher(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  which: WhichFn,
  exists: ExistsFn = existsSync,
): Launcher | undefined {
  if (platform === 'linux') {
    const raw = env.TERMINAL?.trim() ?? ''
    if (raw && SAFE_ARGV_TOKEN.test(raw)) {
      const resolved = which(raw)
      if (resolved) {
        return { kind: 'argv', command: resolved, prefix: execPrefixFor(raw) }
      }
    }
    const xdg = which('xdg-terminal-exec')
    if (xdg) return { kind: 'argv', command: xdg, prefix: execPrefixFor('xdg-terminal-exec') }
    const xte = which('x-terminal-emulator')
    if (xte) return { kind: 'argv', command: xte, prefix: execPrefixFor('x-terminal-emulator') }
    for (const name of LINUX_TERMINAL_CANDIDATES) {
      const found = which(name)
      if (found) return { kind: 'argv', command: found, prefix: execPrefixFor(name) }
    }
    return undefined
  }

  if (platform === 'darwin') {
    if (exists('/Applications/Ghostty.app')) return { kind: 'mac-command', app: 'Ghostty' }
    if (exists('/Applications/iTerm.app')) return { kind: 'mac-command', app: 'iTerm' }
    return { kind: 'mac-command', app: 'Terminal' }
  }

  if (platform === 'win32') {
    const wt = which('wt.exe') ?? which('wt')
    if (wt) return { kind: 'argv', command: wt, prefix: ['new-tab', '--'] }
    return { kind: 'win-cmd-start' }
  }

  return undefined
}

/** `{tmpdir}/rivet-attach-{id}.command` — exported so tests can assert the shape. */
export function macCommandPath(tmpDir: string, id: string): string {
  return join(tmpDir, `rivet-attach-${id}.command`)
}

/** POSIX single-quote; same escaping as the web `shellQuote`. */
export function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`
}

/** Contents of the macOS `.command` wrapper. Every token is single-quoted. */
export function macCommandScript(argv: readonly string[]): string {
  return `#!/bin/sh\nexec ${argv.map(shellQuote).join(' ')}\n`
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { detached: true; stdio: 'ignore' },
) => {
  unref(): void
  on?(event: 'error' | 'spawn', cb: (err: Error) => void): void
}

export interface OpenInTerminalIo {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  which: WhichFn
  exists: ExistsFn
  spawn: SpawnFn
  writeFileSync: (
    file: string,
    data: string,
    opts?: { encoding?: BufferEncoding; mode?: number; flag?: string },
  ) => void
  unlinkSync: (file: string) => void
  tmpdir: () => string
  randomId: () => string
  setTimeout: (fn: () => void, ms: number) => { unref?: () => void }
}

function whichOnPath(
  cmd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (!cmd) return undefined
  if (cmd.includes('/') || cmd.includes('\\')) return existsSync(cmd) ? cmd : undefined
  const pathVal = env.PATH ?? env.Path ?? ''
  const dirs = pathVal.split(delimiter).filter(Boolean)
  const exts =
    platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const dir of dirs) {
    const direct = join(dir, cmd)
    if (existsSync(direct)) return direct
    for (const ext of exts) {
      if (!ext) continue
      const withExt = join(dir, cmd + ext)
      if (existsSync(withExt)) return withExt
    }
  }
  return undefined
}

function defaultIo(): OpenInTerminalIo {
  return {
    platform: process.platform,
    env: process.env,
    which: (cmd) => whichOnPath(cmd, process.env, process.platform),
    exists: existsSync,
    spawn: spawn as unknown as SpawnFn,
    writeFileSync,
    unlinkSync,
    tmpdir: osTmpdir,
    randomId: () => randomBytes(8).toString('hex'),
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms)
      t.unref()
      return t
    },
  }
}

function launch(command: string, args: string[], spawnFn: SpawnFn): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<SpawnFn>
    try {
      child = spawnFn(command, args, { detached: true, stdio: 'ignore' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reject(new Error(`failed to launch ${command}: ${message}`))
      return
    }
    let settled = false
    const succeed = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(new Error(`failed to launch ${command}: ${err.message}`))
    }
    child.on?.('error', fail)
    child.on?.('spawn', succeed)
    child.unref()
  })
}

/**
 * Validate attach fields, resolve a launcher, spawn detached. Optional `io`
 * is for tests; production callers pass the renderer payload only.
 */
export async function openInTerminal(
  attach: unknown,
  io: Partial<OpenInTerminalIo> = {},
): Promise<void> {
  const info = parseTermAttach(attach)
  const argv = attachArgv(info)
  const x: OpenInTerminalIo = { ...defaultIo(), ...io }
  const launcher = resolveTerminalLauncher(x.platform, x.env, x.which, x.exists)
  if (!launcher) throw new Error('no terminal emulator found')

  if (launcher.kind === 'argv') {
    await launch(launcher.command, [...launcher.prefix, ...argv], x.spawn)
    return
  }
  if (launcher.kind === 'win-cmd-start') {
    const comspec = x.env.ComSpec ?? 'cmd.exe'
    await launch(comspec, ['/c', 'start', '', ...argv], x.spawn)
    return
  }

  const file = macCommandPath(x.tmpdir(), x.randomId())
  x.writeFileSync(file, macCommandScript(argv), { encoding: 'utf8', mode: 0o700, flag: 'wx' })
  const t = x.setTimeout(() => {
    try {
      x.unlinkSync(file)
    } catch {
      /* already gone */
    }
  }, MAC_COMMAND_UNLINK_MS)
  t.unref?.()
  try {
    await launch('open', ['-a', launcher.app, file], x.spawn)
  } catch (err) {
    try {
      x.unlinkSync(file)
    } catch {
      /* already gone */
    }
    throw err
  }
}
