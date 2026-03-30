/**
 * Workspace Loader — reads workspace files and builds the system prompt.
 *
 * System prompt files (loaded on /new, cached for the session):
 *   SOUL.md     — personality
 *   IDENTITY.md — who the agent is
 *   USER.md     — who the owner is
 *   AGENTS.md   — operating instructions
 *
 * NOT in system prompt (agent uses tools to access these):
 *   TOOLS.md        — read via file tool if needed
 *   MEMORY.md       — search via memory_grep
 *   HEARTBEAT.md    — only injected during heartbeat turns
 *   memory/*.md     — search via memory_grep
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceFile, Workspace } from '@rivetos/types';

/** Core files that define the agent — always in system prompt */
const CORE_FILES = [
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'AGENTS.md',
];

export class WorkspaceLoader implements Workspace {
  private baseDir: string;
  private cache: Map<string, string> = new Map();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /**
   * Load ONLY the core workspace files for system prompt injection.
   * Called once on session init (/new), not every turn.
   */
  async load(): Promise<WorkspaceFile[]> {
    const files: WorkspaceFile[] = [];
    for (const name of CORE_FILES) {
      const content = await this.read(name);
      if (content) {
        files.push({ name, path: join(this.baseDir, name), content });
      }
    }
    return files;
  }

  /**
   * Load a specific file by name. Used by heartbeat (HEARTBEAT.md)
   * or agent tools that need workspace file access.
   */
  async read(filename: string): Promise<string | null> {
    if (this.cache.has(filename)) {
      return this.cache.get(filename)!;
    }
    try {
      const filepath = join(this.baseDir, filename);
      const content = await readFile(filepath, 'utf-8');
      this.cache.set(filename, content);
      return content;
    } catch {
      return null;
    }
  }

  async write(filename: string, content: string): Promise<void> {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const filepath = join(this.baseDir, filename);
    await mkdir(dirname(filepath), { recursive: true });
    await writeFile(filepath, content, 'utf-8');
    this.cache.set(filename, content);
  }

  /**
   * Build the system prompt from core files only.
   * This is injected ONCE on session init, not every turn.
   */
  async buildSystemPrompt(agentId?: string): Promise<string> {
    const files = await this.load();
    let prompt = '';
    for (const file of files) {
      prompt += `\n\n## ${file.name}\n${file.content}`;
    }
    if (agentId) {
      prompt += `\n\n## Runtime\nAgent: ${agentId} | Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
    }
    return prompt.trim();
  }

  /**
   * Build system prompt for heartbeat turns — includes HEARTBEAT.md.
   */
  async buildHeartbeatPrompt(agentId?: string): Promise<string> {
    const base = await this.buildSystemPrompt(agentId);
    const heartbeat = await this.read('HEARTBEAT.md');
    if (heartbeat) {
      return base + `\n\n## HEARTBEAT.md\n${heartbeat}`;
    }
    return base;
  }

  /** Clear cache — forces re-read on next load (used by /new). */
  clearCache(): void {
    this.cache.clear();
  }
}
