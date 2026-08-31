// SNI tray smoke check — the automated guard behind the Electron pin in
// src/main/index.ts (~line 577). 43.3.0 / 43.4.1 / 44.0.0 ship
// StatusNotifierItem regressions (electron#52674, #53024) where new Tray()
// "succeeds" but the item exports NO D-Bus interfaces and never registers
// with the StatusNotifierWatcher: the tray is silently dead on KDE/GNOME.
// This script proves a registration really happened on the bus before a
// Linux build may ship. It runs from `npm run dist`; escape hatch for
// no-dbus environments: RIVET_SKIP_SNI_CHECK=1 (prints a loud warning).
//
// How: re-exec itself under `dbus-run-session -- xvfb-run -a` so it works
// on a headless builder, own a fake org.kde.StatusNotifierWatcher on that
// private session bus (Electron skips SNI registration entirely when no
// watcher owns the name), launch `electron .` (the exact dist-electron
// bundle electron-builder packages), then require BOTH:
//   1. an org.(kde|freedesktop).StatusNotifierItem-<pid>-<n> name on the bus
//      (watcher got RegisterStatusNotifierItem, or busctl --user list shows
//      the name), AND
//   2. `busctl --user get-property <name> /StatusNotifierItem
//      org.kde.StatusNotifierItem Status` answering `s "..."` — Chromium
//      serves empty Introspect XML even when healthy, so introspection cannot
//      discriminate good from broken builds; KDE trays read properties
//      directly per the SNI spec. The regression's signature is
//      name-without-interfaces, which makes this Get fail, so the second
//      check is the load-bearing one.
//
// No npm deps on purpose: the watcher speaks just enough of the D-Bus wire
// protocol (AUTH EXTERNAL, Hello, RequestName, method_call/method_return/
// error) over the session-bus socket, and busctl (systemd — ubiquitous on
// any box that has dbus) does the bus listing and the property reads.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as net from 'node:net'
import * as os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = dirname(dirname(fileURLToPath(import.meta.url)))
const selfPath = fileURLToPath(import.meta.url)
const TIMEOUT_MS = 20_000
const WATCHER_NAME = 'org.kde.StatusNotifierWatcher'
const SNI_IFACE = 'org.kde.StatusNotifierItem'
// Electron 43.x registers as org.freedesktop.StatusNotifierItem-<pid>-<n>;
// older/ayatana paths use the org.kde prefix. Accept both.
const SNI_NAME_RE = /^org\.(kde|freedesktop)\.StatusNotifierItem-\d+-\d+/m

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const debug = process.env.RIVET_SNI_DEBUG
  ? (...a) => console.error('check-sni[dbg]', ...a)
  : () => {}

// ---------------------------------------------------------------- outer wrap

if (!process.env.RIVET_SNI_CHECK_INNER) {
  const tag = 'check-sni'
  if (process.env.RIVET_SKIP_SNI_CHECK === '1') {
    console.warn(
      `${tag}: ⚠️  SKIPPED via RIVET_SKIP_SNI_CHECK=1 — the Electron SNI tray ` +
        'regression guard did NOT run. Do not ship a Linux build produced this way ' +
        'without running npm run check:sni on a Linux box with dbus + xvfb.',
    )
    process.exit(0)
  }
  if (process.platform !== 'linux') {
    console.warn(
      `${tag}: ⚠️  SKIPPED on ${process.platform} — StatusNotifierItem is a Linux-only ` +
        'tray path; nothing to check here. The guard runs on Linux builds.',
    )
    process.exit(0)
  }
  const missing = ['dbus-run-session', 'xvfb-run', 'busctl'].filter(
    (t) => spawnSync(t, ['--help'], { stdio: 'ignore' }).error,
  )
  if (missing.length) {
    console.error(
      `${tag}: FAIL — required tools not found: ${missing.join(', ')}\n` +
        '  Install dbus + xvfb (Debian: dbus-x11 xvfb xauth, Fedora: dbus-x11 xorg-x11-server-Xvfb).\n' +
        '  On a host that genuinely cannot provide a session bus, rerun with RIVET_SKIP_SNI_CHECK=1.',
    )
    process.exit(1)
  }
  const r = spawnSync(
    'dbus-run-session',
    ['--', 'xvfb-run', '-a', process.execPath, selfPath],
    { stdio: 'inherit', env: { ...process.env, RIVET_SNI_CHECK_INNER: '1' } },
  )
  process.exit(r.status ?? 1)
}

