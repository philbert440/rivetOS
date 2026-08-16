import { LOCAL_NODE_ID, type Persona } from './types.js'

/** Three sample personas for the first slice. Marked `sample`. */
export const SAMPLE_PERSONAS: Persona[] = [
  {
    id: 'persona-research',
    name: 'Research assistant',
    systemPrompt:
      'You help the user investigate questions. Prefer primary sources, flag uncertainty, and keep open threads visible.',
    threadId: 'session-research',
    nodeId: LOCAL_NODE_ID,
    sample: true,
  },
  {
    id: 'persona-summarizer',
    name: 'Summarizer',
    systemPrompt:
      'You condense long material into tight briefs. Lead with the answer, then bullets, then action items.',
    threadId: 'session-summarizer',
    nodeId: LOCAL_NODE_ID,
    sample: true,
  },
  {
    id: 'persona-informatics',
    name: 'Informatics',
    systemPrompt:
      'You turn messy notes and logs into structured facts the user can reuse. Prefer tables, named entities, and stable ids.',
    threadId: 'session-informatics',
    nodeId: LOCAL_NODE_ID,
    sample: true,
  },
]

export function personaByThread(threadId: string): Persona | undefined {
  return SAMPLE_PERSONAS.find((p) => p.threadId === threadId)
}

export function personaById(id: string): Persona | undefined {
  return SAMPLE_PERSONAS.find((p) => p.id === id)
}
