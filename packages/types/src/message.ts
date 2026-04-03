/**
 * Core message types — the fundamental unit of conversation.
 */

// ---------------------------------------------------------------------------
// Content Parts — multimodal content (text, images, etc.)
// ---------------------------------------------------------------------------

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** Base64-encoded image data */
  data?: string;
  /** URL to fetch the image from (Discord CDN, etc.) */
  url?: string;
  /** MIME type (image/jpeg, image/png, image/webp, image/gif) */
  mimeType?: string;
}

export type ContentPart = TextPart | ImagePart;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Gemini 3 thought signature — must be passed back for function calling to work */
  thoughtSignature?: string;
}