// ------------------------------------------------- minimal D-Bus wire codec
// Little-endian only (every real session bus is). Alignment is absolute from
// the start of the message; sub-writers for arrays work because their content
// always starts at an offset that is 0 mod the element alignment.

const align = (n, a) => (n + a - 1) & ~(a - 1)

class Writer {
  constructor() {
    this.parts = []
    this.len = 0
  }
  raw(buf) {
    this.parts.push(buf)
    this.len += buf.length
  }
  pad(a) {
    const n = align(this.len, a) - this.len
    if (n) this.raw(Buffer.alloc(n))
  }
  u8(v) {
    this.raw(Buffer.from([v]))
  }
  u32(v) {
    this.pad(4)
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v >>> 0)
    this.raw(b)
  }
  boolean(v) {
    this.u32(v ? 1 : 0)
  }
  string(v) {
    const b = Buffer.from(String(v), 'utf8')
    this.pad(4)
    this.u32(b.length)
    this.raw(b)
    this.u8(0)
  }
  signature(v) {
    const b = Buffer.from(v, 'ascii')
    this.u8(b.length)
    this.raw(b)
    this.u8(0)
  }
  buffer() {
    return Buffer.concat(this.parts, this.len)
  }
}

function writeValue(w, sig, v) {
  switch (sig) {
    case 's':
    case 'o':
      w.string(v)
      break
    case 'g':
      w.signature(v)
      break
    case 'u':
      w.u32(v)
      break
    case 'b':
      w.boolean(v)
      break
    case 'v':
      w.signature(v.sig)
      writeValue(w, v.sig, v.value)
      break
    case 'as': {
      w.pad(4)
      const sub = new Writer()
      for (const s of v) sub.string(s)
      const content = sub.buffer()
      w.u32(content.length)
      w.pad(4) // element alignment for 's'
      w.raw(content)
      break
    }
    case 'a{sv}': {
      w.pad(4)
      const sub = new Writer()
      for (const [k, val] of v) {
        sub.pad(8)
        sub.string(k)
        sub.signature(val.sig)
        writeValue(sub, val.sig, val.value)
      }
      const content = sub.buffer()
      w.u32(content.length)
      w.pad(8) // dict-entry alignment
      w.raw(content)
      break
    }
    default:
      throw new Error(`encode: unsupported type ${sig}`)
  }
}

class Reader {
  constructor(buf, off = 0) {
    this.buf = buf
    this.off = off
  }
  pad(a) {
    this.off = align(this.off, a)
  }
  u8() {
    return this.buf[this.off++]
  }
  u32() {
    this.pad(4)
    const v = this.buf.readUInt32LE(this.off)
    this.off += 4
    return v
  }
  boolean() {
    return this.u32() !== 0
  }
  string() {
    const n = this.u32()
    const s = this.buf.toString('utf8', this.off, this.off + n)
    this.off += n + 1 // NUL
    return s
  }
  signature() {
    const n = this.u8()
    const s = this.buf.toString('ascii', this.off, this.off + n)
    this.off += n + 1
    return s
  }
  value(sig) {
    switch (sig) {
      case 's':
      case 'o':
        return this.string()
      case 'g':
        return this.signature()
      case 'u':
      case 'h':
        return this.u32()
      case 'b':
        return this.boolean()
      case 'v':
        return this.value(this.signature())
      default:
        throw new Error(`decode: unsupported type ${sig}`)
    }
  }
}

const MSG = { METHOD_CALL: 1, METHOD_RETURN: 2, ERROR: 3, SIGNAL: 4 }
const HDR = {
  PATH: 1,
  INTERFACE: 2,
  MEMBER: 3,
  ERROR_NAME: 4,
  REPLY_SERIAL: 5,
  DESTINATION: 6,
  SENDER: 7,
  SIGNATURE: 8,
}

// Only flat basic types occur in the calls this watcher answers ('', 's',
// 'ss', 'u'); anything richer is left unparsed — the header fields carry
// everything the dispatch below needs in that case.
function splitSig(sig) {
  return /^[sogubvh]*$/.test(sig) ? [...sig] : null
}

