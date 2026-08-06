/**
 * Workflow directory convention loader.
 *
 *   workflows/<name>/
 *     workflow.yaml
 *     run.ts
 *     agents/<name>.md    — frontmatter config + prompt body (Claude Code agent style)
 */

import { readdir, readFile, access } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { loadManifestFile } from './manifest.js'
import type { AgentConfig, AgentDef, LoadedWorkflow } from './types.js'
import { WorkflowNotFoundError } from './errors.js'

export async function loadWorkflowDir(dir: string): Promise<LoadedWorkflow> {
  const manifest = await loadManifestFile(dir)
  const runPath = resolveRunPath(dir)
  const agents = await loadAgents(join(dir, 'agents'))
  return { dir, manifest, runPath, agents }
}

function resolveRunPath(dir: string): string {
  // Prefer compiled JS if present, else run.ts (loaded via tsx / dynamic import).
  const candidates = ['run.js', 'run.mjs', 'run.ts']
  for (const name of candidates) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  throw new Error(`No run.ts/run.js found in ${dir}`)
}

async function loadAgents(agentsDir: string): Promise<Record<string, AgentDef>> {
  const out: Record<string, AgentDef> = {}
  if (!existsSync(agentsDir)) return out

  const entries = await readdir(agentsDir, { withFileTypes: true })
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue
    const name = ent.name.slice(0, -'.md'.length)
    const path = join(agentsDir, ent.name)
    const { config, body } = parseFrontmatter(await readFile(path, 'utf-8'), path)
    if (!body.trim()) {
      throw new Error(`Agent "${name}" has an empty prompt body in ${path}`)
    }
    out[name] = { name, path, prompt: body, config }
  }
  return out
}

/**
 * Split optional `---` YAML frontmatter from a markdown body.
 * Tolerates BOM and CRLF; an opening fence without a closing fence throws
 * (silently treating half a config block as prompt text would be worse).
 */
function parseFrontmatter(text: string, path: string): { config: AgentConfig; body: string } {
  // Tolerate BOM and leading blank lines/indentation before the opening fence.
  const src = text.replace(/^\uFEFF/, '').replace(/^\s+(?=---)/, '')
  if (!/^---[ \t]*\r?\n/.test(src)) {
    return { config: {}, body: src }
  }
  // Opening fence is at position 0, so the first `\n---` is the closing fence.
  const closeMatch = /\r?\n---[ \t]*(\r?\n|$)/.exec(src)
  if (!closeMatch) {
    throw new Error(`Unterminated frontmatter (missing closing ---) in ${path}`)
  }
  const yamlStart = src.indexOf('\n') + 1
  const rawYaml = src.slice(yamlStart, closeMatch.index)
  const body = src.slice(closeMatch.index + closeMatch[0].length)
  const raw: unknown = parseYaml(rawYaml)
  const config = (raw && typeof raw === 'object' ? raw : {}) as AgentConfig
  return { config, body }
}

/**
 * Resolve a bare workflow ref to a directory using explicit map then search roots.
 */
export function resolveWorkflowDir(
  ref: string,
  opts: {
    workflowDirs?: Record<string, string>
    workflowsRoots?: string[]
  },
): string {
  // Absolute / relative path with workflow.yaml
  if (ref.includes('/') || ref.startsWith('.')) {
    if (existsSync(join(ref, 'workflow.yaml'))) return ref
  }

  if (opts.workflowDirs?.[ref]) {
    const d = opts.workflowDirs[ref]
    if (existsSync(join(d, 'workflow.yaml'))) return d
    throw new WorkflowNotFoundError(ref, `Mapped dir missing workflow.yaml: ${d}`)
  }

  for (const root of opts.workflowsRoots ?? []) {
    const candidate = join(root, ref)
    if (existsSync(join(candidate, 'workflow.yaml'))) return candidate
  }

  // Direct path to a workflow dir
  if (existsSync(join(ref, 'workflow.yaml'))) return ref

  throw new WorkflowNotFoundError(
    ref,
    `Could not resolve workflow ref "${ref}" (checked workflowDirs + workflowsRoots)`,
  )
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}
