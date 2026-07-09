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
import { SettingsPage } from './pages/settings.js'
import { TerminalPage } from './pages/terminal.js'
import { TaskDetailPage, TasksPage } from './pages/tasks.js'
import { useConnection } from './stores/connection.js'
import { useNotifications } from './stores/notifications.js'

function RootLayout(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)
  const connectNotifications = useNotifications((s) => s.connect)

  // App-lifetime notifications socket (escalations etc.) — root-level so
  // toasts fire on any page.
  useEffect(() => {
    connectNotifications(`${baseUrl}|${token ?? ''}`)
    return () => useNotifications.getState().disconnect()
  }, [baseUrl, token, connectNotifications])

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

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

export const routeTree = rootRoute.addChildren([
  chatRoute,
  terminalRoute,
  filesRoute,
  tasksRoute,
  taskDetailRoute,
  settingsRoute,
])
