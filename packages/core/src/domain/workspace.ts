/**
 * Workspace Loader — reads workspace files and builds the system prompt.
 *
 * System prompt files (loaded on /new, cached for the session):
 *   AGENT.md        — identity + operating contract + owner/routed-user gate
 *   MEMORY.md       — lightweight context index (tiny, query-based)
 *
 * Per-user identity (appended after core files when a profile matches):
 *   users/<profile>.md — injected as ## USER.md (<profile>)
 *
 * NOT in the always-on system prompt:
 *   HEARTBEAT.md    — workspace override; else DEFAULT_HEARTBEAT (heartbeat turns only)
 *   memory/*.md     — search via memory_search
 */

import { readFile } from 'node:fs/promises'
import { join, resolve, isAbsolute, basename } from 'node:path'
import type { WorkspaceFile, Workspace } from '@rivetos/types'
import { logger } from '../logger.js'

const log = logger('Workspace')

/** Core files — always in system prompt */
const CORE_FILES = ['AGENT.md', 'MEMORY.md']

/** Max size for a single pinned file (50KB) */
const MAX_PIN_SIZE = 50 * 1024
/** Max total size of all pinned files (200KB) */
const MAX_TOTAL_PIN_SIZE = 200 * 1024

/** Default heartbeat checklist. A workspace HEARTBEAT.md overrides this. */
const DEFAULT_HEARTBEAT = `# HEARTBEAT.md — Background Task Checklist

Instructions injected **only on heartbeat turns** (when the runtime polls you to do background work). Keep this small to limit token burn.

## Rules

- If nothing needs attention, reply \`HEARTBEAT_OK\`.
- Do not infer or repeat old tasks from prior chats.
- Stay within the checklist below — freelancing wastes tokens.
- Respect quiet hours (late night) unless something is urgent.

## Checklist

Rotate through these across heartbeats, not all in one turn:

- [ ] Check recent \`memory/YYYY-MM-DD.md\` for anything you committed to do
- [ ] Check \`AGENT.md\` in any active project directory for pending work
- [ ] Brief memory maintenance (consolidate / index)
- [ ] _(add human-specific reminders as they come up)_

## State

Track what you checked and when in \`memory/heartbeat-state.json\`:

\`\`\`json
{
  "lastChecks": {
    "memory_review": null,
    "agent_md": null
  }
}
\`\`\`
`

export class WorkspaceLoader implements Workspace {
  private baseDir: string
  private cache: Map<string, string> = new Map()
  private pinnedFiles: Map<string, { content: string; size: number }> = new Map()
  /** Live skill catalog (name + one-line description), injected into the prompt
   *  so the agent discovers its skills instead of hand-rolling. Set at boot. */
  private skillCatalog = ''

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  /**
   * Load workspace files for system prompt injection.
   * Called once on session init (/new), not every turn.
   */
  async load(): Promise<WorkspaceFile[]> {
    const files: WorkspaceFile[] = []
    for (const name of CORE_FILES) {
      const content = await this.read(name)
      if (content) {
        files.push({ name, path: join(this.baseDir, name), content })
      }
    }
    return files
  }

  /**
   * Load a specific file by name. Used by heartbeat (HEARTBEAT.md)
   * or agent tools that need workspace file access.
   */
  async read(filename: string): Promise<string | null> {
    if (this.cache.has(filename)) {
      return this.cache.get(filename)!
    }
    try {
      const filepath = join(this.baseDir, filename)
      const content = await readFile(filepath, 'utf-8')
      this.cache.set(filename, content)
      return content
    } catch {
      return null
    }
  }

  async write(filename: string, content: string): Promise<void> {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    const filepath = join(this.baseDir, filename)
    await mkdir(dirname(filepath), { recursive: true })
    await writeFile(filepath, content, 'utf-8')
    this.cache.set(filename, content)
  }

  // ---------------------------------------------------------------------------
  // Pinned files — explicit context loading via /context commands
  // ---------------------------------------------------------------------------

