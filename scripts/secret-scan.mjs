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

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DENYLIST_FILE = join(HERE, 'secret-denylist.json')

// Inline suppression: append this token to a line to allow it (rare, audited).
const ALLOW_PRAGMA = 'secret-scan-allow'

// ---------------------------------------------------------------------------
// IP classification

const ip2n = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)
const inRange = (n, a, b) => n >= ip2n(a) && n <= ip2n(b)

/** Documentation/example ranges that are always fine (RFC5737 + a couple of
 *  canonical private examples the repo already used for fixtures). */
function isExampleIp(ip) {
  const n = ip2n(ip)
  return (
    inRange(n, '192.0.2.0', '192.0.2.255') || // RFC5737 TEST-NET-1
    inRange(n, '198.51.100.0', '198.51.100.255') || // RFC5737 TEST-NET-2
    inRange(n, '203.0.113.0', '203.0.113.255') || // RFC5737 TEST-NET-3
    inRange(n, '192.168.0.0', '192.168.255.255') || // canonical LAN example
    inRange(n, '10.0.0.0', '10.0.255.255') || // 10.0.x — allowed example block
    inRange(n, '172.16.0.0', '172.16.255.255') // 172.16.x — allowed example block
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
const WG_KEY = /\b[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g
// `.lan` as the final label only — the (?!\.) stops `foo.lan.com` false hits.
const LAN_HOST = /\b[a-z0-9][a-z0-9-]*\.lan\b(?!\.)/gi

/** Return an array of {rule, match, severity} findings for one line of text.
 *  severity 'block' fails the scan; 'warn' prints but doesn't fail (generic
 *  public IPs are noisy — DNS servers, vendor ranges, canonical examples — so
 *  they warn; our *actual* public IPs are hard-blocked by the hashed denylist). */
function scanLine(line) {
  if (line.includes(ALLOW_PRAGMA)) return []
  const out = []

  for (const m of line.matchAll(IPV4)) {
    const ip = m[0].split('/')[0]
    if (!octetsValid(ip) || isIgnorableIp(ip) || isExampleIp(ip)) continue
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
  for (const m of line.matchAll(WG_KEY))
    out.push({
      rule: 'wg-key',
      severity: 'block',
      match: m[0],
      hint: 'WireGuard/base64 key shape',
    })
  for (const m of line.matchAll(LAN_HOST))
    out.push({ rule: 'lan-host', severity: 'block', match: m[0], hint: 'internal .lan hostname' })

  return out
}

// ---------------------------------------------------------------------------
// hashed denylist — exact crown-jewel strings, matched without storing them

// Fail CLOSED: a missing/corrupt/empty denylist must error, never silently
// disable crown-jewel protection. (Tests pass their own hashes and don't call
// this.) Exported so a self-test can assert it stays populated.
export function loadDenyHashes() {
  if (!existsSync(DENYLIST_FILE)) throw new Error(`denylist missing: ${DENYLIST_FILE}`)
  const j = JSON.parse(readFileSync(DENYLIST_FILE, 'utf8')) // throw on corrupt = fail closed
  const hashes = (j.sha256 ?? []).filter((h) => /^[0-9a-f]{64}$/.test(h))
  if (!hashes.length) throw new Error(`denylist has no valid sha256 entries: ${DENYLIST_FILE}`)
  return new Set(hashes)
}
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Tokens we hash-check: IPs (with/without CIDR), base64 keys, .lan hosts. */
function denylistHits(line, denyHashes) {
  if (!denyHashes.size || line.includes(ALLOW_PRAGMA)) return []
  const tokens = new Set()
  for (const m of line.matchAll(IPV4)) {
    tokens.add(m[0]) // 203.0.113.7/24
    tokens.add(m[0].split('/')[0]) // 203.0.113.7
  }
  for (const m of line.matchAll(WG_KEY)) tokens.add(m[0])
  for (const m of line.matchAll(LAN_HOST)) tokens.add(m[0])
  const out = []
  for (const t of tokens)
    if (denyHashes.has(sha256(t)))
      out.push({
        rule: 'denylist',
        severity: 'block',
        match: t,
        hint: 'exact known-sensitive value',
      })
  return out
}

// ---------------------------------------------------------------------------
// finding sink

export function scanText(text, { denyHashes = new Set() } = {}) {
  const findings = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const f of scanLine(lines[i])) findings.push({ ...f, line: i + 1 })
    for (const f of denylistHits(lines[i], denyHashes)) findings.push({ ...f, line: i + 1 })
  }
  return findings
}

// Exported for unit tests.
export const _internals = { isExampleIp, isIgnorableIp, scanLine, sha256 }

// ---------------------------------------------------------------------------
// modes (only run when invoked as a CLI, not when imported by tests)

function stagedAddedLines() {
  // Added lines in the staged diff, prefixed with their file for reporting.
  const diff = execFileSync('git', ['diff', '--cached', '--unified=0', '--no-color'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const blocks = []
  let file = ''
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) file = line.slice(6)
    else if (line.startsWith('+') && !line.startsWith('+++')) blocks.push({ file, text: line.slice(1) })
  }
  return blocks
}

function trackedFiles() {
  const list = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return list.split('\n').filter(Boolean)
}

// Paths the scanner ignores (its own denylist of hashes, lockfiles, vendored).
const SKIP = [
  /^scripts\/secret-denylist\.json$/,
  /^scripts\/secret-scan\.(mjs|test\.mjs)$/, // the scanner + its fixtures ARE detection patterns/constants

  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.nx\//,
  /(^|\/)dist\//,
  /\.(png|jpg|jpeg|gif|webp|ico|svg|pdf|zip|gz|woff2?|so|a|dll|dylib|jar|class|keystore|jks|bin|wasm)$/i,
]
const skip = (f) => SKIP.some((re) => re.test(f))

/** Binary-content guard: a NUL byte in the first 8KB → treat as binary, skip.
 *  Catches unlisted binary extensions so we never scan (or false-positive on)
 *  compiled blobs. */
function isBinary(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** @returns true if any BLOCK-severity finding was reported (→ nonzero exit). */
function report(findings, where) {
  if (!findings.length) return false
  const blocks = findings.filter((f) => f.severity !== 'warn')
  const warns = findings.filter((f) => f.severity === 'warn')
  if (warns.length) {
    console.error(`\n⚠️  secret-scan: ${warns.length} warning(s) in ${where} (non-blocking):`)
    for (const f of warns)
      console.error(`  ${f.file ?? ''}:${f.line}  [${f.rule}] ${f.match}  — ${f.hint}`)
  }
  if (blocks.length) {
    console.error(`\n❌ secret-scan: ${blocks.length} blocking finding(s) in ${where}:\n`)
    for (const f of blocks)
      console.error(`  ${f.file ?? ''}:${f.line}  [${f.rule}] ${f.match}  — ${f.hint}`)
    console.error(
      `\nThis repo is PUBLIC. Use RFC5737 example IPs (192.0.2.x / 198.51.100.x / 203.0.113.x).\n` +
        `Real value that must ship? append "${ALLOW_PRAGMA}" to the line (audited).\n`,
    )
  }
  return blocks.length > 0
}

function main() {
  const mode = process.argv[2]
  const denyHashes = loadDenyHashes()
  let findings = []

  if (mode === '--staged') {
    for (const { file, text } of stagedAddedLines()) {
      if (skip(file)) continue
      for (const f of scanText(text, { denyHashes })) findings.push({ ...f, file, line: '+' })
    }
    if (report(findings, 'staged changes')) process.exit(1)
  } else if (mode === '--tracked') {
    for (const file of trackedFiles()) {
      if (skip(file)) continue
      let buf
      try {
        buf = readFileSync(file)
      } catch {
        continue
      }
      if (isBinary(buf)) continue
      for (const f of scanText(buf.toString('utf8'), { denyHashes })) findings.push({ ...f, file })
    }
    if (report(findings, 'tracked files')) process.exit(1)
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
