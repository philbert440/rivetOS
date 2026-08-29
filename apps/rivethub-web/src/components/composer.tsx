import { useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, Mic, Paperclip, Volume2, VolumeX, X } from 'lucide-react'
import type { ThinkingLevel } from '@rivetos/types'
import type { WsStatus } from '../stores/chat.js'
import type { ChatSettings } from '../stores/chat-settings.js'
import type { AskQuestion } from '../lib/ask-user.js'
import { useChat } from '../stores/chat.js'
import { useConnection } from '../stores/connection.js'
import { modelOptions } from '../lib/model-options.js'
import { uuidv4 } from '../lib/uuid.js'
import { cn } from '../lib/utils.js'
import {
  anyUploading,
  formatBytes,
  markFailed,
  markStaged,
  withAttachmentText,
  withoutAttachment,
  type PendingAttachment,
} from '../lib/attachments.js'
import {
  getAutoSpeak,
  setAutoSpeak,
  speak,
  startRecording,
  voiceInputSupported,
  type ActiveRecording,
} from '../lib/voice.js'
import { Textarea } from './ui/textarea.js'
import { EffortPicker } from './pickers/effort-picker.js'
import { ModelPicker } from './pickers/model-picker.js'
import { NodePicker } from './pickers/node-picker.js'
import { AskUserCard } from './ask-user-card.js'

/** Imperative surface for the parent (chat page): cancelling a queued message
 *  recalls its text into the draft instead of discarding it. */
export interface ComposerHandle {
  /** Put text back into the draft, above whatever is already being typed. */
  prepend(text: string): void
}

