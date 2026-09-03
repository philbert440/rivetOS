import type { JSX } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { Bell, Folder, Library, ListChecks, MessageSquare, Settings, Workflow } from 'lucide-react'
import { useNotifications } from '../stores/notifications.js'
import { useChat } from '../stores/chat.js'
import { useSidebarPrefs } from '../stores/sidebar-prefs.js'
import { shouldCloseDrawerOnSelection } from '../lib/drawer-selection.js'
import { useIsNarrow } from '../lib/use-narrow.js'
import { cn } from '../lib/utils.js'
import { hubPageTitle, railHeaderClass, railToggle } from './sidebar-chrome.js'
import { NodeSwitcher } from './node-switcher.js'
import { DenBot } from './den-bot.js'
import { AgentsSection } from './agents-section.js'
import { Button } from './ui/button.js'
import { Tooltip } from './ui/tooltip.js'

/** Primary views after Conversations — Memory and Files as the day-to-day
 *  workspace. The standalone Terminal page is gone: chat embeds terminal as a
 *  per-session mode, which is the only entry. Lucide icons match the
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
  const narrow = useIsNarrow()
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
        onClick={() => {
          if (shouldCloseDrawerOnSelection(narrow)) {
            useSidebarPrefs.getState().setDrawerOpen(false)
          }
        }}
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
  const narrow = useIsNarrow()

  return (
    <Tooltip label="Conversations" disabled={!props.collapsed} block>
      <button
        type="button"
        aria-label="Conversations"
        aria-expanded={!narrow && onChat ? !paneHidden : undefined}
        aria-controls={!narrow && onChat ? 'conversations-pane' : undefined}
        className={navClass(onChat, props.collapsed)}
        onClick={() => {
          if (narrow) {
            useSidebarPrefs.getState().openConversation()
            if (shouldCloseDrawerOnSelection(narrow)) {
              useSidebarPrefs.getState().setDrawerOpen(false)
            }
            useChat.getState().setActive(undefined)
            void navigate({ to: '/', search: {} })
            return
          }
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

/** Narrow top bar — DenBot opens the rail drawer (same affordance as desktop). */
export function MobileTopBar(): JSX.Element {
  const unread = useNotifications((s) => s.unread)
  const markAllRead = useNotifications((s) => s.markAllRead)
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const drawerOpen = useSidebarPrefs((s) => s.drawerOpen)
  const setDrawerOpen = useSidebarPrefs((s) => s.setDrawerOpen)

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel/80 px-3">
      <Button
        variant="ghost"
        size="icon"
        id="hub-rail-toggle"
        aria-label="Open sidebar"
        aria-controls="hub-rail"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="size-11 shrink-0 p-0"
      >
        <DenBot className="size-7 shrink-0" decorative />
      </Button>
      <span className="min-w-0 truncate font-mono text-sm text-em">{hubPageTitle(pathname)}</span>
      {unread > 0 && (
        <span className="ml-auto">
          <button
            type="button"
            onClick={() => {
              markAllRead()
              void navigate({ to: '/tasks' })
            }}
            aria-label={`${String(unread)} unread notifications`}
            className={cn(
              'relative flex items-center gap-1 rounded-full border border-red/50 bg-red/10 px-2 py-0.5',
              "font-mono text-[11px] text-red hover:bg-red/20 after:absolute after:-inset-2 after:content-['']",
            )}
          >
            <Bell className="size-3" />
            {unread > 99 ? '99+' : unread}
          </button>
        </span>
      )}
    </div>
  )
}

