#!/usr/bin/env node
// Privacy scanner for the public repo. One engine, three call sites:
//   --staged   scan the staged git diff (added lines only)  → pre-commit hook
//   --tracked  scan every tracked file                      → CI push/PR
//   --text     scan stdin (a PR title+body, etc.)           → CI pull_request
//
// Design: denylisted UUIDs, emails, persona tokens, and hyphenated tags are
// stored only as SHA-256 hashes. The scanner hashes every candidate it finds
// and compares. Plaintext of denylisted values is never committed. Findings
// are redacted in CI.
//
// Marker rules (docs, READMEs, and fixtures): agent-data/agents/<non-fake-uuid>
// and /home/<user> paths.

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
const AGENT_DATA_RE =
  /agent-data\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
const HOME_RE = /\/home\/([A-Za-z0-9._-]+)/g
const IPV4_LIKE_RE = /\b(\d{1,3}(?:\.\d{1,3}){1,3})\b/g
const FC_ID_RE = /\bfc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_0\b/gi
const WORD_RE = /\b[A-Za-z][A-Za-z0-9]*\b/g
const HYPHEN_TOKEN_RE = /\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g
/** Hardcoded default prefix (tags now come from the slug rule). */
const BANNED_PREFIX_RE = /(?:DEFAULT_AGENT_PREFIX|agentPrefix)\s*[:=]\s*['"`]rivet['"`]/

const FAKE_UUIDS = new Set([
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa',
  '11111111-2222-4333-8444-555555555555',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '99999999-aaaa-4bbb-8ccc-dddddddddddd',
])

const ALLOWED_HOME_USERS = new Set(['ubuntu', 'runner', 'rivet', 'rivetos', 'user', 'example'])

/** Vendored trees: skip persona/home false positives. Still scan README at dropbear root. */
const VENDORED_RE = [
  /(^|\/)com\/artifex\/mupdf\//,
  /(^|\/)material-color-utilities\//,
  /(^|\/)native\/dropbear\/(?!README\.md$)/,
  /(^|\/)highlight\/src\/main\/res\/raw\/prism\.js$/,
  /(^|\/)simple_dict\//,
  /(^|\/)jieba\//,
]

export function isVendoredPath(file) {
  return VENDORED_RE.some((re) => re.test(file))
}

export function isArchivePath(file) {
  return /\.(bin|tar\.gz|tgz)$/i.test(file)
}

export function isCommittedOverlayArchive(file) {
  return /(^|\/)assets\/[^/]*overlay[^/]*\.(bin|tar\.gz|tgz)$/i.test(file)
}

/** Path markers apply to READMEs, docs, fixtures — not application source. */
const PATH_MARKER_RE = [
  /(^|\/)README(\.[A-Za-z0-9]+)?$/i,
  /(^|\/)docs\//,
  /(^|\/)fixtures\//,
  /\.(md|mdx)$/i,
]

export function isPathMarkerFile(file) {
  if (!file || file === '<input>') return true
  return PATH_MARKER_RE.some((re) => re.test(file))
}

/** Owner-identity files: skip persona + email only. UUIDs and tags still scan. */
const OWNER_IDENTITY_RE = [
  /(^|\/)LICENSE$/,
  /(^|\/)NOTICE$/,
  /(^|\/)package\.json$/,
  /^scripts\/authorship-check(\.test)?\.mjs$/,
  /^scripts\/authorship-allowlist\.json$/,
  /^scripts\/sync-authorship-allowlist\.mjs$/,
  /^scripts\/git-hooks\/commit-msg$/,
  /^\.claude-plugin\/marketplace\.json$/,
]

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
  if (!hashes.size)
    throw new Error(`privacy denylist has no valid sha256 entries: ${DENYLIST_FILE}`)
  return hashes
}

export function isOwnerIdentityPath(file) {
  return OWNER_IDENTITY_RE.some((re) => re.test(file))
}

/** ALL-CAPS tokens of length 2–4 (PAM, SSH) are not persona names. */
export function isAcronymToken(token) {
  return token.length >= 2 && token.length <= 4 && /^[A-Z]+$/.test(token)
}

/** `--disable-pam` and similar flags are not persona tags. */
export function isCliFlagContext(line, index) {
  let i = index
  while (i > 0 && /[A-Za-z0-9-]/.test(line[i - 1])) i--
  return line.slice(i, i + 2) === '--'
}

function hyphenChainHasAgentPrefix(line, index) {
  let i = index
  while (i > 0 && /[A-Za-z0-9-]/.test(line[i - 1])) i--
  let j = index
  while (j < line.length && /[A-Za-z0-9-]/.test(line[j])) j++
  return /(^|-)(rivet|grokbot)(-|$)/i.test(line.slice(i, j))
}

