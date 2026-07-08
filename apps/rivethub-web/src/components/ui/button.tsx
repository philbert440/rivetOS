import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils.js'

/**
 * shadcn-style Button, remapped to the Rivet tokens (emerald-on-dark, mono).
 * A small variant/size set — enough for the composer + pickers ported from the
 * android web-ui. No class-variance-authority; the maps are inline.
 */
type Variant = 'default' | 'ghost' | 'outline'
type Size = 'default' | 'sm' | 'icon' | 'icon-xs'

const VARIANTS: Record<Variant, string> = {
  default: 'bg-em-dim text-bg hover:bg-em disabled:opacity-40',
  ghost: 'text-ink-dim hover:bg-panel-2 hover:text-ink',
  outline: 'border border-line bg-panel-2 text-ink hover:border-em/60',
}

const SIZES: Record<Size, string> = {
  default: 'h-9 px-4 py-2 text-sm',
  sm: 'h-8 px-3 text-sm',
  icon: 'h-9 w-9',
  'icon-xs': 'h-6 w-6',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size = 'default', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex select-none items-center justify-center gap-1.5 rounded-md font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-em disabled:pointer-events-none',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  )
})
