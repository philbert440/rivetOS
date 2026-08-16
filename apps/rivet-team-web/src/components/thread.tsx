import { useEffect, useRef, type JSX } from 'react'
import { useTeam } from '../stores/team.js'
import { WorkingChip } from './working-chip.js'
import { cn } from '../lib/utils.js'

export function Thread(): JSX.Element {
  const messages = useTeam((s) => s.messages)
  const working = useTeam((s) => s.working)
  const personas = useTeam((s) => s.personas)
  const selectedId = useTeam((s) => s.selectedId)
  const persona = personas.find((p) => p.id === selectedId)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, working])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-baseline justify-between border-b border-line px-5 py-3">
        <div>
          <h1 className="text-sm font-medium text-ink">{persona?.name ?? 'Select a persona'}</h1>
          {persona && (
            <p className="mt-0.5 text-xs text-ink-dim">
              one thread · bound to {persona.nodeId}
              {persona.sample ? ' · sample' : ''}
            </p>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {messages.length === 0 && !working && (
          <p className="text-sm text-ink-dim">
            {persona
              ? `Start a thread with ${persona.name}. Replies are stubbed this slice.`
              : 'Pick someone in the sidebar.'}
          </p>
        )}
        {messages.map((m) => (
          <article
            key={m.id}
            className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[min(40rem,85%)] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap',
                m.role === 'user' ? 'bg-em/15 text-ink' : 'border border-line bg-panel-2 text-ink',
              )}
            >
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                {m.role}
                <span className="ml-2 normal-case opacity-70">
                  {m.personaId} · {m.nodeId}
                </span>
              </div>
              {m.text}
            </div>
          </article>
        ))}
        {working && <WorkingChip label={`${persona?.name ?? 'Persona'} is working…`} />}
        <div ref={bottom} />
      </div>
    </div>
  )
}
