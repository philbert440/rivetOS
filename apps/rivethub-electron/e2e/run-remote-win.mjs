import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  connectThroughTunnel,
  freeLocalPort,
  openTunnel,
  parseLaunchOutput,
  profileSettings,
  requestQuit,
  requireSshHost,
  runPlaywright,
  ssh as sshTo,
  verifyBuild,
  watchSignals,
} from './remote-common.mjs'

// Windows-desktop variant of run-remote.mjs: the remote login shell is
// PowerShell, so each remote step is one PowerShell script shipped as
// `-EncodedCommand` (base64 of UTF-16LE). Nothing user-controlled is ever
// spliced into a command line; values land inside single-quoted PowerShell
// literals, which expand nothing, after passing a strict allow-list regex.
//
// This runner owns only its temporary profile/process. It does not install,
// update, or stop the user's regular RivetHub, and it never reads or writes
// the user's own profile beyond copying the three identity files out of it.
const host = requireSshHost()
const gateway = process.env.E2E_GATEWAY
if (!gateway) {
  throw new Error(
    'E2E_GATEWAY is required for the Windows runner (example: https://10.4.20.116:5174, as ' +
      'reached from the laptop). There is deliberately no default: a wrong default would point ' +
      'the test profile at a production node.',
  )
}
if (!/^https?:\/\/[A-Za-z0-9.\-[\]:]+(\/[A-Za-z0-9._~/-]*)?$/.test(gateway))
  throw new Error('Invalid E2E_GATEWAY (expected http(s)://host[:port][/path])')
new URL(gateway) // throws on anything the regex let through but WHATWG rejects

// Absolute Windows paths only; no quotes, no shell metacharacters, no `..`.
const winPath = /^[A-Za-z]:\\(?:[A-Za-z0-9 ._@()~-]+\\)*[A-Za-z0-9 ._@()~-]+$/
const binary = process.env.E2E_BINARY ?? ''
if (binary && (!winPath.test(binary) || !/\.exe$/i.test(binary)))
  throw new Error('Invalid E2E_BINARY (expected an absolute Windows path to RivetHub.exe)')
const identity = process.env.E2E_IDENTITY ?? ''
if (identity && !winPath.test(identity))
  throw new Error('Invalid E2E_IDENTITY (expected an absolute Windows directory path)')

const profileName = `rivethub-e2e-${randomUUID()}`
const settings = Buffer.from(JSON.stringify(profileSettings(gateway))).toString('base64')
/** PowerShell single-quoted literal: only the quote itself needs escaping. */
const psq = (value) => `'${String(value).replaceAll("'", "''")}'`
/** Run a PowerShell script remotely; stdout comes back as text. */
const ps = (script) =>
  sshTo(
    host,
    `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(
      script,
      'utf16le',
    ).toString('base64')}`,
  )
const port = await freeLocalPort()
let tunnel, browser, pid
const state = watchSignals()
await mkdir('artifacts', { recursive: true })

// Preamble shared by both remote scripts. $profile is a PowerShell automatic
// variable, so the temp profile is $e2eDir.
const preamble = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$e2eDir = Join-Path $env:TEMP ${psq(profileName)}
`
try {
  const output = await ps(`${preamble}
