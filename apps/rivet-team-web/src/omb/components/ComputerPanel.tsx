import { useEffect, useState } from 'react'
import { Loader2, Monitor, X } from 'lucide-react'
import { useStore, type Bot } from '@/state/store'
import { cn } from '@/lib/cn'
import { nodeIdForBot, probeNodeComputer, spawnNodeShell, type NodeComputerStatus } from '@/lib/node-computer'

/** Right-side computer slot. Bound to the persona's Rivet node, not Box. */
export function ComputerPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore()
  const [status, setStatus] = useState<NodeComputerStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [ptyId, setPtyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nodeId = nodeIdForBot(bot.id)

  useEffect(() => {
    let alive = true
    setError(null)
    setPtyId(null)
    void probeNodeComputer(bot.id).then((s) => {
      if (alive) setStatus(s)
    })
    return () => {
      alive = false
    }
  }, [bot.id])

  const openShell = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await spawnNodeShell(bot.threadId)
    setBusy(false)
    if ('error' in result) setError(result.error)
    else setPtyId(result.id)
  }

  return (
    <aside className="flex h-full w-full max-w-[420px] shrink-0 flex-col border-l border-hairline bg-panel">
      <header className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <Monitor size={16} className="text-accent" />
          <span className="text-[15px] font-semibold text-ink">{bot.name}'s computer</span>
        </div>
        <button
          type="button"
          aria-label="Close computer"
          onClick={() => dispatch({ type: 'toggleComputer', open: false })}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        <p className="text-[13px] text-ink-secondary">
          Bound to node <span className="font-mono text-ink">{nodeId}</span>
        </p>
        {!status && (
          <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" />
            Checking the node…
          </div>
        )}
        {status && (
          <div className={cn('rounded-xl border px-3 py-2 text-[13px]', status.reachable ? 'border-success/40 text-ink' : 'border-danger/40 text-danger')}>
            {status.reachable ? `den reachable at ${status.baseUrl}` : status.error ?? 'node unreachable'}
          </div>
        )}
        {status?.term && (
          <div className="rounded-xl bg-raised/50 px-3 py-2 text-[13px] text-ink-secondary">
            terminal {status.term.enabled ? 'on' : 'off'} · {status.term.active}/{status.term.maxPtys} PTYs
            {status.term.commands.length > 0 && (
              <div className="mt-1 text-ink">
                {status.term.commands.map((c) => c.label).join(' · ')}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          disabled={busy || !status?.reachable}
          onClick={() => void openShell()}
          className="rounded-lg bg-accent px-3 py-2 text-[13.5px] font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Opening…' : 'Open shell on this node'}
        </button>
        {ptyId && (
          <p className="font-mono text-[12px] text-ink-secondary">
            PTY {ptyId} — attach from Hub or den for the live screen.
          </p>
        )}
        {error && <p className="text-[13px] text-danger">{error}</p>}
      </div>
    </aside>
  )
}