function parseMessage(buf) {
  const type = buf[1]
  const flags = buf[2]
  const serial = buf.readUInt32LE(8)
  const fieldsLen = buf.readUInt32LE(12)
  const fieldsEnd = 16 + fieldsLen
  const r = new Reader(buf, 16)
  const fields = {}
  while (r.off < fieldsEnd) {
    r.pad(8)
    if (r.off >= fieldsEnd) break
    fields[r.u8()] = r.value(r.signature())
  }
  let body = []
  const sig = fields[HDR.SIGNATURE]
  if (typeof sig === 'string' && sig) {
    const types = splitSig(sig)
    if (types) {
      r.off = align(fieldsEnd, 8)
      try {
        body = types.map((t) => r.value(t))
      } catch {
        body = []
      }
    }
  }
  return { type, flags, serial, fields, body }
}

function encodeMessage(serial, type, opts) {
  const { path, iface, member, errorName, replySerial, destination, bodyTypes, bodyValues } = opts
  const fields = []
  if (path !== undefined) fields.push([HDR.PATH, 'o', path])
  if (iface !== undefined) fields.push([HDR.INTERFACE, 's', iface])
  if (member !== undefined) fields.push([HDR.MEMBER, 's', member])
  if (errorName !== undefined) fields.push([HDR.ERROR_NAME, 's', errorName])
  if (replySerial !== undefined) fields.push([HDR.REPLY_SERIAL, 'u', replySerial])
  if (destination !== undefined) fields.push([HDR.DESTINATION, 's', destination])
  let bodyBuf = Buffer.alloc(0)
  if (bodyTypes?.length) {
    const bw = new Writer()
    bodyTypes.forEach((t, i) => writeValue(bw, t, bodyValues[i]))
    bodyBuf = bw.buffer()
    fields.push([HDR.SIGNATURE, 'g', bodyTypes.join('')])
  }
  const hw = new Writer() // starts at absolute offset 16 ≡ 0 (mod 8)
  for (const [code, sig, val] of fields) {
    hw.pad(8)
    hw.u8(code)
    hw.signature(sig)
    writeValue(hw, sig, val)
  }
  const fieldsBuf = hw.buffer()
  const head = Buffer.alloc(16)
  head[0] = 0x6c // 'l'
  head[1] = type
  head[2] = 0
  head[3] = 1
  head.writeUInt32LE(bodyBuf.length, 4)
  head.writeUInt32LE(serial, 8)
  head.writeUInt32LE(fieldsBuf.length, 12)
  const headerPad = align(16 + fieldsBuf.length, 8) - (16 + fieldsBuf.length)
  return Buffer.concat([head, fieldsBuf, Buffer.alloc(headerPad), bodyBuf])
}

// ------------------------------------------------------- fake SNI watcher

const WATCHER_PATH = '/StatusNotifierWatcher'
const WATCHER_PROPS = {
  [WATCHER_NAME]: {
    ProtocolVersion: { sig: 'u', value: 0 },
    // Must be true: Chromium (like libappindicator) checks this before
    // registering — no host registered, no registration attempt at all.
    IsStatusNotifierHostRegistered: { sig: 'b', value: true },
    RegisteredStatusNotifierItems: { sig: 'as', value: [] },
  },
  'org.freedesktop.DBus.Introspectable': {},
  'org.freedesktop.DBus.Properties': {},
}
const WATCHER_XML = `<node>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect">
      <arg name="xml" type="s" direction="out"/>
    </method>
  </interface>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg name="interface" type="s" direction="in"/>
      <arg name="property" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="GetAll">
      <arg name="interface" type="s" direction="in"/>
      <arg name="properties" type="a{sv}" direction="out"/>
    </method>
  </interface>
  <interface name="${WATCHER_NAME}">
    <method name="RegisterStatusNotifierItem">
      <arg name="service" type="s" direction="in"/>
    </method>
    <method name="RegisterStatusNotifierHost">
      <arg name="service" type="s" direction="in"/>
    </method>
    <property name="ProtocolVersion" type="u" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <signal name="StatusNotifierItemRegistered">
      <arg name="service" type="s"/>
    </signal>
  </interface>
</node>`

function busSocketPath(addr) {
  const first = addr.split(';')[0]
  if (!first.startsWith('unix:')) throw new Error(`unsupported bus address: ${addr}`)
  const kv = Object.fromEntries(
    first
      .slice('unix:'.length)
      .split(',')
      .map((p) => p.split('=')),
  )
  if (kv.path) return kv.path
  if (kv.abstract) return '\0' + kv.abstract
  throw new Error(`unsupported bus address: ${addr}`)
}

