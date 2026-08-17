/** Dictation: den/ogb if present, else the device Web Speech stack. */

export type SpeechLine = { text?: string; partial?: boolean; error?: string }

type Rec = {
  start: () => void
  stop: () => void
  abort?: () => void
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((ev: { results: ArrayLike<{ isFinal?: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((ev: { error?: string }) => void) | null
  onend: (() => void) | null
}

function SpeechCtor(): (new () => Rec) | null {
  const w = globalThis.window as
    | (Window & { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec })
    | undefined
  return w?.SpeechRecognition ?? w?.webkitSpeechRecognition ?? null
}

export function webSpeechAvailable(): boolean {
  return SpeechCtor() !== null
}

export function dictationAvailable(): boolean {
  if (typeof window !== 'undefined' && window.ogb?.speechStart) return true
  return webSpeechAvailable()
}

let rec: Rec | null = null
const transcriptWatchers = new Set<(line: SpeechLine) => void>()
const endWatchers = new Set<(info: { code: number; reason?: string }) => void>()

function emitTranscript(line: SpeechLine) {
  for (const fn of [...transcriptWatchers]) fn(line)
}

function emitEnd(info: { code: number; reason?: string }) {
  for (const fn of [...endWatchers]) fn(info)
}

export function onSpeechTranscript(fn: (line: SpeechLine) => void): () => void {
  if (typeof window !== 'undefined' && window.ogb?.onSpeechTranscript) return window.ogb.onSpeechTranscript(fn)
  transcriptWatchers.add(fn)
  return () => transcriptWatchers.delete(fn)
}

export function onSpeechEnd(fn: (info: { code: number; reason?: string }) => void): () => void {
  if (typeof window !== 'undefined' && window.ogb?.onSpeechEnd) return window.ogb.onSpeechEnd(fn)
  endWatchers.add(fn)
  return () => endWatchers.delete(fn)
}

export function speechStart(opts?: { endpointMs?: number }): Promise<void> {
  if (typeof window !== 'undefined' && window.ogb?.speechStart) return Promise.resolve(window.ogb.speechStart(opts))
  const Ctor = SpeechCtor()
  if (!Ctor) {
    emitEnd({ code: 2, reason: 'no-web-speech' })
    return Promise.reject(new Error('Dictation is not available on this device.'))
  }
  speechStop()
  const next = new Ctor()
  next.continuous = true
  next.interimResults = true
  next.lang = typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US'
  next.onresult = (ev) => {
    const last = ev.results[ev.results.length - 1]
    if (!last) return
    const text = last[0]?.transcript?.trim()
    if (!text) return
    emitTranscript({ text, partial: !last.isFinal })
  }
  next.onerror = (ev) => {
    if (ev.error === 'aborted' || ev.error === 'no-speech') return
    emitTranscript({ error: ev.error ?? 'speech-error' })
    emitEnd({ code: 1, reason: ev.error })
  }
  next.onend = () => {
    if (rec === next) rec = null
    emitEnd({ code: 0 })
  }
  rec = next
  try {
    next.start()
    return Promise.resolve()
  } catch (err) {
    rec = null
    emitEnd({ code: 1, reason: 'start-failed' })
    return Promise.reject(err)
  }
}

export function speechStop(): void {
  if (typeof window !== 'undefined' && window.ogb?.speechStop) {
    void window.ogb.speechStop()
    return
  }
  const live = rec
  rec = null
  try {
    live?.stop()
  } catch {
    live?.abort?.()
  }
}
