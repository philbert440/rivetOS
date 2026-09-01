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

// Verify that the den/ subdirectory exists (copy-den.mjs output).
// Without it, the Den tab links to /den/ but gets a 404, and the AppImage
// ships with an incomplete UI (0.5.5 regression, fixed in this PR).
let denIndexStat
try {
  denIndexStat = statSync(resolve(dist, 'den/index.html'))
} catch {
  console.error(
    `check-webdist: ${dist}/den/index.html not found — ` +
      'copy-den.mjs did not run or failed.\n' +
      'The rivethub-web build script chains copy-den after vite build:\n' +
      '  npm run build --workspace=@rivetos/rivethub-web',
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
console.log(
  `check-webdist: ok (dist built ${indexStat.mtime.toISOString()}, ` +
    `den/ built ${denIndexStat.mtime.toISOString()})`,
)
