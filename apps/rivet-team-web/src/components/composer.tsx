import { useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import { useTeam } from '../stores/team.js'

export function Composer(): JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const send = useTeam((s) => s.send)
  const selectedId = useTeam((s) => s.selectedId)
  const taRef = useRef<HTMLTextAreaElement>(null)

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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <form
      className="border-t border-line bg-panel/90 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex items-end gap-2 rounded-xl border border-line bg-bg px-3 py-2">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          placeholder="Message this persona…"
          className="max-h-40 min-h-10 flex-1 resize-none bg-transparent py-1.5 text-sm text-ink outline-none placeholder:text-ink-dim"
        />
        <button
          type="submit"
          disabled={!text.trim() || sending || !selectedId}
          aria-label="Send"
          className="mb-0.5 flex size-8 items-center justify-center rounded-lg bg-em text-bg disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
      <p className="mt-1.5 px-1 text-[11px] text-ink-dim">Enter to send · Shift+Enter for a new line</p>
    </form>
  )
}
