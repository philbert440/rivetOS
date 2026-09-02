import type { JSX } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { Bell, Folder, Library, ListChecks, MessageSquare, Settings, Workflow } from 'lucide-react'
import { useNotifications } from '../stores/notifications.js'
import { useSidebarPrefs } from '../stores/sidebar-prefs.js'
import { cn } from '../lib/utils.js'
import { railHeaderClass, railToggle } from './sidebar-chrome.js'
import { NodeSwitcher } from './node-switcher.js'
import { DenBot } from './den-bot.js'
import { AgentsSection } from './agents-section.js'
import { Button } from './ui/button.js'
import { Tooltip } from './ui/tooltip.js'

/** Primary views after Conversations — Memory and Files as the day-to-day
 *  workspace. The standalone Terminal / Den pages are gone: chat embeds both
 *  as per-session modes, which is the only entry. Lucide icons match the
 *  TenPAL rail. */
const PRIMARY_NAV = [
  { to: '/memory', label: 'Memory', icon: Library },
  { to: '/files', label: 'Files', icon: Folder },
] as const

/** Ops tools — below the separator. */
const SECONDARY_NAV = [
  { to: '/tasks', label: 'Tasks', icon: ListChecks },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
] as const

const SETTINGS = { to: '/settings', label: 'Settings', icon: Settings } as const

function navClass(active: boolean, collapsed: boolean): string {
  return cn(
    'flex w-full items-center rounded text-sm',
    collapsed ? 'justify-center px-0 py-2' : 'px-3 py-2',
    active ? 'bg-panel-2 text-em' : 'text-ink-dim hover:bg-panel-2 hover:text-ink',
  )
}

function NavLink(props: {
  to: string
  label: string
  icon: typeof MessageSquare
  collapsed: boolean
}): JSX.Element {
  const Icon = props.icon
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active =
    props.to === '/'
      ? pathname === '/'
      : pathname === props.to || pathname.startsWith(`${props.to}/`)
  return (
    <Tooltip label={props.label} disabled={!props.collapsed} block>
      <Link
        to={props.to}
        aria-label={props.label}
        className={navClass(active, props.collapsed)}
        activeOptions={{ exact: props.to === '/' }}
      >
        <Icon className={cn('size-4 shrink-0', !props.collapsed && 'mr-2')} aria-hidden />
        {!props.collapsed && props.label}
      </Link>
    </Tooltip>
  )
}

function ConversationsNav(props: { collapsed: boolean }): JSX.Element {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const onChat = pathname === '/'
  const paneHidden = useSidebarPrefs((s) => s.conversationsCollapsed)
  const setConversationsCollapsed = useSidebarPrefs((s) => s.setConversationsCollapsed)

  return (
    <Tooltip label="Conversations" disabled={!props.collapsed} block>
      <button
        type="button"
        aria-label="Conversations"
        aria-expanded={onChat ? !paneHidden : undefined}
        aria-controls={onChat ? 'conversations-pane' : undefined}
        className={navClass(onChat, props.collapsed)}
        onClick={() => {
          if (!onChat) {
            useSidebarPrefs.getState().openConversation()
            void navigate({ to: '/' })
            return
          }
          setConversationsCollapsed(!paneHidden)
        }}
      >
        <MessageSquare className={cn('size-4 shrink-0', !props.collapsed && 'mr-2')} aria-hidden />
        {!props.collapsed && <span className="min-w-0 truncate">Conversations</span>}
      </button>
    </Tooltip>
  )
}

export function Sidebar(): JSX.Element {
  const unread = useNotifications((s) => s.unread)
  const markAllRead = useNotifications((s) => s.markAllRead)
  const navigate = useNavigate()
  const railCollapsed = useSidebarPrefs((s) => s.railCollapsed)
  const setRailCollapsed = useSidebarPrefs((s) => s.setRailCollapsed)
  const toggle = railToggle(railCollapsed)

  return (
    <aside
      id="hub-rail"
      className={cn(
        'relative z-20 flex shrink-0 flex-col border-r border-line bg-panel/80 transition-[width] duration-150',
        railCollapsed ? 'w-12' : 'w-56',
      )}
    >
      <div className={railHeaderClass(railCollapsed)}>
        <Tooltip label={toggle.label}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={toggle.label}
            aria-expanded={toggle.ariaExpanded}
            aria-controls="hub-rail-nav"
            onClick={() => setRailCollapsed(!railCollapsed)}
            className="size-7 shrink-0 p-0"
          >
            <DenBot className="size-7 shrink-0" decorative />
          </Button>
        </Tooltip>
        {!railCollapsed && (
          <span className="font-mono text-sm font-semibold tracking-wide text-em">RivetHub</span>
        )}
        {/* Unread escalations/outcomes — toasts are ephemeral, this isn't.
            Click = jump to Tasks (the durable record) and mark read. */}
        {unread > 0 && (
          <span className={railCollapsed ? 'absolute left-7 top-3' : 'ml-auto'}>
            <Tooltip label={`${String(unread)} unread notifications`} disabled={!railCollapsed}>
              <button
                type="button"
                onClick={() => {
                  markAllRead()
                  void navigate({ to: '/tasks' })
                }}
                aria-label={`${String(unread)} unread notifications`}
                className={cn(
                  'flex items-center gap-1 rounded-full border border-red/50 bg-red/10 font-mono text-[11px] text-red hover:bg-red/20',
                  railCollapsed ? 'size-4 justify-center px-0' : 'px-2 py-0.5',
                )}
              >
                <Bell className="size-3" />
                {!railCollapsed && (unread > 99 ? '99+' : unread)}
              </button>
            </Tooltip>
          </span>
        )}
      </div>

      <nav id="hub-rail-nav" className={cn('flex flex-col gap-1', railCollapsed ? 'px-1' : 'px-2')}>
        <ConversationsNav collapsed={railCollapsed} />
        {PRIMARY_NAV.map((item) => (
          <NavLink key={item.to} {...item} collapsed={railCollapsed} />
        ))}

        <div className="my-2 border-t border-line" role="separator" />

        {SECONDARY_NAV.map((item) => (
          <NavLink key={item.to} {...item} collapsed={railCollapsed} />
        ))}
      </nav>

      <AgentsSection compact={railCollapsed} />

      <div className="mt-auto flex flex-col">
        <div className={cn('flex flex-col gap-1 pb-1', railCollapsed ? 'px-1' : 'px-2')}>
          <NavLink {...SETTINGS} collapsed={railCollapsed} />
        </div>
        <NodeSwitcher compact={railCollapsed} />
      </div>
    </aside>
  )
}
