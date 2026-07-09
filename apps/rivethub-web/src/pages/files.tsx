import type { JSX } from 'react'

/**
 * Files — browser for the shared collab mount (`/rivet-shared`).
 * Nav slot is live; list/read over the gateway is not wired yet.
 */
export function FilesPage(): JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-1 font-mono text-lg font-semibold text-em">Files</h1>
      <p className="mb-6 font-mono text-xs text-ink-dim">/rivet-shared</p>

      <p className="mb-4 text-sm text-ink-dim">
        Cross-node collaboration tree: plans, the shared RivetOS clone, projects,
        meetings — neutral ground, not any agent&apos;s personal workspace.
      </p>

      <div className="rounded border border-line bg-panel-2/50 px-4 py-3 font-mono text-xs text-ink-dim">
        Browser not wired yet. Will list and open under{' '}
        <span className="text-em">/rivet-shared</span> via the node gateway
        (path-fenced; no secrets, no <span className="text-ink">~/.rivetos</span>).
      </div>
    </div>
  )
}
