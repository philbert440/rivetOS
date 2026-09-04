/**
 * Code-based route tree (no file-routing plugin — keeps the vite config
 * boring). Layout mirrors rivet-android's IA scaled to desktop: ChatDrawer
 * becomes the persistent sidebar; pages land in 4d-4h.
 */

import { useEffect, useLayoutEffect, useRef, type JSX } from 'react'
import {
  Outlet,
  createRootRoute,
  createRoute,
  redirect,
  useRouterState,
} from '@tanstack/react-router'
import { MobileTopBar, Sidebar } from './components/sidebar.js'
import { Toasts } from './components/toasts.js'
import { EdgeSwipeTracker } from './lib/edge-swipe.js'
import { showMobileTopBar } from './lib/session-header.js'
import { useIsNarrow } from './lib/use-narrow.js'
import { useSidebarPrefs } from './stores/sidebar-prefs.js'
import { ChatPage } from './pages/chat.js'
import { FilesPage } from './pages/files.js'
import { MemoryHubPage } from './memory/MemoryHubPage.js'
import { MemoryTopicPage } from './pages/memory.js'
import { SettingsPage } from './pages/settings.js'
import { TaskDetailPage, TasksPage } from './pages/tasks.js'
import {
  WorkflowRunDetailPage,
  WorkflowsHubPage,
  WorkflowTriggerPage,
} from './pages/workflows-hub.js'
import { useChat } from './stores/chat.js'
import { useConnection } from './stores/connection.js'
import { useNotifications } from './stores/notifications.js'

function RootLayout(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  // Desktop mTLS (#491): rebind when the gateway swaps onto the loopback
  // identity pipe (baseUrl unchanged) — see connection.ts transportEpoch.
  const transportEpoch = useConnection((s) => s.transportEpoch)
  const connectNotifications = useNotifications((s) => s.connect)
  const railCollapsed = useSidebarPrefs((s) => s.railCollapsed)
  const drawerOpen = useSidebarPrefs((s) => s.drawerOpen)
  const setDrawerOpen = useSidebarPrefs((s) => s.setDrawerOpen)
  const historyOpen = useSidebarPrefs((s) => s.historyOpen)
  const setHistoryOpen = useSidebarPrefs((s) => s.setHistoryOpen)
  const narrow = useIsNarrow()
  const active = useChat((s) => s.active)
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  })
  const locKey = useRouterState({
    select: (s) => s.location.href,
  })
  const wasDrawerOpen = useRef(drawerOpen)
  const wasHistoryOpen = useRef(historyOpen)
  // Narrow with a session open: the one-row session header owns the top of
  // the screen — the wordmark bar is not shown (Phil 2026-09-03).
  const sessionOpen = pathname === '/' && active !== undefined

  // App-lifetime notifications socket (escalations etc.) — root-level so
  // toasts fire on any page.
  useEffect(() => {
    connectNotifications(baseUrl)
    return () => useNotifications.getState().disconnect()
  }, [baseUrl, transportEpoch, connectNotifications])

  // Off-canvas rail: close on route change AND on session change. Draft
  // sessions never write the URL, so href alone misses agent taps and
  // Conversations-from-draft. The history drawer rides the same rule (a
  // session switch from its own rows closes it via shouldCloseHistoryOnSelect
  // before this fires; this catches every other path).
  useEffect(() => {
    useSidebarPrefs.getState().setDrawerOpen(false)
    useSidebarPrefs.getState().setHistoryOpen(false)
  }, [locKey, active])

  useLayoutEffect(() => {
    const wasOpen = wasDrawerOpen.current
    wasDrawerOpen.current = drawerOpen
    if (drawerOpen && !wasOpen) {
      document.getElementById('hub-rail')?.focus()
    } else if (!drawerOpen && wasOpen) {
      document.getElementById('hub-rail-toggle')?.focus()
    }
  }, [drawerOpen])

  useLayoutEffect(() => {
    const wasOpen = wasHistoryOpen.current
    wasHistoryOpen.current = historyOpen
    if (historyOpen && !wasOpen) {
      document.getElementById('hub-history')?.focus()
    } else if (!historyOpen && wasOpen) {
      document.getElementById('hub-history-toggle')?.focus()
    }
  }, [historyOpen])

  useEffect(() => {
    if (!drawerOpen && !historyOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setDrawerOpen(false)
      setHistoryOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen, historyOpen, setDrawerOpen, setHistoryOpen])

  // Edge swipes own horizontal gestures on narrow (Phil 2026-09-03): left
  // bezel → navigation drawer from EVERY screen; right bezel → history
  // (conversations) drawer while a session is open.
  useEffect(() => {
    if (!narrow) return
    const tracker = new EdgeSwipeTracker()
    const onDown = (e: PointerEvent): void => tracker.down(e.clientX, e.clientY, window.innerWidth)
    const onMove = (e: PointerEvent): void => {
      const side = tracker.move(e.clientX, e.clientY)
      if (side === 'left') useSidebarPrefs.getState().setDrawerOpen(true)
      else if (side === 'right' && sessionOpen) useSidebarPrefs.getState().setHistoryOpen(true)
    }
    const onUp = (): void => tracker.up()
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [narrow, sessionOpen])

  return (
    <div
      className="flex h-full"
      style={{
        ['--hub-rail' as string]: narrow ? '0rem' : railCollapsed ? '3rem' : '14rem',
      }}
    >
      <Sidebar />
      {narrow && drawerOpen && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden={true}
          aria-label="Close sidebar"
          className="fixed inset-0 z-30 bg-bg/70"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        inert={narrow && drawerOpen ? true : undefined}
      >
        {showMobileTopBar(narrow, sessionOpen) && <MobileTopBar />}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <Toasts />
    </div>
  )
}

const rootRoute = createRootRoute({
  component: RootLayout,
})

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): { session?: string } => ({
    session: typeof search.session === 'string' && search.session ? search.session : undefined,
  }),
  component: ChatPage,
})

