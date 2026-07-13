import { useState, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Plus, Server } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { useConnection } from '../../stores/connection.js'
import { prettifyNodeName, urlLabel, useNodeName } from '../../lib/node-name.js'
import { performNodeSwitch } from '../../lib/switch-mode.js'
import { Button } from '../ui/button.js'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '../ui/popover.js'

/** One saved-node row — resolves the node's human name from its /healthz
 *  hostname, falling back to the roster name. Its own component so the
 *  per-node name query is a hook (only mounted while the popover is open). */
function SavedNodeRow(props: {
  name: string
  baseUrl: string
  active: boolean
  onSwitch: (url: string) => void
}): JSX.Element {
  const name = useNodeName(props.baseUrl) ?? props.name
  return (
    <button
      type="button"
      onClick={() => props.onSwitch(props.baseUrl)}
      title={props.baseUrl}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
        props.active ? 'bg-panel text-ink' : 'text-ink-dim hover:bg-panel hover:text-ink',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {props.active && <Check className="size-3.5 shrink-0 text-em" />}
    </button>
  )
}

function DiscoveredNodeRow(props: {
  meshName: string
  denUrl: string
  sessions: number | null
  onAdd: (name: string, denUrl: string) => void
}): JSX.Element {
  const name = useNodeName(props.denUrl) ?? prettifyNodeName(props.meshName)
  return (
    <button
      type="button"
      onClick={() => props.onAdd(name, props.denUrl)}
      title={`${props.denUrl} — click to save`}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-ink-dim transition-colors hover:bg-panel hover:text-em"
    >
      <Plus className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {name}
        {props.sessions !== null ? ` (${String(props.sessions)})` : ''}
      </span>
    </button>
  )
}

/**
 * Node picker for the composer row — shares roster + mesh discovery with the
 * sidebar NodeSwitcher. Always re-points the gateway client so the local UI
 * stays put. Full node management (remove / token) still lives in the
 * sidebar switcher. Labels: hostname via /healthz.
 */
export function NodePicker(props: { disabled?: boolean }): JSX.Element {
  const { baseUrl, roster, switchTo, addNode } = useConnection()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [switchError, setSwitchError] = useState<string | undefined>()

  const mesh = useQuery({
    queryKey: ['mesh', baseUrl],
    queryFn: ({ signal }) => useConnection.getState().gateway.meshOverview(signal),
    enabled: open,
    staleTime: 30_000,
    retry: 0,
  })

  const current = roster.find((n) => n.baseUrl === baseUrl)
  const currentName = useNodeName(baseUrl) ?? current?.name ?? urlLabel(baseUrl)
  const known = new Set(roster.map((n) => n.baseUrl))
  const discovered = (mesh.data?.nodes ?? []).filter(
    (n) => n.online && n.denUrl && !known.has(n.denUrl.replace(/\/+$/, '')),
  )

  const doSwitch = (url: string): void => {
    const result = performNodeSwitch(url, switchTo)
    if (!result) {
      setSwitchError('invalid hub URL')
      return
    }
    setSwitchError(undefined)
    if (result.mode === 'repoint') void queryClient.invalidateQueries()
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
          <span className="max-w-40 truncate">{currentName}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <PopoverHeader className="border-b border-line px-4 py-3">
          <PopoverTitle>Node</PopoverTitle>
        </PopoverHeader>
        <div className="max-h-72 overflow-y-auto p-1.5">
          {roster.map((n) => (
            <SavedNodeRow
              key={n.baseUrl}
              name={n.name}
              baseUrl={n.baseUrl}
              active={n.baseUrl === baseUrl}
              onSwitch={doSwitch}
            />
          ))}
          {roster.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-ink-dim">no saved nodes</div>
          )}

          {discovered.length > 0 && (
            <>
              <div className="mt-1 border-t border-line px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                on the mesh
              </div>
              {discovered.map((n) => (
                <DiscoveredNodeRow
                  key={n.id}
                  meshName={n.name}
                  denUrl={n.denUrl}
                  sessions={n.sessions}
                  onAdd={(name, denUrl) => addNode({ name, baseUrl: denUrl })}
                />
              ))}
            </>
          )}
          {mesh.isError && (
            <div className="px-2.5 py-1.5 font-mono text-[10px] text-ink-dim">
              mesh roster unavailable on this node
            </div>
          )}
          {switchError && (
            <div className="px-2.5 py-1.5 font-mono text-[10px] text-red" role="alert">
              {switchError}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
