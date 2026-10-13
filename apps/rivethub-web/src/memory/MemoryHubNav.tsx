import type { JSX } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, BookOpen, Clock, History, Search, Tags } from 'lucide-react'
import type { RivetGateway } from '@rivetos/gateway-client'
import { useIsNarrow } from '../lib/use-narrow.js'
import { TAG_QUERY_ROOT } from '../lib/use-session-tags.js'
import { useExperimental } from '../stores/experimental.js'
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
  const memoryHome = useExperimental((s) => s.experimental.memoryHome)
  if (memoryHome) return <MemoryHomeHeader {...props} />
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

/** Suggestions fetched for the review count; matches TagsView's first page. */
const PENDING_PAGE = 200

/**
 * Memory home header (experimental `memoryHome`): Sessions | Wiki, plus the
 * tag review queue and datahub health as entry points to Tags and Stats.
 */
function MemoryHomeHeader(props: {
  tab: MemoryHubTab
  gateway?: RivetGateway
  baseUrl?: string
}): JSX.Element {
  const navigate = useNavigate()
  const { gateway, baseUrl } = props
  const pending = useQuery({
    queryKey: [TAG_QUERY_ROOT, baseUrl, 'pending'],
    enabled: Boolean(gateway && baseUrl),
    queryFn: ({ signal }) =>
      gateway ? gateway.memoryTagsPending(PENDING_PAGE, signal) : Promise.resolve({ tags: [] }),
  })
  const toReview = pending.data?.tags.length ?? 0
  const view =
    props.tab === 'wiki'
      ? 'wiki'
      : props.tab === 'tags' || props.tab === 'stats'
        ? null
        : 'sessions'
  const go = (tab: MemoryTab): void => {
    void navigate({ to: '/memory', search: tab === 'search' ? {} : { tab } })
  }
  return (
    <nav className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-panel/60 px-3 py-2">
      <span className="text-sm font-semibold text-ink classic:text-em">Memory</span>
      <div className="inline-flex rounded-pill bg-panel-2 p-0.5 classic:rounded-none classic:border classic:border-line">
        {(
          [
            ['sessions', 'Sessions', History],
            ['wiki', 'Wiki', BookOpen],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            aria-pressed={view === id}
            onClick={() => go(id === 'sessions' ? 'search' : 'wiki')}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-sm classic:rounded-none',
              view === id
                ? 'bg-panel text-ink shadow-sm classic:bg-panel-2 classic:text-em'
                : 'text-ink-dim hover:text-ink',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <span className="grow" />
      {gateway && baseUrl && (
        <button
          type="button"
          onClick={() => go('tags')}
          aria-current={props.tab === 'tags' ? 'page' : undefined}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-sm classic:rounded-none',
            toReview > 0
              ? 'bg-em-container text-on-em-container classic:border classic:border-em classic:bg-transparent classic:text-em'
              : props.tab === 'tags'
                ? 'bg-panel-2 text-em'
                : 'text-ink-dim hover:bg-panel-2 hover:text-ink',
          )}
        >
          <Tags className="size-3.5" aria-hidden />
          {toReview > 0
            ? `${String(toReview)} ${toReview === 1 ? 'tag' : 'tags'} to review`
            : 'Tags'}
        </button>
      )}
      {gateway && baseUrl && (
        <button
          type="button"
          onClick={() => go('stats')}
          aria-current={props.tab === 'stats' ? 'page' : undefined}
          title="Memory health and stats"
          className="hidden sm:block"
        >
          <HealthTile gateway={gateway} baseUrl={baseUrl} compact />
        </button>
      )}
    </nav>
  )
}
