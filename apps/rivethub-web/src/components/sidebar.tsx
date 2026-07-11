import type { JSX } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Bell } from 'lucide-react'
import { useNotifications } from '../stores/notifications.js'
import { NodeSwitcher } from './node-switcher.js'
import { DenBot } from './den-bot.js'

/** Primary session views — top of the rail. Conversations leads: it's the
 *  most-used view; each view after it is a step more immersive. */
const PRIMARY_NAV = [
  { to: '/', label: 'Conversations', icon: '💬' },
  { to: '/terminal', label: 'Terminal', icon: '›_' },
  { to: '/dens', label: 'Den', icon: '▦' },
] as const

/** Workspace tools — below the separator. */
const SECONDARY_NAV = [
  { to: '/files', label: 'Files', icon: '▤' },
  { to: '/tasks', label: 'Tasks', icon: '☑' },
] as const

const SETTINGS = { to: '/settings', label: 'Settings', icon: '⚙' } as const

function NavLink(props: { to: string; label: string; icon: string }): JSX.Element {
  return (
    <Link
      to={props.to}
      className="rounded px-3 py-2 text-sm"
      activeProps={{ className: 'bg-panel-2 text-em' }}
      inactiveProps={{ className: 'text-ink-dim hover:bg-panel-2 hover:text-ink' }}
      activeOptions={{ exact: props.to === '/' }}
    >
      <span className="mr-2 inline-block w-5 text-center font-mono">{props.icon}</span>
      {props.label}
    </Link>
  )
}

export function Sidebar(): JSX.Element {
  const unread = useNotifications((s) => s.unread)
  const markAllRead = useNotifications((s) => s.markAllRead)
  const navigate = useNavigate()

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel/80">
      <div className="flex items-center gap-2 px-4 py-4">
        <DenBot className="size-7" />
        <span className="font-mono text-sm font-semibold tracking-wide text-em">RivetHub</span>
        {/* Unread escalations/outcomes — toasts are ephemeral, this isn't.
            Click = jump to Tasks (the durable record) and mark read. */}
        {unread > 0 && (
          <button
            type="button"
            onClick={() => {
              markAllRead()
              void navigate({ to: '/tasks' })
            }}
            title={`${String(unread)} unread notification${unread === 1 ? '' : 's'}`}
            aria-label={`${String(unread)} unread notifications`}
            className="ml-auto flex items-center gap-1 rounded-full border border-red/50 bg-red/10 px-2 py-0.5 font-mono text-[11px] text-red hover:bg-red/20"
          >
            <Bell className="size-3" />
            {unread > 99 ? '99+' : unread}
          </button>
        )}
      </div>

      <nav className="flex flex-col gap-1 px-2">
        {PRIMARY_NAV.map((item) => (
          <NavLink key={item.to} {...item} />
        ))}

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
