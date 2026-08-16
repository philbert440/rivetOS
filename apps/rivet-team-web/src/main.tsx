import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import './theme.css'

import { StrictMode, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setGateway } from './lib/gateway.js'
import { createStubGateway } from './lib/stub-gateway.js'
import { loadSession, type TeamSession } from './lib/users.js'
import { bootTeam } from './stores/team.js'
import { TeamPage } from './pages/team.js'
import { UserGate } from './components/user-gate.js'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
})

// Chat turns stay on the stub this slice. User roster tries /api/team first.
setGateway(createStubGateway({ baseUrl: 'http://127.0.0.1:5174' }))

function Root(): JSX.Element {
  const [session, setSession] = useState<TeamSession | null>(() => loadSession())
  if (!session) {
    return <UserGate onReady={(next) => {
      bootTeam(next.user)
      setSession(next)
    }} />
  }
  return <TeamPage />
}

bootTeam(loadSession()?.user)

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root element')

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
)
