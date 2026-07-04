// Pack validator — the marketplace gatekeeper. Checks a pack directory for
// schema validity, activity coverage, file completeness, and frame-size
// consistency. Pure Node (fs + a 16-byte PNG header read), no image deps.
//
// The manifest is untrusted JSON cast to PackManifest, so the "unnecessary"
// optional chains below are the actual validation being performed.
/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/restrict-template-expressions */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { ACTIVITIES } from '@rivetos/den-protocol'
import { PACK_SPEC_VERSION, type PackManifest } from './manifest.js'

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  manifest?: PackManifest
}

/** Width/height from a PNG's IHDR chunk, or null if not a PNG. */
export function pngSize(file: string): { w: number; h: number } | null {
  const buf = readFileSync(file)
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

const isRect = (r: unknown): r is { x: number; y: number; w: number; h: number } =>
  typeof r === 'object' &&
  r !== null &&
  ['x', 'y', 'w', 'h'].every((k) => Number.isFinite((r as Record<string, unknown>)[k]))

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

export function validatePack(dir: string): ValidationResult {
  // backstop: a hostile manifest must never turn the gatekeeper into an
  // uncaught exception — anything the guards below miss becomes an error
  try {
    return validatePackInner(dir)
  } catch (e) {
    return {
      ok: false,
      errors: [`pack.json is structurally malformed: ${(e as Error).message}`],
      warnings: [],
    }
  }
}

function validatePackInner(dir: string): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const fail = (): ValidationResult => ({ ok: false, errors, warnings })

  const manifestPath = join(dir, 'pack.json')
  if (!existsSync(manifestPath)) {
    errors.push('pack.json not found')
    return fail()
  }
  let m: PackManifest
  try {
    m = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackManifest
  } catch (e) {
    errors.push(`pack.json is not valid JSON: ${(e as Error).message}`)
    return fail()
  }

  // --- schema basics -------------------------------------------------------
  if (m.spec !== PACK_SPEC_VERSION)
    errors.push(`spec must be ${PACK_SPEC_VERSION}, got ${String(m.spec)}`)
  for (const k of ['name', 'version', 'author', 'license'] as const) {
    if (typeof m[k] !== 'string' || m[k].length === 0) errors.push(`missing required field: ${k}`)
  }
  if (typeof m.grid?.pxPerUnit !== 'number' || m.grid.pxPerUnit <= 0)
    errors.push('grid.pxPerUnit must be a positive number')
  if (typeof m.chroma?.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(m.chroma.color))
    errors.push('chroma.color must be a #rrggbb hex string')
  if (typeof m.shell?.src !== 'string' || !(m.shell?.w > 0) || !(m.shell?.h > 0))
    errors.push('shell requires src, w > 0, h > 0')
  if (errors.length > 0) return fail()

  // pack-relative path check: must exist inside dir, no escaping
  const checkFile = (rel: string, what: string): string | null => {
    if (typeof rel !== 'string') {
      errors.push(`${what}: path must be a string, got ${JSON.stringify(rel)}`)
      return null
    }
    if (normalize(rel).startsWith('..') || rel.startsWith('/')) {
      errors.push(`${what}: path escapes the pack directory: ${rel}`)
      return null
    }
    const abs = join(dir, rel)
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(`${what}: file not found: ${rel}`)
      return null
    }
    return abs
  }

  // existence + PNG-ness in one step (a renamed JPEG passes existsSync and
  // then fails at render time)
  const checkPng = (rel: string, what: string): { w: number; h: number } | null => {
    const abs = checkFile(rel, what)
    if (!abs) return null
    const s = pngSize(abs)
    if (!s) errors.push(`${what}: not a PNG: ${rel}`)
    return s
  }

  checkPng(m.shell.src, 'shell')
  if (m.shell.nightSrc) checkPng(m.shell.nightSrc, 'shell nightSrc')

  // --- character -----------------------------------------------------------
  const poses = m.character?.poses ?? {}
  if (!(m.character?.height > 0)) errors.push('character.height must be > 0')
  for (const [name, pose] of Object.entries(poses)) {
    if (!isObj(pose)) {
      errors.push(`pose ${name}: must be an object`)
      continue
    }
    if (!Array.isArray(pose.frames) || pose.frames.length === 0) {
      errors.push(`pose ${name}: frames must be a non-empty array`)
      continue
    }
    if (typeof pose.frameMs !== 'number' || pose.frameMs < 0)
      errors.push(`pose ${name}: frameMs must be >= 0`)
    if (
      pose.intro !== undefined &&
      !(Number.isInteger(pose.intro) && pose.intro > 0 && pose.intro < pose.frames.length)
    )
      errors.push(`pose ${name}: intro must be an integer between 1 and frames-1`)
    let size: { w: number; h: number } | null = null
    for (const f of pose.frames) {
      const abs = checkFile(f, `pose ${name}`)
      if (!abs) continue
      const s = pngSize(abs)
      if (!s) {
        errors.push(`pose ${name}: not a PNG: ${f}`)
      } else if (size && (s.w !== size.w || s.h !== size.h)) {
        errors.push(
          `pose ${name}: frame size mismatch: ${f} is ${s.w}x${s.h}, expected ${size.w}x${size.h}`,
        )
      } else {
        size ??= s
      }
    }
    // attachments are in frame-image coordinates — must land inside the frame
    for (const [aName, pt] of Object.entries(pose.attachments ?? {})) {
      if (!isObj(pt) || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
        errors.push(`pose ${name}: attachment ${aName} must be {x,y} numbers`)
      } else if (size && (pt.x < 0 || pt.y < 0 || pt.x > size.w || pt.y > size.h)) {
        errors.push(
          `pose ${name}: attachment ${aName} (${pt.x},${pt.y}) outside frame ${size.w}x${size.h}`,
        )
      }
    }
  }
  const activities = m.character?.activities ?? ({} as Record<string, string>)
  for (const a of ACTIVITIES) {
    const pose = activities[a]
    if (!pose) errors.push(`activity not covered: ${a}`)
    else if (!(pose in poses)) errors.push(`activity ${a} maps to unknown pose: ${pose}`)
  }
  if (!('walk' in poses)) warnings.push("no 'walk' pose — character will teleport between stations")
  if (
    Array.isArray(m.furniture) &&
    m.furniture.some((f) => f?.id === 'chair') &&
    !('sitside' in poses)
  )
    warnings.push("chair furniture without a 'sitside' pose — seat choreography disabled")
  for (const [tool, pose] of Object.entries(m.character?.tools ?? {})) {
    if (!(pose in poses)) errors.push(`tool override ${tool} maps to unknown pose: ${pose}`)
  }
  const furniture = Array.isArray(m.furniture) ? m.furniture : []
  if (m.furniture !== undefined && !Array.isArray(m.furniture))
    errors.push('furniture must be an array')
  const declaredFurnIds = new Set(furniture.filter(isObj).map((f) => f.id))
  for (const [name, pose] of Object.entries(poses)) {
    const repl = pose.replaces
      ? Array.isArray(pose.replaces)
        ? pose.replaces
        : [pose.replaces]
      : []
    for (const id of repl) {
      if (!declaredFurnIds.has(id)) errors.push(`pose ${name}: replaces unknown furniture: ${id}`)
    }
  }

  // --- furniture + layout --------------------------------------------------
  const furnIds = new Set<string>()
  for (const f of furniture) {
    if (!isObj(f) || !f.id || typeof f.id !== 'string') {
      errors.push('furniture entry without id')
      continue
    }
    if (furnIds.has(f.id)) errors.push(`duplicate furniture id: ${f.id}`)
    furnIds.add(f.id)
    const srcSize = checkPng(f.src, `furniture ${f.id}`)
    for (const v of f.variants ?? []) checkPng(v, `furniture ${f.id} variant`)
    if (f.sideSrc) checkPng(f.sideSrc, `furniture ${f.id} sideSrc`)
    if (f.nightSrc) checkPng(f.nightSrc, `furniture ${f.id} nightSrc`)
    // functional rects are in ORIGINAL image coordinates — an out-of-bounds
    // rect validates fine structurally but breaks the terminal/whiteboard
    // overlay at render time
    for (const key of ['screen', 'textRect'] as const) {
      const r = f[key]
      if (r === undefined) continue
      if (!isRect(r)) {
        errors.push(`furniture ${f.id}: ${key} must be {x,y,w,h}`)
      } else if (r.w <= 0 || r.h <= 0 || r.x < 0 || r.y < 0) {
        errors.push(`furniture ${f.id}: ${key} must have x,y >= 0 and w,h > 0`)
      } else if (srcSize && (r.x + r.w > srcSize.w || r.y + r.h > srcSize.h)) {
        errors.push(
          `furniture ${f.id}: ${key} (${r.x},${r.y} ${r.w}x${r.h}) outside image ${srcSize.w}x${srcSize.h}`,
        )
      }
    }
  }
  for (const [id, p] of Object.entries(m.layout ?? {})) {
    if (!furnIds.has(id)) errors.push(`layout places unknown furniture: ${id}`)
    if (!isObj(p) || typeof p.x !== 'number' || typeof p.y !== 'number' || !(p.h > 0))
      errors.push(`layout ${id}: requires numeric x, y and h > 0`)
  }
  for (const [act, st] of Object.entries(m.stations ?? {})) {
    if (!(ACTIVITIES as readonly string[]).includes(act))
      errors.push(`station for unknown activity: ${act}`)
    if (typeof st !== 'object' || st === null) {
      errors.push(`station ${act}: must be an object`)
      continue
    }
    if (st.furn && !furnIds.has(st.furn))
      errors.push(`station ${act}: unknown furniture anchor: ${st.furn}`)
    if (!st.furn && (typeof st.x !== 'number' || typeof st.y !== 'number'))
      errors.push(`station ${act}: needs furn or absolute x/y`)
  }
  for (const a of ACTIVITIES) {
    if (!(a in (m.stations ?? {}))) errors.push(`station not defined for activity: ${a}`)
  }

  return { ok: errors.length === 0, errors, warnings, manifest: m }
}
