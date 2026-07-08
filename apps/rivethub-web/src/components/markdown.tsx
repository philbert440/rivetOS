import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '../lib/utils.js'

/**
 * Flatten react-markdown children to plain text (fenced code body).
 * Pure — unit-tested so copy always gets the real source string.
 */
export function textFromMarkdownChildren(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromMarkdownChildren).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textFromMarkdownChildren(node.props.children)
  }
  return ''
}

/** language-* class from fenced blocks → short label for the chrome */
export function languageLabel(className: string | undefined): string {
  const m = /language-([\w+-]+)/.exec(className ?? '')
  return m?.[1] ?? 'code'
}

/** Copy text for LAN http:// (non-secure) Hubs where Clipboard API is blocked. */
export function copyTextToClipboard(text: string): Promise<void> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (clip && typeof clip.writeText === 'function') {
    return clip.writeText(text).catch(() => fallbackCopy(text))
  }
  return fallbackCopy(text)
}

function fallbackCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional LAN fallback
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (ok) resolve()
      else reject(new Error('copy failed'))
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/**
 * Fenced code block with copy control (android web-ui pattern, light weight).
 */
function FencedPre(props: { children?: ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const code = textFromMarkdownChildren(props.children).replace(/\n$/, '')

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    }
  }, [])

  let lang = 'code'
  Children.forEach(props.children, (child) => {
    if (isValidElement<{ className?: string }>(child) && child.props.className) {
      lang = languageLabel(child.props.className)
    }
  })

  const copy = (): void => {
    void copyTextToClipboard(code)
      .then(() => {
        setFailed(false)
        setCopied(true)
        if (timerRef.current !== undefined) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        setCopied(false)
        setFailed(true)
        if (timerRef.current !== undefined) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setFailed(false), 1500)
      })
  }

  return (
    <div className="group relative my-2 overflow-hidden rounded-md border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-3 py-1">
        <span className="font-mono text-[10px] text-ink-dim">{lang}</span>
        <button
          type="button"
          onClick={copy}
          className="font-mono text-[10px] text-ink-dim hover:text-em"
          aria-label={failed ? 'copy failed' : copied ? 'copied' : 'copy code'}
        >
          {failed ? 'failed' : copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-ink">
        {props.children}
      </pre>
    </div>
  )
}

/**
 * Markdown for assistant messages — GFM; Rivet tokens; fenced copy.
 */
const COMPONENTS: Components = {
  a: ({ className, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('text-em underline underline-offset-2 hover:text-em-dim', className)}
    />
  ),
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
  pre: ({ children }) => <FencedPre>{children}</FencedPre>,
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

export const Markdown = memo(function Markdown(props: { children: string }): JSX.Element {
  return (
    <div className="text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {props.children}
      </ReactMarkdown>
    </div>
  )
})
