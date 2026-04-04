/**
 * Channel interface — receives and sends messages on a surface.
 */

export interface InboundMessage {
  id: string;
  userId: string;
  username?: string;
  displayName?: string;
  channelId: string;
  chatType: string;
  text: string;
  platform: string;
  agent?: string;
  replyToMessageId?: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface Attachment {
  type: 'photo' | 'voice' | 'document' | 'video';
  url?: string;
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface OutboundMessage {
  channelId: string;
  text?: string;
  replyToMessageId?: string;
  buttons?: Button[][];
  embed?: EmbedData;
  attachment?: { name: string; content: Buffer | string };
  silent?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Button {
  text: string;
  callbackData: string;
  style?: 'primary' | 'success' | 'danger';
}

export interface EmbedData {
  title?: string;
  description: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
}

/** Resolved attachment data ready to send to an LLM */
export interface ResolvedAttachment {
  type: 'photo' | 'voice' | 'document' | 'video';
  /** Base64-encoded file data */
  data?: string;
  /** Public URL (Discord CDN, etc.) — preferred when available */
  url?: string;
  /** MIME type */
  mimeType?: string;
  /** Original file name */
  fileName?: string;
}

export interface Channel {
  id: string;
  platform: string;
  /** Maximum characters per message for this platform (used by StreamManager for message chains) */
  maxMessageLength?: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<string | null>;
  edit?(channelId: string, messageId: string, text: string): Promise<boolean>;
  react?(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Resolve attachment data (download from platform API, base64 encode, etc.) */
  resolveAttachment?(attachment: Attachment): Promise<ResolvedAttachment | null>;
  onMessage(handler: (message: InboundMessage) => Promise<void>): void;
  onCommand(handler: (command: string, args: string, message: InboundMessage) => Promise<void>): void;
}
