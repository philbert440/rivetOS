import type { JSX } from 'react'
import { Link } from '@tanstack/react-router'
import { NodeSwitcher } from './node-switcher.js'
import { DenBot } from './den-bot.js'

/** Primary session views — top of the rail. */
const PRIMARY_NAV = [
  { to: '/', label: 'Chat', icon: '💬' },
  { to: '/terminal', label: 'Terminal', icon: '›_' },
] as const

/** Workspace tools — below the separator. */
const SECONDARY_NAV = [
  { to: '/files', label: 'Files', icon: '▤' },
  { to: '/tasks', label: 'Tasks', icon: '☑' },
] as const

const SETTINGS = { to: '/settings', label: 'Settings', icon: '⚙' } as const

function NavLink(props: {
  to: string
  label: string
  icon: string
  exact?: boolean
}): JSX.Element {
  return (
    <Link
      to={props.to}
      className="rounded px-3 py-2 text-sm"
      activeProps={{ className: 'bg-panel-2 text-em' }}
      inactiveProps={{ className: 'text-ink-dim hover:bg-panel-2 hover:text-ink' }}
      activeOptions={{ exact: props.exact ?? props.to === '/' }}
    >
      <span className="mr-2 inline-block w-5 text-center font-mono">{props.icon}</span>
      {props.label}
    </Link>
  )
}

export function Sidebar(): JSX.Element {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel/80">
      <div className="flex items-center gap-2 px-4 py-4">
        <DenBot className="size-7" />
        <span className="font-mono text-sm font-semibold tracking-wide text-em">RivetHub</span>
      </div>

      <nav className="flex flex-col gap-1 px-2">
        {PRIMARY_NAV.map((item) => (
          <NavLink key={item.to} {...item} />
        ))}

        {/* Den is a link-out to the node's own /den/ (v1 cut — no in-app embed route). */}
        <a
          href="/den/"
          className="rounded px-3 py-2 text-sm text-ink-dim hover:bg-panel-2 hover:text-ink"
        >
          <span className="mr-2 inline-block w-5 text-center font-mono">▦</span>
          Den ↗
        </a>

        <div className="my-2 border-t border-line" role="separator" />

        {SECONDARY_NAV.map((item) => (
          <NavLink key={item.to} {...item} />
        ))}
      </nav>

      <div className="mt-auto flex flex-col">
        <div className="flex flex-col gap-1 px-2 pb-1">
          <NavLink {...SETTINGS} />
        </div>
        <NodeSwitcher />
      </div>
    </aside>
  )
}
