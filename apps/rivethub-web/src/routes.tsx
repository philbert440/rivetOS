/**
 * Code-based route tree (no file-routing plugin — keeps the vite config
 * boring). Layout mirrors rivet-android's IA scaled to desktop: ChatDrawer
 * becomes the persistent sidebar; pages land in 4d-4h.
 */

import { useEffect, type JSX } from 'react'
import { Outlet, createRootRoute, createRoute } from '@tanstack/react-router'
import { Sidebar } from './components/sidebar.js'
import { Toasts } from './components/toasts.js'
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
import { useConnection } from './stores/connection.js'
import { useNotifications } from './stores/notifications.js'

function RootLayout(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  // Desktop mTLS (#491): rebind when the gateway swaps onto the loopback
  // identity pipe (baseUrl unchanged) — see connection.ts transportEpoch.
  const transportEpoch = useConnection((s) => s.transportEpoch)
  const connectNotifications = useNotifications((s) => s.connect)

  // App-lifetime notifications socket (escalations etc.) — root-level so
  // toasts fire on any page.
  useEffect(() => {
    connectNotifications(baseUrl)
    return () => useNotifications.getState().disconnect()
  }, [baseUrl, transportEpoch, connectNotifications])

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
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
