/**
 * Create a workflow definition directory — blank, or duplicated from an
 * existing def. Used by the gateway's POST /api/workflows (RivetHub "New
 * workflow"). The CLI scaffolder (scaffold.ts) stays separate: it writes a
 * worked example, while a blank def here is the smallest thing that loads, so
 * the flows canvas can take it from Start.
 */

import { cp, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { loadWorkflowDir } from './loader.js'
import type { LoadedWorkflow } from './types.js'

/** `runs` and `canvas` are shadowed by static RivetHub routes under /workflows/. */
const RESERVED_IDS = new Set(['runs', 'canvas'])
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const NAME_MAX = 120

/** Staging lives one level down so a half-written def is never an immediate root child. */
const STAGING_DIR = '.rivet-create'

/** Never copied on duplicate: VCS / deps / editor junk, and stray staging dirs. */
const COPY_SKIP = new Set(['.git', 'node_modules', '.DS_Store', STAGING_DIR])

export class WorkflowCreateError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'exists',
  ) {
    super(message)
    this.name = 'WorkflowCreateError'
  }
}

export interface CreateWorkflowOptions {
  /** Absolute defs root to create under. */
  root: string
  id: string
  name: string
  description?: string
  /** Absolute dir of a def to copy; omitted = blank def. */
  fromDir?: string
}

/** Validation only — callers can reject before touching disk. */
export function validateNewWorkflowId(id: string): string | undefined {
  if (!ID_RE.test(id)) {
    return 'id must be 1–64 lowercase letters, digits, or hyphens, starting with a letter or digit'
  }
  if (RESERVED_IDS.has(id)) return `id "${id}" is reserved`
  return undefined
}

/** "PR Review — v2" → "pr-review-v2"; empty when nothing usable remains. */
export function slugifyWorkflowId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
}

export async function createWorkflowDef(opts: CreateWorkflowOptions): Promise<LoadedWorkflow> {
  const idError = validateNewWorkflowId(opts.id)
  if (idError) throw new WorkflowCreateError(idError, 'invalid')
  const name = opts.name.replace(/\s+/g, ' ').trim()
  if (!name) throw new WorkflowCreateError('name is required', 'invalid')
  if (name.length > NAME_MAX) {
    throw new WorkflowCreateError(`name must be at most ${String(NAME_MAX)} characters`, 'invalid')
  }
  const description = opts.description?.trim() || undefined

  const target = join(opts.root, opts.id)
  if (existsSync(target)) {
    throw new WorkflowCreateError(`a directory named "${opts.id}" already exists`, 'exists')
  }

  // Build in staging, then rename into place: the def list never sees a
  // partial directory, and a failed copy leaves nothing behind.
  const stagingParent = join(opts.root, STAGING_DIR)
  const staging = join(stagingParent, `${opts.id}-${randomUUID()}`)
  await mkdir(stagingParent, { recursive: true })
  try {
    if (opts.fromDir) {
      await cp(opts.fromDir, staging, {
        recursive: true,
        filter: (src) => !COPY_SKIP.has(basename(src)),
      })
      await rewriteManifestIdentity(staging, { id: opts.id, name, description })
    } else {
      await writeBlankDef(staging, { id: opts.id, name, description })
    }
    // Load before publishing — a def that won't load must not appear.
    await loadWorkflowDir(staging)
    if (existsSync(target)) {
      throw new WorkflowCreateError(`a directory named "${opts.id}" already exists`, 'exists')
    }
    await rename(staging, target)
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    throw err
  } finally {
    // Best effort: rmdir only succeeds on an empty dir, so a concurrent create keeps its staging.
    await rmdir(stagingParent).catch(() => undefined)
  }
  return loadWorkflowDir(target)
}

async function writeBlankDef(
  dir: string,
  meta: { id: string; name: string; description?: string },
): Promise<void> {
  await mkdir(join(dir, 'agents'), { recursive: true })
  await mkdir(join(dir, 'scripts'), { recursive: true })
  const manifest = {
    id: meta.id,
    version: '0.1.0',
    name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
    input: [],
    output: [],
  }
  await writeFile(join(dir, 'workflow.yaml'), stringify(manifest), 'utf-8')
  await writeFile(
    join(dir, 'run.ts'),
    `/**
 * ${meta.name.replace(/\*\//g, '* /')} — new workflow. Build it on the RivetHub flows canvas;
 * saving from the canvas regenerates this file.
 */
import type { Step } from '@rivetos/workflows'

export default async function run(step: Step): Promise<void> {
  await step.done({})
}
`,
    'utf-8',
  )
}

/** Set id / name / description in place, keeping the rest of the file (and its comments). */
async function rewriteManifestIdentity(
  dir: string,
  meta: { id: string; name: string; description?: string },
): Promise<void> {
  const path = join(dir, 'workflow.yaml')
  const doc = parseDocument(await readFile(path, 'utf-8'))
  if (doc.errors.length > 0) {
    throw new WorkflowCreateError(
      `source workflow.yaml does not parse: ${doc.errors[0].message}`,
      'invalid',
    )
  }
  doc.set('id', meta.id)
  doc.set('name', meta.name)
  if (meta.description !== undefined) doc.set('description', meta.description)
  await writeFile(path, doc.toString(), 'utf-8')
}
