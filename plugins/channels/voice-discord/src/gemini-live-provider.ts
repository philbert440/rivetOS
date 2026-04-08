/**
 * Gemini Live API Provider — real-time bidirectional voice via WebSocket.
 *
 * Protocol:
 *   - Connect to wss://generativelanguage.googleapis.com/ws/...?key=API_KEY
 *   - First message: { config: { model, responseModalities, ... } }
 *   - Audio in:  { realtimeInput: { audio: { data: base64, mimeType: "audio/pcm;rate=16000" } } }
 *   - Audio out: serverContent.modelTurn.parts[].inlineData.data (base64, 24kHz PCM)
 *   - Tool calls: { toolCall: { functionCalls: [{ name, id, args }] } }
 *   - Tool responses: { toolResponse: { functionResponses: [{ name, id, response }] } }
 *   - Transcriptions: serverContent.inputTranscription / outputTranscription
 *
 * Audio formats:
 *   - Input: 16kHz mono PCM 16-bit LE (Gemini native)
 *   - Output: 24kHz mono PCM 16-bit LE (same as xAI → audio-player handles it)
 *
 * Discord sends us 24kHz PCM (via Opus decoder at 24kHz). We downsample to 16kHz
 * before sending to Gemini, and receive 24kHz back — no change needed for playback.
 */

import WebSocket from 'ws'
import type { VoiceProvider, VoiceProviderCallbacks } from './voice-provider.js'
import { buildGeminiTools } from './voice-provider.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GeminiLiveConfig {
  apiKey: string
  model: string
  voice: string
  instructions: string
  sampleRate: number // Discord decode rate (24000)
}

// ---------------------------------------------------------------------------
// Gemini Live event shapes
// ---------------------------------------------------------------------------

