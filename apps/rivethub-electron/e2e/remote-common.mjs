// Shared by run-remote.mjs (Linux desktop) and run-remote-win.mjs (Windows
// desktop). Everything here is platform-neutral: the SSH transport, the CDP
// tunnel, the build-stamp check, and the Playwright child. Launch and cleanup
// stay in the per-platform runner because that is where the shells differ.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

/** `E2E_SSH` is required; there is no default host. */
export function requireSshHost() {
  const host = process.env.E2E_SSH
  if (!host) {
    throw new Error(
      'E2E_SSH is required (example: user@host). No default SSH target is configured.',
    )
  }
  if (!/^[a-zA-Z0-9_.@-]+$/.test(host) || host.startsWith('-')) throw new Error('Invalid E2E_SSH')
  return host
}

export const command = (bin, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${bin} exited ${code}: ${stderr}\n${stdout}`)),
    )
  })

/** One non-interactive SSH command; `script` is handed to the remote login shell. */
export const ssh = (host, script) =>
  command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, script])

/** A free loopback port for the local end of the debugging tunnel. */
export const freeLocalPort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })

/** settings.json for the temporary profile; the marker is what fixtures.mjs checks. */
export const profileSettings = (gateway) => ({
  'rivethub.e2eProfile': true,
  'rivethub.baseUrl': gateway,
  'rivethub.remoteUi': gateway,
  'rivethub.roster': [{ name: new URL(gateway).host, baseUrl: gateway }],
})

/** Forward SIGINT/SIGTERM to the Playwright child and remember the interruption. */
export function watchSignals() {
  const state = { interrupted: false, testProcess: undefined }
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      state.interrupted = true
      state.testProcess?.kill(signal)
    })
  return state
}

/** First line: launched PID; second line: remote DevTools port. */
export function parseLaunchOutput(output) {
  const lines = output.trim().split(/\r?\n/)
  const pid = Number(lines[0])
  const remotePort = Number(lines[1])
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(remotePort) ||
    remotePort < 1 ||
    remotePort > 65535
  )
    throw new Error(`Invalid launch result: ${output}`)
  return { pid, remotePort }
}

/**
 * Local forward to the remote debugging port. `keepalive` replaces `-N` with
 * a long-running remote command: Windows OpenSSH spawns the user's default
 * shell for a `-N` session anyway, that shell exits at once with no stdin,
 * and the tunnel goes with it (observed 2026-10-25). Linux keeps `-N`.
 */
export const openTunnel = (host, localPort, remotePort, keepalive) =>
  spawn(
    'ssh',
    [
      ...(keepalive ? [] : ['-N']),
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-L',
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      host,
      ...(keepalive ? [keepalive] : []),
    ],
    { stdio: 'ignore' },
  )

/** Connect through the tunnel, retrying while the forward comes up. */
export async function connectThroughTunnel(endpoint) {
  // Windows sshd forwards noticeably slower than OpenSSH on Linux, and a
  // first /json/version answer from a just-started Electron can take a few
  // seconds; 20 × 5 s keeps the total wait near the Linux runner's.
  for (let i = 0; i < 20; i++) {
    try {
      return await chromium.connectOverCDP(endpoint, { timeout: 5000 })
    } catch (error) {
      if (i === 19)
        throw new Error(
          `SSH debugging tunnel did not become ready (${endpoint}): ${error instanceof Error ? error.message : String(error)}`,
        )
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

export const appWindow = (browser) =>
  browser
    .contexts()[0]
    .pages()
    .find((page) => page.url().startsWith('app://bundle'))

/**
 * Record the installed build in artifacts/build.json and refuse to test a
 * build other than E2E_EXPECT_SHA (and E2E_EXPECT_VERSION when set). `record`
 * supplies the leading identification fields (host, binary, gateway, ...).
 */
export async function verifyBuild(browser, record) {
  const window = appWindow(browser)
  if (!window) throw new Error('No RivetHub window after launch')
  // The build stamp lives on the Advanced tab since Settings became tabbed
  // (#1189); older dists have no tab routes and show it on /settings.
  await window.goto('app://bundle/settings/advanced')
  await window.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
  if (!/· dist /.test(await window.locator('main').innerText())) {
    await window.goto('app://bundle/settings')
    await window.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
  }
  const version = await window.evaluate(() => window.rivetShell.appVersion())
  const text = await window.locator('main').innerText()
  const build = text.match(/RivetHub v[^\n]+ · dist [^\n]+/g)?.at(-1)
  await writeFile(
    'artifacts/build.json',
    JSON.stringify(
      {
        ...record,
        version,
        build,
        expectedSha: process.env.E2E_EXPECT_SHA,
        testedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  if (
    !process.env.E2E_EXPECT_SHA ||
    !text.includes(`dist ${process.env.E2E_EXPECT_SHA.slice(0, 8)}`)
  )
    throw new Error(`Build mismatch: expected ${process.env.E2E_EXPECT_SHA}, got ${build}`)
  if (process.env.E2E_EXPECT_VERSION && version !== process.env.E2E_EXPECT_VERSION)
    throw new Error(`Version mismatch: ${version}`)
}

/** Run `playwright test` against the tunnel; resolves to its exit code. */
export function runPlaywright(endpoint, gateway, state) {
  const child = (state.testProcess = spawn(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: { ...process.env, E2E_CDP: endpoint, E2E_GATEWAY: gateway },
    },
  ))
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/**
 * Graceful quit through the app's own IPC. Returns the CDP connection (if one
 * was made) so the caller can close it in its cleanup; the app may already be
 * gone, in which case the caller's scoped process cleanup takes over.
 */
export async function requestQuit(endpoint) {
  let browser
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 })
    const page = appWindow(browser)
    if (page)
      await page
        .evaluate(() => {
          void window.rivetShell.quitApp()
        })
        .catch(() => {})
  } catch {
    /* process may already be gone; scoped fallback below */
  }
  return browser
}
