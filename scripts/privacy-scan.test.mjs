// Run: node --test scripts/privacy-scan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  isAcronymToken,
  isArchivePath,
  isCommittedOverlayArchive,
  isFakeUuid,
  isOwnerIdentityPath,
  isPathMarkerFile,
  isVendoredPath,
  parseDenyHashes,
  shouldCheckPersonaToken,
  loadDenyHashes,
  removedHashes,
  RETIRED_DENY_HASHES,
  scanText,
  sha256,
} from './privacy-scan.mjs'

const TEST_UUID = 'deadbeef-0123-4567-89ab-cdef01234567'
const TEST_EMAIL = 'owner@example.test'
const SYNTH_PERSONA = 'Zyxlorn'
const SYNTH_SHORT = 'Qxyp'
const SYNTH_TAG = 'synth-legacy-tag'
const SYNTH_TOOL = 'fc_deadbeef-0123-4567-89ab-cdef01234567_0'
const SHORT_FALSE = ['ar', 'ch'].join('')
const denyHashes = new Set([
  sha256(TEST_UUID),
  sha256(TEST_EMAIL),
  sha256(SYNTH_PERSONA.toLowerCase()),
  sha256(SYNTH_SHORT.toLowerCase()),
  sha256(SHORT_FALSE),
  sha256('pam'),
  sha256(SYNTH_TAG),
  sha256(SYNTH_TOOL),
])

test('fake UUID prefix and repeating test ids are recognized', () => {
  assert.equal(isFakeUuid('00000000-0000-4000-8000-000000000001'), true)
  assert.equal(isFakeUuid('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'), true)
  assert.equal(isFakeUuid('11111111-1111-4111-8111-111111111111'), true)
  assert.equal(isFakeUuid('aaaaaaaa-bbbb-4ccc-8ddd-111111111111'), true)
  assert.equal(isFakeUuid(TEST_UUID), false)
})

test('hashed denylist catches a UUID without storing it', () => {
  const hits = scanText(`id ${TEST_UUID}`, { denyHashes })
  assert.equal(
    hits.some((h) => h.rule === 'denylist-uuid'),
    true,
  )
  assert.equal(
    hits.every((h) => h.rule === 'denylist-uuid'),
    true,
  )
  assert.equal(hits[0].severity, 'block')
})

test('a non-denylisted UUID is ignored', () => {
  const hits = scanText('id 00000000-0000-4000-8000-000000000001', { denyHashes })
  assert.equal(hits.length, 0)
})

test('hashed email is checked on every path except owner-identity files', () => {
  const inSrc = scanText(`mail ${TEST_EMAIL}`, {
    file: 'plugins/memory/postgres/src/index.ts',
    denyHashes,
  })
  assert.equal(
    inSrc.some((h) => h.rule === 'denylist-email'),
    true,
  )
  const owner = scanText(`mail ${TEST_EMAIL}`, {
    file: 'scripts/authorship-check.mjs',
    denyHashes,
  })
  assert.equal(
    owner.some((h) => h.rule === 'denylist-email'),
    false,
  )
})

test('agent-data path with a non-fake UUID is blocked in docs', () => {
  const hits = scanText(`path agent-data/agents/${TEST_UUID}/profile.json`, {
    file: 'docs/MEMORY-DESIGN.md',
  })
  assert.equal(
    hits.some((h) => h.rule === 'agent-data-path'),
    true,
  )
  const fake = scanText(
    'path agent-data/agents/00000000-0000-4000-8000-000000000001/profile.json',
    { file: 'README.md' },
  )
  assert.equal(
    fake.some((h) => h.rule === 'agent-data-path'),
    false,
  )
})

