import type { JSX } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useConnection } from '../stores/connection.js'
import { useNotifications } from '../stores/notifications.js'
import { useTheme } from '../stores/theme.js'
import { hubPageTitle, nodeLabel, themeLabel } from './sidebar-chrome.js'

/**
 * Desktop status strip — a Waybar-style row above the tiles: where you are on
 * the left; theme, what needs you and the node on the right. Replaces the
 * unread pill that used to sit in the rail header (the narrow drawer keeps
 * that pill, as there is no strip on the phone).
 */
export function StatusStrip(): JSX.Element {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const unread = useNotifications((s) => s.unread)
  const markAllRead = useNotifications((s) => s.markAllRead)
  const preference = useTheme((s) => s.preference)
  const omarchyName = useTheme((s) => s.omarchy?.name)
  const baseUrl = useConnection((s) => s.baseUrl)
  const roster = useConnection((s) => s.roster)

  return (
    <header className="flex h-[30px] shrink-0 items-center gap-4 border-b border-line bg-panel px-3 font-mono text-xs">
      <span className="text-ink">{hubPageTitle(pathname).toLowerCase()}</span>
      <span className="ml-auto text-ink-dim">
        theme <span className="text-ink">{themeLabel(preference, omarchyName)}</span>
      </span>
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
