import { useMemo, useState, type JSX } from 'react'
import { saveSession } from '../lib/users.js'
import { cn, formatTime } from '../lib/utils.js'
import { useTeam } from '../stores/team.js'
import { PersonaFace } from './den-bot.js'

export function Sidebar(props: { className?: string }): JSX.Element {
  const personas = useTeam((s) => s.personas)
  const selectedId = useTeam((s) => s.selectedId)
  const selectPersona = useTeam((s) => s.selectPersona)
  const previews = useTeam((s) => s.previews)
  const working = useTeam((s) => s.working)
  const userName = useTeam((s) => s.userName)
  const userHandle = useTeam((s) => s.userHandle)
  const live = useTeam((s) => s.live)
  const lastError = useTeam((s) => s.lastError)
  const [query, setQuery] = useState('')

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return personas.filter((p) => {
      if (!q) return true
      const preview = previews[p.id]?.text ?? p.systemPrompt
      return p.name.toLowerCase().includes(q) || preview.toLowerCase().includes(q)
    })
  }, [personas, previews, query])

  return (
    <aside
      className={cn(
        'flex h-full min-h-0 w-full flex-col bg-panel md:w-[320px] md:shrink-0 md:border-r md:border-hairline',
        props.className,
      )}
    >
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <div className="text-[22px] font-semibold text-ink">rivet-team</div>
      </div>
      <div className="px-4 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          className="w-full rounded-[14px] bg-inset px-3.5 py-2.5 text-[15px] text-ink outline-none placeholder:text-ink-secondary"
        />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2" aria-label="Personas">
        {rows.map((p) => {
          const active = p.id === selectedId
          const last = previews[p.id]
          const preview =
            working && active
              ? 'Working…'
              : last?.text.replace(/\s+/g, ' ').slice(0, 72) ||
                p.systemPrompt.split('.')[0] ||
                'Say hello'
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => selectPersona(p.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left',
                active ? 'bg-raised' : 'hover:bg-raised/50',
              )}
            >
              <PersonaFace personaId={p.id} size={36} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[15px] font-semibold text-ink">{p.name}</span>
                  {last && (
                    <span className="shrink-0 text-xs text-ink-secondary">{formatTime(last.ts)}</span>
                  )}
                </span>
                <span className="block truncate text-[13px] text-ink-secondary">{preview}</span>
              </span>
            </button>
          )
        })}
      </nav>
      <div className="flex items-center gap-3 border-t border-hairline px-4 py-3">
        <span className="flex size-9 items-center justify-center rounded-full bg-em/15 text-[12px] font-semibold text-em">
          {userName.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-ink">{userName}</div>
          <div className="truncate text-[12px] text-ink-secondary">
            @{userHandle} · {live ? 'store live' : 'stub · this person only'}
          </div>
        </div>
        <button
          type="button"
          className="text-[14px] font-medium text-em"
          onClick={() => {
            saveSession(null)
            window.location.reload()
          }}
        >
          Switch
        </button>
      </div>
      {lastError && <div className="px-4 pb-3 text-[12px] text-danger">{lastError}</div>}
    </aside>
  )
}