test('/home/<user> is blocked in docs and fixtures', () => {
  assert.equal(isPathMarkerFile('docs/MEMORY-DESIGN.md'), true)
  assert.equal(isPathMarkerFile('integrations/grok-bot/rivet-memory/README.md'), true)
  assert.equal(isPathMarkerFile('capture/test/fixtures/page-start.txt'), true)
  assert.equal(
    isPathMarkerFile('apps/rivet-android/app/src/main/java/dev/rivet/app/runtime/RivetRuntime.kt'),
    false,
  )
  const someone = ['al', 'ice'].join('')
  const other = ['p', 'at'].join('')
  const doc = scanText(`cd /home/${someone}/app`, { file: 'docs/MEMORY-DESIGN.md' })
  assert.equal(
    doc.some((h) => h.rule === 'home-path'),
    true,
  )
  const readme = scanText(`open /home/${other}/.rivetos`, {
    file: 'integrations/grok-bot/rivet-memory/README.md',
  })
  assert.equal(
    readme.some((h) => h.rule === 'home-path'),
    true,
  )
  const ci = scanText('cd /home/ubuntu/work', { file: 'docs/MEMORY-DESIGN.md' })
  assert.equal(
    ci.some((h) => h.rule === 'home-path'),
    false,
  )
  const product = scanText('cwd /home/rivet/.rivetos', {
    file: 'plugins/providers/grok-cli/README.md',
  })
  assert.equal(
    product.some((h) => h.rule === 'home-path'),
    false,
  )
  const src = scanText(`cd /home/${someone}/app`, {
    file: 'apps/rivet-android/app/src/main/java/dev/rivet/app/runtime/RivetRuntime.kt',
  })
  assert.equal(
    src.some((h) => h.rule === 'home-path'),
    false,
  )
  const hashedUser = ['Qx', 'ypHome'].join('')
  const hashed = scanText(`cd /home/${hashedUser}/app`, {
    file: 'apps/rivet-android/app/src/main/java/dev/rivet/app/runtime/RivetRuntime.kt',
    denyHashes: new Set([sha256(hashedUser.toLowerCase())]),
  })
  assert.equal(
    hashed.some((h) => h.rule === 'home-path'),
    true,
  )
})

test('parseDenyHashes folds case and drops junk', () => {
  const set = parseDenyHashes({
    sha256: ['A'.repeat(64), 'not-a-hash', createHash('sha256').update('x').digest('hex')],
  })
  assert.equal(set.size, 2)
  assert.ok(set.has('a'.repeat(64)))
})

test('a retired hash is off the denylist, and retiring is the only way to shrink it', () => {
  const current = loadDenyHashes()
  for (const hash of RETIRED_DENY_HASHES) {
    assert.match(hash, /^[0-9a-f]{64}$/)
    // Retired and still listed would mean the word is both allowed and blocked.
    assert.equal(current.has(hash), false)
  }
  // A baseline that had the retired entries plus one more: only the other one counts as removed.
  const other = 'c'.repeat(64)
  const baseline = new Set([...current, ...RETIRED_DENY_HASHES, other])
  const removed = removedHashes(baseline, current).filter((h) => !RETIRED_DENY_HASHES.has(h))
  assert.deepEqual(removed, [other])
})

test('removedHashes detects a shrink', () => {
  const a = new Set(['aa', 'bb'])
  const b = new Set(['bb'])
  assert.deepEqual(removedHashes(a, b), ['aa'])
})

test('synthetic hashed persona, tag, and tool-call id are detected', () => {
  const file = 'plugins/providers/grok-cli/src/index.test.ts'
  assert.equal(
    scanText(`persona: "${SYNTH_PERSONA}"`, { file, denyHashes }).some(
      (h) => h.rule === 'denylist-persona',
    ),
    true,
  )
  assert.equal(
    scanText(`agent: ${SYNTH_TAG}`, { file, denyHashes }).some((h) => h.rule === 'denylist-tag'),
    true,
  )
  assert.equal(
    scanText(`id ${SYNTH_TOOL}`, { file, denyHashes }).some((h) => h.rule === 'denylist-tool-id'),
    true,
  )
})