export function Sidebar(): JSX.Element {
  const unread = useNotifications((s) => s.unread)
  const markAllRead = useNotifications((s) => s.markAllRead)
  const navigate = useNavigate()
  const narrow = useIsNarrow()
  const railCollapsed = useSidebarPrefs((s) => s.railCollapsed)
  const setRailCollapsed = useSidebarPrefs((s) => s.setRailCollapsed)
  const drawerOpen = useSidebarPrefs((s) => s.drawerOpen)
  const setDrawerOpen = useSidebarPrefs((s) => s.setDrawerOpen)
  // Narrow always uses the expanded rail — never the 48px icon strip.
  const collapsed = narrow ? false : railCollapsed
  const toggle = railToggle(collapsed)
  const logoLabel = narrow ? (drawerOpen ? 'Close sidebar' : 'Open sidebar') : toggle.label
  const logoExpanded = narrow ? drawerOpen : toggle.ariaExpanded

  return (
    <aside
      id="hub-rail"
      role={narrow ? 'dialog' : undefined}
      aria-modal={narrow && drawerOpen ? true : undefined}
      aria-label={narrow ? 'Navigation' : undefined}
      tabIndex={narrow ? -1 : undefined}
      inert={narrow && !drawerOpen ? true : undefined}
      className={
        narrow
          ? cn(
              'fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-line bg-panel/80',
              'transition-transform duration-150 motion-reduce:transition-none',
              drawerOpen ? 'translate-x-0' : '-translate-x-full',
            )
          : cn(
              'relative z-20 flex shrink-0 flex-col border-r border-line bg-panel/80 transition-[width] duration-150',
              collapsed ? 'w-12' : 'w-56',
            )
      }
    >
      <div className={railHeaderClass(collapsed)}>
        <Tooltip label={logoLabel}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={logoLabel}
            aria-expanded={logoExpanded}
            aria-controls="hub-rail-nav"
            onClick={() => {
              if (narrow) setDrawerOpen(!drawerOpen)
              else setRailCollapsed(!railCollapsed)
            }}
            className={cn('shrink-0 p-0', narrow ? 'size-11' : 'size-7')}
          >
            <DenBot className="size-7 shrink-0" decorative />
          </Button>
        </Tooltip>
        {!collapsed && (
          <span className="font-mono text-sm font-semibold tracking-wide text-em">RivetHub</span>
        )}
        {/* Unread escalations/outcomes — toasts are ephemeral, this isn't.
            Click = jump to Tasks (the durable record) and mark read. */}
        {unread > 0 && (
          <span className={collapsed ? 'absolute left-7 top-3' : 'ml-auto'}>
            <Tooltip label={`${String(unread)} unread notifications`} disabled={!collapsed}>
              <button
                type="button"
                onClick={() => {
                  markAllRead()
                  if (shouldCloseDrawerOnSelection(narrow)) {
                    useSidebarPrefs.getState().setDrawerOpen(false)
                  }
                  void navigate({ to: '/tasks' })
                }}
                aria-label={`${String(unread)} unread notifications`}
                className={cn(
                  'relative flex items-center gap-1 rounded-full border border-red/50',
                  'bg-red/10 font-mono text-[11px] text-red hover:bg-red/20',
                  collapsed
                    ? 'size-4 justify-center px-0'
                    : "px-2 py-0.5 after:absolute after:-inset-2 after:content-['']",
                )}
              >
                <Bell className="size-3" />
                {!collapsed && (unread > 99 ? '99+' : unread)}
              </button>
            </Tooltip>
          </span>
        )}
      </div>

      <nav id="hub-rail-nav" className={cn('flex flex-col gap-1', collapsed ? 'px-1' : 'px-2')}>
        <ConversationsNav collapsed={collapsed} />
        {PRIMARY_NAV.map((item) => (
          <NavLink key={item.to} {...item} collapsed={collapsed} />
        ))}

        <div className="my-2 border-t border-line" role="separator" />

        {SECONDARY_NAV.map((item) => (
          <NavLink key={item.to} {...item} collapsed={collapsed} />
        ))}
      </nav>

      <AgentsSection compact={collapsed} />

      <div className="mt-auto flex flex-col">
        <div className={cn('flex flex-col gap-1 pb-1', collapsed ? 'px-1' : 'px-2')}>
          <NavLink {...SETTINGS} collapsed={collapsed} />
        </div>
        <NodeSwitcher compact={collapsed} />
      </div>
    </aside>
  )
}
