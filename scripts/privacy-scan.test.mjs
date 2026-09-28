// Run: node --test scripts/privacy-scan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  isAcronymToken,
  isFakeUuid,
  isOwnerIdentityPath,
  isPathMarkerFile,
  parseDenyHashes,
  shouldCheckPersonaToken,
  removedHashes,
  scanText,
  sha256,
} from './privacy-scan.mjs'

const TEST_UUID = 'deadbeef-0123-4567-89ab-cdef01234567'
const TEST_EMAIL = 'owner@example.test'
const SYNTH_PERSONA = 'Zyxlorn'
const SYNTH_SHORT = 'Qxyp'
const SYNTH_TAG = 'synth-legacy-tag'
const SYNTH_TOOL = 'fc_deadbeef-0123-4567-89ab-cdef01234567_0'
const denyHashes = new Set([
  sha256(TEST_UUID),
  sha256(TEST_EMAIL),
  sha256(SYNTH_PERSONA.toLowerCase()),
  sha256(SYNTH_SHORT.toLowerCase()),
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
  assert.equal(isPathMarkerFile('capture/test/fixtures/page-gamma-0-20.txt'), true)
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
})

test('parseDenyHashes folds case and drops junk', () => {
  const set = parseDenyHashes({
    sha256: ['A'.repeat(64), 'not-a-hash', createHash('sha256').update('x').digest('hex')],
  })
  assert.equal(set.size, 2)
  assert.ok(set.has('a'.repeat(64)))
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
  assert.equal(isAcronymToken('PAM'), true)
  assert.equal(isAcronymToken('SSH'), true)
  assert.equal(isAcronymToken(SYNTH_PERSONA), false)
  assert.equal(shouldCheckPersonaToken('PAM'), false)
  assert.equal(shouldCheckPersonaToken('pam'), false)
  assert.equal(shouldCheckPersonaToken(SYNTH_SHORT), true)
  assert.equal(shouldCheckPersonaToken(SYNTH_SHORT.toLowerCase()), false)
  const generic = ['x', 'yz'].join('')
  assert.equal(shouldCheckPersonaToken(generic), false)
  const file = 'docs/MEMORY-DESIGN.md'
  assert.equal(scanText('PAM auth and SSH keys', { file, denyHashes }).length, 0)
  assert.equal(scanText('configure --disable-pam', { file, denyHashes }).length, 0)
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
  assert.equal(scanText('persona Alpha / agent grokbot-alpha', { file, denyHashes }).length, 0)
  const bannedPrefix = ['DEFAULT_AGENT_PREFIX = ', "'", ['ri', 'vet'].join(''), "'"].join('')
  assert.equal(
    scanText(bannedPrefix, { file, denyHashes }).some((h) => h.rule === 'legacy-prefix'),
    true,
  )
})

test('owner-identity paths skip persona and email only', () => {
  assert.equal(isOwnerIdentityPath('LICENSE'), true)
  assert.equal(isOwnerIdentityPath('package.json'), true)
  assert.equal(isOwnerIdentityPath('apps/site/package.json'), true)
  assert.equal(isOwnerIdentityPath('scripts/authorship-check.test.mjs'), true)
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
