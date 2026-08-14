/**
 * Memory hub — Search / Wiki / Browse / Stats.
 * Wiki is the existing encyclopedia. Search/Browse/Stats hit datahub
 * GET /api/memory/* (same origin resolution as /api/wiki).
 */
import { type JSX } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { NotConnected } from '../components/not-connected.js'
import { MemoryPage } from '../pages/memory.js'
import { useWikiEndpoint } from '../lib/wiki-client.js'
import { BrowseView } from './BrowseView.js'
import { MemoryHubNav, type MemoryTab } from './MemoryHubNav.js'
import { SearchView } from './SearchView.js'
import { StatsView } from './StatsView.js'

export type { MemoryTab } from './MemoryHubNav.js'

export function MemoryHubPage(): JSX.Element {
  const navigate = useNavigate()
  const search = useSearch({ strict: false })
  const tab: MemoryTab = search.tab ?? 'search'
  const { endpoint, pending, needNode } = useWikiEndpoint()

  function openSession(sessionId: string): void {
    void navigate({ to: '/', search: { session: sessionId } })
  }

  if (needNode) return <NotConnected />
  if (pending) {
    return <div className="p-8 font-mono text-sm text-ink-dim">resolving datahub…</div>
  }
  if (!endpoint) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-sm font-semibold text-em">Memory</div>
        <p className="max-w-md text-sm text-ink-dim">
          Point RivetHub at datahub so Search, Wiki, Browse, and Stats can read the memory store.
          Set the datahub gateway URL in Settings, or connect a node that lists datahub on the mesh.
        </p>
        <Link
          to="/settings"
          className="rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em"
        >
          Open Settings
        </Link>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MemoryHubNav tab={tab} gateway={endpoint.gateway} baseUrl={endpoint.baseUrl} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'wiki' ? (
          <div className="rivet-memory-surfaces min-h-full">
            <MemoryPage />
          </div>
        ) : (
          <div className="rivet-memory-surfaces p-4">
            {tab === 'search' && (
              <SearchView
                gateway={endpoint.gateway}
                baseUrl={endpoint.baseUrl}
                onOpenSession={openSession}
              />
            )}
            {tab === 'browse' && (
              <BrowseView
                gateway={endpoint.gateway}
                baseUrl={endpoint.baseUrl}
                onOpenSession={openSession}
              />
            )}
            {tab === 'stats' && (
              <StatsView
                gateway={endpoint.gateway}
                baseUrl={endpoint.baseUrl}
                onOpenSession={openSession}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
