import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'

// This runner owns only its temporary profile/process. It does not install,
// update, or stop the user's regular RivetHub or gateway service.
const host = process.env.E2E_SSH ?? 'rivet@ct111'
if (!/^[a-zA-Z0-9_.@-]+$/.test(host) || host.startsWith('-')) throw new Error('Invalid E2E_SSH')
const binary = process.env.E2E_BINARY ?? '/home/rivet/.local/bin/RivetHub'
const gateway = process.env.E2E_GATEWAY ?? 'https://localhost:5174'
const identity = process.env.E2E_IDENTITY ?? '/home/rivet/.config/RivetHub/mtls'
const profile = `/tmp/rivethub-e2e-${randomUUID()}`
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const command = (bin, args, options = {}) =>
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
const ssh = (script) =>
  command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, script])
const port = await new Promise((resolve, reject) => {
  const server = createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => resolve(port))
  })
})
const settings = Buffer.from(
  JSON.stringify({
    'rivethub.e2eProfile': true,
    'rivethub.baseUrl': gateway,
    'rivethub.remoteUi': gateway,
    'rivethub.roster': [{ name: new URL(gateway).host, baseUrl: gateway }],
  }),
).toString('base64')
let tunnel, browser, pid, testProcess
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true
    testProcess?.kill(signal)
  })
await mkdir('artifacts', { recursive: true })
try {
  const output = await ssh(`set -eu
umask 077
mkdir -p ${quote(profile)}/mtls
cp ${quote(identity)}/device.crt ${quote(identity)}/device.key ${quote(identity)}/ca.pem ${quote(profile)}/mtls/
printf %s ${quote(settings)} | base64 -d > ${quote(profile)}/settings.json
APPIMAGE_EXTRACT_AND_RUN=1 DISPLAY=${quote(process.env.E2E_DISPLAY ?? ':0')} XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus nohup ${quote(binary)} --user-data-dir=${quote(profile)} --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --ozone-platform=x11 > ${quote(profile)}/app.log 2>&1 < /dev/null &
echo $!
for i in $(seq 1 60); do
  if test -s ${quote(profile)}/DevToolsActivePort; then head -1 ${quote(profile)}/DevToolsActivePort; exit 0; fi
  sleep 1
done
tail -30 ${quote(profile)}/app.log
exit 1`)
  const lines = output.trim().split('\n')
  pid = Number(lines[0])
  const remotePort = Number(lines[1])
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(remotePort) ||
    remotePort < 1 ||
    remotePort > 65535
  )
    throw new Error(`Invalid launch result: ${output}`)
  tunnel = spawn(
    'ssh',
    [
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-L',
      `127.0.0.1:${port}:127.0.0.1:${remotePort}`,
      host,
    ],
    { stdio: 'ignore' },
  )
  const endpoint = `http://127.0.0.1:${port}`
  for (let i = 0; i < 30; i++) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 1000 })
      break
    } catch {
      if (i === 29) throw new Error('SSH debugging tunnel did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  const window = browser
    .contexts()[0]
    .pages()
    .find((page) => page.url().startsWith('app://bundle'))
  if (!window) throw new Error('No RivetHub window after launch')
  await window.goto('app://bundle/settings')
  await window.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
  const version = await window.evaluate(() => window.rivetShell.appVersion())
  const text = await window.locator('main').innerText()
  const build = text.match(/RivetHub v[^\n]+ · dist [^\n]+/g)?.at(-1)
  await writeFile(
    'artifacts/build.json',
    JSON.stringify(
      {
        host,
        binary,
        gateway,
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
  await browser.close()
  browser = undefined
  if (interrupted) throw new Error('Test run interrupted')
  const child = (testProcess = spawn(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: { ...process.env, E2E_CDP: endpoint, E2E_GATEWAY: gateway },
    },
  ))
  process.exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 })
    const page = browser
      .contexts()[0]
      .pages()
      .find((page) => page.url().startsWith('app://bundle'))
    if (page)
      await page
        .evaluate(() => {
          void window.rivetShell.quitApp()
        })
        .catch(() => {})
  } catch {
    /* process may already be gone; scoped fallback below */
  }
} finally {
  if (browser) await browser.close().catch(() => {})
  tunnel?.kill('SIGTERM')
  await writeFile(
    'artifacts/desktop.log',
    await ssh(`cat ${quote(profile)}/app.log 2>/dev/null || true`),
  )
  // Enumerate /proc and signal only processes whose argv contains this exact
  // profile argument, including an AppImage wrapper left behind after quit.
  const cleanup = `import pathlib,os,signal,shutil,time
profile=${JSON.stringify(profile)}
for entry in pathlib.Path('/proc').iterdir():
 try:
  argv=(entry/'cmdline').read_bytes().split(b'\\0')
  if ('--user-data-dir='+profile).encode() in argv: os.kill(int(entry.name),signal.SIGTERM)
 except (OSError,ValueError): pass
time.sleep(1)
shutil.rmtree(profile)
`
  await ssh(`python3 -c ${quote(cleanup)}`)
}
