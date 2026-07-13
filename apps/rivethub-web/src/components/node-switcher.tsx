import { useEffect, useRef, useState, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useConnection } from '../stores/connection.js'
import { urlLabel, useNodeName } from '../lib/node-name.js'
import { performNodeSwitch } from '../lib/switch-mode.js'

/**
 * 4h node switcher. Roster persists in localStorage; mesh overview of the
 * CURRENT node seeds discovery (peers advertise denUrl = hub face).
 * Always re-points the gateway via switchTo — local/bundled UI stays put
 * whether browser, Tauri, or Android WebView.
 */
export function NodeSwitcher(): JSX.Element {
  const { baseUrl, roster, switchTo, addNode, removeNode } = useConnection()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [switchError, setSwitchError] = useState<string | undefined>()
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on Escape / click-outside so the dropdown (and its mesh polling)
  // can't linger across navigation (#304 review).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [open])

  const doSwitch = (url: string): void => {
    const result = performNodeSwitch(url, switchTo)
    if (!result) {
      setSwitchError('invalid hub URL')
      return
    }
    setSwitchError(undefined)
    // repoint stays in-page — invalidate queries so no key serves node A as B.
    if (result.mode === 'repoint') void queryClient.invalidateQueries()
    setOpen(false)
  }

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
  const currentName = useNodeName(baseUrl) ?? current?.name ?? urlLabel(baseUrl)

  return (
    <div ref={rootRef} className="relative border-t border-line">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-panel-2"
        title={baseUrl}
      >
        <span className="truncate font-mono text-[11px] text-ink-dim">{currentName}</span>
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
                onClick={() => doSwitch(n.baseUrl)}
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
          {switchError && (
            <div className="mt-1 px-2 font-mono text-[10px] text-red" role="alert">
              {switchError}
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
