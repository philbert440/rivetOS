/**
 * `rivetos pair <device>` — pair a phone by QR on a node that is already set
 * up (a mesh node like one whose memory lives on a datahub), without
 * `rivetos local`, which rewrites config.yaml for a single-machine install.
 *
 *   rivetos pair <device> [--user <id>] [--host <ip|name>] [--config <path>]
 *                         [--users-file <path>] [--json]
 *
 * It only writes what pairing needs, never config.yaml:
 *   1. mints the device certificate from the node's CA into
 *      ~/.rivetos/devices/<device>.p12 (lib/hub-identity.ts),
 *   2. adds the device to its user's `devices` in users.json (the owner by
 *      default) when that file exists — den loads users.json at boot, so a
 *      newly added device needs a den restart before the phone can use the
 *      API. Without the file tenancy is off and every device the CA issues
 *      is already allowed; creating one here would switch tenancy on and
 *      lock out the node's other devices, so none is created,
 *   3. writes the one-time pairing record (lib/pairing.ts) and prints the QR:
 *      `https://<LAN address>:<den.port>`, the token, and the SHA-256 of the
 *      certificate den actually serves (`den.tls_cert`).
 *
 * `--json` prints the result (QR text included) as one JSON line instead of
 * the terminal QR — how den's Settings → Pair a phone runs this command, so
 * minting lives in one place. Errors print as `{"error": …}` and exit 1.
 *
 * Den redeems the QR at POST /api/devices/pair (services/den-server/src/pairing.ts).
 * A name that already has a certificate is refused, so pairing never touches
 * an existing device's key; a still-pending pairing for the name is re-shown.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { execFileAsync } from '../lib/harness-detect.js'
import { mintDeviceP12 } from '../lib/hub-identity.js'
import { listBannerLanIpv4, localCaPaths } from '../lib/local-ca.js'
import {
  armPairing,
  certSha256,
  createPairing,
  PAIRING_TTL_MS,
  pairingQrText,
  renderTerminalQr,
} from '../lib/pairing.js'
import { defaultFile, load, save } from './user.js'

const USAGE =
  'usage: rivetos pair <device> [--user <id>] [--host <ip|name>] [--config <path>] [--users-file <path>] [--json]'

/** Same charset the CA accepts for a client leaf name. */
const DEVICE_NAME = /^[A-Za-z0-9._-]+$/

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const DEFAULT_DEN_PORT = 5174

export interface DenPairingTarget {
  port: number
  tlsCert: string
}

/**
 * The den settings pairing depends on, from config.yaml. Throws with the
 * reason when this node cannot pair a phone: den off, bound to loopback, or
 * serving without TLS (the phone pins the TLS leaf).
 */
export function readDenForPairing(configYaml: string): DenPairingTarget {
  const cfg = (parseYaml(configYaml) ?? {}) as {
    den?: { enabled?: boolean; host?: string; port?: number; tls_cert?: string }
  }
  const den = cfg.den
  if (!den || den.enabled === false) throw new Error('den is not enabled in config.yaml')
  if (den.host && LOOPBACK_HOSTS.has(den.host)) {
    throw new Error(`den is bound to ${den.host}; a phone cannot reach it`)
  }
  const tlsCert = den.tls_cert?.trim()
  if (!tlsCert) throw new Error('den.tls_cert is not set; the phone pins den’s TLS certificate')
  return { port: typeof den.port === 'number' ? den.port : DEFAULT_DEN_PORT, tlsCert }
}

export interface PairDeps {
  home?: string
  configPath?: string
  usersFile?: string
  lanAddrs?: string[]
  exec?: typeof execFileAsync
  scriptPath?: string
  now?: number
  log?: (line: string) => void
  /** Skip the terminal QR and notes (the `--json` path). */
  quiet?: boolean
}

export interface PairResult {
  deviceId: string
  gateway: string
  /** True when users.json gained the device (den needs a restart to see it). */
  addedToUsers: boolean
  /** True when a still-pending pairing was re-shown instead of minting. */
  reshown: boolean
  /** Unix ms after which the QR no longer redeems. */
  expiresAt: number
  qrText: string
}

