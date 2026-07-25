/**
 * Long-form wiki markdown — GFM, [[slug]] → /memory/*, heading anchors for TOC.
 */

import { memo, type JSX } from 'react'
import { Link } from '@tanstack/react-router'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternal } from '../lib/open-external.js'
import { headingId, wikiLinksToMarkdown } from '../lib/wiki-base.js'
import { cn } from '../lib/utils.js'

function headingText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(headingText).join('')
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props
    return headingText(props?.children)
  }
  return ''
}

function makeComponents(knownSlugs?: Set<string>): Components {
  return {
    a: ({ className, href, children, ...props }) => {
      if (href && href.startsWith('/memory/')) {
        const slug = href.slice('/memory/'.length).split(/[?#]/)[0] ?? ''
        if (/^[a-z0-9-]{1,80}$/.test(slug)) {
          const missing = knownSlugs ? !knownSlugs.has(slug) : false
          return (
            <Link
              to="/memory/$slug"
              params={{ slug }}
              className={cn(
                'underline underline-offset-2',
                missing ? 'text-red hover:text-red/80' : 'text-em hover:text-em-dim',
                className,
              )}
              title={missing ? 'red link — no article yet' : undefined}
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
          className={cn('text-[#79c0ff] underline underline-offset-2 hover:opacity-90', className)}
        >
          {children}
        </a>
      )
    },
    h2: ({ children }) => {
      const text = headingText(children)
      const id = headingId(text)
      return (
        <h2
          id={id}
          className="mb-2 mt-8 scroll-mt-20 border-b border-line pb-1 text-xl font-semibold text-ink first:mt-0"
        >
          {children}
        </h2>
      )
    },
    h3: ({ children }) => {
      const text = headingText(children)
      const id = headingId(text)
      return (
        <h3 id={id} className="mb-1.5 mt-6 scroll-mt-20 text-base font-semibold text-ink">
          {children}
        </h3>
      )
    },
    h4: ({ children }) => <h4 className="mb-1 mt-4 text-sm font-semibold text-ink">{children}</h4>,
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
        <code
          className="rounded bg-[#161b22] px-1.5 py-0.5 font-mono text-[0.88em] text-em"
          {...props}
        >
          {children}
        </code>
      )
    },
    pre: ({ children }) => (
      <pre className="my-3 overflow-x-auto rounded-md border border-line bg-[#161b22] p-3 font-mono text-[13px] leading-relaxed">
        {children}
      </pre>
    ),
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
    p: ({ children }) => (
      <p className="my-2 text-[15px] leading-relaxed first:mt-0 last:mb-0">{children}</p>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-em/50 pl-3 text-ink-dim">{children}</blockquote>
    ),
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-line bg-panel px-2 py-1.5 text-left font-medium">{children}</th>
    ),
    td: ({ children }) => <td className="border border-line px-2 py-1.5 align-top">{children}</td>,
    hr: () => <hr className="my-6 border-line" />,
  }
}

export const WikiMarkdown = memo(function WikiMarkdown(props: {
  children: string
  /** When set, unknown /memory/slugs render as red links. */
  knownSlugs?: Set<string>
}): JSX.Element {
  const src = wikiLinksToMarkdown(props.children)
  return (
    <div className="wiki-prose max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeComponents(props.knownSlugs)}>
        {src}
      </ReactMarkdown>
    </div>
  )
})
