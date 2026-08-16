import type { JSX } from 'react'
import { cn, initials } from '../lib/utils.js'
import { useTeam } from '../stores/team.js'

export function Sidebar(): JSX.Element {
  const personas = useTeam((s) => s.personas)
  const selectedId = useTeam((s) => s.selectedId)
  const selectPersona = useTeam((s) => s.selectPersona)
  const memoryNotes = useTeam((s) => s.memoryNotes)
  const wsStatus = useTeam((s) => s.wsStatus)

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel/80">
      <div className="px-4 py-4">
        <div className="font-mono text-sm font-semibold tracking-wide text-em">rivet-team</div>
        <p className="mt-1 text-xs text-ink-dim">Personas · one thread each</p>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-2" aria-label="Personas">
        {personas.map((p) => {
          const active = p.id === selectedId
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => selectPersona(p.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm',
                active ? 'bg-panel-2 text-ink' : 'text-ink-dim hover:bg-panel-2 hover:text-ink',
              )}
            >
              <span
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full font-mono text-[11px]',
                  active ? 'bg-em/15 text-em' : 'bg-panel-2 text-ink-dim',
                )}
                aria-hidden
              >
                {initials(p.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.name}</span>
                <span className="block truncate text-[11px] text-ink-dim">
                  {p.sample ? 'sample · ' : ''}
                  {p.nodeId}
                </span>
              </span>
            </button>
          )
        })}
      </nav>

      <div className="border-t border-line px-4 py-3 text-[11px] text-ink-dim">
        <div>Memory · {memoryNotes} notes (shared, local)</div>
        <div className="mt-1 font-mono">
          gateway {wsStatus}
          <span className="ml-2 text-ink-dim/80">stub</span>
        </div>
      </div>
    </aside>
  )
}
