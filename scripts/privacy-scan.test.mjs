// Run: node --test scripts/privacy-scan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  isFakeUuid,
  parseDenyHashes,
  removedHashes,
  scanText,
  sha256,
} from './privacy-scan.mjs'

const TEST_UUID = 'deadbeef-0123-4567-89ab-cdef01234567'
const TEST_EMAIL = 'owner@example.test'
const denyHashes = new Set([sha256(TEST_UUID), sha256(TEST_EMAIL)])

test('fake UUID prefix and repeating test ids are recognized', () => {
  assert.equal(isFakeUuid('00000000-0000-4000-8000-000000000001'), true)
  assert.equal(isFakeUuid('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'), true)
  assert.equal(isFakeUuid('11111111-1111-4111-8111-111111111111'), true)
  assert.equal(isFakeUuid('aaaaaaaa-bbbb-4ccc-8ddd-111111111111'), true)
  assert.equal(isFakeUuid(TEST_UUID), false)
})

test('hashed denylist catches a UUID without storing it', () => {
  const hits = scanText(`id ${TEST_UUID}`, { denyHashes })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].rule, 'denylist-uuid')
  assert.equal(hits[0].severity, 'block')
})

test('a non-denylisted UUID is ignored', () => {
  const hits = scanText('id 00000000-0000-4000-8000-000000000001', { denyHashes })
  assert.equal(hits.length, 0)
})

test('hashed email is only checked on grok-bot / fixture / input paths', () => {
  const inFixture = scanText(`mail ${TEST_EMAIL}`, {
    file: 'integrations/grok-bot/rivet-memory/capture/test/fixtures/x.jsonl',
    denyHashes,
  })
  assert.equal(inFixture.some((h) => h.rule === 'denylist-email'), true)
  const elsewhere = scanText(`mail ${TEST_EMAIL}`, {
    file: 'scripts/authorship-check.mjs',
    denyHashes,
  })
  assert.equal(elsewhere.some((h) => h.rule === 'denylist-email'), false)
})

test('fixture agent-data path with a non-fake UUID is blocked', () => {
  const hits = scanText(`path agent-data/agents/${TEST_UUID}/profile.json`, {
    file: 'integrations/grok-bot/rivet-memory/capture/test/fixtures/x.jsonl',
  })
  assert.equal(hits.some((h) => h.rule === 'agent-data-path'), true)
  const fake = scanText(
    'path agent-data/agents/00000000-0000-4000-8000-000000000001/profile.json',
    { file: 'integrations/grok-bot/rivet-memory/capture/test/fixtures/x.jsonl' },
  )
  assert.equal(fake.some((h) => h.rule === 'agent-data-path'), false)
})

test('fixture /home/box and /home/<user> are blocked', () => {
  const box = scanText('cd /home/box/grokbot', {
    file: 'integrations/grok-bot/rivet-memory/capture/test/fixtures/x.jsonl',
  })
  assert.equal(box.some((h) => h.rule === 'home-path'), true)
  const named = scanText('open /home/pat/.rivetos', {
    file: 'integrations/grok-bot/rivet-memory/capture/test/fixtures/x.jsonl',
  })
  assert.equal(named.some((h) => h.rule === 'home-path'), true)
  const src = scanText('cd /home/box/grokbot', { file: 'integrations/grok-bot/rivet-memory/README.md' })
  assert.equal(src.some((h) => h.rule === 'home-path'), false)
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
