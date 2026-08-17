import type { CSSProperties, JSX } from 'react'
import denBotUrl from '../assets/den-bot.png'
import { cn } from '../lib/utils.js'

/** Rivet den-bot sprite — household face. Not the OpenMausBot cursor mascot. */
export function DenBot(props: {
  className?: string
  title?: string
  style?: CSSProperties
  decorative?: boolean
}): JSX.Element {
  return (
    <img
      src={denBotUrl}
      alt={props.decorative ? '' : 'Rivet'}
      aria-hidden={props.decorative || undefined}
      title={props.title}
      draggable={false}
      style={props.style}
      className={cn('select-none object-contain [image-rendering:pixelated]', props.className)}
    />
  )
}

const ACCENTS = ['#34d399', '#1084fe', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c']

export function personaAccent(id: string): string {
  if (id.includes('research')) return '#34d399'
  if (id.includes('summarizer')) return '#1084fe'
  if (id.includes('informatics')) return '#fbbf24'
  let n = 0
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0
  return ACCENTS[n % ACCENTS.length]
}

export function PersonaFace(props: {
  personaId: string
  size?: number
  title?: string
}): JSX.Element {
  const size = props.size ?? 40
  const accent = personaAccent(props.personaId)
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      title={props.title}
    >
      <span
        className="absolute inset-0 rounded-full"
        style={{ boxShadow: `inset 0 0 0 2px ${accent}` }}
        aria-hidden
      />
      <DenBot className="size-[70%]" decorative />
    </span>
  )
}
