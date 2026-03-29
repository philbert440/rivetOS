/**
 * Markdown → Telegram HTML converter.
 *
 * Converts standard markdown (as produced by LLMs) into Telegram's
 * supported HTML subset. Handles: bold, italic, strikethrough,
 * inline code, code blocks, links, and escaping.
 *
 * Telegram HTML supports: <b>, <i>, <s>, <code>, <pre>, <a href="">,
 * <blockquote>, <tg-spoiler>. Everything else is stripped or escaped.
 */

// ---------------------------------------------------------------------------
// HTML Escaping
// ---------------------------------------------------------------------------

/** Escape HTML entities (must run FIRST, before inserting any tags) */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Block-Level Processing
// ---------------------------------------------------------------------------

interface Block {
  type: 'code' | 'text';
  lang?: string;
  content: string;
}

/** Split text into code blocks and text blocks */
function extractBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Text before this code block
    if (match.index > lastIndex) {
      blocks.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    blocks.push({ type: 'code', lang: match[1] || undefined, content: match[2] });
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  if (lastIndex < text.length) {
    blocks.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Inline Processing
// ---------------------------------------------------------------------------

/** Convert inline markdown to HTML within a text block (already escaped) */
function processInline(text: string): string {
  // Inline code (must go first — content inside backticks should not be processed)
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold + italic (***text*** or ___text___)
  text = text.replace(/\*{3}(.+?)\*{3}/g, '<b><i>$1</i></b>');
  text = text.replace(/_{3}(.+?)_{3}/g, '<b><i>$1</i></b>');

  // Bold (**text** or __text__)
  text = text.replace(/\*{2}(.+?)\*{2}/g, '<b>$1</b>');
  text = text.replace(/_{2}(.+?)_{2}/g, '<b>$1</b>');

  // Italic (*text* or _text_) — be careful not to match mid-word underscores
  text = text.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '<i>$1</i>');
  text = text.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough (~~text~~)
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return text;
}

/** Convert markdown headings to bold lines */
function processHeadings(text: string): string {
  return text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
}

/** Convert markdown lists to Telegram-friendly format */
function processLists(text: string): string {
  // Unordered: - item or * item → • item
  text = text.replace(/^(\s*)[-*]\s+/gm, '$1• ');
  return text;
}

/** Convert blockquotes */
function processBlockquotes(text: string): string {
  // Match consecutive lines starting with >
  return text.replace(/(?:^&gt;\s?.+$\n?)+/gm, (match) => {
    const content = match
      .split('\n')
      .map((line) => line.replace(/^&gt;\s?/, ''))
      .join('\n')
      .trim();
    return `<blockquote>${content}</blockquote>\n`;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert markdown text to Telegram HTML.
 * Safe for use with parse_mode: 'HTML'.
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return '';

  const blocks = extractBlocks(markdown);
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'code') {
      // Code blocks: escape HTML inside, wrap in <pre>
      const escaped = escapeHtml(block.content.trimEnd());
      if (block.lang) {
        parts.push(`<pre><code class="language-${block.lang}">${escaped}</code></pre>`);
      } else {
        parts.push(`<pre>${escaped}</pre>`);
      }
    } else {
      // Text blocks: escape first, then process markdown
      let text = escapeHtml(block.content);
      text = processHeadings(text);
      text = processBlockquotes(text);
      text = processLists(text);
      text = processInline(text);
      parts.push(text);
    }
  }

  return parts.join('');
}
