import { useEffect, useState, type JSX } from 'react'
import { Square, Volume2 } from 'lucide-react'
import { onSpeakingChange, speak, speakingKey, stopSpeaking } from '../lib/voice.js'

/** Hover/focus speak-aloud for an assistant message — sits beside the copy
 *  button. Play fetches TTS from the node voice proxy; while THIS message is
 *  playing the button becomes stop. */
export function SpeakMessage(props: { id: string; text: string }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(() => speakingKey() === props.id)
  const [failed, setFailed] = useState(false)
  useEffect(() => onSpeakingChange(() => setPlaying(speakingKey() === props.id)), [props.id])
  const onClick = (): void => {
    setFailed(false)
    if (playing) {
      stopSpeaking()
      return
    }
    setBusy(true)
    void speak(props.text, props.id)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }
  return (
    <button
      type="button"
      aria-label={playing ? 'stop speaking' : 'speak message'}
      title={failed ? 'voice unavailable' : playing ? 'stop' : 'speak message'}
      onClick={onClick}
      disabled={busy}
      className="absolute top-0 right-8 rounded border border-line bg-panel/90 p-1 text-ink-dim opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100 hover:text-em disabled:animate-pulse"
    >
      {playing ? (
        <Square className="size-3 text-em" />
      ) : (
        <Volume2 className={`size-3 ${failed ? 'text-red' : ''}`} />
      )}
    </button>
  )
}
