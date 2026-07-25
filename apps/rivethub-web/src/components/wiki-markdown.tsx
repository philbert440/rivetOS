/**
 * Markdown for wiki topic bodies — GFM via react-markdown, plus in-app routing
 * for /memory/* links (from [[slug]] rewrites).
 */

import { memo, type JSX } from 'react'
import { Link } from '@tanstack/react-router'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternal } from '../lib/open-external.js'
import { wikiLinksToMarkdown } from '../lib/wiki-base.js'
import { cn } from '../lib/utils.js'

// Parallel to chat Markdown components, with in-app /memory/* links.
const WIKI_COMPONENTS: Components = {
  a: ({ className, href, children, ...props }) => {
    if (href && href.startsWith('/memory/')) {
      const slug = href.slice('/memory/'.length).split(/[?#]/)[0] ?? ''
      if (/^[a-z0-9-]{1,80}$/.test(slug)) {
        return (
          <Link
            to="/memory/$slug"
            params={{ slug }}
            className={cn('text-em underline underline-offset-2 hover:text-em-dim', className)}
          >
            {children}
          </Link>
        )
      }
    }
    return (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (href && /^https?:\/\//i.test(href)) {
            e.preventDefault()
            openExternal(href)
          }
        }}
        className={cn('text-em underline underline-offset-2 hover:text-em-dim', className)}
      >
        {children}
      </a>
    )
  },
  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? '')
    if (isBlock) {
      return (
        <code className={cn('font-mono text-[13px]', className)} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[13px] text-em" {...props}>
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border border-line bg-panel p-3 font-mono text-[13px] leading-relaxed">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>,
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-1 mt-2 text-lg font-semibold text-ink">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-2 text-base font-semibold text-ink">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold text-ink">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-em/50 pl-3 text-ink-dim">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line bg-panel px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
  hr: () => <hr className="my-3 border-line" />,
}

export const WikiMarkdown = memo(function WikiMarkdown(props: { children: string }): JSX.Element {
  const src = wikiLinksToMarkdown(props.children)
  return (
    <div className="text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={WIKI_COMPONENTS}>
        {src}
      </ReactMarkdown>
    </div>
  )
})