test('ALL-CAPS acronyms and Rivet product language are allowed', () => {
  const pam = ['P', 'A', 'M'].join('')
  const ssh = ['S', 'S', 'H'].join('')
  assert.equal(isAcronymToken(pam), true)
  assert.equal(isAcronymToken(ssh), true)
  assert.equal(isAcronymToken(SYNTH_PERSONA), false)
  assert.equal(shouldCheckPersonaToken(pam), false)
  assert.equal(shouldCheckPersonaToken(pam.toLowerCase()), false)
  assert.equal(shouldCheckPersonaToken(SYNTH_SHORT), true)
  assert.equal(shouldCheckPersonaToken(SYNTH_SHORT.toLowerCase()), false)
  const generic = ['x', 'yz'].join('')
  assert.equal(shouldCheckPersonaToken(generic), false)
  const file = 'docs/MEMORY-DESIGN.md'
  assert.equal(scanText(`${pam} auth and ${ssh} keys`, { file, denyHashes }).length, 0)
  assert.equal(scanText(`configure --disable-${pam.toLowerCase()}`, { file, denyHashes }).length, 0)
  assert.equal(scanText(`generic user ${generic} in a fixture`, { file, denyHashes }).length, 0)
  assert.equal(
    scanText(`persona ${SYNTH_SHORT}`, { file, denyHashes }).some(
      (h) => h.rule === 'denylist-persona',
    ),
    true,
  )
  assert.equal(scanText('RivetOS shared memory', { file, denyHashes }).length, 0)
  assert.equal(scanText('every Rivet agent serving this user', { file, denyHashes }).length, 0)
  assert.equal(scanText('architecture notes', { file, denyHashes }).length, 0)
  const os = `${SHORT_FALSE[0].toUpperCase()}${SHORT_FALSE.slice(1)}`
  assert.equal(scanText(`${os} Linux`, { file, denyHashes }).length, 0)
  assert.equal(scanText('persona Alpha / agent grokbot-alpha', { file, denyHashes }).length, 0)
  const bannedPrefix = ['DEFAULT_AGENT_PREFIX = ', "'", ['ri', 'vet'].join(''), "'"].join('')
  assert.equal(
    scanText(bannedPrefix, { file, denyHashes }).some((h) => h.rule === 'legacy-prefix'),
    true,
  )
})

test('short persona tokens hit tags, quotes, and Title-case — not prose lowercase/ALL-CAPS', () => {
  const file = 'docs/MEMORY-DESIGN.md'
  const low = SYNTH_SHORT.toLowerCase()
  const up = SYNTH_SHORT.toUpperCase()
  const pam = ['P', 'A', 'M'].join('')
  assert.equal(
    scanText(`hello ${low} in prose`, { file, denyHashes }).some(
      (h) => h.rule === 'denylist-persona',
    ),
    false,
  )
  assert.equal(scanText(`hello ${up} in prose`, { file, denyHashes }).length, 0)
  assert.equal(
    scanText(`persona ${SYNTH_SHORT}`, { file, denyHashes }).some(
      (h) => h.rule === 'denylist-persona',
    ),
    true,
  )
  assert.equal(
    scanText(`agent rivet-${low}`, { file, denyHashes }).some((h) => h.rule === 'denylist-tag'),
    true,
  )
  assert.equal(
    scanText(`agent grokbot-${low}`, { file, denyHashes }).some((h) => h.rule === 'denylist-tag'),
    true,
  )
  assert.equal(
    scanText(`slug rivet-${low}-v3`, { file, denyHashes }).some((h) => h.rule === 'denylist-tag'),
    true,
  )
  assert.equal(
    scanText(`id '${low}'`, { file, denyHashes }).some((h) => h.rule === 'denylist-persona'),
    true,
  )
  assert.equal(
    scanText(`id "${low}"`, { file, denyHashes }).some((h) => h.rule === 'denylist-persona'),
    true,
  )
  assert.equal(
    scanText(`id '${up}'`, { file, denyHashes }).some((h) => h.rule === 'denylist-persona'),
    true,
  )
  assert.equal(
    scanText(`agent rivet-${up}`, { file, denyHashes }).some((h) => h.rule === 'denylist-tag'),
    true,
  )
  assert.equal(scanText(`${pam} auth`, { file, denyHashes }).length, 0)
  assert.equal(scanText(`configure --disable-${pam.toLowerCase()}`, { file, denyHashes }).length, 0)
  assert.equal(scanText('architecture notes', { file, denyHashes }).length, 0)
  const os = `${SHORT_FALSE[0].toUpperCase()}${SHORT_FALSE.slice(1)}`
  assert.equal(scanText(`${os} Linux`, { file, denyHashes }).length, 0)
  assert.equal(scanText('every Rivet agent', { file, denyHashes }).length, 0)
  assert.equal(
    scanText(`seedUsersJson('${low}')`, { file, denyHashes }).some(
      (h) => h.rule === 'denylist-persona',
    ),
    false,
  )
  assert.equal(
    scanText(`process.arch === '${SHORT_FALSE}'`, { file, denyHashes }).some(
      (h) => h.rule === 'denylist-persona',
    ),
    false,
  )
  assert.equal(
    scanText(`process.arch === '${SHORT_FALSE.toUpperCase()}'`, { file, denyHashes }).some(
      (h) => h.rule === 'denylist-persona',
    ),
    false,
  )
  assert.equal(
    scanText(`agent rivet-${SHORT_FALSE}`, { file, denyHashes }).some(
      (h) => h.rule === 'denylist-tag',
    ),
    true,
  )
  assert.equal(
    scanText(`agent grokbot-${SHORT_FALSE}`, { file, denyHashes }).some(
      (h) => h.rule === 'denylist-tag',
    ),
    true,
  )
})

