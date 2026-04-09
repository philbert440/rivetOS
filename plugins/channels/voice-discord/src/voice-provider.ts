/**
 * VoiceProvider — abstraction for real-time voice AI backends.
 *
 * Each provider implements bidirectional audio streaming (PCM in/out),
 * transcription, and function calling. The VoiceSession is provider-agnostic;
 * it wires Discord audio ↔ provider via this interface.
 *
 * Implementations:
 *   - XAIRealtimeProvider  (xAI Realtime API, 24kHz in/out)
 *   - GeminiLiveProvider   (Gemini Live API, 16kHz in / 24kHz out)
 */

// ---------------------------------------------------------------------------
// Callbacks — VoiceSession provides these to the provider
// ---------------------------------------------------------------------------

export interface VoiceProviderCallbacks {
  /** Provider has audio to play (PCM 24kHz mono, 16-bit LE) */
  onAudio: (audio: Buffer) => void
  /** User speech transcribed */
  onUserTranscript: (text: string) => void
  /** Assistant speech transcribed */
  onAssistantTranscript: (text: string) => void
  /** Full response finished (no more audio coming for this turn) */
  onResponseDone: () => void
  /** Provider wants to call a function; return the JSON result string */
  onFunctionCall: (name: string, callId: string, args: string) => Promise<string>
  /** Something went wrong */
  onError: (error: Error) => void
}

// ---------------------------------------------------------------------------
// Memory tool executor — injected from RivetOS runtime
// ---------------------------------------------------------------------------

/**
 * Thin wrapper so voice providers can call memory tools without importing
 * the full RivetOS tool system. The VoiceSession bridges this.
 */
export interface MemoryToolExecutor {
  search(query: string, opts?: { scope?: string; limit?: number }): Promise<string>
  browse(opts?: { limit?: number; order?: string }): Promise<string>
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface VoiceProvider {
  /** Open the connection to the AI backend */
  connect(): void
  /** Gracefully disconnect */
  disconnect(): void
  /** Send raw PCM audio from the user's mic */
  sendAudio(pcm: Buffer): void
  /** Change voice and/or system instructions mid-session (if supported) */
  updateSession(voice: string, instructions: string): void
  /** Whether the provider is connected and ready to receive audio */
  isReady(): boolean
}

// ---------------------------------------------------------------------------
// Tool definitions — shared across providers
// ---------------------------------------------------------------------------

/** OpenAI-style tool definition (used by xAI) */
export interface XAIToolDef {
  type: string
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  vector_store_ids?: string[]
  max_num_results?: number
}

/** Gemini-style function declaration */
export interface GeminiFunctionDecl {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

const MEMORY_SEARCH_DESC =
  "Search Phil's conversation history and memories. " +
  'Use when Phil asks about past conversations, decisions, or projects.'

const MEMORY_BROWSE_DESC =
  "Get recent messages from Phil's conversation history. " +
  'Use when Phil asks what has been happening recently.'

/** Build xAI-format tools (OpenAI-compatible) */
export function buildXAITools(collectionId?: string): XAIToolDef[] {
  const tools: XAIToolDef[] = [
    { type: 'web_search' },
    {
      type: 'function',
      name: 'search_memories',
      description: MEMORY_SEARCH_DESC,
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
      description: MEMORY_BROWSE_DESC,
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

/** Build Gemini-format function declarations */
export function buildGeminiTools(): GeminiFunctionDecl[] {
  return [
    {
      name: 'search_memories',
      description: MEMORY_SEARCH_DESC,
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
      name: 'get_recent_conversations',
      description: MEMORY_BROWSE_DESC,
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
}
