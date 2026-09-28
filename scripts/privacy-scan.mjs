#!/usr/bin/env node
// Privacy scanner for the public repo. One engine, three call sites:
//   --staged   scan the staged git diff (added lines only)  → pre-commit hook
//   --tracked  scan every tracked file                      → CI push/PR
//   --text     scan stdin (a PR title+body, etc.)           → CI pull_request
//
// Design: denylisted UUIDs and emails are stored only as SHA-256 hashes.
// The scanner hashes every UUID / email it finds and compares. Plaintext of
// denylisted values is never committed. Findings are redacted in CI.
//
// Marker rules (fixtures only): agent-data/agents/<non-fake-uuid> and
// /home/box or /home/<user> paths.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DENYLIST_FILE = join(HERE, 'privacy-denylist.json')
const DENYLIST_REPO_PATH = 'scripts/privacy-denylist.json'

const REDACT = !!(process.env.CI || process.env.GITHUB_ACTIONS)
const MAX_FILE_BYTES = 5 * 1024 * 1024

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const AGENT_DATA_RE = /agent-data\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
const HOME_RE = /\/home\/([A-Za-z0-9._-]+)/g

const FAKE_UUIDS = new Set([
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa',
  '11111111-2222-4333-8444-555555555555',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '99999999-aaaa-4bbb-8ccc-dddddddddddd',
])

export function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export function isFakeUuid(id) {
  const s = String(id).toLowerCase()
  if (s.startsWith('00000000-0000-4000-8000-')) return true
  if (FAKE_UUIDS.has(s)) return true
  const first = s.slice(0, 8)
  if (/^(.)\1{7}$/.test(first)) return true
  const hex = s.replace(/-/g, '')
  return new Set(hex).size <= 4
}

export function parseDenyHashes(json) {
  return new Set(
    (json.sha256 ?? []).map((h) => String(h).toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h)),
  )
}

export function loadDenyHashes() {
  if (!existsSync(DENYLIST_FILE)) throw new Error(`privacy denylist missing: ${DENYLIST_FILE}`)
  const hashes = parseDenyHashes(JSON.parse(readFileSync(DENYLIST_FILE, 'utf8')))
  if (!hashes.size) throw new Error(`privacy denylist has no valid sha256 entries: ${DENYLIST_FILE}`)
  return hashes
}

export function isFixturePath(file) {
  return /(^|\/)(test\/)?fixtures\//.test(file) || /(^|\/)fixtures\//.test(file)
}

export function isGrokBotFixturePath(file) {
  return file.startsWith('integrations/grok-bot/') && isFixturePath(file)
}

export function isEmailScanPath(file) {
  return file.startsWith('integrations/grok-bot/') || isFixturePath(file) || file === '<input>'
}

export function scanLine(line, { file = '', denyHashes = new Set() } = {}) {
  const out = []
  for (const m of line.matchAll(UUID_RE)) {
    const id = m[0].toLowerCase()
    if (denyHashes.has(sha256(id))) {
      out.push({
        rule: 'denylist-uuid',
        severity: 'block',
        match: id,
        hint: 'hashed denylist UUID',
      })
    }
  }
  if (isEmailScanPath(file)) {
    for (const m of line.matchAll(EMAIL_RE)) {
      const email = m[0].toLowerCase()
      if (denyHashes.has(sha256(email))) {
        out.push({
          rule: 'denylist-email',
          severity: 'block',
          match: email,
          hint: 'hashed denylist email',
        })
      }
    }
  }
  if (isGrokBotFixturePath(file)) {
    for (const m of line.matchAll(AGENT_DATA_RE)) {
      const id = m[1].toLowerCase()
      if (!isFakeUuid(id)) {
        out.push({
          rule: 'agent-data-path',
          severity: 'block',
          match: m[0],
          hint: 'agent-data/agents/<uuid> in a fixture must use a fake UUID',
        })
      }
    }
    for (const m of line.matchAll(HOME_RE)) {
      if (m[1] === 'ubuntu') continue
      out.push({
        rule: 'home-path',
        severity: 'block',
        match: m[0],
        hint: '/home/<user> in fixtures — use /tmp or $HOME',
      })
    }
  }
  return out
}

