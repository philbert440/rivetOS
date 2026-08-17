import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Phone, PhoneOff, X } from 'lucide-react'
import { useStore, visibleMessages, type Bot } from '@/state/store'
import { currentCall, deferCallCleanup, endCall, startCall, useOnCall } from '@/lib/call'
import { speaker, voiceStackReady } from '@/lib/tts'
import { useSpeech } from '@/lib/tts/useSpeech'
import { dictationAvailable, onSpeechEnd, onSpeechTranscript, speechStart, speechStop } from '@/lib/speech'
import { MausAvatar } from './Avatar'
import { pendingApprovals } from './PendingApproval'
import { cn } from '@/lib/cn'
import { track } from '@/lib/analytics'

type Phase = 'listening' | 'sending' | 'working' | 'speaking'

export function CallButton({ bot }: { bot: Bot }) {
  const { dispatch } = useStore()
  const active = useOnCall() === bot.id
  const canCall = dictationAvailable() && (voiceStackReady() || Boolean(bot.voice))
  const label = active ? `Hang up on ${bot.name}` : canCall ? `Call ${bot.name}` : 'Voice needs this device microphone'
  return (
    <button
      onClick={() => {
        if (active) return void endCall(bot.id)
        if (!canCall) {
          dispatch({ type: 'toggleAppSettings', open: true, section: 'voice' })
          return
        }
        track('call_started', { driver: bot.modelSelection?.instanceId })
        startCall(bot.id)
      }}
      aria-label={label}
      title={label}
      className={cn(
        'relative flex size-9 items-center justify-center rounded-full transition-colors',
        active
          ? 'bg-danger text-white hover:brightness-110'
          : canCall
            ? 'text-ink-secondary hover:bg-raised hover:text-ink'
            : 'text-ink-secondary/50 hover:bg-raised hover:text-ink-secondary',
      )}
    >
      {active ? <PhoneOff size={17} /> : <Phone size={17} />}
    </button>
  )
}

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id
  if (!active) return null
  return <Call bot={bot} />
}

function Call({ bot }: { bot: Bot }) {
  const { dispatch } = useStore()
  const speech = useSpeech()
  const initial: Phase = bot.busy ? 'working' : 'listening'
  const [phase, setPhase] = useState<Phase>(initial)
  const [heard, setHeard] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const messages = visibleMessages(bot)
  const approval = pendingApprovals(messages)[0]
  const spokenIds = useRef(new Set(messages.map((m) => m.id)))
  const phaseRef = useRef<Phase>(initial)
  const alive = useRef(true)
  const sayGen = useRef(0)

  const move = useCallback((next: Phase) => {
    phaseRef.current = next
    if (alive.current) setPhase(next)
  }, [])

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return
    move('listening')
    setHeard('')
    setNote(null)
    void speechStart().catch(() => {
      if (alive.current && currentCall() === bot.id) {
        setNote('The microphone could not start. Allow mic access and try again.')
      }
    })
  }, [bot.id, move])

  const say = useCallback(
    async (text: string) => {
      if (!alive.current || currentCall() !== bot.id) return false
      const mine = ++sayGen.current
      move('speaking')
      speechStop()
      await speaker.speak(text, { botId: bot.id, voiceId: bot.voice })
      return alive.current && currentCall() === bot.id && sayGen.current === mine
    },
    [bot.id, bot.voice, move],
  )

  const sayThenListen = useCallback(
    async (text: string) => {
      const still = await say(text)
      if (still && phaseRef.current === 'speaking') listen()
    },
    [listen, say],
  )

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      sayGen.current += 1
      deferCallCleanup(bot.id, () => alive.current)
    }
  }, [bot.id])

  useEffect(() => {
    const offTranscript = onSpeechTranscript((line) => {
      if (!alive.current || currentCall() !== bot.id || phaseRef.current !== 'listening') return
      if (line.error) {
        setNote('Dictation stopped. Check microphone permission.')
        return
      }
      if (typeof line.text !== 'string') return
      setHeard(line.text)
      if (line.partial !== false) return
      const said = line.text.trim()
      if (!said) return listen()
      move('sending')
      dispatch({ type: 'send', botId: bot.id, text: said })
    })
    const offEnd = onSpeechEnd(() => {
      if (!alive.current || currentCall() !== bot.id) return
      if (phaseRef.current === 'listening') listen()
    })
    if (bot.busy && !approval) move('working')
    else listen()
    return () => {
      offTranscript()
      offEnd()
      speechStop()
    }
    // initial snapshot only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, bot.threadId, dispatch, listen, move])

  useEffect(() => {
    const fresh = messages.filter((m) => !spokenIds.current.has(m.id))
    if (!fresh.length) return
    const reply = [...fresh].reverse().find((m) => m.role === 'bot' && m.kind === 'text' && m.text?.trim())
    for (const m of fresh) spokenIds.current.add(m.id)
    if (reply?.text) void sayThenListen(reply.text)
  }, [messages, sayThenListen])

  useEffect(() => {
    if (bot.busy) {
      if (phaseRef.current !== 'speaking') {
        move('working')
        speechStop()
      }
    } else if (phaseRef.current === 'working' && !speaker.isSpeaking()) {
      listen()
    }
  }, [bot.busy, listen, move])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        endCall(bot.id)
      } else if (e.code === 'Space' && speaker.isSpeaking()) {
        e.preventDefault()
        sayGen.current += 1
        speaker.stop()
        listen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bot.id, listen])

  const status =
    phase === 'listening' ? 'Listening' : phase === 'sending' ? 'One moment' : phase === 'speaking' ? bot.name : 'Working'

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">
      <button
        onClick={() => endCall(bot.id)}
        aria-label="Hang up"
        className="absolute right-5 top-5 rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <X size={18} />
      </button>
      <MausAvatar
        color={bot.color}
        state={phase === 'listening' ? 'listening' : phase === 'speaking' ? 'sending' : 'working'}
        size={160}
      />
      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[20px] font-medium text-ink">{bot.name}</div>
        <div className="flex items-center gap-2 text-[13.5px] text-ink-secondary">
          {(phase === 'working' || phase === 'sending') && <Loader2 size={13} className="animate-spin" />}
          {status}
        </div>
      </div>
      <div className="min-h-[3.5rem] max-w-[560px] px-6 text-center text-[15px] leading-relaxed text-ink">
        {phase === 'listening' ? heard || <span className="text-ink-secondary">Say something…</span> : speech.caption}
      </div>
      {note && (
        <div className="flex max-w-[460px] flex-col items-center gap-2 text-center text-[12.5px] text-warning">
          <span>{note}</span>
          <button onClick={listen} className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10">
            Try microphone again
          </button>
        </div>
      )}
      {speech.error && <div className="max-w-[420px] text-center text-[12.5px] text-danger">{speech.error}</div>}
      <div className="flex items-center gap-3">
        {speaker.isSpeaking() && (
          <button
            onClick={() => {
              sayGen.current += 1
              speaker.stop()
              listen()
            }}
            className="rounded-full border border-hairline/50 px-4 py-2 text-[13.5px] text-ink hover:bg-raised"
          >
            Interrupt
          </button>
        )}
        <button
          onClick={() => endCall(bot.id)}
          className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          <PhoneOff size={16} /> Hang up
        </button>
      </div>
    </div>
  )
}