/** Session-bus connection + minimal org.kde.StatusNotifierWatcher service.
 *  onItem(name, objectPath) fires when a client calls
 *  RegisterStatusNotifierItem. */
async function startWatcher(onItem) {
  const sock = net.connect(busSocketPath(process.env.DBUS_SESSION_BUS_ADDRESS))
  let acc = Buffer.alloc(0)
  let serial = 0
  const pending = new Map() // our serial -> {resolve, reject}

  const fail = (err) => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }
  sock.once('error', fail)

  const send = (type, opts) => {
    serial += 1
    sock.write(encodeMessage(serial, type, opts))
    return serial
  }
  const call = (member, bodyTypes, bodyValues) =>
    new Promise((resolve, reject) => {
      const s = send(MSG.METHOD_CALL, {
        path: '/org/freedesktop/DBus',
        iface: 'org.freedesktop.DBus',
        member,
        destination: 'org.freedesktop.DBus',
        bodyTypes,
        bodyValues,
      })
      pending.set(s, { resolve, reject })
      setTimeout(() => {
        if (pending.delete(s)) reject(new Error(`${member}: no reply from bus daemon within 5s`))
      }, 5000)
    })

  function replyReturn(m, bodyTypes, bodyValues) {
    send(MSG.METHOD_RETURN, {
      replySerial: m.serial,
      destination: m.fields[HDR.SENDER],
      bodyTypes,
      bodyValues,
    })
  }
  function replyError(m, name, text) {
    send(MSG.ERROR, {
      errorName: name,
      replySerial: m.serial,
      destination: m.fields[HDR.SENDER],
      bodyTypes: ['s'],
      bodyValues: [text],
    })
  }

  function onMethodCall(m) {
    const iface = m.fields[HDR.INTERFACE]
    const member = m.fields[HDR.MEMBER]
    const sender = m.fields[HDR.SENDER]
    try {
      if (iface === WATCHER_NAME && member === 'RegisterStatusNotifierItem') {
        // Spec passes the item's bus name; the ayatana variant passes an
        // object path instead, in which case the item lives at the sender.
        const arg = typeof m.body[0] === 'string' ? m.body[0] : ''
        const isPath = arg.startsWith('/')
        replyReturn(m, [], [])
        const name = isPath ? sender : arg
        if (name) onItem(name, isPath ? arg : '/StatusNotifierItem')
        return
      }
      if (iface === WATCHER_NAME && member === 'RegisterStatusNotifierHost') {
        replyReturn(m, [], [])
        return
      }
      if (iface === 'org.freedesktop.DBus.Introspectable' && member === 'Introspect') {
        replyReturn(m, ['s'], [WATCHER_XML])
        return
      }
      if (iface === 'org.freedesktop.DBus.Properties' && member === 'Get') {
        const prop = WATCHER_PROPS[m.body[0]]?.[m.body[1]]
        if (!prop)
          return replyError(m, 'org.freedesktop.DBus.Error.UnknownProperty', 'no such property')
        replyReturn(m, ['v'], [prop])
        return
      }
      if (iface === 'org.freedesktop.DBus.Properties' && member === 'GetAll') {
        const wanted =
          typeof m.body[0] === 'string' && m.body[0] ? [m.body[0]] : Object.keys(WATCHER_PROPS)
        const entries = wanted.flatMap((i) => Object.entries(WATCHER_PROPS[i] ?? {}))
        replyReturn(m, ['a{sv}'], [entries])
        return
      }
      replyError(
        m,
        'org.freedesktop.DBus.Error.UnknownMethod',
        `${iface}.${member} not implemented`,
      )
    } catch (err) {
      replyError(
        m,
        'org.freedesktop.DBus.Error.Failed',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // Message framing. Attached only AFTER auth completes: the auth exchange
  // is CRLF text, and letting the binary framer see those bytes could make
  // it consume them as a bogus (garbage-length) message.
  const onFrame = (chunk) => {
    debug('chunk: %d bytes (acc was %d)', chunk.length, acc.length)
    acc = Buffer.concat([acc, chunk])
    for (;;) {
      if (acc.length < 16) return
      const total = align(16 + acc.readUInt32LE(12), 8) + acc.readUInt32LE(4)
      if (acc.length < total) return
      let m
      try {
        m = parseMessage(acc.subarray(0, total))
      } catch (err) {
        debug('dropping undecodable %d-byte message: %s', total, err?.message)
        acc = acc.subarray(total)
        continue // undecodable message — never let one wedge the stream
      }
      acc = acc.subarray(total)
      debug('msg in: type=%d serial=%d fields=%o body=%o', m.type, m.serial, m.fields, m.body)
      if (m.type === MSG.METHOD_RETURN || m.type === MSG.ERROR) {
        const p = pending.get(m.fields[HDR.REPLY_SERIAL])
        if (p) {
          pending.delete(m.fields[HDR.REPLY_SERIAL])
          if (m.type === MSG.ERROR)
            p.reject(new Error(`${m.fields[HDR.ERROR_NAME]}: ${m.body[0] ?? ''}`))
          else p.resolve(m.body)
        }
      } else if (m.type === MSG.METHOD_CALL) {
        onMethodCall(m)
      }
      // signals (NameAcquired & co) carry nothing this watcher needs
    }
  }

  // AUTH EXTERNAL <hex(uid)> — the session bus accepts the peer's uid.
  const uidHex = Buffer.from(String(process.getuid()), 'ascii').toString('hex')
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('error', reject)
  })
  sock.write(`\0AUTH EXTERNAL ${uidHex}\r\n`)
  const authLine = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dbus auth timed out')), 5000)
    const onData = (c) => {
      acc = Buffer.concat([acc, c])
      const i = acc.indexOf('\r\n')
      if (i === -1) return
      const line = acc.subarray(0, i).toString('ascii')
      acc = acc.subarray(i + 2)
      clearTimeout(timer)
      sock.off('data', onData)
      resolve(line)
    }
    sock.on('data', onData)
    sock.once('error', reject)
  })
  if (!authLine.startsWith('OK ')) throw new Error(`dbus auth rejected: ${authLine}`)
  sock.write('BEGIN\r\n')
  sock.on('data', onFrame)
  sock.on('close', () => debug('socket closed by peer'))
  sock.on('end', () => debug('socket ended'))

  const hello = await call('Hello')
  const uniqueName = hello[0]
  const req = await call('RequestName', ['s', 'u'], [WATCHER_NAME, 4]) // 4 = DO_NOT_QUEUE
  if (req[0] !== 1) throw new Error(`RequestName(${WATCHER_NAME}) returned ${req[0]}, expected 1`)
  return { sock, uniqueName }
}

