import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import { useTeam } from '../stores/team.js'

export function Composer(): JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const send = useTeam((s) => s.send)
  const selectedId = useTeam((s) => s.selectedId)
  const personas = useTeam((s) => s.personas)
  const persona = personas.find((p) => p.id === selectedId)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const submit = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || sending || !selectedId) return
    setSending(true)
    setText('')
    try {
      await send(trimmed)
    } finally {
      setSending(false)
      taRef.current?.focus()
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <form
      className="bg-app px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 md:px-5"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="mx-auto flex max-w-[900px] items-end gap-2 rounded-3xl border border-hairline/40 bg-raised/60 py-2 pr-2 pl-4">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          placeholder={persona ? `Message ${persona.name}` : 'Message'}
          aria-label={persona ? `Message ${persona.name}` : 'Message'}
          className="max-h-40 w-full resize-none self-center bg-transparent py-1 text-[15px] leading-6 text-ink outline-none placeholder:text-ink-secondary"
        />
        <button
          type="submit"
          disabled={!text.trim() || sending || !selectedId}
          aria-label="Send"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:bg-raised disabled:text-ink-secondary"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </form>
  )
}