/**
 * Identifier / tag context: `rivet-x`, `grokbot-x`, `-x-` slugs that
 * include those prefixes, or quoted strings. Not a CLI flag
 * (`--disable-x`) and not `Foo('x')`.
 */
export function inTagOrIdContext(line, index, token) {
  if (isCliFlagContext(line, index)) return false
  const before = line.slice(0, index)
  const after = line.slice(index + token.length)
  if (/[A-Za-z0-9]-$/.test(before) || /^-[A-Za-z0-9]/.test(after)) {
    return hyphenChainHasAgentPrefix(line, index)
  }
  const q = before.slice(-1)
  if ((q === "'" || q === '"' || q === '`') && after.startsWith(q)) {
    // process.arch comparisons (`=== 'arch'`) are not persona tags.
    if (/^arch$/i.test(token)) return false
    const pre = before.slice(0, -1)
    // Foo('x'), ['x'], or `fn("x")` are call/list args, not tags.
    if (/[A-Za-z0-9_]$/.test(pre) || /[[(,]$/.test(pre) || /,\s*$/.test(pre)) return false
    return true
  }
  return false
}

/**
 * Short tokens (≤4): Title-case words in prose (except `… Linux`), plus
 * lowercase / ALL-CAPS only in identifier or tag contexts. Longer tokens
 * match any case. PAM auth, `--disable-pam`, and `architecture` stay clean.
 */
export function shouldCheckPersonaToken(token, line = '', index = 0) {
  if (token.length <= 4) {
    if (/^[A-Z][a-z]+$/.test(token)) {
      if (/^\s+Linux\b/.test(line.slice(index + token.length))) return false
      return true
    }
    return inTagOrIdContext(line, index, token)
  }
  if (isAcronymToken(token)) return false
  return true
}

export function scanLine(line, { file = '', denyHashes = new Set() } = {}) {
  const out = []
  const skipOwnerTokens = isOwnerIdentityPath(file)

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
  for (const m of line.matchAll(FC_ID_RE)) {
    const id = m[0].toLowerCase()
    if (denyHashes.has(sha256(id))) {
      out.push({
        rule: 'denylist-tool-id',
        severity: 'block',
        match: id,
        hint: 'hashed denylist tool-call id',
      })
    }
  }
  if (!skipOwnerTokens) {
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
    for (const m of line.matchAll(HYPHEN_TOKEN_RE)) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m[0])) continue
      if (isCliFlagContext(line, m.index ?? 0)) continue
      const token = m[0].toLowerCase()
      const parts = token.split('-')
      const agentTag = parts.includes('rivet') || parts.includes('grokbot')
      const partHit = agentTag && parts.some((p) => p && denyHashes.has(sha256(p)))
      if (denyHashes.has(sha256(token)) || partHit) {
        out.push({
          rule: 'denylist-tag',
          severity: 'block',
          match: m[0],
          hint: 'hashed denylist hyphenated tag',
        })
      }
    }
    for (const m of line.matchAll(WORD_RE)) {
      if (!shouldCheckPersonaToken(m[0], line, m.index ?? 0)) continue
      if (denyHashes.has(sha256(m[0].toLowerCase()))) {
        out.push({
          rule: 'denylist-persona',
          severity: 'block',
          match: m[0],
          hint: 'hashed denylist persona token',
        })
      }
    }
  }
  if (BANNED_PREFIX_RE.test(line)) {
    out.push({
      rule: 'legacy-prefix',
      severity: 'block',
      match: 'rivet',
      hint: 'hardcoded rivet- agent prefix — tags come from the slug rule',
    })
  }
  if (!isVendoredPath(file)) {
    for (const m of line.matchAll(IPV4_LIKE_RE)) {
      const token = m[0]
      const parts = token.split('.')
      const candidates = [token]
      if (parts.length >= 3) candidates.push(parts.slice(0, 3).join('.'))
      if (parts.length >= 2) candidates.push(parts.slice(0, 2).join('.'))
      if (candidates.some((c) => denyHashes.has(sha256(c)))) {
        out.push({
          rule: 'denylist-ip-prefix',
          severity: 'block',
          match: token,
          hint: 'hashed denylist address or prefix',
        })
      }
    }
    for (const m of line.matchAll(WORD_RE)) {
      if (shouldCheckPersonaToken(m[0], line, m.index ?? 0)) continue
      // Short letter+digit tokens (lab hosts like box3) skip the persona gate.
      if (!/^[A-Za-z]{2,}\d+$/.test(m[0])) continue
      if (denyHashes.has(sha256(m[0].toLowerCase()))) {
        out.push({
          rule: 'denylist-host',
          severity: 'block',
          match: m[0],
          hint: 'hashed denylist host or token',
        })
      }
    }
    for (const m of line.matchAll(HOME_RE)) {
      if (ALLOWED_HOME_USERS.has(m[1])) continue
      const personal = denyHashes.has(sha256(m[1].toLowerCase()))
      if (!personal && !isPathMarkerFile(file)) continue
      out.push({
        rule: 'home-path',
        severity: 'block',
        match: m[0],
        hint: '/home/<user> — use /home/user, /home/ubuntu, /home/rivet, or $HOME',
      })
    }
  }
  if (isPathMarkerFile(file)) {
    for (const m of line.matchAll(AGENT_DATA_RE)) {
      const id = m[1].toLowerCase()
      if (!isFakeUuid(id)) {
        out.push({
          rule: 'agent-data-path',
          severity: 'block',
          match: m[0],
          hint: 'agent-data/agents/<uuid> must use a fake UUID',
        })
      }
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
  /^scripts\/privacy-denylist-add\.mjs$/,
  /^scripts\/secret-denylist\.json$/,
  /^scripts\/secret-scan\.(mjs|test\.mjs)$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.nx\//,
  /(^|\/)dist\//,
  /(^|\/)__pycache__\//,
  /(^|\/)prebuilt\//,
  /(^|\/)simple_dict\/idf\.utf8$/,
  /\.(png|jpg|jpeg|gif|webp|ico|svg|pdf|zip|woff2?|ttf|otf|mp3|wav|ogg|mp4|m4a|webm|so|a|dll|dylib|jar|class|keystore|jks|wasm|pyc|pyo)$/i,
]
const skip = (f) => SKIP.some((re) => re.test(f)) || isVendoredPath(f)

function archiveMembers(file) {
  try {
    const out = execFileSync('tar', ['-tzf', file], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out.split('\n').filter(Boolean)
  } catch {
    return null
  }
}

function archiveMemberText(file, member) {
  try {
    const buf = execFileSync('tar', ['-xOf', file, member], {
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (buf.includes(0)) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

export function scanArchiveFile(file, denyHashes) {
  const findings = []
  if (isCommittedOverlayArchive(file)) {
    findings.push({
      rule: 'committed-archive',
      severity: 'block',
      match: file,
      hint: 'overlay archives must be built from overlay-src, not committed',
      file,
      line: 1,
    })
  }
  const members = archiveMembers(file)
  if (members === null) {
    findings.push({
      rule: 'unreadable-archive',
      severity: 'block',
      match: file,
      hint: 'tracked .bin/.tar.gz could not be listed as a tar archive',
      file,
      line: 1,
    })
    return findings
  }
  for (const member of members) {
    if (member.endsWith('/')) continue
    const text = archiveMemberText(file, member)
    if (text == null) continue
    for (const f of scanText(text, { file: `${file}!${member}`, denyHashes })) {
      findings.push({ ...f, file: `${file}!${member}` })
    }
  }
  return findings
}

/**
 * Entries deliberately taken off the denylist, by hash. The list must not
 * shrink by accident, so a removal is allowed only for a hash named here, in
 * the same reviewed change. Reason for these two: they were added as private
 * names but are also ordinary words (an English adjective and a common given
 * name), and the word rule blocked them in plain prose.
 */
export const RETIRED_DENY_HASHES = new Set([
  '0f1324de378fb2e399bc66843abb736ca47eb638b6a05bacb23a82efb5ffd62b',
  '3464f13b59481aa6bc54e9e86694a2e52344ba3dccf24c46475a2f1596271619',
])

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
  return removedHashes(parseDenyHashes(JSON.parse(mainJson)), current).filter(
    (hash) => !RETIRED_DENY_HASHES.has(hash),
  )
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
      if (isArchivePath(file) || skip(file)) continue
      for (const f of scanText(text, { file, denyHashes })) findings.push({ ...f, file, line })
    }
    let stagedNames = ''
    try {
      stagedNames = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
    } catch {
      stagedNames = ''
    }
    for (const file of stagedNames.split('\n').filter(Boolean)) {
      if (isArchivePath(file)) findings.push(...scanArchiveFile(file, denyHashes))
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
      if (isArchivePath(file)) {
        findings.push(...scanArchiveFile(file, denyHashes))
        continue
      }
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
      console.error(
        `\n❌ privacy-scan: ${unscannable} tracked file(s) could not be safely scanned.`,
      )
    if (bad || unscannable > 0) process.exit(1)
  } else if (mode === '--text') {
    const text = readFileSync(0, 'utf8')
    findings = scanText(text, { file: '<input>', denyHashes }).map((f) => ({
      ...f,
      file: '<input>',
    }))
    if (report(findings, 'input text')) process.exit(1)
  } else {
    console.error('usage: privacy-scan.mjs --staged | --tracked | --text (stdin)')
    process.exit(2)
  }
  console.log('✅ privacy-scan: clean')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
