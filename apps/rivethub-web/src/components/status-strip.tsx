import type { JSX } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useConnection } from '../stores/connection.js'
import { useNotifications } from '../stores/notifications.js'
import { hubPageTitle, nodeLabel } from './sidebar-chrome.js'

/**
 * Desktop status strip — a Waybar-style row above the tiles: where you are on
 * the left; what needs you and the node on the right. Replaces the
 * unread pill that used to sit in the rail header (the narrow drawer keeps
 * that pill, as there is no strip on the phone).
 */
export function StatusStrip(): JSX.Element {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const unread = useNotifications((s) => s.unread)
  const markAllRead = useNotifications((s) => s.markAllRead)
  const baseUrl = useConnection((s) => s.baseUrl)
  const roster = useConnection((s) => s.roster)

  return (
    <header className="flex h-[30px] shrink-0 items-center gap-4 border-b border-line bg-panel px-3 font-mono text-xs">
      <span className="mr-auto text-ink">{hubPageTitle(pathname).toLowerCase()}</span>
      {unread > 0 && (
        <button
          type="button"
          onClick={() => {
            markAllRead()
            void navigate({ to: '/tasks' })
          }}
          aria-label={`${String(unread)} unread notifications`}
          className="text-red hover:underline"
        >
          ! {unread > 99 ? '99+' : unread} need you
        </button>
      )}
      <span className="text-em" title={baseUrl || undefined}>
        ● {nodeLabel(baseUrl, roster)}
      </span>
    </header>
  )
}
