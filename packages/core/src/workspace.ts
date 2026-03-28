/**
 * Workspace Loader — reads workspace files and builds the system prompt.
 *
 * Load order (same as TinyClaw/OpenClaw convention):
 * 1. SOUL.md — personality
 * 2. IDENTITY.md — who the agent is
 * 3. USER.md — who the owner is
 * 4. AGENTS.md — operating instructions
 * 5. TOOLS.md — tool usage notes
 * 6. MEMORY.md — long-term curated memory
 * 7. HEARTBEAT.md — heartbeat configuration
 * 8. memory/YYYY-MM-DD.md — today + yesterday's daily notes
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceFile, Workspace } from '@rivetos/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOAD_ORDER = [
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'AGENTS.md',
  'TOOLS.md',
  'MEMORY.md',
  'HEARTBEAT.md',
];

// ---------------------------------------------------------------------------
// Workspace Loader
// ---------------------------------------------------------------------------

export class WorkspaceLoader implements Workspace {
  private baseDir: string;
  private cache: Map<string, string> = new Map();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /**
   * Load all workspace files in priority order.
   */
  async load(): Promise<WorkspaceFile[]> {
    const files: WorkspaceFile[] = [];

    // Load standard files in order
    for (const name of LOAD_ORDER) {
      const content = await this.read(name);
      if (content) {
        files.push({ name, path: join(this.baseDir, name), content });
      }
    }

    // Load recent memory files (today + yesterday)
    const memoryFiles = await this.loadRecentMemory(1);
    files.push(...memoryFiles);

    return files;
  }

  /**
   * Read a single workspace file. Returns null if not found.
   */
  async read(filename: string): Promise<string | null> {
    try {
      const filepath = join(this.baseDir, filename);
      const content = await readFile(filepath, 'utf-8');
      this.cache.set(filename, content);
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Write a workspace file.
   */
  async write(filename: string, content: string): Promise<void> {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const filepath = join(this.baseDir, filename);
    await mkdir(dirname(filepath), { recursive: true });
    await writeFile(filepath, content, 'utf-8');
    this.cache.set(filename, content);
  }

  /**
   * Build the system prompt from workspace files.
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
   * Load recent memory files (today + N days back).
   */
  private async loadRecentMemory(daysBack: number): Promise<WorkspaceFile[]> {
    const files: WorkspaceFile[] = [];
    const now = new Date();

    for (let i = 0; i <= daysBack; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const filename = `memory/${dateStr}.md`;
      const content = await this.read(filename);

      if (content) {
        files.push({
          name: filename,
          path: join(this.baseDir, filename),
          content,
        });
      }
    }

    return files;
  }

  /**
   * Clear the in-memory cache (force re-read from disk).
   */
  clearCache(): void {
    this.cache.clear();
  }
}
