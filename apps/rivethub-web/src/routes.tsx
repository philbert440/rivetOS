/**
 * Code-based route tree (no file-routing plugin — keeps the vite config
 * boring). Layout mirrors rivet-android's IA scaled to desktop: ChatDrawer
 * becomes the persistent sidebar; pages land in 4d-4h.
 */

import { Outlet, createRootRoute, createRoute } from '@tanstack/react-router'
import { Sidebar } from './components/sidebar.js'
import { ChatPage } from './pages/chat.js'
import { SettingsPage } from './pages/settings.js'
import { PlaceholderPage } from './pages/placeholder.js'

const rootRoute = createRootRoute({
  component: () => (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  ),
})

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ChatPage,
})

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/terminal',
  component: () => <PlaceholderPage title="Terminal" phase="4f" />,
})

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks',
  component: () => <PlaceholderPage title="Tasks" phase="4g" />,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

export const routeTree = rootRoute.addChildren([
  chatRoute,
  terminalRoute,
  tasksRoute,
  settingsRoute,
])
