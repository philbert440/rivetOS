/**
 * macOS LaunchAgent for `rivetos local` (Linux uses the systemd user unit).
 *
 * Plist: `~/Library/LaunchAgents/dev.rivetos.node.plist`
 * bootstrap: `launchctl bootstrap gui/$UID <plist>`
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseRivetEnv } from './env-file.js'
import { execFailed, execFileAsync, type ExecResult } from './harness-detect.js'

export const LAUNCHD_LABEL = 'dev.rivetos.node'

export function launchdPlistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface LaunchdPlistOpts {
  nodePath: string
  cliEntry: string
  workingDir: string
  env: Record<string, string>
  label?: string
  /** stdout/stderr log dir (default: workingDir). Prefer ~/.rivetos/logs. */
  logDir?: string
}

export function renderLaunchdPlist(opts: LaunchdPlistOpts): string {
  const label = opts.label ?? LAUNCHD_LABEL
  const args = [opts.nodePath, opts.cliEntry, 'start']
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n')
  const envLines = Object.entries(opts.env)
    .filter(([k, v]) => k && v !== undefined)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join('\n')
  const logDir = opts.logDir ?? opts.workingDir
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(opts.workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envLines}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`
}

export function envFileToRecord(contents: string): Record<string, string> {
  return parseRivetEnv(contents)
}

export async function installLaunchdAgent(opts: {
  home?: string
  uid?: number
  nodePath: string
  cliEntry: string
  workingDir: string
  env: Record<string, string>
  exec?: typeof execFileAsync
  logDir?: string
}): Promise<{ plistPath: string }> {
  const home = opts.home ?? homedir()
  const plistPath = launchdPlistPath(home)
  mkdirSync(dirname(plistPath), { recursive: true })
  const logDir = opts.logDir ?? join(home, '.rivetos', 'logs')
  mkdirSync(logDir, { recursive: true })
  const body = renderLaunchdPlist({
    nodePath: opts.nodePath,
    cliEntry: opts.cliEntry,
    workingDir: opts.workingDir,
    env: opts.env,
    logDir,
  })
  writeFileSync(plistPath, body, { encoding: 'utf-8', mode: 0o600 })
  try {
    chmodSync(plistPath, 0o600)
  } catch {
    // Windows may ignore mode bits
  }

  const uid = opts.uid ?? process.getuid?.() ?? 0
  const domain = `gui/${String(uid)}`
  const exec = opts.exec ?? execFileAsync
  const bootout = await exec('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], {
    timeoutMs: 10_000,
  })
  void bootout
  const enable = await exec('launchctl', ['enable', `${domain}/${LAUNCHD_LABEL}`], {
    timeoutMs: 10_000,
  })
  if (execFailed(enable)) {
    const detail = (enable.stderr || enable.stdout).trim().slice(0, 400)
    throw new Error(`launchctl enable failed: ${detail}`)
  }
  const boot = await exec('launchctl', ['bootstrap', domain, plistPath], { timeoutMs: 15_000 })
  if (execFailed(boot)) {
    const kick = await exec('launchctl', ['kickstart', '-k', `${domain}/${LAUNCHD_LABEL}`], {
      timeoutMs: 10_000,
    })
    if (execFailed(kick)) {
      const detail = (boot.stderr || boot.stdout || kick.stderr).trim().slice(0, 400)
      throw new Error(`launchctl bootstrap failed: ${detail}`)
    }
  }
  return { plistPath }
}

function launchctlAbsent(result: ExecResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase()
  return (
    result.code === 5 ||
    text.includes('not found') ||
    text.includes('not loaded') ||
    text.includes('could not find') ||
    text.includes('could not be found')
  )
}

export async function stopLaunchdAgent(opts: {
  uid?: number
  exec?: typeof execFileAsync
}): Promise<void> {
  const uid = opts.uid ?? process.getuid?.() ?? 0
  const exec = opts.exec ?? execFileAsync
  const domain = `gui/${String(uid)}`
  const bootout = await exec('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], {
    timeoutMs: 10_000,
  })
  const disable = await exec('launchctl', ['disable', `${domain}/${LAUNCHD_LABEL}`], {
    timeoutMs: 10_000,
  })
  if (execFailed(bootout) && !launchctlAbsent(bootout)) {
    throw new Error(
      `launchctl bootout failed: ${(bootout.stderr || bootout.stdout).trim().slice(0, 300)}`,
    )
  }
  if (execFailed(disable) && !launchctlAbsent(disable)) {
    throw new Error(
      `launchctl disable failed: ${(disable.stderr || disable.stdout).trim().slice(0, 300)}`,
    )
  }
}
