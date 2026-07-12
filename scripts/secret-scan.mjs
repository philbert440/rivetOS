#!/usr/bin/env node
// Secret / private-network scanner. One engine, three call sites:
//   --staged   scan the staged git diff (added lines only)  → pre-commit hook
//   --tracked  scan every tracked file                      → CI push/PR
//   --text     scan stdin (a PR title+body, etc.)           → CI pull_request
//
// Why home-grown instead of gitleaks: it runs with zero external binaries in
// the commit path (node is already required), the same rules cover files AND
// PR prose, and it supports a *hashed* denylist — exact crown-jewel strings
// matched by SHA-256 so the denylist itself carries no plaintext. gitleaks is
// regex-only and would need a companion script for that anyway.
//
// This repo is PUBLIC. Everything below uses RFC5737 documentation ranges
// (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) as the *only* allowed
// example IPs — real infra addresses/subnets/keys must never land here.
//
// IMPORTANT (public CI): findings are REDACTED in CI (GITHUB_ACTIONS/CI env) —
// Actions logs are world-readable, so printing a caught WG key or crown-jewel
// IP would re-leak it. CI shows rule + location + an 8-char hash; run the hook
// locally to see the full value you need to fix.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DENYLIST_FILE = join(HERE, 'secret-denylist.json')
const DENYLIST_REPO_PATH = 'scripts/secret-denylist.json'

// Inline suppression: append this token to a line to allow it (rare, audited).
// It suppresses the SHAPE rules on that line — it never suppresses a `denylist`
// (crown-jewel) hit, and its use is surfaced as a `suppressed` warning so the
// bypass is auditable in review.
const ALLOW_PRAGMA = 'secret-scan-allow'

// Redact match values in CI logs (world-readable) — see header note.
const REDACT = !!(process.env.CI || process.env.GITHUB_ACTIONS)
const MAX_FILE_BYTES = 5 * 1024 * 1024

// ---------------------------------------------------------------------------
// IP classification

const ip2n = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)
const n2ip = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
const inRange = (n, a, b) => n >= ip2n(a) && n <= ip2n(b)

/** [networkAddr, broadcastAddr] a token covers. A bare IP is a /32 (itself).
 *  Used so a wide CIDR (10.0.0.0/8) is judged over its WHOLE range, not just
 *  its network address sitting in an example /24. */
function cidrRange(token) {
  const [ip, p] = token.split('/')
  const base = ip2n(ip)
  if (p === undefined) return [base, base]
  const prefix = Number(p)
  if (!(prefix >= 0 && prefix <= 32)) return [base, base]
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const net = (base & mask) >>> 0
  return [net, (net | (~mask >>> 0)) >>> 0]
}

/** Documentation/example ranges that are always fine. RFC5737 is the real
 *  answer; the RFC1918 example blocks are deliberately NARROW /24s (not whole
 *  /16s) so real home/lab/docker addressing like 192.168.5.x or 10.4.x still
 *  hits the private-ip BLOCK path — prefer RFC5737 for new fixtures. */
function isExampleIp(ip) {
  const n = ip2n(ip)
  return (
    inRange(n, '192.0.2.0', '192.0.2.255') || // RFC5737 TEST-NET-1
    inRange(n, '198.51.100.0', '198.51.100.255') || // RFC5737 TEST-NET-2
    inRange(n, '203.0.113.0', '203.0.113.255') || // RFC5737 TEST-NET-3
    inRange(n, '192.168.0.0', '192.168.1.255') || // 192.168.0-1.x example only
    inRange(n, '10.0.0.0', '10.0.0.255') || // 10.0.0.x example only
    inRange(n, '172.16.0.0', '172.16.0.255') // 172.16.0.x example only
  )
}

/** Well-known public resolvers used as connectivity-check targets — not infra. */
const WELL_KNOWN = new Set(['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9'])

/** Non-routable / reserved space we never care about (loopback, link-local,
 *  this-host, multicast+, broadcast), plus the well-known resolvers. */
function isIgnorableIp(ip) {
  if (WELL_KNOWN.has(ip)) return true
  const n = ip2n(ip)
  return (
    inRange(n, '0.0.0.0', '0.255.255.255') ||
    inRange(n, '127.0.0.0', '127.255.255.255') ||
    inRange(n, '169.254.0.0', '169.254.255.255') ||
    inRange(n, '224.0.0.0', '255.255.255.255')
  )
}