$binary = ${psq(binary)}
if (-not $binary) {
  # electron-builder's per-user NSIS target installs under
  # %LOCALAPPDATA%\\Programs\\<sanitized package name>; the folder name is
  # not stable across packaging changes, so prefer what Windows recorded.
  $entry = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'RivetHub*' } | Select-Object -First 1
  if ($entry -and $entry.InstallLocation) { $binary = Join-Path $entry.InstallLocation 'RivetHub.exe' }
  elseif ($entry -and $entry.DisplayIcon) { $binary = ($entry.DisplayIcon -replace ',-?\\d+$', '').Trim('"') }
  if (-not $binary) {
    $binary = Get-Process RivetHub -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path
  }
  if (-not $binary) { $binary = Join-Path $env:LOCALAPPDATA 'Programs\\@rivetosrivethub-electron\\RivetHub.exe' }
}
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "RivetHub binary not found: $binary" }
$identity = ${psq(identity)}
if (-not $identity) { $identity = Join-Path $env:APPDATA 'RivetHub\\mtls' }
foreach ($name in @('device.crt', 'device.key', 'ca.pem')) {
  if (-not (Test-Path -LiteralPath (Join-Path $identity $name) -PathType Leaf)) { throw "Identity file missing: $identity\\$name" }
}
if (Test-Path -LiteralPath $e2eDir) { throw "Profile directory already exists: $e2eDir" }
$null = New-Item -ItemType Directory -Path (Join-Path $e2eDir 'mtls')
foreach ($name in @('device.crt', 'device.key', 'ca.pem')) {
  Copy-Item -LiteralPath (Join-Path $identity $name) -Destination (Join-Path $e2eDir "mtls\\$name")
}
[IO.File]::WriteAllBytes((Join-Path $e2eDir 'settings.json'), [Convert]::FromBase64String(${psq(settings)}))
# Start-Process joins -ArgumentList with spaces and does not quote, so quote
# the path argument ourselves ($env:TEMP may contain spaces for other users).
# Launch through WMI, not Start-Process: a process started by the ssh
# session's shell lives in that session's job object and dies when the ssh
# command returns. Win32_Process.Create runs it outside the job, in the same
# (non-interactive, session 0) context, so it outlives this script. No GPU
# process in that context, so skip it rather than crash and fall back.
$cmdLine = ('"{0}" --user-data-dir="{1}" --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --disable-gpu' -f $binary, $e2eDir)
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = (Split-Path $binary) }
if ($created.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($created.ReturnValue)" }
$proc = Get-Process -Id $created.ProcessId
Write-Output $proc.Id
$portFile = Join-Path $e2eDir 'DevToolsActivePort'
for ($i = 0; $i -lt 60; $i++) {
  if ((Test-Path -LiteralPath $portFile) -and (Get-Item -LiteralPath $portFile).Length -gt 0) {
    $cdpPort = (Get-Content -LiteralPath $portFile -TotalCount 1).Trim()
    Write-Output $cdpPort
    Write-Output $binary
    # Probe the DevTools HTTP endpoint locally: a timeout here means Electron,
    # a timeout only through the tunnel means ssh forwarding.
    try {
      $probe = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri ("http://127.0.0.1:" + $cdpPort + "/json/version")
      Write-Output ("PROBE " + $probe.StatusCode)
    } catch { Write-Output ("PROBE-FAIL " + $_.Exception.Message) }
    exit 0
  }
  if ($proc.HasExited) { throw "RivetHub exited during startup with code $($proc.ExitCode)" }
  Start-Sleep -Seconds 1
}
throw 'RivetHub did not publish DevToolsActivePort within 60s'
`)
  const launched = parseLaunchOutput(output)
  pid = launched.pid
  const resolvedBinary = output.trim().split(/\r?\n/)[2] ?? binary
  console.log(output.trim().split(/\r?\n/).slice(3).join('\n'))
  tunnel = openTunnel(
    host,
    port,
    launched.remotePort,
    'powershell -NoProfile -NonInteractive -Command Start-Sleep -Seconds 7200',
  )
  const endpoint = `http://127.0.0.1:${port}`
  browser = await connectThroughTunnel(endpoint)
  await verifyBuild(browser, { host, platform: 'win32', binary: resolvedBinary, pid, gateway })
  await browser.close()
  browser = undefined
  if (state.interrupted) throw new Error('Test run interrupted')
  process.exitCode = await runPlaywright(endpoint, gateway, state)
  browser = await requestQuit(endpoint)
} finally {
  if (browser) await browser.close().catch(() => {})
  tunnel?.kill('SIGTERM')
  // Logs come back base64-encoded: the console code page (IBM437 on this
  // target) would otherwise mangle anything non-ASCII in main.log.
  const logs = await ps(`${preamble}
foreach ($rel in @('logs\\main.log')) {
  $path = Join-Path $e2eDir $rel
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    Write-Output ("LOG " + $rel + " " + [Convert]::ToBase64String([IO.File]::ReadAllBytes($path)))
  }
}
`).catch((error) => `LOGERR ${Buffer.from(String(error.message)).toString('base64')}`)
  await writeFile(
    'artifacts/desktop.log',
    logs
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [kind, ...rest] = line.split(' ')
        const name = kind === 'LOG' ? rest[0] : 'cleanup error'
        return `===== ${name} =====\n${Buffer.from(rest.at(-1) ?? '', 'base64')}\n`
      })
      .join(''),
  )
  // Stop only processes whose command line carries this exact profile dir
  // (Electron's helper processes inherit --user-data-dir, so this catches them
  // too; matching on the marker rather than the exe name also covers an
  // E2E_BINARY with a different file name). A different userData dir means a
  // different single-instance lock, so the user's own RivetHub never matches
  // and is never touched. Ask nicely first; -Force only for what is still
  // alive after that. The launched PID is recorded in build.json.
  await ps(`${preamble}
$marker = '--user-data-dir="' + $e2eDir + '"'
$mine = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) })
foreach ($p in $mine) {
  $live = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($live) { $null = $live.CloseMainWindow() }
}
for ($i = 0; $i -lt 10; $i++) {
  $alive = @($mine | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
  if ($alive.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
foreach ($p in $mine) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
# Belt and braces before a recursive delete: only ever remove the directory
# this run created under the user's own TEMP.
if ($e2eDir -like (Join-Path $env:TEMP 'rivethub-e2e-*') -and (Test-Path -LiteralPath $e2eDir)) {
  for ($i = 0; $i -lt 10; $i++) {
    try { Remove-Item -LiteralPath $e2eDir -Recurse -Force; break }
    catch { if ($i -eq 9) { throw } ; Start-Sleep -Milliseconds 500 }
  }
}
`)
}
