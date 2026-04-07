/**
 * xAI Realtime API WebSocket Client
 *
 * Bidirectional audio streaming: PCM 24kHz mono in/out.
 * Server VAD for turn detection. Function calling for memory tools.
 * Auto-reconnect with exponential backoff.
 */

import WebSocket from 'ws'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface XAIConfig {
  apiKey: string
  voice: string
  instructions: string
  sampleRate: number
  silenceDurationMs: number
  collectionId?: string
}

export interface XAICallbacks {
  onAudio: (audio: Buffer) => void
  onUserTranscript: (text: string) => void
  onAssistantTranscript: (text: string) => void
  onResponseDone: () => void
  onFunctionCall: (name: string, callId: string, args: string) => Promise<string>
  onError: (error: Error) => void
}

// ---------------------------------------------------------------------------
// xAI event shapes (partial — only fields we access)
// ---------------------------------------------------------------------------

interface XAIEvent {
  type: string
  delta?: string
  transcript?: string
  name?: string
  call_id?: string
  arguments?: string
  error?: { message?: string }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface XAITool {
  type: string
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  vector_store_ids?: string[]
  max_num_results?: number
}

function buildTools(collectionId?: string): XAITool[] {
  const tools: XAITool[] = [
    { type: 'web_search' },
    {
      type: 'function',
      name: 'search_memories',
      description:
        "Search Phil's conversation history and memories using semantic search. " +
        'Use when Phil asks about past conversations, decisions, or projects.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          scope: {
            type: 'string',
            enum: ['both', 'messages', 'summaries'],
            description: 'Where to search (default: both)',
          },
          limit: { type: 'number', description: 'Max results (default 8, max 20)' },
        },
        required: ['query'],
      },
    },
    {
      type: 'function',
      name: 'get_recent_conversations',
      description:
        "Get recent messages from Phil's conversation history. " +
        'Use when Phil asks what has been happening recently.',
      parameters: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'Hours to look back (default 24, max 168)' },
          limit: { type: 'number', description: 'Max messages (default 15, max 30)' },
        },
        required: [],
      },
    },
  ]

  if (collectionId) {
    tools.push({
      type: 'file_search',
      vector_store_ids: [collectionId],
      max_num_results: 10,
    })
  }

  return tools
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class XAIRealtimeClient {
  private ws: WebSocket | null = null
  private callbacks: XAICallbacks
  private config: XAIConfig
  private sessionConfigured = false
  private sessionConfigSent = false
  private reconnectAttempts = 0
  private maxReconnects = 5
  private assistantTranscriptBuffer = ''
  private intentionalClose = false

  constructor(config: XAIConfig, callbacks: XAICallbacks) {
    this.config = config
    this.callbacks = callbacks
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  connect(): void {
    this.intentionalClose = false
    this.doConnect()
  }

  isReady(): boolean {
    return this.sessionConfigured
  }

  private doConnect(): void {
    this.sessionConfigured = false
    this.sessionConfigSent = false

    this.ws = new WebSocket('wss://api.x.ai/v1/realtime', {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    })

    this.ws.on('open', () => {
      this.reconnectAttempts = 0
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString()) as XAIEvent
        this.handleEvent(event)
      } catch {
        // Parse error — skip
      }
    })

    this.ws.on('error', (err) => {
      this.callbacks.onError(err)
    })

    this.ws.on('close', () => {
      if (!this.intentionalClose) this.reconnect()
    })
  }

  private reconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnects) {
      this.callbacks.onError(new Error('Max reconnect attempts reached'))
      return
    }
    const delay = 1000 * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++
    setTimeout(() => this.doConnect(), delay)
  }

  // -----------------------------------------------------------------------
  // Session Configuration
  // -----------------------------------------------------------------------

  updateSession(voice: string, instructions: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    this.ws.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          instructions,
          voice,
          turn_detection: {
            type: 'server_vad',
            threshold: 0.6,
            silence_duration_ms: this.config.silenceDurationMs,
          },
          audio: {
            input: { format: { type: 'audio/pcm', rate: this.config.sampleRate } },
            output: { format: { type: 'audio/pcm', rate: this.config.sampleRate } },
          },
          tools: buildTools(this.config.collectionId),
        },
      }),
    )
    this.sessionConfigSent = true
  }

  // -----------------------------------------------------------------------
  // Audio
  // -----------------------------------------------------------------------

  sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sessionConfigured) return
    this.ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm.toString('base64'),
      }),
    )
  }

  // -----------------------------------------------------------------------
  // Event Handler
  // -----------------------------------------------------------------------

  private handleEvent(event: XAIEvent): void {
    switch (event.type) {
      // Session lifecycle
      case 'conversation.created':
      case 'session.created':
        if (!this.sessionConfigSent) {
          this.updateSession(this.config.voice, this.config.instructions)
        }
        break

      case 'session.updated':
        this.sessionConfigured = true
        break

      // Audio output
      case 'response.audio.delta':
      case 'response.output_audio.delta':
        if (event.delta) {
          this.callbacks.onAudio(Buffer.from(event.delta, 'base64'))
        }
        break

      // User transcription
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          this.callbacks.onUserTranscript(event.transcript)
        }
        break

      // Assistant transcription (streaming)
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        if (event.delta) this.assistantTranscriptBuffer += event.delta
        break

      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (this.assistantTranscriptBuffer || event.transcript) {
          this.callbacks.onAssistantTranscript(this.assistantTranscriptBuffer || event.transcript!)
          this.assistantTranscriptBuffer = ''
        }
        break

      // Function calls
      case 'response.function_call_arguments.done':
        void this.handleFunctionCall(event.name!, event.call_id!, event.arguments!)
        break

      // Response lifecycle
      case 'response.done':
        this.callbacks.onResponseDone()
        break

      // Errors
      case 'error':
        this.callbacks.onError(new Error(event.error?.message ?? 'Unknown xAI error'))
        break

      // Silently ignore expected events
      case 'input_audio_buffer.speech_started':
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed':
      case 'response.created':
      case 'response.output_item.added':
      case 'response.output_item.done':
      case 'conversation.item.created':
      case 'conversation.item.added':
      case 'rate_limits.updated':
        break
    }
  }

  // -----------------------------------------------------------------------
  // Function Calls
  // -----------------------------------------------------------------------

  private async handleFunctionCall(name: string, callId: string, rawArgs: string): Promise<void> {
    try {
      const result = await this.callbacks.onFunctionCall(name, callId, rawArgs)

      // Sanitize lone surrogates that xAI rejects
      const sanitized = result.replace(/[\uD800-\uDFFF]/g, '\uFFFD')

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: callId, output: sanitized },
          }),
        )
        this.ws.send(JSON.stringify({ type: 'response.create' }))
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({ error: message }),
            },
          }),
        )
        this.ws.send(JSON.stringify({ type: 'response.create' }))
      }
    }
  }

  // -----------------------------------------------------------------------
  // Disconnect
  // -----------------------------------------------------------------------

  disconnect(): void {
    this.intentionalClose = true
    this.ws?.close()
    this.ws = null
  }
}
