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

// This runner owns only its temporary profile/process. It does not install,
// update, or stop the user's regular RivetHub or gateway service.
const host = requireSshHost()
const binary = process.env.E2E_BINARY ?? '/home/rivet/.local/bin/RivetHub'
const gateway = process.env.E2E_GATEWAY ?? 'https://localhost:5174'
const identity = process.env.E2E_IDENTITY ?? '/home/rivet/.config/RivetHub/mtls'
const profile = `/tmp/rivethub-e2e-${randomUUID()}`
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const ssh = (script) => sshTo(host, script)
const port = await freeLocalPort()
const settings = Buffer.from(JSON.stringify(profileSettings(gateway))).toString('base64')
let tunnel, browser
const state = watchSignals()
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
  const { remotePort } = parseLaunchOutput(output)
  tunnel = openTunnel(host, port, remotePort)
  const endpoint = `http://127.0.0.1:${port}`
  browser = await connectThroughTunnel(endpoint)
  await verifyBuild(browser, { host, binary, gateway })
  await browser.close()
  browser = undefined
  if (state.interrupted) throw new Error('Test run interrupted')
  process.exitCode = await runPlaywright(endpoint, gateway, state)
  browser = await requestQuit(endpoint)
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
