import { useState, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Plus, Server } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { useConnection } from '../../stores/connection.js'
import { Button } from '../ui/button.js'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '../ui/popover.js'

/**
 * Node picker for the composer row — quick client-side re-point (never a
 * proxy), sharing the roster + mesh-discovery logic with the sidebar
 * NodeSwitcher via useConnection, so both stay in sync. Full node management
 * (remove / token) still lives in the sidebar switcher.
 */
export function NodePicker(props: { disabled?: boolean }): JSX.Element {
  const { baseUrl, roster, switchTo, addNode } = useConnection()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const mesh = useQuery({
    queryKey: ['mesh', baseUrl],
    queryFn: ({ signal }) => useConnection.getState().gateway.meshOverview(signal),
    enabled: open,
    staleTime: 30_000,
    retry: 0,
  })

  const current = roster.find((n) => n.baseUrl === baseUrl)
  const known = new Set(roster.map((n) => n.baseUrl))
  const discovered = (mesh.data?.nodes ?? []).filter(
    (n) => n.online && n.denUrl && !known.has(n.denUrl.replace(/\/+$/, '')),
  )

  const doSwitch = (url: string): void => {
    switchTo(url)
    // query keys carry endpoint identity, but invalidate so no future key can
    // serve node A's data as node B's (mirrors the sidebar switcher).
    void queryClient.invalidateQueries()
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        // only block OPENING when disabled — keep an open popover dismissable.
        if (o && props.disabled) return
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          title="node"
          className="h-8 rounded-full px-2.5 font-normal"
        >
          <Server className="size-3.5" />
          <span className="max-w-40 truncate">
            {current?.name ?? baseUrl.replace(/^https?:\/\//, '')}
          </span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <PopoverHeader className="border-b border-line px-4 py-3">
          <PopoverTitle>Node</PopoverTitle>
        </PopoverHeader>
        <div className="max-h-72 overflow-y-auto p-1.5">
          {roster.map((n) => {
            const active = n.baseUrl === baseUrl
            return (
              <button
                key={n.baseUrl}
                type="button"
                onClick={() => doSwitch(n.baseUrl)}
                title={n.baseUrl}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                  active ? 'bg-panel text-ink' : 'text-ink-dim hover:bg-panel hover:text-ink',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{n.name}</span>
                {active && <Check className="size-3.5 shrink-0 text-em" />}
              </button>
            )
          })}
          {roster.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-ink-dim">no saved nodes</div>
          )}

          {discovered.length > 0 && (
            <>
              <div className="mt-1 border-t border-line px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                on the mesh
              </div>
              {discovered.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => addNode({ name: n.name, baseUrl: n.denUrl })}
                  title={`${n.denUrl} — click to save`}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-ink-dim transition-colors hover:bg-panel hover:text-em"
                >
                  <Plus className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {n.name}
                    {n.sessions !== null ? ` (${String(n.sessions)})` : ''}
                  </span>
                </button>
              ))}
            </>
          )}
          {mesh.isError && (
            <div className="px-2.5 py-1.5 font-mono text-[10px] text-ink-dim">
              mesh roster unavailable on this node
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
