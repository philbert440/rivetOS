#!/usr/bin/env node
/**
 * Publish the freshly-built desktop artifact to the mesh filestore so every
 * RivetHub's Settings → Updates can find it.
 *
 *   node scripts/publish-mesh.mjs [--root /rivet-shared]
 *
 * Reads release/ for this platform's artifact (win: "RivetHub Setup
 * <ver>.exe", linux: "RivetHub-<ver>.AppImage"), copies it to
 * <root>/builds/rivethub/ under a space-free name, and merges this
 * platform's entry into latest.json ({win32: {...}, linux: {...}} — other
 * platforms' entries are preserved). sha256 in the manifest is what the
 * shell verifies before launching the installer.
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = dirname(dirname(fileURLToPath(import.meta.url)))
const rootIdx = process.argv.indexOf('--root')
const root = rootIdx > -1 ? process.argv[rootIdx + 1] : '/rivet-shared'
const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version

const releaseDir = join(appDir, 'release')
const platform = process.platform
const artifactRe =
  platform === 'win32'
    ? new RegExp(`^RivetHub Setup ${version.replaceAll('.', '\\.')}\\.exe$`)
    : new RegExp(`^RivetHub-${version.replaceAll('.', '\\.')}\\.AppImage$`)
const artifact = readdirSync(releaseDir).find((f) => artifactRe.test(f))
if (!artifact) {
  console.error(`no ${platform} artifact for v${version} in ${releaseDir} — run npm run dist first`)
  process.exit(1)
}

const src = join(releaseDir, artifact)
const destName =
  platform === 'win32' ? `RivetHub-Setup-${version}.exe` : `RivetHub-${version}.AppImage`
const outDir = join(root, 'builds', 'rivethub')
mkdirSync(outDir, { recursive: true })
copyFileSync(src, join(outDir, destName))

const sha256 = createHash('sha256').update(readFileSync(src)).digest('hex')
const sizeBytes = statSync(src).size

const manifestPath = join(outDir, 'latest.json')
let manifest = {}
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch {
  /* first publish */
}
manifest[platform] = { version, file: destName, sha256, sizeBytes }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

console.log(
  `published ${destName} (${(sizeBytes / 1e6).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…) → ${outDir}`,
)
