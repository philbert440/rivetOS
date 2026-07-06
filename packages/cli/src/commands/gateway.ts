/**
 * `rivetos gateway` — gateway (embedded den) helpers.
 *
 *   rivetos gateway token           print the per-node gateway token
 *   rivetos gateway token --rotate  mint a new token (old clients 401 until
 *                                   they pick up the new one)
 *
 * The token lives at ~/.rivetos/gateway.token (0600). It is only consulted
 * when the gateway binds a non-loopback host without an explicit den.token
 * in config — loopback binds run tokenless (private-LAN posture).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const TOKEN_FILE = join(homedir(), '.rivetos', 'gateway.token')

export default function gateway(): void {
  const args = process.argv.slice(3)
  const sub = args[0]

  if (sub !== 'token') {
    console.log('Usage: rivetos gateway token [--rotate]')
    process.exitCode = sub ? 1 : 0
    return
  }

  const rotate = args.includes('--rotate')
  if (!rotate && existsSync(TOKEN_FILE)) {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (token) {
      console.log(token)
      return
    }
  }

  mkdirSync(join(homedir(), '.rivetos'), { recursive: true })
  const token = randomBytes(24).toString('base64url')
  writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
  if (rotate) {
    console.error('rotated — restart rivetos so the gateway picks up the new token')
  }
  console.log(token)
}
