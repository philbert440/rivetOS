import type { JSX } from 'react'
export function PlaceholderPage(props: { title: string; phase: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <div className="text-lg text-ink-dim">{props.title}</div>
      <div className="font-mono text-xs text-ink-dim">lands in phase {props.phase}</div>
    </div>
  )
}
