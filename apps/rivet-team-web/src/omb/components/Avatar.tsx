// Rivet mascot: den-bot sprite + OpenMausBot motion vocabulary (arrive/switch/
// thinking/working/…). Not their CursorAvatar engine.
import { forwardRef, memo, type CSSProperties } from 'react'
import '../rivet-mascot.css'
import denBotUrl from '../assets/den-bot.png'
import { MAUS_COLORS, type MausColor, type MausMotion, type MausState } from '@/lib/mascot'

export const FACE_X = 80
export const FACE_Y = 102
export const FACE_SCALE = 0.47
export const EYE_SCALE = 1.12
export const MOUTH_WEIGHT = 11

export type MausAvatarHandle = { el: HTMLSpanElement | null }

function motionStyle(motion: MausMotion | undefined, state: MausState | undefined): CSSProperties {
  const beat = motion && motion !== 'none' ? motion : state === 'working' ? 'working' : state === 'thinking' ? 'thinking' : 'none'
  switch (beat) {
    case 'arrive':
    case 'switch':
    case 'launch':
      return { animation: 'rivet-mascot-pop 0.45s cubic-bezier(0.22,1,0.36,1)' }
    case 'thinking':
      return { animation: 'rivet-mascot-think 1.3s ease-in-out infinite' }
    case 'working':
      return { animation: 'rivet-mascot-work 1.1s ease-in-out infinite' }
    case 'alert':
    case 'surprise':
      return { animation: 'rivet-mascot-alert 0.8s ease-out' }
    case 'celebrate':
    case 'success':
      return { animation: 'rivet-mascot-pop 0.5s ease-out' }
    default:
      return {}
  }
}

export const MausAvatar = memo(
  forwardRef<
    MausAvatarHandle,
    {
      color: MausColor
      state?: MausState
      size?: number
      motion?: MausMotion
      motionKey?: number
      animated?: boolean
      className?: string
    }
  >(function MausAvatar({ color, size = 56, motion, state, motionKey, animated = true, className }, ref) {
    const hex = MAUS_COLORS[color] ?? MAUS_COLORS.green
    return (
      <span
        ref={(el) => {
          if (typeof ref === 'function') ref({ el })
          else if (ref) ref.current = { el }
        }}
        className={className}
        data-motion={motion}
        data-motion-key={motionKey}
        style={{
          width: size,
          height: size,
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '9999px',
          flexShrink: 0,
          boxShadow: `inset 0 0 0 2px ${hex}`,
          ...(animated ? motionStyle(motion, state) : {}),
        }}
        aria-hidden
      >
        <img
          src={denBotUrl}
          alt=""
          draggable={false}
          style={{
            width: '78%',
            height: '78%',
            objectFit: 'contain',
            imageRendering: 'pixelated',
          }}
        />
      </span>
    )
  }),
)

export function InitialsAvatar({
  initials,
  size = 36,
  className,
}: {
  initials: string
  size?: number
  className?: string
}) {
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '9999px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(16,132,254,0.18)',
        color: '#1084fe',
        fontSize: Math.max(10, size * 0.34),
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials}
    </span>
  )
}
