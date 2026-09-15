#!/usr/bin/env node
/**
 * Merge / unmerge rivet-memory capture hooks into ~/.qwen/settings.json
 * (or stage an extension dir by rewriting <PLUGIN_PATH>).
 *
 *   node dist/merge-settings-hooks.js apply  DEST FRAGMENT PLUGIN_PATH
 *   node dist/merge-settings-hooks.js remove DEST PLUGIN_PATH
 *   node dist/merge-settings-hooks.js stage  SRC DEST PLUGIN_PATH
 *   node dist/merge-settings-hooks.js disable-auto-memory SETTINGS
 *
 * Never rewrites DEST on parse/shape errors. Command strings are built with
 * bash single-quote quoting (never raw <PLUGIN_PATH> substitution). All other
 * keys in settings.json are left untouched.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER_SCRIPT = 'qwen-memory-capture.sh'
const MARKER_FLAG = '--hook'
const PLACEHOLDER = '<PLUGIN_PATH>'

const USAGE =
  'usage: merge-settings-hooks.js apply DEST FRAGMENT PLUGIN_PATH\n' +
  '       merge-settings-hooks.js remove DEST PLUGIN_PATH\n' +
  '       merge-settings-hooks.js stage SRC DEST PLUGIN_PATH\n' +
  '       merge-settings-hooks.js disable-auto-memory SETTINGS\n'

export interface MergeIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

class MergeExit extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, `'\\''`) + "'"
}

export function hookCommand(pluginPath: string): string {
  const script = path.join(pluginPath, 'bin', MARKER_SCRIPT)
  return `bash ${shellQuote(script)} ${MARKER_FLAG}`
}

function commandIsOurs(command: unknown): boolean {
  const text = typeof command === 'string' ? command : ''
  return text.includes(MARKER_SCRIPT) && text.includes(MARKER_FLAG)
}

function die(message: string, dest?: string): never {
  const extra = dest ? ` Leaving ${dest} untouched.` : ''
  throw new MergeExit(1, message.replace(/\n?$/, extra + '\n'))
}

function loadJsonFile(file: string, missingOk: boolean): unknown {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (missingOk && (err as NodeJS.ErrnoException).code === 'ENOENT') return null
    die(`error: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`, file)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    die(
      `error: ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Repair the file and re-run.`,
      file,
    )
  }
}

function requireHooksObject(destObj: unknown, dest: string): Record<string, unknown> {
  if (!isRecord(destObj)) {
    die(`error: ${dest} is not a JSON object. Repair the file and re-run.`, dest)
  }
  if (destObj.hooks == null) destObj.hooks = {}
  if (!isRecord(destObj.hooks)) {
    die(`error: ${dest} has a hooks value that is not an object. Repair the file and re-run.`, dest)
  }
  return destObj
}

function innerHasMarker(group: unknown): boolean {
  const inner = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : []
  return inner.some((h) => isRecord(h) && commandIsOurs(h.command))
}

function eventHasMarker(groups: unknown): boolean {
  return Array.isArray(groups) && groups.some(innerHasMarker)
}

function ourGroupFromTemplate(template: unknown, command: string): Record<string, unknown> {
  const innerSrc =
    isRecord(template) && Array.isArray(template.hooks) && template.hooks.length
      ? template.hooks
      : [{ type: 'command', timeout: 20, name: 'rivet-memory' }]
  const inner = innerSrc.map((item) => {
    const base = isRecord(item) ? { ...item } : {}
    base.type = base.type || 'command'
    base.command = command
    if (base.timeout == null) base.timeout = 20
    if (base.name == null) base.name = 'rivet-memory'
    return base
  })
  return { hooks: inner }
}

function stripGroup(group: unknown): unknown {
  if (!isRecord(group)) return group
  const inner = Array.isArray(group.hooks) ? group.hooks : null
  if (!inner) return group
  const kept = inner.filter((h) => !(isRecord(h) && commandIsOurs(h.command)))
  if (kept.length === inner.length) return group
  if (kept.length === 0) return null
  return { ...group, hooks: kept }
}

export function applyMerge(
  dest: string,
  fragmentPath: string,
  pluginPath: string,
  io: MergeIo,
): void {
  const command = hookCommand(pluginPath)
  const fragment = loadJsonFile(fragmentPath, false)
  if (!isRecord(fragment)) {
    die(`error: ${fragmentPath} is not a JSON object.`)
  }
  let destObj = loadJsonFile(dest, true)
  if (destObj == null) destObj = { hooks: {} }
  else destObj = requireHooksObject(destObj, dest)
  const hooks = (destObj as Record<string, unknown>).hooks as Record<string, unknown>
  let added = 0
  const fragmentHooks = isRecord(fragment.hooks) ? fragment.hooks : {}
  for (const [event, groups] of Object.entries(fragmentHooks)) {
    if (!Array.isArray(groups)) continue
    if (hooks[event] != null && !Array.isArray(hooks[event])) {
      die(`error: ${dest} hooks.${event} is not an array. Repair the file and re-run.`, dest)
    }
    const existing = Array.isArray(hooks[event]) ? hooks[event] : []
    const stripped = existing.map(stripGroup).filter((g) => g != null)
    const built = groups.map((g) => ourGroupFromTemplate(g, command))
    hooks[event] = stripped.concat(built)
    if (!eventHasMarker(existing)) added += built.length
  }
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(destObj, null, 2) + '\n')
  io.stdout.write(
    (added > 0 ? `merged ${added} hook group(s) into ` : `hooks already present in `) + dest + '\n',
  )
}

export function removeMerge(dest: string, io: MergeIo): void {
  const destObjRaw = loadJsonFile(dest, true)
  if (destObjRaw == null) {
    io.stdout.write(`no ${dest}\n`)
    return
  }
  const destObj = requireHooksObject(destObjRaw, dest)
  const hooks = destObj.hooks as Record<string, unknown>
  let removed = 0
  const nextHooks: Record<string, unknown> = {}
  for (const event of Object.keys(hooks)) {
    const existing = hooks[event]
    if (!Array.isArray(existing)) {
      nextHooks[event] = existing
      continue
    }
    const kept: unknown[] = []
    for (const group of existing) {
      const before = isRecord(group) && Array.isArray(group.hooks) ? group.hooks.length : 0
      const stripped = stripGroup(group)
      if (stripped == null) {
        const inner = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : []
        removed += inner.filter((h) => isRecord(h) && commandIsOurs(h.command)).length
        continue
      }
      const after = isRecord(stripped) && Array.isArray(stripped.hooks) ? stripped.hooks.length : 0
      if (after < before) removed += before - after
      kept.push(stripped)
    }
    if (kept.length) nextHooks[event] = kept
  }
  destObj.hooks = nextHooks
  fs.writeFileSync(dest, JSON.stringify(destObj, null, 2) + '\n')
  io.stdout.write(`removed ${removed} hook command(s) from ${dest}\n`)
}

function rewriteText(text: string, pluginPath: string): string {
  return text.split(PLACEHOLDER).join(pluginPath)
}

export function stageExtension(src: string, dest: string, pluginPath: string): void {
  if (!fs.existsSync(src)) die(`error: source dir missing: ${src}`)
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const ent of entries) {
    const from = path.join(src, ent.name)
    const to = path.join(dest, ent.name)
    if (ent.isDirectory()) {
      stageExtension(from, to, pluginPath)
      continue
    }
    const raw = fs.readFileSync(from)
    if (/\.(json|md|sh|ts|js|cjs)$/i.test(ent.name) || ent.name === 'SKILL.md') {
      fs.writeFileSync(to, rewriteText(raw.toString('utf8'), pluginPath))
    } else {
      fs.writeFileSync(to, raw)
    }
  }
}

export function disableAutoMemory(settingsPath: string, io: MergeIo): void {
  let destObj = loadJsonFile(settingsPath, true)
  if (destObj == null) destObj = {}
  if (!isRecord(destObj)) {
    die(`error: ${settingsPath} is not a JSON object.`, settingsPath)
  }
  if (destObj.memory == null) destObj.memory = {}
  if (!isRecord(destObj.memory)) {
    die(`error: ${settingsPath} memory is not an object.`, settingsPath)
  }
  destObj.memory.enableManagedAutoMemory = false
  fs.mkdirSync(path.dirname(path.resolve(settingsPath)), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(destObj, null, 2) + '\n')
  io.stdout.write(`set memory.enableManagedAutoMemory=false in ${settingsPath}\n`)
}

function dispatch(args: string[], io: MergeIo): void {
  const action = args[0]
  if (action === 'apply') {
    if (args.length !== 4) die('usage: merge-settings-hooks.js apply DEST FRAGMENT PLUGIN_PATH')
    applyMerge(args[1], args[2], args[3], io)
    return
  }
  if (action === 'remove') {
    if (args.length !== 3) die('usage: merge-settings-hooks.js remove DEST PLUGIN_PATH')
    removeMerge(args[1], io)
    return
  }
  if (action === 'stage') {
    if (args.length !== 4) die('usage: merge-settings-hooks.js stage SRC DEST PLUGIN_PATH')
    stageExtension(args[1], args[2], args[3])
    io.stdout.write(`staged ${args[1]} → ${args[2]} with PLUGIN_PATH=${args[3]}\n`)
    return
  }
  if (action === 'disable-auto-memory') {
    if (args.length !== 2) die('usage: merge-settings-hooks.js disable-auto-memory SETTINGS')
    disableAutoMemory(args[1], io)
    return
  }
  throw new MergeExit(1, USAGE)
}

/** CLI entry used by tests and `node dist/merge-settings-hooks.js`. Never process.exit. */
export function runMergeCli(
  args: string[],
  io: MergeIo = { stdout: process.stdout, stderr: process.stderr },
): number {
  try {
    dispatch(args, io)
    return 0
  } catch (err) {
    if (err instanceof MergeExit) {
      io.stderr.write(err.message)
      return err.status
    }
    throw err
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    /merge-settings-hooks\.(ts|js)$/.test(process.argv[1]))

if (invokedDirectly) {
  process.exit(runMergeCli(process.argv.slice(2)))
}
