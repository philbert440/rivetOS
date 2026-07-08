import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef, type ReactNode } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '../../lib/utils.js'

/**
 * shadcn-style Popover over Radix — the picker surface for effort / model /
 * node. Radix renders a portaled <div>, not a native control, so it styles
 * correctly in the WebKitGTK desktop shell (unlike native <select>, which is
 * why the pickers moved off it).
 */
export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export const PopoverContent = forwardRef<
  ComponentRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, align = 'center', sideOffset = 6, ...props }, ref) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-lg border border-line bg-panel-2 text-ink shadow-xl outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
})

export function PopoverHeader({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}): ReactNode {
  return <div className={cn('flex flex-col gap-1', className)}>{children}</div>
}

export function PopoverTitle({ children }: { children: ReactNode }): ReactNode {
  return <div className="text-sm font-medium text-ink">{children}</div>
}

export function PopoverDescription({ children }: { children: ReactNode }): ReactNode {
  return <div className="text-xs text-ink-dim">{children}</div>
}
