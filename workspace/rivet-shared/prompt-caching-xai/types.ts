/**
 * Extended types for the prompt-caching-xai implementation.
 * These can be merged into @rivetos/types/ChatOptions in the main package.
 */

export interface XAIExtendedChatOptions {
  /** Stable conversation identifier for xAI prompt caching.
   * Use your application's session/conversation ID. Highly recommended
   * for consistent cache hits per xAI best practices.
   */
  conversationId?: string
  // All other ChatOptions fields remain compatible
}
