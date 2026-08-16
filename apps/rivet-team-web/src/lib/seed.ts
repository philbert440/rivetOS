import { LOCAL_NODE_ID, type Persona } from './types.js'

/** Three sample personas for one user. Thread ids are user-scoped. */
export function samplePersonasFor(userId: string): Persona[] {
  const tag = userId.slice(0, 8)
  return [
    {
      id: `${tag}-persona-research`,
      name: 'Research assistant',
      systemPrompt:
        'You help the user investigate questions. Prefer primary sources, flag uncertainty, and keep open threads visible.',
      threadId: `${tag}-session-research`,
      nodeId: LOCAL_NODE_ID,
      sample: true,
    },
    {
      id: `${tag}-persona-summarizer`,
      name: 'Summarizer',
      systemPrompt:
        'You condense long material into tight briefs. Lead with the answer, then bullets, then action items.',
      threadId: `${tag}-session-summarizer`,
      nodeId: LOCAL_NODE_ID,
      sample: true,
    },
    {
      id: `${tag}-persona-informatics`,
      name: 'Informatics',
      systemPrompt:
        'You turn messy notes and logs into structured facts the user can reuse. Prefer tables, named entities, and stable ids.',
      threadId: `${tag}-session-informatics`,
      nodeId: LOCAL_NODE_ID,
      sample: true,
    },
  ]
}

export const SAMPLE_PERSONAS: Persona[] = samplePersonasFor('local-user')

export function personaByThread(threadId: string): Persona | undefined {
  if (threadId.endsWith('session-research')) {
    return samplePersonasFor('lookup').find((p) => p.name === 'Research assistant')
  }
  if (threadId.endsWith('session-summarizer')) {
    return samplePersonasFor('lookup').find((p) => p.name === 'Summarizer')
  }
  if (threadId.endsWith('session-informatics')) {
    return samplePersonasFor('lookup').find((p) => p.name === 'Informatics')
  }
  return SAMPLE_PERSONAS.find((p) => p.threadId === threadId)
}

export function personaById(id: string): Persona | undefined {
  return SAMPLE_PERSONAS.find((p) => p.id === id)
}