  /**
   * Pin a file into context. Content is read once and cached.
   * Paths resolve relative to baseDir unless absolute.
   */
  async pinFile(filePath: string): Promise<{ name: string; size: number } | { error: string }> {
    const resolved = isAbsolute(filePath) ? filePath : resolve(this.baseDir, filePath)
    const name = isAbsolute(filePath) ? basename(filePath) : filePath

    try {
      const content = await readFile(resolved, 'utf-8')
      const size = Buffer.byteLength(content, 'utf-8')

      if (size > MAX_PIN_SIZE) {
        return { error: `File too large: ${name} is ${(size / 1024).toFixed(1)}KB (max 50KB)` }
      }

      // Check total pinned size (excluding this file if already pinned)
      let totalSize = size
      for (const [key, val] of this.pinnedFiles) {
        if (key !== name) totalSize += val.size
      }
      if (totalSize > MAX_TOTAL_PIN_SIZE) {
        return { error: 'Total pinned context would exceed 200KB limit. Unpin some files first.' }
      }

      this.pinnedFiles.set(name, { content, size })
      return { name, size }
    } catch {
      return { error: `File not found: ${filePath}` }
    }
  }

  /** Unpin a file. Returns true if it was pinned. */
  unpinFile(filePath: string): boolean {
    const name = isAbsolute(filePath) ? basename(filePath) : filePath
    return this.pinnedFiles.delete(name)
  }

  /** List all pinned files with their sizes. */
  getPinnedFiles(): Array<{ name: string; size: number }> {
    return Array.from(this.pinnedFiles.entries()).map(([name, { size }]) => ({ name, size }))
  }

  /** Clear all pinned files. Returns count removed. */
  clearPinnedFiles(): number {
    const count = this.pinnedFiles.size
    this.pinnedFiles.clear()
    return count
  }

  // ---------------------------------------------------------------------------
  // System prompt construction
  // ---------------------------------------------------------------------------

  /**
   * Resolve a per-user profile name from `users/profiles.json` (a
   * `{ "<userId>": "<profile>" }` map). Returns null when there's no map or no
   * entry. Matching profiles append `users/<profile>.md` as a USER.md section;
   * the owner identity lives in AGENT.md.
   */
  async resolveProfile(userId?: string): Promise<string | null> {
    if (!userId) return null
    const raw = await this.read('users/profiles.json')
    if (!raw) return null
    try {
      const map = JSON.parse(raw) as Record<string, string>
      return map[userId] ?? null
    } catch {
      return null
    }
  }

  /** Set the live skill catalog (built at boot from the SkillManager). */
  setSkillCatalog(text: string): void {
    this.skillCatalog = text.trim()
  }

  async buildSystemPrompt(agentId?: string, userId?: string): Promise<string> {
    const files = await this.load()
    if (files.length === 0) {
      log.warn(
        `No workspace files loaded from ${this.baseDir} — agent will boot without personality files`,
      )
    }
    // Per-user identity: if the speaker maps to a profile, append their
    // `users/<profile>.md` after the core files. No match → nothing extra
    // (AGENT.md carries the owner identity contract).
    const profile = await this.resolveProfile(userId)
    const profileMd = profile ? await this.read(`users/${profile}.md`) : null

    let prompt = ''
    for (const file of files) {
      prompt += `\n\n## ${file.name}\n${file.content}`
    }
    if (profile && profileMd) {
      prompt += `\n\n## USER.md (${profile})\n${profileMd}`
    }

    // Pinned files — after workspace files, before runtime section
    for (const [name, { content }] of this.pinnedFiles) {
      prompt += `\n\n## Pinned: ${name}\n${content}`
    }

    if (agentId) {
      prompt += `\n\n## Runtime\nAgent: ${agentId} | Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`
    }
    // Live skill catalog — the always-on menu for progressive discovery. The
    // agent sees what skills exist; invoking one loads its full SKILL.md.
    if (this.skillCatalog) {
      prompt += `\n\n${this.skillCatalog}`
    }
    return prompt.trim()
  }

  /**
   * Build system prompt for heartbeat turns — includes HEARTBEAT.md
   * (workspace override) or DEFAULT_HEARTBEAT.
   */
  async buildHeartbeatPrompt(agentId?: string): Promise<string> {
    const base = await this.buildSystemPrompt(agentId)
    const heartbeat = (await this.read('HEARTBEAT.md')) || DEFAULT_HEARTBEAT
    return base + `\n\n## HEARTBEAT.md\n${heartbeat}`
  }

  /** Clear cache and pinned files — forces re-read on next load (used by /new). */
  clearCache(): void {
    this.cache.clear()
    this.pinnedFiles.clear()
  }
}
