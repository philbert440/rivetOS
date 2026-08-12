import type { JSX } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { BarChart3, BookOpen, Clock, Search } from 'lucide-react'
import type { RivetGateway } from '@rivetos/gateway-client'
import { HealthTile } from './HealthTile.js'

export type MemoryTab = 'search' | 'wiki' | 'browse' | 'stats'

const TABS: { id: MemoryTab; label: string; icon: typeof Search }[] = [
  { id: 'search', label: 'Search', icon: Search },
  { id: 'wiki', label: 'Wiki', icon: BookOpen },
  { id: 'browse', label: 'Browse', icon: Clock },
  { id: 'stats', label: 'Stats', icon: BarChart3 },
]

/** Shared tab strip — also mounted on `/memory/$slug` so a topic is still the hub. */
export function MemoryHubNav(props: { tab: MemoryTab; gateway?: RivetGateway }): JSX.Element {
  const navigate = useNavigate()
  function setTab(next: MemoryTab): void {
    void navigate({
      to: '/memory',
      search: next === 'search' ? {} : { tab: next },
    })
  }
  return (
    <nav className="flex shrink-0 items-center gap-1 border-b border-line bg-panel/60 px-3 py-2">
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => setTab(id)}
          aria-current={props.tab === id ? 'page' : undefined}
          className={
            props.tab === id
              ? 'inline-flex items-center gap-1.5 rounded bg-panel-2 px-3 py-1.5 text-sm text-em'
              : 'inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm text-ink-dim hover:bg-panel-2 hover:text-ink'
          }
        >
          <Icon className="size-3.5" aria-hidden />
          {label}
        </button>
      ))}
      {props.gateway && (
        <div className="ml-auto hidden sm:block">
          <HealthTile gateway={props.gateway} compact />
        </div>
      )}
    </nav>
  )
}