export async function runPair(
  deviceId: string,
  opts: { user?: string; host?: string },
  deps: PairDeps = {},
): Promise<PairResult> {
  const home = deps.home ?? homedir()
  const log = deps.log ?? ((line: string) => console.log(line))
  if (!DEVICE_NAME.test(deviceId)) {
    throw new Error(`device name "${deviceId}" may only use letters, digits, ".", "_" and "-"`)
  }

  const configPath =
    deps.configPath ?? process.env.RIVETOS_CONFIG ?? join(home, '.rivetos', 'config.yaml')
  const den = readDenForPairing(readFileSync(configPath, 'utf-8'))
  const pin = certSha256(readFileSync(den.tlsCert, 'utf-8'))
  const host = opts.host ?? (deps.lanAddrs ?? listBannerLanIpv4())[0]
  if (!host) throw new Error('no LAN address found; pass --host <ip> the phone can reach')
  const gateway = `https://${host}:${String(den.port)}`

  // A pending pairing (minted, not yet redeemed) is re-shown with a fresh TTL.
  let rec = armPairing(home, deviceId, deps.now)
  const reshown = rec !== null
  if (!rec) {
    const issued = join(localCaPaths(home).sharedDir, 'issued')
    const existing = [`device-${deviceId}.crt`, `device-${deviceId}.key`]
      .map((f) => join(issued, f))
      .filter((f) => existsSync(f))
    if (existing.length > 0) {
      throw new Error(
        `"${deviceId}" already has a certificate (${existing.join(', ')}); ` +
          'pick a new device name so its key is left alone',
      )
    }
    const minted = await mintDeviceP12({
      home,
      name: deviceId,
      exec: deps.exec,
      scriptPath: deps.scriptPath,
    })
    rec = createPairing({
      home,
      deviceId,
      p12Path: minted.p12Path,
      passphrase: minted.passphrase,
      now: deps.now,
    })
  }

  const usersFile = deps.usersFile ?? defaultFile()
  let addedToUsers = false
  let userId = opts.user ?? ''
  if (existsSync(usersFile)) {
    const registry = load(usersFile)
    userId = opts.user ?? registry.ownerUserId
    const user = registry.users[userId] ?? { id: userId, devices: [] }
    addedToUsers = !user.devices.includes(deviceId)
    if (addedToUsers) {
      user.devices.push(deviceId)
      registry.users[userId] = user
      save(usersFile, registry)
    }
  }

  const qrText = pairingQrText({ gateway, token: rec.token, certSha256: pin })
  const result = { deviceId, gateway, addedToUsers, reshown, expiresAt: rec.expiresAt, qrText }
  if (deps.quiet) return result
  const minutes = String(Math.round(PAIRING_TTL_MS / 60_000))
  log('')
  log(`  Pair ${deviceId}: open RivetHub on the phone → Scan pairing QR`)
  log(`  (${gateway}, one use, expires in ${minutes} min)`)
  log('')
  log(await renderTerminalQr(qrText))
  if (addedToUsers) {
    log(`  Added ${deviceId} to ${userId} in ${usersFile}.`)
    log('  Den reads users.json at startup: restart it before the phone connects,')
    log('  e.g. systemctl --user restart rivetos.service')
  }
  return result
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i < 0 ? undefined : args[i + 1]
}

export default async function pairCommand(args: string[]): Promise<void> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE)
    return
  }
  const deviceId = args[0]
  if (!deviceId || deviceId.startsWith('-')) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }
  const asJson = args.includes('--json')
  try {
    const result = await runPair(
      deviceId,
      { user: argValue(args, '--user'), host: argValue(args, '--host') },
      {
        configPath: argValue(args, '--config'),
        usersFile: argValue(args, '--users-file'),
        quiet: asJson,
      },
    )
    if (asJson) console.log(JSON.stringify(result))
  } catch (err) {
    const message = (err as Error).message
    if (asJson) console.log(JSON.stringify({ error: message }))
    else console.error(`[pair] ${message}`)
    process.exitCode = 1
  }
}
