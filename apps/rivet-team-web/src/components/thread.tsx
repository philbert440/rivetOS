import { useEffect, useRef, type JSX } from 'react'
import { cn } from '../lib/utils.js'
import { useTeam } from '../stores/team.js'
import { PersonaFace } from './den-bot.js'

export function Thread(props: { onBack?: () => void }): JSX.Element {
  const messages = useTeam((s) => s.messages)
  const working = useTeam((s) => s.working)
  const personas = useTeam((s) => s.personas)
  const selectedId = useTeam((s) => s.selectedId)
  const persona = personas.find((p) => p.id === selectedId)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, working])

  if (!persona) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center bg-app text-[14px] text-ink-secondary">
        Pick someone in the roster.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <header className="flex items-center gap-2.5 px-3 py-3 md:px-5">
        {props.onBack && (
          <button
            type="button"
            aria-label="Back to roster"
            onClick={props.onBack}
            className="rounded-md px-2 py-1 text-[22px] leading-none text-ink md:hidden"
          >
            ‹
          </button>
        )}
        <PersonaFace personaId={persona.id} size={28} />
        <span className="text-[15px] font-semibold text-ink">{persona.name}</span>
        {working && (
          <span className="text-[12px] text-ink-secondary">working…</span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-5">
        <div className="mx-auto flex max-w-[900px] flex-col gap-3 pb-4">
          {messages.length === 0 && !working && (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
              <PersonaFace personaId={persona.id} size={64} />
              <div className="text-[17px] font-semibold text-ink">{persona.name}</div>
              <div className="max-w-[360px] text-[14px] text-ink-secondary">
                {persona.systemPrompt.split('.')[0]}. Replies are stubbed this slice.
              </div>
            </div>
          )}
          {messages.map((m) => (
            <article
              key={m.id}
              className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink',
                  m.role === 'user'
                    ? 'max-w-[86%] bg-bubble-user'
                    : 'w-full max-w-[900px] bg-card md:max-w-[70%]',
                )}
              >
                {m.text}
              </div>
            </article>
          ))}
          {working && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2.5 rounded-2xl bg-raised px-4 py-3">
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:0ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:150ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:300ms]" />
                </span>
                <span className="text-[12.5px] text-ink-secondary">Working…</span>
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>
    </div>
  )
}
