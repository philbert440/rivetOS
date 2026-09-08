/**
 * RivetHub desktop identity install + extra-device PKCS#12 minting.
 *
 * Electron `identityDir()` is `<userData>/mtls/{device.crt,device.key,ca.pem}`
 * (`apps/rivethub-electron/src/main/index.ts`).
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFailed, execFileAsync } from './harness-detect.js'
import { issueClientDevice, localCaPaths } from './local-ca.js'

export function rivethubUserDataDir(
  platform: NodeJS.Platform,
  home: string,
  appData?: string,
): string {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'RivetHub')
  }
  if (platform === 'win32') {
    const roaming = appData?.trim() || join(home, 'AppData', 'Roaming')
    return join(roaming, 'RivetHub')
  }
  return join(home, '.config', 'RivetHub')
}

export function rivethubMtlsDir(platform: NodeJS.Platform, home: string, appData?: string): string {
  return join(rivethubUserDataDir(platform, home, appData), 'mtls')
}

function chmod600(path: string): void {
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows may ignore mode bits
  }
}

export interface InstallDesktopIdentityOpts {
  home?: string
  hostname: string
  platform?: NodeJS.Platform
  appData?: string
}

export interface InstalledDesktopIdentity {
  destDir: string
  cert: string
  key: string
  ca: string
  /** Previous RivetHub mtls copied aside before overwrite, if any. */
  preservedDir?: string
}

/**
 * Copy the desktop leaf + key + chain into RivetHub's userData mtls dir.
 */
export function installDesktopIdentity(opts: InstallDesktopIdentityOpts): InstalledDesktopIdentity {
  const home = opts.home ?? homedir()
  const platform = opts.platform ?? process.platform
  const paths = localCaPaths(home)
  const desktopId = `desktop-${opts.hostname}`
  const srcCert = join(paths.sharedDir, 'issued', `device-${desktopId}.crt`)
  const srcKey = join(paths.sharedDir, 'issued', `device-${desktopId}.key`)
  const srcCa = existsSync(paths.caChainPem) ? paths.caChainPem : paths.chainPem
  if (!existsSync(srcCert) || !existsSync(srcKey)) {
    throw new Error(`desktop identity missing (${srcCert}) — run ensureLocalCa first`)
  }
  if (!existsSync(srcCa)) {
    throw new Error(`CA chain missing (${srcCa}) — run ensureLocalCa first`)
  }
  const destDir = rivethubMtlsDir(platform, home, opts.appData)
  mkdirSync(destDir, { recursive: true })
  const cert = join(destDir, 'device.crt')
  const key = join(destDir, 'device.key')
  const ca = join(destDir, 'ca.pem')
  let preservedDir: string | undefined
  if (existsSync(cert) || existsSync(key) || existsSync(ca)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    preservedDir = join(destDir, `previous-${stamp}`)
    mkdirSync(preservedDir, { recursive: true })
    if (existsSync(cert)) copyFileSync(cert, join(preservedDir, 'device.crt'))
    if (existsSync(key)) copyFileSync(key, join(preservedDir, 'device.key'))
    if (existsSync(ca)) copyFileSync(ca, join(preservedDir, 'ca.pem'))
  }
  copyFileSync(srcCert, cert)
  copyFileSync(srcKey, key)
  copyFileSync(srcCa, ca)
  chmod600(cert)
  chmod600(key)
  chmod600(ca)
  return { destDir, cert, key, ca, preservedDir }
}

export function generateDevicePassphrase(): string {
  return randomBytes(18).toString('base64url')
}

export interface MintDeviceP12Opts {
  home?: string
  name: string
  passphrase?: string
  exec?: typeof execFileAsync
  scriptPath?: string
  root?: string | null
}

export interface MintedDeviceP12 {
  id: string
  cert: string
  key: string
  p12Path: string
  passphrase: string
}

/**
 * `issue-client <name>` then `openssl pkcs12 -export` into
 * `~/.rivetos/devices/<name>.p12`. Passphrase is generated and returned
 * once — the QR flow in PR 6 replaces hand-minting.
 */
export async function mintDeviceP12(opts: MintDeviceP12Opts): Promise<MintedDeviceP12> {
  const home = opts.home ?? homedir()
  const issued = await issueClientDevice({
    home,
    name: opts.name,
    exec: opts.exec,
    scriptPath: opts.scriptPath,
    root: opts.root,
  })
  const paths = localCaPaths(home)
  const chain = existsSync(paths.caChainPem) ? paths.caChainPem : paths.chainPem
  const devicesDir = join(home, '.rivetos', 'devices')
  mkdirSync(devicesDir, { recursive: true })
  const p12Path = join(devicesDir, `${opts.name}.p12`)
  const passphrase = opts.passphrase ?? generateDevicePassphrase()
  const exec = opts.exec ?? execFileAsync
  const args = [
    'pkcs12',
    '-export',
    '-inkey',
    issued.key,
    '-in',
    issued.cert,
    '-out',
    p12Path,
    '-passout',
    'env:RIVETOS_P12_PASS',
  ]
  if (existsSync(chain)) {
    args.push('-certfile', chain)
  }
  const result = await exec('openssl', args, {
    timeoutMs: 15_000,
    env: { ...process.env, RIVETOS_P12_PASS: passphrase },
  })
  if (execFailed(result)) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 400)
    throw new Error(`openssl pkcs12 -export failed for ${opts.name}: ${detail}`)
  }
  chmod600(p12Path)
  return { id: issued.id, cert: issued.cert, key: issued.key, p12Path, passphrase }
}

export function extraDeviceP12Path(home: string, name: string): string {
  return join(home, '.rivetos', 'devices', `${name}.p12`)
}

/** Used by `local reset` — identity dirs under `~/.rivetos` only. */
export function identityPathsToReset(home: string): string[] {
  return [
    join(home, '.rivetos', 'ca'),
    join(home, '.rivetos', 'shared', 'rivet-ca'),
    join(home, '.rivetos', 'devices'),
  ]
}