/** Valid dotted-quad: each octet ≤255, ≤3 digits, and NO leading zero (real IP
 *  notation has none — this also kills SVG path-data false positives like
 *  "082.001.069.001"). */
const octetsValid = (ip) =>
  ip.split('.').every((o) => o.length <= 3 && Number(o) <= 255 && !(o.length > 1 && o[0] === '0'))

// ---------------------------------------------------------------------------
// rules

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g
// ULA (fc00::/7 → fc../fd..) and link-local (fe80::) internal IPv6. Requires ≥2
// colon groups so it doesn't fire on stray hex.
const IPV6_INTERNAL = /\b(?:f[cd][0-9a-f]{2}|fe80)(?::[0-9a-f]{0,4}){2,}\b/gi
// A standard-base64 32-byte value (== a WireGuard key). NOTE: this also matches
// any other 32-byte base64 blob (raw sha256, other keys) — a known FP class;
// use `secret-scan-allow` for audited fixtures. Kept BLOCK because a real key
// leak is worse than an occasional pragma.
const WG_KEY = /\b[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g
// `.lan` as the final label only — the (?!\.) stops `foo.lan.com` false hits.
const LAN_HOST = /\b[a-z0-9][a-z0-9-]*\.lan\b(?!\.)/gi

/** Shape-rule findings for one line. Returns [] when the allow pragma is present
 *  (pragma suppresses SHAPE rules only — the denylist runs regardless). */
function scanLine(line) {
  if (line.includes(ALLOW_PRAGMA)) return []
  const out = []

  for (const m of line.matchAll(IPV4)) {
    const ip = m[0].split('/')[0]
    if (!octetsValid(ip)) continue
    // Judge the WHOLE covered range: a CIDR is example/ignorable only if BOTH
    // endpoints are — so 10.0.0.0/8 (broadcast 10.255.255.255) is NOT clean.
    const [lo, hi] = cidrRange(m[0])
    const bothIgnorable = isIgnorableIp(n2ip(lo)) && isIgnorableIp(n2ip(hi))
    const bothExample = isExampleIp(n2ip(lo)) && isExampleIp(n2ip(hi))
    if (bothIgnorable || bothExample) continue
    const n = ip2n(ip)
    const isPrivate =
      inRange(n, '10.0.0.0', '10.255.255.255') ||
      inRange(n, '172.16.0.0', '172.31.255.255') ||
      inRange(n, '192.168.0.0', '192.168.255.255')
    out.push(
      isPrivate
        ? {
            rule: 'private-ip',
            severity: 'block',
            match: m[0],
            hint: 'internal subnet/host — use an RFC5737 range (192.0.2.x)',
          }
        : {
            rule: 'public-ip',
            severity: 'warn',
            match: m[0],
            hint: 'real public IP? confirm it is not infra (hard-blocked ones live in the denylist)',
          },
    )
  }
  for (const m of line.matchAll(IPV6_INTERNAL))
    out.push({ rule: 'ipv6-internal', severity: 'block', match: m[0], hint: 'internal IPv6 (ULA/link-local)' })
  for (const m of line.matchAll(WG_KEY))
    out.push({ rule: 'wg-key', severity: 'block', match: m[0], hint: 'WireGuard/base64 key shape' })
  for (const m of line.matchAll(LAN_HOST))
    out.push({ rule: 'lan-host', severity: 'block', match: m[0], hint: 'internal .lan hostname' })

  return out
}

// ---------------------------------------------------------------------------
// hashed denylist — exact crown-jewel strings, matched without storing them

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Parse a denylist JSON blob → lowercased 64-hex Set. Accepts A-F (folds to
 *  lowercase) so a hand-edited entry can't silently drop. */
function parseDenyHashes(json) {
  return new Set((json.sha256 ?? []).map((h) => String(h).toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h)))
}

// Fail CLOSED: a missing/corrupt/empty denylist must error, never silently
// disable crown-jewel protection. (Tests pass their own hashes and don't call
// this.) Exported so a self-test can assert it stays populated.
export function loadDenyHashes() {
  if (!existsSync(DENYLIST_FILE)) throw new Error(`denylist missing: ${DENYLIST_FILE}`)
  const hashes = parseDenyHashes(JSON.parse(readFileSync(DENYLIST_FILE, 'utf8'))) // throw on corrupt = fail closed
  if (!hashes.size) throw new Error(`denylist has no valid sha256 entries: ${DENYLIST_FILE}`)
  return hashes
}

