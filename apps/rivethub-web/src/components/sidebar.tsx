import type { JSX } from 'react'
import { Link } from '@tanstack/react-router'
import { useConnection } from '../stores/connection.js'

const NAV = [
  { to: '/', label: 'Chat', icon: '💬' },
  { to: '/terminal', label: 'Terminal', icon: '›_' },
  { to: '/tasks', label: 'Tasks', icon: '☑' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
] as const

export function Sidebar(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const nodeLabel = baseUrl.replace(/^https?:\/\//, '')

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel/80">
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="text-xl">🔩</span>
        <span className="font-mono text-sm font-semibold tracking-wide text-em">RivetHub</span>
      </div>

      <nav className="flex flex-col gap-1 px-2">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="rounded px-3 py-2 text-sm"
            activeProps={{ className: 'bg-panel-2 text-em' }}
            inactiveProps={{ className: 'text-ink-dim hover:bg-panel-2 hover:text-ink' }}
            activeOptions={{ exact: item.to === '/' }}
          >
            <span className="mr-2 inline-block w-5 text-center font-mono">{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="mt-4 flex flex-col gap-1 border-t border-line px-2 pt-3">
        {/* Link-outs by design: den + wiki live on their own pages (v1 cut). */}
        <a
          href="/den/"
          className="rounded px-3 py-2 text-sm text-ink-dim hover:bg-panel-2 hover:text-ink"
        >
          <span className="mr-2 inline-block w-5 text-center font-mono">▦</span>
          Den ↗
        </a>
      </div>

      <div className="mt-auto border-t border-line px-4 py-3">
        <div className="font-mono text-[11px] text-ink-dim" title={baseUrl}>
          {nodeLabel}
        </div>
      </div>
    </aside>
  )
}
