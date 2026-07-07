import { useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConnection } from '../stores/connection.js'

/**
 * 4h node switcher — client-side re-point, never a proxy. Roster persists
 * in localStorage; the mesh overview of the CURRENT node seeds discovery
 * (den-enabled peers advertise their denUrl). Switching endpoints resets
 * the chat/notification stores via their endpoint-identity watchers.
 */
export function NodeSwitcher(): JSX.Element {
  const { baseUrl, roster, switchTo, addNode, removeNode } = useConnection()
  const [open, setOpen] = useState(false)

  const mesh = useQuery({
    queryKey: ['mesh', baseUrl],
    queryFn: ({ signal }) => useConnection.getState().gateway.meshOverview(signal),
    enabled: open,
    staleTime: 30_000,
    retry: 0,
  })

  const known = new Set(roster.map((n) => n.baseUrl))
  const discovered = (mesh.data?.nodes ?? []).filter(
    (n) => n.online && n.denUrl && !known.has(n.denUrl.replace(/\/+$/, '')),
  )
  const current = roster.find((n) => n.baseUrl === baseUrl)

  return (
    <div className="relative border-t border-line">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-panel-2"
        title={baseUrl}
      >
        <span className="truncate font-mono text-[11px] text-ink-dim">
          {current?.name ?? baseUrl.replace(/^https?:\/\//, '')}
        </span>
        <span className="font-mono text-[10px] text-ink-dim">{open ? '▾' : '▴'}</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-2 right-2 z-40 mb-1 rounded-lg border border-line bg-panel-2 p-2 shadow-lg">
          <div className="mb-1 px-2 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
            nodes
          </div>
          {roster.map((n) => (
            <div key={n.baseUrl} className="flex items-center">
              <button
                onClick={() => {
                  switchTo(n.baseUrl)
                  setOpen(false)
                }}
                className={`flex-1 truncate rounded px-2 py-1.5 text-left font-mono text-xs ${
                  n.baseUrl === baseUrl ? 'text-em' : 'text-ink-dim hover:text-ink'
                }`}
                title={n.baseUrl}
              >
                {n.baseUrl === baseUrl ? '● ' : '○ '}
                {n.name}
              </button>
              <button
                onClick={() => removeNode(n.baseUrl)}
                className="px-1 text-ink-dim hover:text-red"
                aria-label={`remove ${n.name}`}
              >
                ✕
              </button>
            </div>
          ))}
          {roster.length === 0 && (
            <div className="px-2 py-1 text-xs text-ink-dim">no saved nodes</div>
          )}

          {discovered.length > 0 && (
            <>
              <div className="mb-1 mt-2 px-2 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                on the mesh
              </div>
              {discovered.map((n) => (
                <button
                  key={n.id}
                  onClick={() => addNode({ name: n.name, baseUrl: n.denUrl })}
                  className="block w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs text-ink-dim hover:text-em"
                  title={`${n.denUrl} — click to save`}
                >
                  + {n.name}
                  {n.sessions !== null ? ` (${String(n.sessions)} sessions)` : ''}
                </button>
              ))}
            </>
          )}
          {mesh.isError && (
            <div className="mt-1 px-2 font-mono text-[10px] text-ink-dim">
              mesh roster unavailable on this node
            </div>
          )}
          <div className="mt-2 border-t border-line px-2 pt-2 text-[10px] text-ink-dim">
            add / token: Settings
          </div>
        </div>
      )}
    </div>
  )
}
