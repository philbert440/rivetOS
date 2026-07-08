import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/utils.js'

/** Bare styled textarea — the composer owns auto-grow + key handling; this is
 *  just the themed surface (transparent so it sits inside the input shell). */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'w-full resize-none bg-transparent text-sm text-ink outline-none placeholder:text-ink-dim disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
})
