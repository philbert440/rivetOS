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
import { DensPage } from './pages/dens.js'
import { FilesPage } from './pages/files.js'
import { MemoryPage, MemoryTopicPage } from './pages/memory.js'
import { SettingsPage } from './pages/settings.js'
import { TerminalPage } from './pages/terminal.js'
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
  const connectNotifications = useNotifications((s) => s.connect)

  // App-lifetime notifications socket (escalations etc.) — root-level so
  // toasts fire on any page.
  useEffect(() => {
    connectNotifications(baseUrl)
    return () => useNotifications.getState().disconnect()
  }, [baseUrl, connectNotifications])

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
  component: ChatPage,
})

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/terminal',
  component: TerminalPage,
})

const densRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dens',
  component: DensPage,
})

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/memory',
  component: MemoryPage,
})

const memoryTopicRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/memory/$slug',
  component: MemoryTopicPage,
})

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/files',
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
  terminalRoute,
  densRoute,
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
