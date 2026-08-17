import { Loader2, Square, Volume2 } from 'lucide-react'
import { speaker, voiceStackReady } from '@/lib/tts'
import { useSpeech } from '@/lib/tts/useSpeech'
import { useStore } from '@/state/store'
import { cn } from '@/lib/cn'

export function SpeakButton({
  text,
  botId,
  messageId,
  voiceId,
  className,
}: {
  text: string
  botId?: string
  messageId: string
  voiceId?: string
  className?: string
}) {
  const { state } = useStore()
  const speech = useSpeech()
  const ready = Boolean(state.config?.tts?.ready) || voiceStackReady()
  const mine = speech.messageId === messageId && speech.status !== 'idle'
  const preparing = mine && speech.status === 'preparing'

  const label = !ready
    ? 'Voice stack not ready on this client'
    : mine
      ? 'Stop speaking'
      : 'Read this aloud'
  return (
    <button
      onClick={() => {
        if (mine) return speaker.stop()
        void speaker.speak(text, { botId, messageId, voiceId })
      }}
      disabled={!ready}
      aria-label={label}
      title={label}
      className={cn(
        'rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary',
        mine ? 'text-accent' : '',
        className,
      )}
    >
      {preparing ? <Loader2 size={14} className="animate-spin" /> : mine ? <Square size={14} className="fill-current" /> : <Volume2 size={14} />}
    </button>
  )
}
