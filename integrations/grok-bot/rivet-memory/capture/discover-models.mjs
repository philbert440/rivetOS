#!/usr/bin/env node
// Thin wrapper over identity.ts (built dist/identity.js). All roster logic
// lives in src/identity.ts; historical tags live in models.json overrides.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist', 'identity.js')
const MODELS_FILE = process.env.GROKBOT_MODELS || join(HERE, 'models.json')

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
export const discoverModels = ident.discoverModels
export const makeIdentityLookup = ident.makeIdentityLookup
export const resolveIdentity = ident.resolveIdentity
export const identityFor = ident.identityFor
export const loadIdentityConfig = ident.loadIdentityConfig

/** Last-resort dump of models.json overrides when dist is present but discovery throws. */
export function modelsJsonOverrides() {
  const raw = JSON.parse(readFileSync(MODELS_FILE, 'utf8'))
  const overrides = raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {}
  const models = Object.entries(overrides).map(([id, o]) => ({
    id,
    persona: o.persona || o.name,
    name: o.persona || o.name,
    session: o.session || o.sessionId,
    sessionId: o.session || o.sessionId,
    agent: o.agent || o.agentId,
    agentId: o.agent || o.agentId,
  }))
  return { nodeId: raw.nodeId || 'grokbot', models }
}

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
        `unmapped transcripts (not on roster/overrides): ${catalog.unmappedTranscripts.join(', ')}`,
      )
    }
  }
}
