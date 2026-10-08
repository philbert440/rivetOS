import type { JSX } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { BarChart3, BookOpen, Clock, History, Search, Tags } from 'lucide-react'
import type { RivetGateway } from '@rivetos/gateway-client'
import { useIsNarrow } from '../lib/use-narrow.js'
import { cn } from '../lib/utils.js'
import { HealthTile } from './HealthTile.js'

export type MemoryTab = 'search' | 'wiki' | 'browse' | 'tags' | 'stats'
/** Sessions is a hub tab with its own routes (`/sessions`, `/sessions/$id`). */
export type MemoryHubTab = MemoryTab | 'sessions'

const TABS: { id: MemoryHubTab; label: string; icon: typeof Search }[] = [
  { id: 'search', label: 'Search', icon: Search },
  { id: 'wiki', label: 'Wiki', icon: BookOpen },
  { id: 'browse', label: 'Browse', icon: Clock },
  { id: 'sessions', label: 'Sessions', icon: History },
  { id: 'tags', label: 'Tags', icon: Tags },
  { id: 'stats', label: 'Stats', icon: BarChart3 },
]

/** Shared tab strip — also mounted on `/memory/$slug` so a topic is still the
 *  hub, and on the Sessions pages, which are the hub's Sessions tab. */
export function MemoryHubNav(props: {
  tab: MemoryHubTab
  gateway?: RivetGateway
  /** Datahub identity the health tile keys its queries on. */
  baseUrl?: string
}): JSX.Element {
  const navigate = useNavigate()
  const narrow = useIsNarrow()
  function setTab(next: MemoryHubTab): void {
    if (next === 'sessions') {
      void navigate({ to: '/sessions' })
      return
    }
    void navigate({
      to: '/memory',
      search: next === 'search' ? {} : { tab: next },
    })
  }
  return (
    <nav
      className={
        narrow
          ? 'flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-panel/60 px-2 py-1.5'
          : 'flex shrink-0 items-center gap-1 border-b border-line bg-panel/60 px-3 py-2'
      }
    >
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => setTab(id)}
          aria-current={props.tab === id ? 'page' : undefined}
          className={cn(
            props.tab === id
              ? 'inline-flex items-center gap-1.5 rounded bg-panel-2 px-3 py-1.5 text-sm text-em'
              : 'inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm text-ink-dim hover:bg-panel-2 hover:text-ink',
            narrow && 'shrink-0 whitespace-nowrap',
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {label}
        </button>
      ))}
      {props.gateway && props.baseUrl && (
        <div className="ml-auto hidden sm:block">
          <HealthTile gateway={props.gateway} baseUrl={props.baseUrl} compact />
        </div>
      )}
    </nav>
  )
}
