import type { JSX } from 'react'

/**
 * The Files breadcrumb strip: root label, crumb buttons, drop hint.
 * Stateless: navigation flows to the page's guarded navigate.
 */
export function Breadcrumbs(props: {
  path: string
  rootLabel: string
  onNavigate: (next: string) => void
}): JSX.Element {
  const crumbs = props.path === '' ? [] : props.path.split('/')
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-line bg-panel/40 px-4 py-2 text-xs">
      <button
        type="button"
        onClick={() => props.onNavigate('')}
        className={crumbs.length === 0 ? 'text-em' : 'text-ink-dim hover:text-ink'}
      >
        {props.rootLabel}
      </button>
      {crumbs.map((seg, i) => (
        <span key={crumbs.slice(0, i + 1).join('/')} className="flex items-center gap-1">
          <span className="text-ink-dim">/</span>
          <button
            type="button"
            onClick={() => props.onNavigate(crumbs.slice(0, i + 1).join('/'))}
            className={i === crumbs.length - 1 ? 'text-em' : 'text-ink-dim hover:text-ink'}
          >
            {seg}
          </button>
        </span>
      ))}
      <span className="ml-auto text-ink-dim">
        drop files to upload · drag onto a folder to move
      </span>
    </div>
  )
}