/** Tokens hash-checked: IPs (bare + CIDR), base64 keys, .lan hosts (lowercased
 *  so Box.LAN matches a box.lan entry). NOT gated by the allow pragma — crown
 *  jewels can never be pragma-bypassed. */
function denylistHits(line, denyHashes) {
  if (!denyHashes.size) return []
  const tokens = new Set()
  for (const m of line.matchAll(IPV4)) {
    tokens.add(m[0]) // 203.0.113.7/24
    tokens.add(m[0].split('/')[0]) // 203.0.113.7
  }
  for (const m of line.matchAll(IPV6_INTERNAL)) tokens.add(m[0].toLowerCase())
  for (const m of line.matchAll(WG_KEY)) tokens.add(m[0])
  for (const m of line.matchAll(LAN_HOST)) tokens.add(m[0].toLowerCase())
  const out = []
  for (const t of tokens)
    if (denyHashes.has(sha256(t)))
      out.push({ rule: 'denylist', severity: 'block', match: t, hint: 'exact known-sensitive value' })
  return out
}

// ---------------------------------------------------------------------------
// finding sink

export function scanText(text, { denyHashes = new Set() } = {}) {
  const findings = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const f of scanLine(line)) findings.push({ ...f, line: i + 1 })
    // Surface pragma use as an auditable warning (it silences shape rules).
    if (line.includes(ALLOW_PRAGMA))
      findings.push({ rule: 'suppressed', severity: 'warn', match: '', hint: `${ALLOW_PRAGMA} used`, line: i + 1 })
    for (const f of denylistHits(line, denyHashes)) findings.push({ ...f, line: i + 1 })
  }
  return findings
}

// Exported for unit tests.
export const _internals = { isExampleIp, isIgnorableIp, octetsValid, scanLine, denylistHits, sha256 }

// ---------------------------------------------------------------------------
// modes (only run when invoked as a CLI, not when imported by tests)

/** Added lines from the staged diff, with REAL file line numbers parsed from
 *  the @@ hunk headers (-U0 → each added line advances the +side counter). */
function stagedAddedLines() {
  const diff = execFileSync('git', ['diff', '--cached', '--unified=0', '--no-color'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const blocks = []
  let file = ''
  let lineNo = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6)
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) {
      lineNo = Number(hunk[1])
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      blocks.push({ file, text: line.slice(1), line: lineNo })
      lineNo++
    }
    // '-' and header lines don't advance the +side counter.
  }
  return blocks
}

function trackedFiles() {
  const list = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return list.split('\n').filter(Boolean)
}

// Paths the scanner ignores (its own denylist of hashes, lockfiles, vendored).
// Skip by extension/path ONLY (deterministic + auditable). We deliberately do
// NOT content-sniff for binary: a NUL-prefixed *text* file would then be
// silently skipped (an evasion path). Anything not skipped here is scanned; a
// genuine binary that slips through fails closed (its shape rules trip) until
// its extension/path is added below.
const SKIP = [
  /^scripts\/secret-denylist\.json$/,
  /^scripts\/secret-scan\.(mjs|test\.mjs)$/, // the scanner + its fixtures ARE detection patterns/constants
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.nx\//,
  /(^|\/)dist\//,
  /(^|\/)__pycache__\//, // compiled python
  /(^|\/)prebuilt\//, // native prebuilt binaries (e.g. dropbear ELF, no extension)
  /(^|\/)simple_dict\/idf\.utf8$/, // large IDF dictionary data blob
  /\.(png|jpg|jpeg|gif|webp|ico|svg|pdf|zip|gz|woff2?|ttf|otf|mp3|wav|ogg|mp4|m4a|webm|so|a|dll|dylib|jar|class|keystore|jks|bin|wasm|pyc|pyo)$/i,
]
const skip = (f) => SKIP.some((re) => re.test(f))

/** A PR can weaken crown-jewel protection by deleting hashes from the denylist
 *  in the same change that introduces the plaintext (generic public-ip only
 *  warns). Compare against origin/main and fail if any hash was removed. Returns
 *  null when main's copy can't be read (shallow clone / new file) — caller warns
 *  and leans on CODEOWNERS. */
