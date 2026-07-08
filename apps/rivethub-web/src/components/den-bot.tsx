import type { JSX } from 'react'
import denBotUrl from '../assets/den-bot.png'
import { cn } from '../lib/utils.js'

/**
 * The Rivet den bot — the pixel-art character from the default den pack
 * (idle pose). This is Rivet's face across RivetHub: it replaces the old 🔩
 * bolt emoji as the assistant avatar, the sidebar mark, and empty-state art.
 *
 * `pixelated` rendering keeps the sprite crisp at small sizes instead of
 * blurring the pixel art. Pass `className` for sizing (e.g. `size-9`).
 */
export function DenBot(props: { className?: string; title?: string }): JSX.Element {
  return (
    <img
      src={denBotUrl}
      alt="Rivet den bot"
      title={props.title}
      draggable={false}
      className={cn('select-none object-contain [image-rendering:pixelated]', props.className)}
    />
  )
}
