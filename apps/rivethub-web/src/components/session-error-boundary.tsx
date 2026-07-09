import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react'

/**
 * Catches render errors inside a conversation so a single bad session can't
 * take over the whole shell with a minified React crash (no way back without
 * killing the app). Shows a recover control that clears selection.
 */
export class SessionErrorBoundary extends Component<
  {
    sessionId: string
    onClose: () => void
    children: ReactNode
  },
  { error?: Error }
> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ActiveSession crashed', this.props.sessionId, error, info.componentStack)
  }

  componentDidUpdate(prev: { sessionId: string }): void {
    // New conversation after a crash — clear the error so the next one can mount.
    if (prev.sessionId !== this.props.sessionId && this.state.error) {
      this.setState({ error: undefined })
    }
  }

  render(): JSX.Element | ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8">
          <div className="font-mono text-sm font-semibold text-red">conversation crashed</div>
          <p className="max-w-md text-center text-sm text-ink-dim">
            Something went wrong rendering this chat. You can go back to the list without quitting
            the app.
          </p>
          <pre className="max-w-lg overflow-auto rounded border border-line bg-panel-2 p-3 font-mono text-[11px] text-ink-dim">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: undefined })
              this.props.onClose()
            }}
            className="rounded border border-em px-3 py-1.5 font-mono text-sm text-em hover:bg-em-dim/20"
          >
            back to conversations
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
