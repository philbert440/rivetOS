#!/usr/bin/env node
// Add a SHA-256 hash to scripts/privacy-denylist.json without writing the
// plaintext. Usage:
//   node scripts/privacy-denylist-add.mjs '<value>'
//   printf '%s' '<value>' | node scripts/privacy-denylist-add.mjs --stdin
// Values are lowercased before hashing (UUIDs and emails). The value is never
// printed.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, 'privacy-denylist.json')

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function readValue() {
  if (process.argv[2] === '--stdin') {
    return readFileSync(0, 'utf8').replace(/\r?\n$/, '')
  }
  const arg = process.argv[2]
  if (!arg || arg.startsWith('-')) {
    console.error('usage: privacy-denylist-add.mjs <value> | --stdin')
    process.exit(2)
  }
  return arg
}

const raw = readValue()
if (!raw) {
  console.error('privacy-denylist-add: empty value')
  process.exit(2)
}
const hash = sha256(raw.toLowerCase())
const json = JSON.parse(readFileSync(FILE, 'utf8'))
const hashes = new Set((json.sha256 ?? []).map((h) => String(h).toLowerCase()))
if (hashes.has(hash)) {
  console.log('already present')
  process.exit(0)
}
hashes.add(hash)
json.sha256 = [...hashes].sort()
writeFileSync(FILE, `${JSON.stringify(json, null, 2)}\n`)
console.log(`added ${hash.slice(0, 12)}… (${hashes.size} entries)`)
