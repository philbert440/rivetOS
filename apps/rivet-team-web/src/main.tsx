import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import './omb/styles.css'

import { StrictMode, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setGateway } from './lib/gateway.js'
import { createStubGateway } from './lib/stub-gateway.js'
import { loadSession, type TeamSession } from './lib/users.js'
import { bootTeam } from './stores/team.js'
import { UserGate } from './components/user-gate.js'
import App from './omb/App.js'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
})

setGateway(createStubGateway({ baseUrl: 'http://127.0.0.1:5174' }))

function Root(): JSX.Element {
  const [session, setSession] = useState<TeamSession | null>(() => loadSession())
  if (!session) {
    return (
      <UserGate
        onReady={(next) => {
          void bootTeam(next.user, next.deviceToken).then(() => setSession(next))
        }}
      />
    )
  }
  return <App />
}

const existing = loadSession()
void bootTeam(existing?.user, existing?.deviceToken)

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root element')

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
)
