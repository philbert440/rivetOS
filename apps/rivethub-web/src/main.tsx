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
import { applyBootNodeParam } from './lib/boot-node-param.js'
import { installClipboardBridge } from './lib/clipboard.js'
import { maybeRedirectToRemoteUi } from './lib/remote-ui.js'
import { tokenFor, useConnection } from './stores/connection.js'

// Selection copy (Ctrl/Cmd+C, context menu) must ride Tauri/Android IPC on
// shells where the WebView's native clipboard is broken or absent.
installClipboardBridge()

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
// 1) Adopt last-active remote into the gateway (repoint only).
// 2) Honor ?node= / ?token= (Android drawer deep-link).
// 3) Mount React.
void maybeRedirectToRemoteUi((baseUrl) => {
  const { baseUrl: current, setConnection } = useConnection.getState()
  // Preserve any saved bearer for this node (setConnection clears when token omitted).
  if (!current) setConnection(baseUrl, tokenFor(baseUrl))
}).then(() => {
  applyBootNodeParam({
    setConnection: (url, token) => useConnection.getState().setConnection(url, token),
    addNode: (node) => useConnection.getState().addNode(node),
    tokenFor,
  })
  createRoot(rootEl).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  )
})
