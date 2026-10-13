import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils.js'

/**
 * shadcn-style Button, remapped to the Rivet tokens (emerald, mono, square in
 * classic; filled / text / outlined pills in material).
 * A small variant/size set — enough for the composer + pickers ported from the
 * android web-ui. No class-variance-authority; the maps are inline.
 */
type Variant = 'default' | 'ghost' | 'outline'
type Size = 'default' | 'sm' | 'icon' | 'icon-xs'

const VARIANTS: Record<Variant, string> = {
  default:
    'bg-em text-on-em hover:bg-em-dim disabled:opacity-40 classic:bg-em-dim classic:hover:bg-em classic:text-bg',
  ghost: 'text-ink-dim hover:bg-ink/8 hover:text-ink classic:hover:bg-panel-2',
  outline:
    'border border-line text-ink hover:bg-ink/6 classic:bg-panel-2 classic:hover:border-em/60',
}

const SIZES: Record<Size, string> = {
  default: 'h-10 px-5 py-2 text-sm classic:h-9 classic:px-4',
  sm: 'h-8 px-3.5 text-sm classic:px-3',
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
        'inline-flex select-none items-center justify-center gap-1.5 rounded-pill font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-em focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:pointer-events-none classic:font-medium classic:focus-visible:ring-1 classic:focus-visible:ring-offset-0',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  )
})
