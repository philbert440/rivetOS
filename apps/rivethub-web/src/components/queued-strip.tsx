import type { JSX } from 'react'
import type { OutboundItem } from '../stores/chat.js'

/**
 * Mid-turn outbound queue — sits under the live bubble / above the composer.
 * Queued turns are NOT history: inject steers now, cancel recalls into the
 * composer.
 */
export function QueuedStrip(props: {
  items: OutboundItem[]
  onInject: (id: string) => void
  onCancel: (id: string) => void
}): JSX.Element | null {
  const queued = props.items.filter((o) => o.status === 'queued')
  if (queued.length === 0) return null
  return (
    <div className="border-t border-line bg-panel-2/40 px-4 py-1.5">
      <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
        {queued.map((item) => (
          <div key={item.id} className="flex items-start gap-2 font-mono text-[11px] text-ink-dim">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">
              {item.text}
            </span>
            <button
              type="button"
              onClick={() => props.onInject(item.id)}
              className="shrink-0 text-em hover:underline"
              title="Inject this message into the harness now"
            >
              inject
            </button>
            <button
              type="button"
              onClick={() => props.onCancel(item.id)}
              className="shrink-0 text-ink-dim hover:text-red hover:underline"
              title="Return to composer"
            >
              cancel
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