// ----------------------------------------------------------------- assertion

function busctl(args) {
  return spawnSync('busctl', ['--user', '--no-pager', ...args], { encoding: 'utf8', timeout: 5000 })
}

function listSniNames() {
  const r = busctl(['list'])
  if (r.status !== 0 || !r.stdout) return []
  return r.stdout
    .split('\n')
    .map((l) => l.match(SNI_NAME_RE)?.[0])
    .filter(Boolean)
}

/** Assert via a direct property read, not introspection: Chromium serves an
 *  empty Introspect table (status 0, header only) even on healthy builds, so
 *  introspection cannot discriminate. KDE trays use Properties.Get per the
 *  SNI spec — do the same. PASS condition: exit 0 and stdout starting with
 *  `s "` (a good 43.4.0 answers `s "Active"`). Do NOT probe IconName: the app
 *  publishes pixmaps, not a named icon, so IconName errors even on good
 *  builds. Broken builds' objects export no interfaces, so Get on
 *  org.kde.StatusNotifierItem fails there — exactly the regression signature. */
function readsSniStatus(name, objectPath) {
  const r = busctl(['get-property', name, objectPath, SNI_IFACE, 'Status'])
  return r.status === 0 && typeof r.stdout === 'string' && r.stdout.startsWith('s "')
}

// ---------------------------------------------------------------------- main

const require = createRequire(import.meta.url)
const failLines = []
const out = (s) => console.log(`check-sni: ${s}`)
const note = (s) => failLines.push(s)

function resolveElectron() {
  try {
    const version = require('electron/package.json').version
    const bin = require('electron') // electron's npm entry resolves to the binary path
    if (typeof bin !== 'string' || !existsSync(bin))
      throw new Error(`bad electron binary path: ${bin}`)
    return { version, bin }
  } catch (err) {
    console.error(
      `check-sni: FAIL — cannot resolve the electron binary (${err instanceof Error ? err.message : err}).\n` +
        '  Run npm install first.',
    )
    process.exit(1)
  }
}