function denylistRemovedVsMain(current) {
  let mainJson
  try {
    mainJson = execFileSync('git', ['show', `origin/main:${DENYLIST_REPO_PATH}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  return removedHashes(parseDenyHashes(JSON.parse(mainJson)), current)
}

/** Pure core of the tamper check: baseline hashes present but no longer in
 *  current = a removal (must be blocked). Exported for tests. */
export const removedHashes = (baseline, current) => [...baseline].filter((h) => !current.has(h))

/** Match value shown in output — redacted (8-char hash) in CI to avoid
 *  re-leaking a caught secret into world-readable logs. */
function shown(f) {
  if (!f.match) return ''
  return REDACT ? `<redacted:${sha256(f.match).slice(0, 8)}>` : f.match
}

/** @returns true if any BLOCK-severity finding was reported (→ nonzero exit). */
function report(findings, where) {
  if (!findings.length) return false
  const blocks = findings.filter((f) => f.severity !== 'warn')
  const warns = findings.filter((f) => f.severity === 'warn')
  if (warns.length) {
    console.error(`\n⚠️  secret-scan: ${warns.length} warning(s) in ${where} (non-blocking):`)
    for (const f of warns)
      console.error(`  ${f.file ?? ''}:${f.line}  [${f.rule}] ${shown(f)}  — ${f.hint}`)
  }
  if (blocks.length) {
    console.error(`\n❌ secret-scan: ${blocks.length} blocking finding(s) in ${where}:\n`)
    for (const f of blocks)
      console.error(`  ${f.file ?? ''}:${f.line}  [${f.rule}] ${shown(f)}  — ${f.hint}`)
    console.error(
      `\nThis repo is PUBLIC. Use RFC5737 example IPs (192.0.2.x / 198.51.100.x / 203.0.113.x).\n` +
        (REDACT ? 'Values redacted in CI — run the pre-commit hook locally to see them.\n' : '') +
        `Real value that must ship? append "${ALLOW_PRAGMA}" to the line (audited; never bypasses the denylist).\n`,
    )
  }
  return blocks.length > 0
}

function main() {
  const mode = process.argv[2]
  const denyHashes = loadDenyHashes()
  let findings = []

  if (mode === '--staged') {
    for (const { file, text, line } of stagedAddedLines()) {
      if (skip(file)) continue
      for (const f of scanText(text, { denyHashes })) findings.push({ ...f, file, line })
    }
    if (report(findings, 'staged changes')) process.exit(1)
  } else if (mode === '--tracked') {
    // Integrity: no crown-jewel hash may disappear vs origin/main.
    const removed = denylistRemovedVsMain(denyHashes)
    if (removed === null)
      console.error('⚠️  secret-scan: could not compare denylist against origin/main (CODEOWNERS is the backstop)')
    else if (removed.length) {
      console.error(
        `\n❌ secret-scan: ${removed.length} denylist entr(y/ies) REMOVED vs origin/main — ` +
          `crown-jewel protection must not shrink without an explicit, reviewed reason.\n`,
      )
      process.exit(1)
    }
    // Anything we can't fully scan FAILS CLOSED (a leak must not hide behind an
    // unreadable/oversize/NUL-prefixed file). Expected binaries belong in SKIP.
    let unscannable = 0
    for (const file of trackedFiles()) {
      if (skip(file)) continue
      let buf
      try {
        buf = readFileSync(file)
      } catch {
        unscannable++
        console.error(`  UNREADABLE (fail closed): ${file}`)
        continue
      }
      if (buf.length > MAX_FILE_BYTES) {
        unscannable++
        console.error(`  OVERSIZE >${MAX_FILE_BYTES}B (fail closed — split, or add to SKIP if a data blob): ${file}`)
        continue
      }
      for (const f of scanText(buf.toString('utf8'), { denyHashes })) findings.push({ ...f, file })
    }
    const bad = report(findings, 'tracked files')
    if (unscannable > 0)
      console.error(`\n❌ secret-scan: ${unscannable} tracked file(s) could not be safely scanned (see above).`)
    if (bad || unscannable > 0) process.exit(1)
  } else if (mode === '--text') {
    const text = readFileSync(0, 'utf8') // stdin
    findings = scanText(text, { denyHashes }).map((f) => ({ ...f, file: '<input>' }))
    if (report(findings, 'input text')) process.exit(1)
  } else {
    console.error('usage: secret-scan.mjs --staged | --tracked | --text (stdin)')
    process.exit(2)
  }
  console.log('✅ secret-scan: clean')
}

// Only execute as a CLI; importing the module (tests) must not run main().
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
