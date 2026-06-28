/**
 * Core message types — the fundamental unit of conversation.
 */

// ---------------------------------------------------------------------------
// Content Parts — multimodal content (text, images, etc.)
// ---------------------------------------------------------------------------

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image'
  /** Base64-encoded image data */
  data?: string
  /** URL to fetch the image from (Discord CDN, etc.) */
  url?: string
  /** MIME type (image/jpeg, image/png, image/webp, image/gif) */
  mimeType?: string
}

export interface VideoPart {
  type: 'video'
  /** Base64-encoded video data (Telegram downloads bytes). */
  data?: string
  /** URL to fetch the video from (Discord CDN, etc.). Preferred over data —
   *  videos are large, so a URL keeps the request small when available. */
  url?: string
  /** MIME type (video/mp4, video/webm, …). */
  mimeType?: string
}

export type ContentPart = TextPart | ImagePart | VideoPart

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  /** Gemini 3 thought signature — must be passed back for function calling to work */
  thoughtSignature?: string
}
