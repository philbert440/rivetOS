import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { useStore } from '@/state/store'
import { getGateway } from '../../lib/gateway.js'
import { useTeam } from '../../stores/team.js'
import { cn } from '@/lib/cn'

interface WikiHit {
  slug: string
  title: string
}

interface NoteHit {
  id: string
  content: string
}

/** Replaces the Composio marketplace: household memory + wiki. */
export function PluginsPanel() {
  const { dispatch } = useStore()
  const [q, setQ] = useState('')
  const [notes, setNotes] = useState<NoteHit[]>([])
  const [wiki, setWiki] = useState<WikiHit[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setBusy(true)
    setError(null)
    const userId = useTeam.getState().userId
    void getGateway()
      .memorySearch(userId, { q, limit: 20 })
      .then((res) => {
        if (!alive) return
        setNotes(res.hits.map((h) => ({ id: h.id, content: h.content })))
      })
      .catch((err: Error) => {
        if (alive) setError(err.message)
      })
      .finally(() => {
        if (alive) setBusy(false)
      })

    void fetch(`/api/wiki?q=${encodeURIComponent(q)}`)
      .then(async (r) => {
        if (!r.ok) return
        const body = (await r.json()) as { pages?: WikiHit[]; articles?: WikiHit[] }
        if (alive) setWiki(body.pages ?? body.articles ?? [])
      })
      .catch(() => {
        /* wiki optional until datahub is on this origin */
      })
    return () => {
      alive = false
    }
  }, [q])

  return (
    <div className="absolute inset-0 z-40 flex justify-end bg-black/45">
      <aside className="flex h-full w-full max-w-[420px] flex-col border-l border-hairline bg-panel">
        <header className="flex items-center justify-between px-4 py-3">
          <div>
            <div className="text-[15px] font-semibold text-ink">Memory</div>
            <div className="text-[12px] text-ink-secondary">Household notes + wiki — not the app marketplace</div>
          </div>
          <button
            type="button"
            aria-label="Close memory"
            onClick={() => dispatch({ type: 'togglePlugins', open: false })}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={16} />
          </button>
        </header>
        <div className="px-4 pb-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search notes and wiki"
            className="w-full rounded-[14px] bg-inset px-3.5 py-2.5 text-[15px] text-ink outline-none placeholder:text-ink-secondary"
          />
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          {busy && (
            <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
              <Loader2 size={14} className="animate-spin" />
              Searching…
            </div>
          )}
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <section>
            <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">Notes</h2>
            {notes.length === 0 && !busy && <p className="text-[13px] text-ink-secondary">No notes yet for this person.</p>}
            {notes.map((n) => (
              <p key={n.id} className="mb-2 line-clamp-3 rounded-lg bg-raised/50 px-3 py-2 text-[13px] text-ink">
                {n.content}
              </p>
            ))}
          </section>
          <section>
            <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">Wiki</h2>
            {wiki.length === 0 && (
              <p className="text-[13px] text-ink-secondary">No wiki hits on this origin. Point den at datahub to fill this.</p>
            )}
            {wiki.map((w) => (
              <a
                key={w.slug}
                href={`/memory/${w.slug}`}
                className={cn('mb-1 block rounded-lg px-3 py-2 text-[14px] text-accent hover:bg-raised')}
              >
                {w.title || w.slug}
              </a>
            ))}
          </section>
        </div>
      </aside>
    </div>
  )
}
