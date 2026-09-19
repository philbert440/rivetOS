#!/usr/bin/env node
/**
 * Guard the npm publish list against an unpublished / out-of-order
 * @rivetos/* runtime edge.
 *
 * Parses PACKAGES from .github/workflows/pipeline.yml and every listed
 * package.json. Walks the @rivetos/mcp-sidecar runtime closure (the set
 * this packaging change must keep installable) and fails if a listed
 * non-private package in that closure depends on an @rivetos/* package
 * that is private, missing from PACKAGES, or listed AFTER it.
 *
 * Also fails if a closure package itself is private or absent from the
 * list. Also fails if a listed package with unset `type` (CJS default)
 * depends on a listed package that is `type: "module"` with an
 * import-only `exports` map (the round-1 wiki-core / TS1479 failure).
 * Exit non-zero; each line names the offending edge.
 *
 * Run: node scripts/check-publish-closure.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PIPELINE = join(ROOT, '.github/workflows/pipeline.yml')
const SIDECAR_NAME = '@rivetos/mcp-sidecar'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function parsePackages(yml) {
  const marker = 'PACKAGES=('
  const start = yml.indexOf(marker)
  if (start < 0) {
    throw new Error('PACKAGES=( not found in .github/workflows/pipeline.yml')
  }
  const rest = yml.slice(start + marker.length)
  const end = rest.indexOf(')')
  if (end < 0) {
    throw new Error('unclosed PACKAGES=( in .github/workflows/pipeline.yml')
  }
  const dirs = []
  for (const raw of rest.slice(0, end).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    dirs.push(line)
  }
  if (dirs.length === 0) {
    throw new Error('PACKAGES array is empty')
  }
  return dirs
}

function listImmediateSubdirs(rel) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return []
  const out = []
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (ent.isDirectory()) out.push(join(rel, ent.name))
  }
  return out
}

function workspaceDirs() {
  return [
    ...listImmediateSubdirs('packages'),
    ...listImmediateSubdirs('plugins/channels'),
    ...listImmediateSubdirs('plugins/memory'),
    ...listImmediateSubdirs('plugins/providers'),
    ...listImmediateSubdirs('plugins/tools'),
    ...listImmediateSubdirs('plugins/transports'),
    ...listImmediateSubdirs('services'),
  ]
}

function rivetosDeps(pkg) {
  return Object.keys(pkg.dependencies || {}).filter((d) => d.startsWith('@rivetos/'))
}

/** Node `type` is unset (CommonJS default) — not `type: "module"`. */
function isTypeUnset(pkg) {
  return pkg.type == null
}

/**
 * True when `exports` is a map with at least one condition object that
 * has `import` and no `require`. That is the round-1 wiki-core shape
 * that made CJS consumers fail with TS1479.
 */
function isImportOnlyExportsMap(exportsField) {
  if (exportsField == null || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    return false
  }
  for (const value of Object.values(exportsField)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (
        Object.prototype.hasOwnProperty.call(value, 'import') &&
        !Object.prototype.hasOwnProperty.call(value, 'require')
      ) {
        return true
      }
    }
  }
  return false
}

function loadDir(dir) {
  const path = join(ROOT, dir, 'package.json')
  if (!existsSync(path)) return null
  return readJson(path)
}

const yml = readFileSync(PIPELINE, 'utf8')
const listedDirs = parsePackages(yml)
const errors = []

/** @type {Map<string, { dir: string, pkg: object, index: number }>} */
const listedByName = new Map()
const listedByDir = new Map()

for (let i = 0; i < listedDirs.length; i++) {
  const dir = listedDirs[i]
  const pkg = loadDir(dir)
  if (!pkg) {
    errors.push(`${dir} is in PACKAGES but has no package.json`)
    continue
  }
  const entry = { dir, pkg, index: i }
  listedByDir.set(dir, entry)
  if (pkg.name) listedByName.set(pkg.name, entry)
}

/** @type {Map<string, { dir: string, pkg: object }>} */
const workspaceByName = new Map()
for (const dir of workspaceDirs()) {
  const pkg = loadDir(dir)
  if (pkg?.name) workspaceByName.set(pkg.name, { dir, pkg })
}

const sidecar = workspaceByName.get(SIDECAR_NAME)
if (!sidecar) {
  errors.push(`${SIDECAR_NAME} not found in the workspace`)
}

const closure = new Set()
if (sidecar) {
  const stack = [SIDECAR_NAME]
  while (stack.length) {
    const name = stack.pop()
    if (closure.has(name)) continue
    closure.add(name)
    const found = workspaceByName.get(name)
    if (!found) {
      errors.push(`${name} is in the ${SIDECAR_NAME} runtime closure but has no workspace package.json`)
      continue
    }
    for (const dep of rivetosDeps(found.pkg)) stack.push(dep)
  }
}

for (const name of closure) {
  const ws = workspaceByName.get(name)
  const listed = listedByName.get(name)
  const dir = listed?.dir ?? ws?.dir ?? '?'
  if (!listed) {
    errors.push(`${name} (${dir}) is in the ${SIDECAR_NAME} runtime closure but missing from PACKAGES`)
    continue
  }
  if (listed.pkg.private) {
    errors.push(`${name} (${dir}) is private`)
  }

  if (!listed.pkg.private) {
    for (const dep of rivetosDeps(listed.pkg)) {
      const depListed = listedByName.get(dep)
      const depWs = workspaceByName.get(dep)
      const depDir = depListed?.dir ?? depWs?.dir ?? '?'
      if (!depListed) {
        errors.push(`${name} (${dir}) depends on ${dep} (${depDir}) which is missing from PACKAGES`)
        continue
      }
      if (depListed.pkg.private) {
        errors.push(`${name} (${dir}) depends on ${dep} (${depDir}) which is private`)
      }
      if (depListed.index > listed.index) {
        errors.push(
          `${name} (${dir}) depends on ${dep} (${depDir}) which is listed AFTER it`,
        )
      }
    }
  }
}

// CJS-typed listed packages cannot consume a listed dep that is
// `type: "module"` with an import-only exports map (TS1479).
for (const { dir, pkg } of listedByName.values()) {
  if (!isTypeUnset(pkg)) continue
  for (const dep of rivetosDeps(pkg)) {
    const depListed = listedByName.get(dep)
    if (!depListed) continue
    if (depListed.pkg.type === 'module' && isImportOnlyExportsMap(depListed.pkg.exports)) {
      errors.push(
        `${dep} (${depListed.dir}) is type:module with an import-only exports map, consumed by ${pkg.name} (${dir}) whose type is unset`,
      )
    }
  }
}

if (errors.length > 0) {
  console.error('check-publish-closure: failing edges:')
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}

console.log(
  `check-publish-closure: ok (${closure.size} packages in ${SIDECAR_NAME} closure, ${listedDirs.length} PACKAGES entries)`,
)
