/**
 * Workspace Loader — reads workspace files and builds the system prompt.
 *
 * System prompt files (loaded on /new, cached for the session):
 *   CORE.md         — identity + personality + operating values
 *   USER.md         — who the owner is
 *   WORKSPACE.md    — operating rules + infrastructure context
 *   MEMORY.md       — lightweight context index (tiny, query-based)
 *
 * Extended (local models where tokens are free, adds):
 *   CAPABILITIES.md — tools, skills, infrastructure reference
 *
 * NOT in system prompt (agent uses tools to access these):
 *   HEARTBEAT.md    — only injected during heartbeat turns
 *   memory/*.md     — search via memory_search
 */

import { readFile } from 'node:fs/promises'
import { join, resolve, isAbsolute, basename } from 'node:path'
import type { WorkspaceFile, Workspace } from '@rivetos/types'
import { logger } from '../logger.js'

const log = logger('Workspace')

/** Core files — always in system prompt (minimal, for paid APIs) */
const CORE_FILES = ['CORE.md', 'USER.md', 'WORKSPACE.md', 'MEMORY.md']

/** Extended files — included for local models where tokens are free */
const EXTENDED_FILES = ['CORE.md', 'USER.md', 'WORKSPACE.md', 'MEMORY.md', 'CAPABILITIES.md']

/** Max size for a single pinned file (50KB) */
const MAX_PIN_SIZE = 50 * 1024
/** Max total size of all pinned files (200KB) */
const MAX_TOTAL_PIN_SIZE = 200 * 1024

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
   *
   * @param extended — true for local models where tokens are free (includes CAPABILITIES.md)
   */
  async load(extended = false): Promise<WorkspaceFile[]> {
    const fileList = extended ? EXTENDED_FILES : CORE_FILES
    const files: WorkspaceFile[] = []
    for (const name of fileList) {
      const content = await this.read(name)
      if (content) {
        files.push({ name, path: join(this.baseDir, name), content })
      }
    }

    // For extended mode, also load recent daily notes
    if (extended) {
      const memoryFiles = await this.loadRecentMemory(2)
      files.push(...memoryFiles)
    }

    return files
  }

  private async loadRecentMemory(daysBack: number): Promise<WorkspaceFile[]> {
    const files: WorkspaceFile[] = []
    const now = new Date()
    for (let i = 0; i <= daysBack; i++) {
      const date = new Date(now)
      date.setDate(date.getDate() - i)
      const dateStr = date.toISOString().split('T')[0]
      const filename = `memory/${dateStr}.md`
      const content = await this.read(filename)
      if (content) {
        files.push({ name: filename, path: join(this.baseDir, filename), content })
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
   * Build the system prompt from core files + pinned files.
   * This is injected ONCE on session init, not every turn.
   */
  /**
   * Resolve a per-user profile name from `users/profiles.json` (a
   * `{ "<userId>": "<profile>" }` map). Returns null when there's no map or no
   * entry — i.e. the default owner identity (USER.md) applies. Used to give
   * non-owner speakers their own USER.md and to tag their memory.
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

  async buildSystemPrompt(agentId?: string, extended = false, userId?: string): Promise<string> {
    const files = await this.load(extended)
    if (files.length === 0) {
      log.warn(
        `No workspace files loaded from ${this.baseDir} — agent will boot without personality files`,
      )
    }
    // Per-user identity: if the speaker maps to a profile, swap USER.md for
    // their `users/<profile>.md`. Everyone else gets the default USER.md.
    const profile = await this.resolveProfile(userId)
    const profileMd = profile ? await this.read(`users/${profile}.md`) : null

    let prompt = ''
    for (const file of files) {
      if (profileMd && file.name === 'USER.md') {
        prompt += `\n\n## USER.md (${profile})\n${profileMd}`
      } else {
        prompt += `\n\n## ${file.name}\n${file.content}`
      }
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
   * Build system prompt for heartbeat turns — includes HEARTBEAT.md.
   */
  async buildHeartbeatPrompt(agentId?: string): Promise<string> {
    const base = await this.buildSystemPrompt(agentId)
    const heartbeat = await this.read('HEARTBEAT.md')
    if (heartbeat) {
      return base + `\n\n## HEARTBEAT.md\n${heartbeat}`
    }
    return base
  }

  /** Clear cache and pinned files — forces re-read on next load (used by /new). */
  clearCache(): void {
    this.cache.clear()
    this.pinnedFiles.clear()
  }
}
