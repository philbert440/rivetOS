/**
 * Channel interface — receives and sends messages on a surface.
 */

export interface InboundMessage {
  id: string
  userId: string
  username?: string
  displayName?: string
  channelId: string
  chatType: string
  text: string
  platform: string
  agent?: string
  replyToMessageId?: string
  attachments?: Attachment[]
  metadata?: Record<string, unknown>
  timestamp: number
}

export interface Attachment {
  type: 'photo' | 'voice' | 'document' | 'video'
  url?: string
  fileId?: string
  fileName?: string
  mimeType?: string
  width?: number
  height?: number
  duration?: number
}

export interface OutboundMessage {
  channelId: string
  text?: string
  replyToMessageId?: string
  buttons?: Button[][]
  embed?: EmbedData
  attachment?: { name: string; content: Buffer | string }
  silent?: boolean
  metadata?: Record<string, unknown>
}

export interface Button {
  text: string
  callbackData: string
  style?: 'primary' | 'success' | 'danger'
}

export interface EmbedData {
  title?: string
  description: string
  color?: number
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  footer?: string
}

/** Resolved attachment data ready to send to an LLM */
export interface ResolvedAttachment {
  type: 'photo' | 'voice' | 'document' | 'video'
  /** Base64-encoded file data */
  data?: string
  /** Public URL (Discord CDN, etc.) — preferred when available */
  url?: string
  /** MIME type */
  mimeType?: string
  /** Original file name */
  fileName?: string
}

/** Result from editing a message that may have overflowed into multiple messages */
export interface EditResult {
  /** All message IDs in order: [primary, overflow1, overflow2, ...] */
  messageIds: string[]
}

export interface Channel {
  id: string
  platform: string
  start(): Promise<void>
  stop(): Promise<void>
  send(message: OutboundMessage): Promise<string | null>
  /**
   * Edit a message. If text exceeds the platform limit, the channel
   * handles overflow internally — edit the current message with as much
   * as fits, send the rest as continuation messages.
   *
   * @param channelId - Channel/chat ID
   * @param messageId - Primary message to edit
   * @param text - New full text content
   * @param overflowIds - IDs of overflow messages from a previous edit.
   *   Pass these so the channel can re-edit them instead of creating new ones.
   *
   * Returns an EditResult with all message IDs (primary + overflow),
   * or null on failure.
   */
  edit?(
    channelId: string,
    messageId: string,
    text: string,
    overflowIds?: string[],
  ): Promise<EditResult | null>
  react?(channelId: string, messageId: string, emoji: string): Promise<void>
  /** Resolve attachment data (download from platform API, base64 encode, etc.) */
  resolveAttachment?(attachment: Attachment): Promise<ResolvedAttachment | null>
  onMessage(handler: (message: InboundMessage) => Promise<void>): void
  onCommand(
    handler: (command: string, args: string, message: InboundMessage) => Promise<void>,
  ): void
}
