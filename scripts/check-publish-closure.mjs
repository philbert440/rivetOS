#!/usr/bin/env node
/**
 * Guard the npm publish list against an unpublished / out-of-order
 * @rivetos/* runtime edge.
 *
 * Parses PACKAGES and BLOCKED_PACKAGES from
 * .github/workflows/pipeline.yml and every listed package.json.
 * For every non-private package in PACKAGES, fails if it depends on an
 * @rivetos/* package (dependencies, optionalDependencies, or
 * peerDependencies) that is private, missing from PACKAGES, listed AFTER
 * it, or listed in BLOCKED_PACKAGES.
 *
 * Also fails if a listed package with unset `type` (CJS default) depends
 * on a listed package that is `type: "module"` with an import-only
 * `exports` map (the round-1 wiki-core / TS1479 failure).
 *
 * BLOCKED_PACKAGES are not published. Their blocking edges are printed
 * (without failing). A PACKAGES entry must not depend on a BLOCKED entry.
 *
 * Parser: strip quotes and inline # comments; do not terminate on a `)`
 * inside a comment; fail loudly on an entry with no package.json.
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

/**
 * Parse a bash array `NAME=( ... )` from workflow YAML.
 * Stops only on a line whose trimmed content is exactly `)`.
 * Skips comment-only lines. Strips quotes and trailing inline comments.
 */
function parseNamedArray(yml, name) {
  const marker = `${name}=(`
  // Line-anchored so BLOCKED_PACKAGES=( is not mistaken for PACKAGES=(.
  const re = new RegExp(`^\\s*${name}=\\(`, 'm')
  const m = re.exec(yml)
  if (!m) {
    throw new Error(`${marker} not found in .github/workflows/pipeline.yml`)
  }
  const rest = yml.slice(m.index + m[0].length)
  const dirs = []
  let closed = false
  for (const raw of rest.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line === ')') {
      closed = true
      break
    }
    if (line.startsWith('#')) continue
    const m = line.match(/^["']?([^"'\s#]+)["']?\s*(?:#.*)?$/)
    if (!m) {
      throw new Error(`unparseable ${name} entry: ${JSON.stringify(line)}`)
    }
    dirs.push(m[1])
  }
  if (!closed) {
    throw new Error(`unclosed ${marker} in .github/workflows/pipeline.yml`)
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

/**
 * Union of dependencies / optionalDependencies / peerDependencies whose
 * name starts with @rivetos/. First kind wins if a name appears in more
 * than one map.
 */
function rivetosDepEntries(pkg) {
  const seen = new Set()
  const out = []
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const d of Object.keys(pkg[kind] || {})) {
      if (!d.startsWith('@rivetos/') || seen.has(d)) continue
      seen.add(d)
      out.push({ name: d, kind })
    }
  }
  return out
}

function rivetosDeps(pkg) {
  return rivetosDepEntries(pkg).map((e) => e.name)
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
const listedDirs = parseNamedArray(yml, 'PACKAGES')
const blockedDirs = parseNamedArray(yml, 'BLOCKED_PACKAGES')
const errors = []
const blockedNotes = []

if (listedDirs.length === 0) {
  errors.push('PACKAGES array is empty')
}

/** @type {Map<string, { dir: string, pkg: object, index: number }>} */
const listedByName = new Map()
const listedDirSet = new Set(listedDirs)

for (let i = 0; i < listedDirs.length; i++) {
  const dir = listedDirs[i]
  const pkg = loadDir(dir)
  if (!pkg) {
    errors.push(`${dir} is in PACKAGES but has no package.json`)
    continue
  }
  const entry = { dir, pkg, index: i }
  if (pkg.name) listedByName.set(pkg.name, entry)
}

/** @type {Map<string, { dir: string, pkg: object }>} */
const blockedByName = new Map()

for (const dir of blockedDirs) {
  if (listedDirSet.has(dir)) {
    errors.push(`${dir} is in both PACKAGES and BLOCKED_PACKAGES`)
  }
  const pkg = loadDir(dir)
  if (!pkg) {
    errors.push(`${dir} is in BLOCKED_PACKAGES but has no package.json`)
    continue
  }
  if (pkg.name) blockedByName.set(pkg.name, { dir, pkg })
}

/** @type {Map<string, { dir: string, pkg: object }>} */
const workspaceByName = new Map()
for (const dir of workspaceDirs()) {
  const pkg = loadDir(dir)
  if (pkg?.name) workspaceByName.set(pkg.name, { dir, pkg })
}

const sidecar = listedByName.get(SIDECAR_NAME)
if (!sidecar) {
  const ws = workspaceByName.get(SIDECAR_NAME)
  const dir = ws?.dir ?? '?'
  errors.push(`${SIDECAR_NAME} (${dir}) is missing from PACKAGES`)
} else if (sidecar.pkg.private) {
  errors.push(`${SIDECAR_NAME} (${sidecar.dir}) is private`)
}

function depDirOf(dep) {
  return listedByName.get(dep)?.dir ?? blockedByName.get(dep)?.dir ?? workspaceByName.get(dep)?.dir ?? '?'
}

for (const [name, listed] of listedByName) {
  if (listed.pkg.private) continue
  const { dir } = listed
  for (const dep of rivetosDeps(listed.pkg)) {
    const depBlocked = blockedByName.get(dep)
    if (depBlocked) {
      errors.push(
        `${name} (${dir}) depends on ${dep} (${depBlocked.dir}) which is in BLOCKED_PACKAGES`,
      )
      continue
    }
    const depListed = listedByName.get(dep)
    const depDir = depDirOf(dep)
    if (!depListed) {
      const depWs = workspaceByName.get(dep)
      if (depWs?.pkg.private) {
        errors.push(`${name} (${dir}) depends on ${dep} (${depDir}) which is private`)
      } else {
        errors.push(`${name} (${dir}) depends on ${dep} (${depDir}) which is missing from PACKAGES`)
      }
      continue
    }
    if (depListed.pkg.private) {
      errors.push(`${name} (${dir}) depends on ${dep} (${depDir}) which is private`)
    }
    if (depListed.index > listed.index) {
      errors.push(`${name} (${dir}) depends on ${dep} (${depDir}) which is listed AFTER it`)
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

for (const dir of blockedDirs) {
  const pkg = loadDir(dir)
  if (!pkg) continue
  const name = pkg.name ?? dir
  const reasons = []
  for (const dep of rivetosDeps(pkg)) {
    const depDir = depDirOf(dep)
    const depWs = workspaceByName.get(dep)
    const depListed = listedByName.get(dep)
    const depBlocked = blockedByName.get(dep)
    if (depWs?.pkg.private) {
      reasons.push(`depends on private ${dep} (${depDir})`)
    } else if (depBlocked) {
      reasons.push(`depends on blocked ${dep} (${depDir})`)
    } else if (!depListed) {
      reasons.push(`depends on unlisted ${dep} (${depDir})`)
    }
  }
  if (reasons.length === 0) {
    blockedNotes.push(`${name} (${dir}) is in BLOCKED_PACKAGES`)
  } else {
    for (const r of reasons) blockedNotes.push(`${name} (${dir}) ${r}`)
  }
}

if (blockedNotes.length > 0) {
  console.log('check-publish-closure: blocked packages (not failing):')
  for (const n of blockedNotes) console.log(`  ${n}`)
}

if (errors.length > 0) {
  console.error('check-publish-closure: failing edges:')
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}

console.log(
  `check-publish-closure: ok (${listedDirs.length} PACKAGES entries, ${blockedDirs.length} BLOCKED_PACKAGES)`,
)
