#!/usr/bin/env node
// den-pack CLI — `den-pack validate <dir>`: the pack gatekeeper.

import { validatePack } from './validate.js'

const [cmd, dir] = process.argv.slice(2)

if (cmd !== 'validate' || !dir) {
  console.error('usage: den-pack validate <pack-dir>')
  process.exit(2)
}

const res = validatePack(dir)
for (const w of res.warnings) console.warn(`warn: ${w}`)
for (const e of res.errors) console.error(`error: ${e}`)
if (res.ok) {
  const m = res.manifest
  console.log(
    `ok: ${m?.name}@${m?.version} — ${Object.keys(m?.character.poses ?? {}).length} poses, ${m?.furniture.length ?? 0} furniture pieces`,
  )
} else {
  console.error(`invalid pack: ${res.errors.length} error(s)`)
  process.exit(1)
}
