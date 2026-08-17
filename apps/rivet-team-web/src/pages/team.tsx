import { useEffect, useState, type JSX } from 'react'
import { Sidebar } from '../components/sidebar.js'
import { Thread } from '../components/thread.js'
import { Composer } from '../components/composer.js'
import { useTeam } from '../stores/team.js'

function useWide(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = (): void => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return wide
}

export function TeamPage(): JSX.Element {
  const selectedId = useTeam((s) => s.selectedId)
  const selectPersona = useTeam((s) => s.selectPersona)
  const wide = useWide()

  useEffect(() => {
    const onPop = (): void => {
      useTeam.getState().selectPersona(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (!selectedId) return
    if (window.history.state?.chat !== selectedId) {
      window.history.pushState({ chat: selectedId }, '')
    }
  }, [selectedId])

  const backToRoster = (): void => {
    selectPersona(null)
    if (window.history.state?.chat) window.history.back()
  }

  if (!wide) {
    if (!selectedId) return <Sidebar />
    return (
      <main className="flex h-full min-h-0 flex-1 flex-col bg-app">
        <Thread onBack={backToRoster} />
        <Composer />
      </main>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <Sidebar />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        <Thread />
        <Composer />
      </main>
    </div>
  )
}
