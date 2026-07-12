// Run: node --test scripts/secret-scan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanText, _internals } from './secret-scan.mjs'

const rules = (text, opts) => scanText(text, opts).map((f) => f.rule)

test('flags a real private (internal) subnet/host', () => {
  // generic RFC1918 values (NOT this infra's) — the scanner's own test file is
  // excluded from --tracked, but keep real subnets out of it regardless.
  assert.deepEqual(rules('const lan = "10.9.8.0/24"'), ['private-ip'])
  assert.ok(rules('host 172.20.5.9').includes('private-ip'))
})

test('flags a real public IP as a non-blocking warning', () => {
  const hits = scanText('endpoint 93.184.216.34')
  assert.deepEqual(
    hits.map((h) => h.rule),
    ['public-ip'],
  )
  assert.equal(hits[0].severity, 'warn')
})

test('internal subnet and wg key are blocking', () => {
  assert.equal(scanText('lan 172.20.5.9')[0].severity, 'block')
  assert.equal(scanText('key ' + 'Z'.repeat(43) + '=')[0].severity, 'block')
  assert.equal(scanText('ssh box.lan')[0].severity, 'block')
})

test('allows RFC5737 and canonical example ranges', () => {
  assert.deepEqual(rules('e.g. 192.0.2.10 and 198.51.100.7 and 203.0.113.1'), [])
  assert.deepEqual(rules('lan 192.168.1.5, 10.0.0.4, 172.16.0.9'), [])
})

test('ignores loopback / link-local / this-host / version-ish reserved', () => {
  assert.deepEqual(rules('127.0.0.1 and 169.254.1.1 and 0.0.0.0'), [])
})

test('flags WireGuard/base64 key shape', () => {
  assert.ok(rules('key ' + 'Z'.repeat(43) + '=').includes('wg-key'))
})

test('flags internal .lan hostnames', () => {
  assert.deepEqual(rules('ssh box.lan'), ['lan-host'])
})

test('rejects invalid octets (not an IP)', () => {
  assert.deepEqual(rules('build 10.4.999.1'), []) // 999 > 255
})

test('inline allow pragma suppresses a line', () => {
  assert.deepEqual(rules('host 198.18.0.1 // secret-scan-allow'), [])
})

test('hashed denylist catches an exact value the generic rules would too', () => {
  // Prove the mechanism without shipping a real secret: hash a doc IP and
  // confirm it's caught even though the IP is otherwise allowlisted.
  const deny = new Set([_internals.sha256('192.0.2.55')])
  const hits = scanText('safe-looking 192.0.2.55', { denyHashes: deny })
  assert.deepEqual(
    hits.map((h) => h.rule),
    ['denylist'],
  )
})

test('no false positive on semver-ish and plain prose', () => {
  assert.deepEqual(rules('version 1.2.3 released; see the 4.10 notes'), [])
})
