/**
 * Live /api/team client. Used when the signed-in session has a device token
 * from pairing (PR 512). Never talks to ros_messages.
 */

import type { Persona } from './types.js'
import { LOCAL_NODE_ID } from './types.js'

export interface LiveNote {
  id: string
  userId: string
  personaId: string
  role: string
  content: string
  createdAt: number
}

function headers(token: string): HeadersInit {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  }
}

async function read<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(body.error || `team api ${res.status}`)
  return body
}

export async function livePersonas(token: string): Promise<Persona[]> {
  const body = await read<{ personas: Array<{
    id: string
    name: string
    systemPrompt: string
    threadId: string
    sample?: boolean
  }> }>('/api/team/personas', { headers: headers(token) })
  return body.personas.map((p) => ({
    id: p.id,
    name: p.name,
    systemPrompt: p.systemPrompt,
    threadId: p.threadId,
    nodeId: LOCAL_NODE_ID,
    sample: p.sample,
  }))
}

export async function liveCreateNote(
  token: string,
  note: { personaId: string; role: string; content: string },
): Promise<LiveNote> {
  const body = await read<{ note: LiveNote }>('/api/team/notes', {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(note),
  })
  return body.note
}

export async function liveSearchNotes(token: string, q = ''): Promise<LiveNote[]> {
  const qs = new URLSearchParams()
  if (q) qs.set('q', q)
  qs.set('limit', '200')
  const body = await read<{ notes: LiveNote[] }>(`/api/team/notes/search?${qs}`, {
    headers: headers(token),
  })
  return body.notes
}
