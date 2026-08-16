/**
 * Local-first memory shared by every persona of the same user.
 * Household memory is out of scope. Search is a substring placeholder.
 */

import type { MemorySearchHit, MemorySearchResponse } from './types.js'
import { uuidv4 } from './uuid.js'

export interface MemoryNote {
  id: string
  userId: string
  content: string
  role: string
  agent: string
  createdAt: number
}

const PREFIX = 'rivet-team.memory.'

function load(userId: string): MemoryNote[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(PREFIX + userId)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as MemoryNote[]) : []
  } catch {
    return []
  }
}

function save(userId: string, notes: MemoryNote[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PREFIX + userId, JSON.stringify(notes.slice(-200)))
  } catch {
    /* quota / private mode */
  }
}

export function appendMemory(note: Omit<MemoryNote, 'id' | 'createdAt'>): MemoryNote {
  const entry: MemoryNote = { ...note, id: uuidv4(), createdAt: Date.now() }
  const notes = load(note.userId)
  notes.push(entry)
  save(note.userId, notes)
  return entry
}

export function searchMemory(
  userId: string,
  query: { q: string; limit?: number },
): MemorySearchResponse {
  const q = query.q.trim().toLowerCase()
  const limit = query.limit ?? 20
  const hits: MemorySearchHit[] = []
  if (!q) return { hits }
  for (const note of load(userId)) {
    if (!note.content.toLowerCase().includes(q)) continue
    hits.push({
      id: note.id,
      content: note.content,
      role: note.role,
      agent: note.agent,
      score: 1,
      createdAt: note.createdAt,
    })
    if (hits.length >= limit) break
  }
  return { hits }
}

export function memoryCount(userId: string): number {
  return load(userId).length
}