export function scanText(text, opts = {}) {
  const findings = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const f of scanLine(lines[i], opts)) findings.push({ ...f, line: i + 1 })
  }
  return findings
}

export const removedHashes = (baseline, current) => [...baseline].filter((h) => !current.has(h))

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
  }
  return blocks
}

function trackedFiles() {
  const list = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return list.split('\n').filter(Boolean)
}

const SKIP = [
  /^scripts\/privacy-denylist\.json$/,
  /^scripts\/privacy-scan\.(mjs|test\.mjs)$/,
  /^scripts\/privacy-denylist-add\.mjs$/,
  /^integrations\/grok-bot\/rivet-memory\/capture\/privacy-history-paths\.txt$/,
  /^scripts\/secret-denylist\.json$/,
  /^scripts\/secret-scan\.(mjs|test\.mjs)$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.nx\//,
  /(^|\/)dist\//,
  /(^|\/)__pycache__\//,
  /(^|\/)prebuilt\//,
  /(^|\/)simple_dict\/idf\.utf8$/,
  /\.(png|jpg|jpeg|gif|webp|ico|svg|pdf|zip|gz|woff2?|ttf|otf|mp3|wav|ogg|mp4|m4a|webm|so|a|dll|dylib|jar|class|keystore|jks|bin|wasm|pyc|pyo)$/i,
]
const skip = (f) => SKIP.some((re) => re.test(f))

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

function shown(f) {
  if (!f.match) return ''
  return REDACT ? `<redacted:${sha256(f.match).slice(0, 8)}>` : f.match
}

function report(findings, where) {
  if (!findings.length) return false
  const blocks = findings.filter((f) => f.severity !== 'warn')
  const warns = findings.filter((f) => f.severity === 'warn')
  if (warns.length) {
    console.error(`\n⚠️  privacy-scan: ${warns.length} warning(s) in ${where}:`)
    for (const f of warns)
      console.error(`  ${f.file ?? ''}:${f.line}  [${f.rule}] ${shown(f)}  — ${f.hint}`)
  }
  if (blocks.length) {
    console.error(`\n❌ privacy-scan: ${blocks.length} blocking finding(s) in ${where}:\n`)
    for (const f of blocks)
      console.error(`  ${f.file ?? ''}:${f.line}  [${f.rule}] ${shown(f)}  — ${f.hint}`)
    console.error(
      `\nThis repo is PUBLIC. Use fake UUIDs (00000000-0000-4000-8000-…) and example.com.\n` +
        (REDACT ? 'Values redacted in CI — run the scanner locally to see them.\n' : ''),
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
      for (const f of scanText(text, { file, denyHashes })) findings.push({ ...f, file, line })
    }
    if (report(findings, 'staged changes')) process.exit(1)
  } else if (mode === '--tracked') {
    const removed = denylistRemovedVsMain(denyHashes)
    if (removed === null)
      console.error(
        '⚠️  privacy-scan: could not compare denylist against origin/main (first add is ok)',
      )
    else if (removed.length) {
      console.error(
        `\n❌ privacy-scan: ${removed.length} denylist entr(y/ies) REMOVED vs origin/main — ` +
          `hashed privacy protection must not shrink without an explicit, reviewed reason.\n`,
      )
      process.exit(1)
    }
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
        console.error(`  OVERSIZE >${MAX_FILE_BYTES}B (fail closed): ${file}`)
        continue
      }
      for (const f of scanText(buf.toString('utf8'), { file, denyHashes }))
        findings.push({ ...f, file })
    }
    const bad = report(findings, 'tracked files')
    if (unscannable > 0)
      console.error(`\n❌ privacy-scan: ${unscannable} tracked file(s) could not be safely scanned.`)
    if (bad || unscannable > 0) process.exit(1)
  } else if (mode === '--text') {
    const text = readFileSync(0, 'utf8')
    findings = scanText(text, { file: '<input>', denyHashes }).map((f) => ({ ...f, file: '<input>' }))
    if (report(findings, 'input text')) process.exit(1)
  } else {
    console.error('usage: privacy-scan.mjs --staged | --tracked | --text (stdin)')
    process.exit(2)
  }
  console.log('✅ privacy-scan: clean')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