export function Composer(props: {
  sessionId: string
  wsStatus: WsStatus
  settingsKey: string
  agent?: string
  effort: ThinkingLevel
  /** Agent-preset system prompt; sent on the chat-loop POST path. */
  systemPrompt?: string
  onSetting: (patch: Partial<ChatSettings>) => void
  /** Seamless modes: when set, a turn drives the session's live harness
   *  (inject into its PTY) instead of the chat-loop postMessage — so chat,
   *  terminal, and den are one conversation. The reply streams back via the
   *  den→sessions-WS bridge. */
  onSend?: (text: string) => Promise<void>
  /** Ask-user card content (agent prompted the user). Empty hides the card. */
  ask?: AskQuestion[]
  onDismissAsk?: () => void
  handleRef?: RefObject<ComposerHandle | null>
}): JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [atts, setAtts] = useState<PendingAttachment[]>([])
  const [micState, setMicState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [autoSpeak, setAutoSpeakState] = useState(getAutoSpeak)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recRef = useRef<ActiveRecording | undefined>(undefined)
  const connected = props.wsStatus === 'open'
  const baseUrl = useConnection((s) => s.baseUrl)

  // Cancel-recall: the parent pushes a cancelled queue item's text back into
  // the draft (prepended, so an in-progress draft isn't clobbered).
  const handleRef = props.handleRef
  useEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      prepend: (t: string) => {
        setText((prev) => (prev.trim() ? `${t}\n${prev}` : t))
        taRef.current?.focus()
      },
    }
    return () => {
      handleRef.current = null
    }
  }, [handleRef])

  // Drop the mic on unmount — never leave a tab holding the capture device.
  useEffect(
    () => () => {
      recRef.current?.cancel()
      recRef.current = undefined
    },
    [],
  )

  // Auto-speak: voice out for each assistant turn that COMMITS while the
  // toggle is on. Committed messages only (the live turn is separate state),
  // seeded on mount so reopening a thread doesn't read history aloud.
  const lastAssistant = useChat((s) => {
    const msgs = s.messages[props.sessionId]
    if (!msgs) return undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === 'assistant' && m.text) return m
    }
    return undefined
  })
  const spokenRef = useRef<string | null>(null)
  useEffect(() => {
    if (spokenRef.current === null) {
      spokenRef.current = lastAssistant?.id ?? ''
      return
    }
    if (!autoSpeak || !lastAssistant || lastAssistant.id === spokenRef.current) return
    spokenRef.current = lastAssistant.id
    void speak(lastAssistant.text, lastAssistant.id).catch(() => undefined)
  }, [autoSpeak, lastAssistant])

  // Model dropdown (Claude Code / grok Build / local + mesh) from the catalog.
  const catalog = useQuery({
    queryKey: ['catalog-agents', baseUrl],
    queryFn: ({ signal }) => useConnection.getState().gateway.catalogAgents(signal),
    staleTime: 300_000,
  })
  const models = modelOptions(catalog.data?.agents ?? [])

  const addFiles = (files: Iterable<File>): void => {
    for (const file of files) {
      const id = uuidv4()
      setAtts((prev) => [
        ...prev,
        {
          id,
          name: file.name || 'pasted-image.png',
          size: file.size,
          mime: file.type || 'application/octet-stream',
          status: 'uploading',
        },
      ])
      void useConnection
        .getState()
        .gateway.stageUpload(file.name || 'pasted-image.png', file, {
          mime: file.type || undefined,
        })
        .then((res) => setAtts((prev) => markStaged(prev, id, res.uri)))
        .catch(() => setAtts((prev) => markFailed(prev, id)))
    }
  }

  const sendBody = async (body: string): Promise<void> => {
    const trimmed = withAttachmentText(body.trim(), atts)
    // Seamless queue path: allow stacking while a prior turn is in flight
    // (onSend enqueues and returns). Chat-loop path still serializes via sending.
    if (!trimmed || (sending && !props.onSend)) return
    if (anyUploading(atts)) {
      setError('still uploading an attachment…')
      return
    }
    setError(undefined)
    setSending(true)
    setText('')
    setAtts([])
    try {
      if (props.onSend) {
        // Enqueue + pump (returns immediately). Messages show as queued/sending
        // in the transcript until the harness injects them.
        await props.onSend(trimmed)
      } else {
        // Fire-and-forget; the reply (and this message's echo) arrive on the
        // sessions WS. Model (agent) + effort (thinking) ride the request and
        // persist per-conversation.
        await useConnection.getState().gateway.postMessage(props.sessionId, {
          text: trimmed,
          agent: props.agent,
          thinking: props.effort,
          ...(props.systemPrompt?.trim() ? { systemPrompt: props.systemPrompt.trim() } : {}),
        })
      }
    } catch (err) {
      setError((err as Error).message)
      setText(trimmed) // give the draft back
    } finally {
      setSending(false)
    }
  }

  const send = async (): Promise<void> => {
    await sendBody(text)
  }

  const toggleMic = (): void => {
    setError(undefined)
    if (micState === 'recording') {
      const rec = recRef.current
      recRef.current = undefined
      if (!rec) {
        setMicState('idle')
        return
      }
      setMicState('transcribing')
      void rec
        .finish()
        .then((heard) => {
          if (!heard) return
          // Insert at the cursor so dictation can extend a typed draft.
          const ta = taRef.current
          const pos = ta?.selectionStart ?? text.length
          setText((prev) => {
            const head = prev.slice(0, pos)
            const tail = prev.slice(pos)
            const glue = head && !head.endsWith(' ') && !head.endsWith('\n') ? ' ' : ''
            return `${head}${glue}${heard}${tail}`
          })
        })
        .catch((err: unknown) => setError((err as Error).message))
        .finally(() => {
          setMicState('idle')
          taRef.current?.focus()
        })
      return
    }
    if (micState !== 'idle') return
    void startRecording()
      .then((rec) => {
        recRef.current = rec
        setMicState('recording')
      })
      .catch((err: unknown) => setError((err as Error).message))
  }

  // Seamless: never lock out Enter for a second queued message.
  const hasBody = text.trim().length > 0 || atts.some((a) => a.status === 'ready')
  const canSend = connected && hasBody && (props.onSend ? true : !sending)
  // Line count without allocating an array per keystroke.
  const rowCount = useMemo(() => {
    let n = 1
    for (let i = 0; i < text.length && n < 8; i++) if (text[i] === '\n') n++
    return n
  }, [text])

  return (
    <div
      className="border-t border-line bg-panel/60 px-4 py-3"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return
        e.preventDefault()
        addFiles(e.dataTransfer.files)
      }}
    >
      {error && <div className="mb-2 font-mono text-xs text-red">✗ {error}</div>}
      {/* Ask card — pops from the top of the input when the agent asked a
          question. Picking an option sends it as the next user turn; typing a
          freeform reply below works too (the send retires the card). */}
      {(props.ask?.length ?? 0) > 0 && (
        <AskUserCard
          questions={props.ask ?? []}
          disabled={!connected || sending}
          onAnswer={(label) => void sendBody(label)}
          onDismiss={() => props.onDismissAsk?.()}
          onFocusComposer={() => taRef.current?.focus()}
        />
      )}
      {atts.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {atts.map((a) => (
            <span
              key={a.id}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px]',
                a.status === 'failed'
                  ? 'border-red/60 text-red'
                  : a.status === 'uploading'
                    ? 'animate-pulse border-line text-ink-dim'
                    : 'border-em-dim/60 text-ink',
              )}
              title={a.status === 'failed' ? `${a.name} — upload failed` : a.name}
            >
              <Paperclip className="size-3" />
              <span className="max-w-40 truncate">{a.name}</span>
              <span className="text-ink-dim">{formatBytes(a.size)}</span>
              <button
                type="button"
                aria-label={`remove ${a.name}`}
                onClick={() => setAtts((prev) => withoutAttachment(prev, a.id))}
                className="text-ink-dim hover:text-red"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div
        className={cn(
          'flex flex-col gap-2 rounded-xl border border-line bg-panel p-2 transition-shadow',
          'focus-within:border-em/60 focus-within:ring-1 focus-within:ring-em/30',
          !connected && 'opacity-70',
        )}
      >
        <Textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          onPaste={(e) => {
            // Files only (screenshots, image paste). Plain text keeps the
            // native paste path untouched.
            if (e.clipboardData.files.length === 0) return
            e.preventDefault()
            addFiles(e.clipboardData.files)
          }}
          rows={rowCount}
          placeholder={
            connected ? 'Message Rivet… (Enter to send, Shift+Enter for newline)' : 'reconnecting…'
          }
          disabled={!connected || sending}
          className="px-2 pt-1"
        />
        {/* Picker row (node · model · effort) + attach/mic/speak + send —
            Claude-app style, in the input shell, persisted per-conversation. */}
        <div className="flex items-center gap-1">
          <NodePicker />
          <ModelPicker
            value={props.agent ?? ''}
            options={models}
            onChange={(v) => props.onSetting({ agent: v })}
            disabled={catalog.isError}
            unavailable={catalog.isError}
          />
          <EffortPicker value={props.effort} onChange={(v) => props.onSetting({ effort: v })} />
          <div className="flex-1" />
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="attach files"
            title="attach files (or drop / paste them)"
            className="flex size-8 items-center justify-center rounded-full text-ink-dim transition-colors hover:text-em"
          >
            <Paperclip className="size-4" />
          </button>
          {voiceInputSupported() && (
            <button
              type="button"
              onClick={toggleMic}
              aria-label={micState === 'recording' ? 'stop recording' : 'dictate'}
              title={
                micState === 'recording'
                  ? 'stop and transcribe'
                  : micState === 'transcribing'
                    ? 'transcribing…'
                    : 'dictate (node ASR)'
              }
              disabled={micState === 'transcribing'}
              className={cn(
                'flex size-8 items-center justify-center rounded-full transition-colors',
                micState === 'recording'
                  ? 'animate-pulse bg-red/20 text-red'
                  : micState === 'transcribing'
                    ? 'animate-pulse text-ink-dim'
                    : 'text-ink-dim hover:text-em',
              )}
            >
              <Mic className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const next = !autoSpeak
              setAutoSpeak(next)
              setAutoSpeakState(next)
            }}
            aria-label={autoSpeak ? 'disable auto-speak' : 'enable auto-speak'}
            title={autoSpeak ? 'auto-speak replies: on' : 'auto-speak replies: off'}
            className={cn(
              'flex size-8 items-center justify-center rounded-full transition-colors',
              autoSpeak ? 'text-em' : 'text-ink-dim hover:text-em',
            )}
          >
            {autoSpeak ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          </button>
          <button
            onClick={() => void send()}
            disabled={!canSend}
            aria-label="send"
            title="send"
            className={cn(
              'flex size-8 items-center justify-center rounded-full transition-colors',
              canSend ? 'bg-em-dim text-bg hover:bg-em' : 'bg-panel-2 text-ink-dim',
            )}
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
