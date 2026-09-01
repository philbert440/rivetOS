import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import './theme.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routes.js'
// Applies data-theme (and persists the Settings toggle) — import for the
// side effect before first render.
import './stores/theme.js'
import { applyBootNodeParam } from './lib/boot-node-param.js'
import { installClipboardBridge } from './lib/clipboard.js'
import { installShellKeys } from './lib/shell-keys.js'
import { hydrateSettingsIfEmpty, installSettingsSync } from './lib/settings-sync.js'
import { adoptStoredRemoteUi } from './lib/remote-ui.js'
import { useConnection } from './stores/connection.js'

// Selection copy (Ctrl/Cmd+C, context menu) must ride Tauri/Android IPC on
// shells where the WebView's native clipboard is broken or absent.
installClipboardBridge()
installShellKeys()

// Settings persistence: hydrate localStorage from the Electron shell's
// settings.json on boot if Chromium store is empty, and install write hooks
// to persist back to the file. Survives Linux updates wiping localStorage.
installSettingsSync()

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
})

const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root element')

// Boot: never leave the local/bundled dist for a remote node's UI.
// 1) Hydrate settings from the shell's JSON file if localStorage is empty.
// 2) Adopt last-active remote into the gateway (repoint only).
// 3) Honor ?node= (Android drawer deep-link). Auth is device mTLS.
// 4) Mount React.
void hydrateSettingsIfEmpty()
  .then(() =>
    adoptStoredRemoteUi((baseUrl) => {
      const { baseUrl: current, setConnection } = useConnection.getState()
      if (!current) setConnection(baseUrl)
    }),
  )
  .then(() => {
    applyBootNodeParam({
      setConnection: (url) => useConnection.getState().setConnection(url),
      addNode: (node) => useConnection.getState().addNode(node),
    })
    createRoot(rootEl).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    )
  })
