// Packaging guard: refuse to package without a web dist, and warn loudly when
// it looks stale — electron-builder's extraResources copies whatever is there,
// so a forgotten `nx build @rivetos/rivethub-web` would silently ship an old
// UI under a new shell (review finding, PR #555).
import { statSync } from 'node:fs'
import { resolve } from 'node:path'

const dist = resolve(import.meta.dirname, '../../rivethub-web/dist')
let indexStat
try {
  indexStat = statSync(resolve(dist, 'index.html'))
} catch {
  console.error(
    `check-webdist: ${dist}/index.html not found — build the UI first:\n` +
      '  npx nx build @rivetos/rivethub-web',
  )
  process.exit(1)
}
const ageHours = (Date.now() - indexStat.mtimeMs) / 3_600_000
if (ageHours > 24) {
  console.warn(
    `check-webdist: WARNING — web dist is ${ageHours.toFixed(1)}h old; ` +
      'rebuild @rivetos/rivethub-web if that is not what you mean to ship.',
  )
}
console.log(`check-webdist: ok (dist built ${indexStat.mtime.toISOString()})`)
