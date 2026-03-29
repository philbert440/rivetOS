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

export interface Channel {
  id: string;
  platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<string | null>;
  edit?(channelId: string, messageId: string, text: string): Promise<boolean>;
  react?(channelId: string, messageId: string, emoji: string): Promise<void>;
  onMessage(handler: (message: InboundMessage) => Promise<void>): void;
  onCommand(handler: (command: string, args: string, message: InboundMessage) => Promise<void>): void;
}
