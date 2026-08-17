import type { ReactNode } from 'react'

export function Card({
  title,
  subtitle,
  children,
}: {
  title?: string
  subtitle?: string
  children?: ReactNode
}) {
  return (
    <div className="rounded-xl bg-card p-4">
      {title && <div className="text-[15px] font-medium text-ink">{title}</div>}
      {subtitle && (
        <div className={title ? 'mt-0.5 text-[13px] leading-relaxed text-ink-secondary' : 'text-[13px] leading-relaxed text-ink-secondary'}>
          {subtitle}
        </div>
      )}
      {children && <div className={title || subtitle ? 'mt-4' : undefined}>{children}</div>}
    </div>
  )
}
