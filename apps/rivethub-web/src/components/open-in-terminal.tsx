import { useEffect, useRef, useState, type JSX } from 'react'
import type { TermAttachInfo } from '@rivetos/types'
import { SquareTerminal } from 'lucide-react'
import { copyTextToClipboard } from '../lib/clipboard.js'
import {
  canOpenInTerminal,
  fallbackAttachCommand,
  openInExternalTerminal,
} from '../lib/open-in-terminal.js'
import { rivetShell } from '../lib/shell-bridge.js'
import { Button } from './ui/button.js'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from './ui/popover.js'

/**
 * "Open in your terminal" — Electron launches the user's emulator onto the
 * same tmux session; web/mobile show the command with a Copy button.
 * Hidden by the caller when the current PTY has no `attach`.
 */
export function OpenInTerminalButton(props: { attach: TermAttachInfo }): JSX.Element {
  const shell = rivetShell()
  const launch = canOpenInTerminal(shell)
  const [error, setError] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const command = fallbackAttachCommand(props.attach)

  useEffect(() => {
    return () => {
      if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
    }
  }, [])

  const onLaunch = (): void => {
    setError(undefined)
    void openInExternalTerminal(props.attach, shell).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    })
  }

  const onCopy = (): void => {
    setError(undefined)
    void copyTextToClipboard(command)
      .then(() => {
        setCopied(true)
        if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => setCopied(false), 1500)
      })
      .catch((e: unknown) => {
        setCopied(false)
        setError(e instanceof Error ? e.message : String(e))
      })
  }

  if (launch) {
    return (
      <span className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          title="Open in your terminal"
          onClick={onLaunch}
          className="h-7 px-2 font-mono text-[11px] font-normal"
        >
          <SquareTerminal className="size-3" aria-hidden />
          Open in your terminal
        </Button>
        {error && (
          <span className="max-w-48 truncate font-mono text-[11px] text-red" title={error}>
            {error}
          </span>
        )}
      </span>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title="Open in your terminal"
          className="h-7 px-2 font-mono text-[11px] font-normal"
        >
          <SquareTerminal className="size-3" aria-hidden />
          Open in your terminal
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <PopoverHeader className="border-b border-line px-3 py-2">
          <PopoverTitle className="text-sm">Open in your terminal</PopoverTitle>
          <PopoverDescription>
            Paste this into a local terminal to attach the same tmux session.
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-2 p-3">
          <code className="block max-h-24 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-panel px-2 py-1.5 font-mono text-[11px] text-ink">
            {command}
          </code>
          <div className="flex items-center justify-end gap-2">
            {error && (
              <span className="max-w-48 truncate font-mono text-[11px] text-red" title={error}>
                {error}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={onCopy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
