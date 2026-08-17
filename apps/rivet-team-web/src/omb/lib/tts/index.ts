/**
 * Rivet speaker — same singleton contract as OpenMausBot's speaker.
 * Tries den /api/tts/speak (household voice stack) then Web Speech.
 * Never talks to ElevenLabs.
 */
export type SpeechStatus = 'idle' | 'preparing' | 'speaking'

export interface SpeechSnapshot {
  status: SpeechStatus
  botId?: string
  messageId?: string
  caption?: string
  error?: string
}

interface SpeakOptions {
  voiceId?: string
  botId?: string
  messageId?: string
}

const IDLE: SpeechSnapshot = { status: 'idle' }

export function voiceStackReady(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined'
}

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE
  private watchers = new Set<(s: SpeechSnapshot) => void>()
  private token = 0
  private utterance: SpeechSynthesisUtterance | null = null

  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.watchers.add(fn)
    fn(this.snapshot)
    return () => this.watchers.delete(fn)
  }

  get state(): SpeechSnapshot {
    return this.snapshot
  }

  private set(next: SpeechSnapshot) {
    this.snapshot = next
    for (const watcher of [...this.watchers]) watcher(next)
  }

  isSpeaking(messageId?: string): boolean {
    if (this.snapshot.status === 'idle') return false
    if (messageId) return this.snapshot.messageId === messageId
    return this.snapshot.status === 'speaking' || this.snapshot.status === 'preparing'
  }

  stop() {
    this.token += 1
    globalThis.window?.speechSynthesis?.cancel()
    this.utterance = null
    if (this.snapshot.status !== 'idle' || this.snapshot.error) this.set(IDLE)
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    this.stop()
    const mine = this.token
    this.set({ status: 'preparing', botId: opts.botId, messageId: opts.messageId })

    const clip = await tryDenSpeak(text, opts.voiceId)
    if (this.token !== mine) return
    if (clip) {
      await this.playBlob(clip, opts, mine)
      return
    }

    if (!voiceStackReady()) {
      this.set({ ...IDLE, error: 'No Rivet voice stack on this client.' })
      return
    }
    await this.playWebSpeech(text, opts, mine)
  }

  private playBlob(blob: Blob, opts: SpeakOptions, mine: number): Promise<void> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      this.set({ status: 'speaking', botId: opts.botId, messageId: opts.messageId, caption: opts.messageId })
      audio.onended = () => {
        URL.revokeObjectURL(url)
        if (this.token === mine) this.set(IDLE)
        resolve()
      }
      audio.onerror = () => {
        URL.revokeObjectURL(url)
        if (this.token === mine) this.set({ ...IDLE, error: 'Could not play voice clip.' })
        resolve()
      }
      void audio.play().catch(() => {
        URL.revokeObjectURL(url)
        if (this.token === mine) this.set({ ...IDLE, error: 'Could not play voice clip.' })
        resolve()
      })
    })
  }

  private playWebSpeech(text: string, opts: SpeakOptions, mine: number): Promise<void> {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text)
      this.utterance = u
      if (opts.voiceId) {
        const match = window.speechSynthesis.getVoices().find((v) => v.voiceURI === opts.voiceId || v.name === opts.voiceId)
        if (match) u.voice = match
      }
      u.onstart = () => {
        if (this.token === mine) this.set({ status: 'speaking', botId: opts.botId, messageId: opts.messageId, caption: text.slice(0, 160) })
      }
      u.onend = () => {
        if (this.token === mine) this.set(IDLE)
        resolve()
      }
      u.onerror = () => {
        if (this.token === mine) this.set({ ...IDLE, error: 'Voice stack failed.' })
        resolve()
      }
      window.speechSynthesis.speak(u)
    })
  }
}

async function tryDenSpeak(text: string, voiceId?: string): Promise<Blob | null> {
  try {
    const res = await fetch('/api/tts/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voiceId }),
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    if (!type.startsWith('audio/')) return null
    return await res.blob()
  } catch {
    return null
  }
}

export const speaker = new Speaker()