/** Electron shells before this fix loaded /index.html; keep the old path reaching chat. */
const indexHtmlRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/index.html',
  beforeLoad: ({ search }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects by throwing a Redirect, not an Error
    throw redirect({ to: '/', search })
  },
})

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/memory',
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: 'search' | 'wiki' | 'browse' | 'stats' } => {
    const tab = search.tab
    if (tab === 'search' || tab === 'wiki' || tab === 'browse' || tab === 'stats') {
      return { tab }
    }
    return {}
  },
  component: MemoryHubPage,
})

const memoryTopicRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/memory/$slug',
  component: MemoryTopicPage,
})

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/files',
  validateSearch: (search: Record<string, unknown>): { path?: string } => ({
    path: typeof search.path === 'string' && search.path ? search.path : undefined,
  }),
  component: FilesPage,
})

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks',
  component: TasksPage,
})

const taskDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$taskId',
  component: TaskDetailPage,
})

/** Slice C front door — defs + recent runs. */
const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows',
  component: WorkflowsHubPage,
})

/** Contract trigger form for a workflow def.
 *  Known edge: the param segment shadows def ids literally named `runs` or
 *  `canvas` (static routes rank higher) — don't name workflow defs that. */
const workflowTriggerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows/$workflowId',
  component: WorkflowTriggerPage,
})

/** Run detail — journal, gate, kill. Must be registered before $workflowId
 *  only if paths conflict; /workflows/runs/$runId is distinct from $workflowId. */
const workflowRunDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows/runs/$runId',
  component: WorkflowRunDetailPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

export const routeTree = rootRoute.addChildren([
  chatRoute,
  indexHtmlRoute,
  memoryRoute,
  memoryTopicRoute,
  filesRoute,
  tasksRoute,
  taskDetailRoute,
  // More specific workflow paths first so they win over $workflowId.
  workflowRunDetailRoute,
  workflowsRoute,
  workflowTriggerRoute,
  settingsRoute,
])
