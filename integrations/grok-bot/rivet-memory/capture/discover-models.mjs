#!/usr/bin/env node
// Thin wrapper over identity.ts (built dist/identity.js). All roster logic
// lives in src/identity.ts — discovery of agents/<uuid>/profile.json only.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist', 'identity.js')

async function loadIdentity() {
  if (existsSync(DIST)) {
    return import(pathToFileURL(DIST).href)
  }
  console.error(
    'Build the capture package first (npx nx build @rivetos/grok-bot-rivet-memory-capture).',
  )
  process.exit(2)
}

const ident = await loadIdentity()

export const slug = ident.slug
export const uniqueSlug = ident.uniqueSlug
export const suffixedSlug = ident.suffixedSlug
export const deriveIdentity = ident.deriveIdentity
export const discoverModels = ident.discoverModels
export const makeIdentityLookup = ident.makeIdentityLookup
export const resolveIdentity = ident.resolveIdentity
export const identityFor = ident.identityFor
export const loadIdentityConfig = ident.loadIdentityConfig

const invoked =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invoked) {
  let catalog
  try {
    catalog = ident.discoverModels()
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
  if (process.argv[2] === '--json') {
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`)
  } else {
    for (const m of catalog.models) process.stdout.write(`${JSON.stringify(m)}\n`)
    if (catalog.unmappedTranscripts?.length) {
      console.error(
        `unmapped transcripts (not on the discovered roster): ${catalog.unmappedTranscripts.join(', ')}`,
      )
    }
  }
}
