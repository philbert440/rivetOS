import type { TermAttachInfo } from '@rivetos/types'

/**
 * Build the argv (and a copy-pasteable command string) that attaches an
 * external emulator to a den PTY's tmux session. The attach descriptor never
 * contains argv/env — those are derived here. Electron main duplicates
 * attachArgv and is the spawn trust boundary; this module is the copy-string
 * path.
 */

export type TermAttachFields = TermAttachInfo

/** Tokens that do not need POSIX quoting in the copy-to-clipboard fallback. */
const SAFE_SHELL_TOKEN = /^[A-Za-z0-9._@:=/-]+$/

/** `user@host`. IPv6 must be bare — OpenSSH only strips brackets in
 *  `[host]:port` / `ssh://` contexts, so `user@[v6]` fails to resolve. */
export function sshDest(user: string, host: string): string {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  return user + '@' + h
}

export function attachArgv(attach: TermAttachFields): string[] {
  const tmux = ['tmux', '-L', attach.socket, 'attach-session', '-t', '=' + attach.session]
  if (attach.local) return tmux
  return ['ssh', '-t', sshDest(attach.sshUser, attach.host), ...tmux]
}

/** POSIX single-quote tokens that are not already safe. */
export function shellQuote(token: string): string {
  if (SAFE_SHELL_TOKEN.test(token)) return token
  return `'${token.replace(/'/g, `'\\''`)}'`
}

export function attachCommandString(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}
