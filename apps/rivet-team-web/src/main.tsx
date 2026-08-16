import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import './theme.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setGateway } from './lib/gateway.js'
import { createStubGateway } from './lib/stub-gateway.js'
import { bootTeam } from './stores/team.js'
import { TeamPage } from './pages/team.js'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
})

// This slice: stub. Later: setGateway(new RivetGateway({ baseUrl })).
setGateway(createStubGateway({ baseUrl: 'http://127.0.0.1:5174' }))
bootTeam()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root element')

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TeamPage />
    </QueryClientProvider>
  </StrictMode>,
)