interface GeminiServerMessage {
  setupComplete?: Record<string, unknown>
  serverContent?: {
    modelTurn?: {
      parts?: Array<{
        text?: string
        inlineData?: { data: string; mimeType: string }
      }>
    }
    turnComplete?: boolean
    inputTranscription?: { text: string }
    outputTranscription?: { text: string }
  }
  toolCall?: {
    functionCalls: Array<{
      name: string
      id: string
      args: Record<string, unknown>
    }>
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GeminiLiveProvider implements VoiceProvider {
  private ws: WebSocket | null = null
  private config: GeminiLiveConfig
  private callbacks: VoiceProviderCallbacks
  private ready = false
  private reconnectAttempts = 0
  private maxReconnects = 5
  private intentionalClose = false
  private outputTranscriptBuffer = ''

  private static readonly WS_BASE =
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

  constructor(config: GeminiLiveConfig, callbacks: VoiceProviderCallbacks) {
    this.config = config
    this.callbacks = callbacks
  }

  // -----------------------------------------------------------------------
  // VoiceProvider interface
  // -----------------------------------------------------------------------

  connect(): void {
    this.intentionalClose = false
    this.doConnect()
  }

  disconnect(): void {
    this.intentionalClose = true
    this.ready = false
    this.ws?.close()
    this.ws = null
  }

  sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) return

    // Discord gives us 24kHz PCM — downsample to 16kHz for Gemini
    const downsampled = this.downsample24to16(pcm)

    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: downsampled.toString('base64'),
            mimeType: 'audio/pcm;rate=16000',
          },
        },
      }),
    )
  }

  updateSession(voice: string, instructions: string): void {
    // Gemini Live doesn't support mid-session config updates.
    // To change voice, we need to reconnect with new config.
    if (voice !== this.config.voice || instructions !== this.config.instructions) {
      this.config.voice = voice
      this.config.instructions = instructions
      // Reconnect with new config
      this.disconnect()
      this.intentionalClose = false
      this.doConnect()
    }
  }

  isReady(): boolean {
    return this.ready
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  private doConnect(): void {
    this.ready = false
    this.outputTranscriptBuffer = ''

    const url = `${GeminiLiveProvider.WS_BASE}?key=${this.config.apiKey}`

    this.ws = new WebSocket(url)

    this.ws.on('open', () => {
      this.reconnectAttempts = 0
      this.sendSetup()
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as GeminiServerMessage
        this.handleMessage(msg)
      } catch {
        // Parse error — skip
      }
    })

    this.ws.on('error', (err) => {
      this.callbacks.onError(err)
    })

    this.ws.on('close', () => {
      this.ready = false
      if (!this.intentionalClose) this.reconnect()
    })
  }

  private sendSetup(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const functionDeclarations = buildGeminiTools()

    const setup = {
      config: {
        model: `models/${this.config.model}`,
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.config.voice,
            },
          },
        },
        systemInstruction: {
          parts: [{ text: this.config.instructions }],
        },
        tools: [
          { functionDeclarations },
          { google_search: {} },
        ],
        // Enable transcription for both input and output
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Recommended sampling parameters from Google's model card
        generationConfig: {
          temperature: 1.0,
          topP: 0.95,
          topK: 64,
        },
      },
    }

    this.ws.send(JSON.stringify(setup))
  }

  private reconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnects) {
      this.callbacks.onError(new Error('Gemini Live: max reconnect attempts reached'))
      return
    }
    const delay = 1000 * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++
    setTimeout(() => this.doConnect(), delay)
  }

  // -----------------------------------------------------------------------
  // Message Handler
  // -----------------------------------------------------------------------

  private handleMessage(msg: GeminiServerMessage): void {
    // Setup complete — ready to receive audio
    if (msg.setupComplete) {
      this.ready = true
      return
    }

    // Server content — audio, transcriptions, turn complete
    if (msg.serverContent) {
      const sc = msg.serverContent

      // Audio output from model
      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.data) {
            // Gemini outputs 24kHz PCM — perfect, same as xAI
            const audio = Buffer.from(part.inlineData.data, 'base64')
            this.callbacks.onAudio(audio)
          }
          // Text parts in model turn (shouldn't happen with AUDIO modality, but just in case)
          if (part.text) {
            this.outputTranscriptBuffer += part.text
          }
        }
      }

      // Input transcription (user speech → text)
      if (sc.inputTranscription?.text) {
        this.callbacks.onUserTranscript(sc.inputTranscription.text)
      }

      // Output transcription (model speech → text)
      if (sc.outputTranscription?.text) {
        this.outputTranscriptBuffer += sc.outputTranscription.text
      }

      // Turn complete — flush transcript and signal response done
      if (sc.turnComplete) {
        if (this.outputTranscriptBuffer) {
          this.callbacks.onAssistantTranscript(this.outputTranscriptBuffer)
          this.outputTranscriptBuffer = ''
        }
        this.callbacks.onResponseDone()
      }
    }

    // Tool calls
    if (msg.toolCall) {
      void this.handleToolCalls(msg.toolCall.functionCalls)
    }
  }

  // -----------------------------------------------------------------------
  // Tool Calls
  // -----------------------------------------------------------------------

  private async handleToolCalls(
    functionCalls: Array<{ name: string; id: string; args: Record<string, unknown> }>,
  ): Promise<void> {
    const functionResponses: Array<{
      name: string
      id: string
      response: Record<string, unknown>
    }> = []

    for (const fc of functionCalls) {
      try {
        const resultStr = await this.callbacks.onFunctionCall(
          fc.name,
          fc.id,
          JSON.stringify(fc.args),
        )
        functionResponses.push({
          name: fc.name,
          id: fc.id,
          response: { result: JSON.parse(resultStr) },
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        functionResponses.push({
          name: fc.name,
          id: fc.id,
          response: { error: message },
        })
      }
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          toolResponse: { functionResponses },
        }),
      )
    }
  }

  // -----------------------------------------------------------------------
  // Audio Resampling
  // -----------------------------------------------------------------------

  /**
   * Downsample 24kHz mono PCM16 → 16kHz mono PCM16 (2:3 ratio).
   * Uses linear interpolation for reasonable quality.
   */
  private downsample24to16(input: Buffer): Buffer {
    const inSamples = input.length / 2
    const outSamples = Math.floor((inSamples * 2) / 3)
    const output = Buffer.alloc(outSamples * 2)

    for (let i = 0; i < outSamples; i++) {
      // Map output sample index to input sample position
      const srcPos = (i * 3) / 2
      const srcIdx = Math.floor(srcPos)
      const frac = srcPos - srcIdx

      const s0 = srcIdx < inSamples ? input.readInt16LE(srcIdx * 2) : 0
      const s1 = srcIdx + 1 < inSamples ? input.readInt16LE((srcIdx + 1) * 2) : s0

      // Linear interpolation
      const sample = Math.round(s0 + frac * (s1 - s0))
      output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
    }

    return output
  }
}