const { version, bin } = resolveElectron()
out(`testing electron ${version} (${bin})`)

const builtMain = join(appDir, 'dist-electron', 'main.cjs')
if (!existsSync(builtMain)) {
  console.error('check-sni: FAIL — dist-electron/main.cjs missing; run npm run bundle first.')
  process.exit(1)
}

let child
let tmpHome
function cleanup() {
  try {
    child?.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  try {
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
function finish(code, lines) {
  for (const l of lines) (code === 0 ? console.log : console.error)(`check-sni: ${l}`)
  cleanup()
  process.exit(code)
}
process.on('SIGINT', () => finish(1, ['aborted (SIGINT)']))
process.on('SIGTERM', () => finish(1, ['aborted (SIGTERM)']))
setTimeout(() => finish(1, ['FAIL — internal watchdog: check exceeded its time budget.']), TIMEOUT_MS + 15_000)

let itemName = null
let itemPath = '/StatusNotifierItem'
let bus
try {
  bus = await startWatcher((name, objectPath) => {
    if (!itemName) {
      itemName = name
      itemPath = objectPath
    }
  })
} catch (err) {
  finish(1, [
    `FAIL — could not start the fake StatusNotifierWatcher on the session bus: ${err instanceof Error ? err.message : err}`,
  ])
}
out(`fake ${WATCHER_NAME} owned as ${bus.uniqueName}; launching the app`)

// Isolated XDG homes: the app's single-instance lock and userData live under
// XDG_CONFIG_HOME, so a dev instance on this box must not make the smoke app
// the "second instance" (it would quit before ever creating a tray).
tmpHome = mkdtempSync(join(os.tmpdir(), 'rivet-sni-check-'))
let childOut = ''
child = spawn(bin, [appDir, '--no-sandbox', '--disable-gpu'], {
  cwd: appDir,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: tmpHome,
    XDG_CACHE_HOME: tmpHome,
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (c) => (childOut = (childOut + c).slice(-8192)))
child.stderr.on('data', (c) => (childOut = (childOut + c).slice(-8192)))
let childExited = null
child.once('exit', (code, signal) => (childExited = `exit code ${code ?? signal}`))

const deadline = Date.now() + TIMEOUT_MS
while (!itemName && Date.now() < deadline && !childExited) {
  await sleep(250)
  // The watcher callback is primary; the bus scan is a belt-and-suspenders
  // fallback for registration paths our minimal watcher does not model.
  for (const n of listSniNames()) {
    if (!itemName) itemName = n
  }
}

if (childExited && !itemName) {
  note(`FAIL — electron ${version}: the app exited before any tray registered (${childExited}).`)
} else if (!itemName) {
  note(
    `FAIL — electron ${version}: no StatusNotifierItem on the session bus within ${TIMEOUT_MS / 1000}s — ` +
      `no RegisterStatusNotifierItem reached the watcher and busctl --user list shows no org.kde/org.freedesktop.StatusNotifierItem-*. ` +
      'The tray never registered; this Electron build has a dead SNI tray.',
  )
} else {
  out(`saw ${itemName} on the bus; reading ${SNI_IFACE} Status from ${itemPath}`)
  // Fresh items may need a beat before the object answers property reads.
  // Bounded well under the watchdog even if every get-property hangs to its
  // own 5s timeout (4 × 5.3s ≈ 21s).
  let alive = false
  for (let tries = 0; tries < 4 && !alive; tries += 1) {
    alive = readsSniStatus(itemName, itemPath)
    if (!alive) await sleep(300)
  }
  if (alive) {
    finish(0, [
      `PASS — electron ${version}: ${itemName} registered with the StatusNotifierWatcher ` +
        `and ${itemPath} answers Get(${SNI_IFACE}, Status). Tray is alive.`,
    ])
  }
  note(
    `FAIL — electron ${version}: ${itemName} is on the bus but Get(${SNI_IFACE}, Status) ` +
      `on ${itemPath} fails` +
      ' — this is exactly the electron#52674/#53024 regression signature (name without interfaces, ' +
      'so a property Get on the interface fails). ' +
      'Do not ship this Electron build; keep the pin or find a fixed version.',
  )
}

note('--- last app output ---')
note(childOut.trim() || '(no output)')
note('--- busctl --user list ---')
note(busctl(['list']).stdout?.trim() ?? '(busctl list failed)')
finish(1, failLines)