test('owner-identity paths skip persona and email only', () => {
  assert.equal(isOwnerIdentityPath('LICENSE'), true)
  assert.equal(isOwnerIdentityPath('packages/cli/LICENSE'), true)
  assert.equal(isOwnerIdentityPath('NOTICE'), true)
  assert.equal(isOwnerIdentityPath('package.json'), true)
  assert.equal(isOwnerIdentityPath('apps/site/package.json'), true)
  assert.equal(isOwnerIdentityPath('scripts/authorship-check.test.mjs'), true)
  assert.equal(isOwnerIdentityPath('scripts/authorship-allowlist.json'), true)
  assert.equal(isOwnerIdentityPath('scripts/sync-authorship-allowlist.mjs'), true)
  assert.equal(isOwnerIdentityPath('.claude-plugin/marketplace.json'), true)
  assert.equal(isOwnerIdentityPath('docs/MEMORY-DESIGN.md'), false)
  const hits = scanText(`persona: "${SYNTH_PERSONA}" mail ${TEST_EMAIL} id ${TEST_UUID}`, {
    file: 'LICENSE',
    denyHashes,
  })
  assert.equal(
    hits.some((h) => h.rule === 'denylist-persona'),
    false,
  )
  assert.equal(
    hits.some((h) => h.rule === 'denylist-email'),
    false,
  )
  assert.equal(
    hits.some((h) => h.rule === 'denylist-uuid'),
    true,
  )
})

test('hashed IPv4 prefix matches a full address and the 3-octet prefix', () => {
  const prefix = ['203', '0', '113'].join('.')
  const hashes = new Set([sha256(prefix)])
  assert.equal(
    scanText(`gw ${prefix}.10`, { denyHashes: hashes }).some(
      (h) => h.rule === 'denylist-ip-prefix',
    ),
    true,
  )
  assert.equal(
    scanText(`net ${prefix}`, { denyHashes: hashes }).some((h) => h.rule === 'denylist-ip-prefix'),
    true,
  )
  assert.equal(scanText('other 198.51.100.1', { denyHashes: hashes }).length, 0)
})

test('short hashed host tokens are caught outside tag context', () => {
  const host = ['zv', '3'].join('')
  const hashes = new Set([sha256(host)])
  assert.equal(
    scanText(`ssh ${host}`, { file: 'scripts/foo.sh', denyHashes: hashes }).some(
      (h) => h.rule === 'denylist-host',
    ),
    true,
  )
})

test('vendored paths skip home and host rules; dropbear README still scans', () => {
  assert.equal(
    isVendoredPath('apps/rivet-android/document/src/main/java/com/artifex/mupdf/fitz/Archive.java'),
    true,
  )
  assert.equal(isVendoredPath('apps/rivet-android/native/dropbear/localoptions.h'), true)
  assert.equal(isVendoredPath('apps/rivet-android/native/dropbear/README.md'), false)
  const someone = ['al', 'ice'].join('')
  assert.equal(
    scanText(`cd /home/${someone}/x`, {
      file: 'apps/rivet-android/native/dropbear/localoptions.h',
    }).some((h) => h.rule === 'home-path'),
    false,
  )
})

test('overlay archives are identified as committed assets', () => {
  assert.equal(
    isArchivePath('apps/rivet-android/app/src/main/assets/rivet-phone-overlay.bin'),
    true,
  )
  assert.equal(
    isCommittedOverlayArchive('apps/rivet-android/app/src/main/assets/rivet-phone-overlay.bin'),
    true,
  )
  assert.equal(isCommittedOverlayArchive('docs/foo.md'), false)
})
