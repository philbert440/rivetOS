import type { JSX } from 'react'
import { Sidebar } from '../components/sidebar.js'
import { Thread } from '../components/thread.js'
import { Composer } from '../components/composer.js'

export function TeamPage(): JSX.Element {
  return (
    <div className="flex h-full min-h-0">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-bg/80">
        <Thread />
        <Composer />
      </main>
    </div>
  )
}
