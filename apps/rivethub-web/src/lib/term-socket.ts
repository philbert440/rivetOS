/**
 * Open a den PTY WebSocket and fail closed if it never reaches OPEN.
 *
 * RivetHub's xterm pane starts as `connecting` and only flips to `attached`
 * on `onopen`. A socket that stays in CONNECTING (wss to a den that waits
 * on a client cert, a hung pipe, a dropped upgrade) left the overlay up
 * forever because there was no onerror and no timeout. This helper is the
 * attach entry point: timeout + close → onClose, same as a real close.
 */

export const TERM_WS_TIMEOUT_MS = 8_000

export interface TermSocketHandle {
  close(): void
}

export interface TermSocketHandlers {
  onOpen: (ws: WebSocket) => void
  onClose: () => void
}

export interface TermSocketDeps {
  /** Injected in tests. Production uses the platform WebSocket. */
  WebSocketImpl?: new (
    url: string,
  ) => Pick<WebSocket, 'readyState' | 'onopen' | 'onclose' | 'onerror' | 'close'>
  timeoutMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

const OPEN = 1

/**
 * Dial `url` (from RivetGateway.terminalWsUrl). `onOpen` fires once at OPEN;
 * `onClose` fires on close, error, or timeout — never both after a successful
 * open's later close is the caller's (they bind ws.onclose themselves).
 */
export function connectTermSocket(
  url: string,
  handlers: TermSocketHandlers,
  deps: TermSocketDeps = {},
): TermSocketHandle {
  const WS = deps.WebSocketImpl ?? WebSocket
  const timeoutMs = deps.timeoutMs ?? TERM_WS_TIMEOUT_MS
  const setT = deps.setTimeoutFn ?? setTimeout
  const clearT = deps.clearTimeoutFn ?? clearTimeout

  let settled = false
  const ws = new WS(url)

  const finishClose = (): void => {
    if (settled) return
    settled = true
    clearT(timer)
    handlers.onClose()
  }

  const timer = setT(() => {
    if (settled) return
    if (ws.readyState !== OPEN) {
      try {
        ws.close()
      } catch {
        /* already dead */
      }
      finishClose()
    }
  }, timeoutMs)

  ws.onopen = () => {
    if (settled) return
    settled = true
    clearT(timer)
    handlers.onOpen(ws as WebSocket)
  }
  ws.onerror = () => {
    try {
      ws.close()
    } catch {
      /* close is best-effort */
    }
  }
  ws.onclose = () => {
    finishClose()
  }

  return {
    close() {
      if (settled) {
        try {
          ws.close()
        } catch {
          /* already closed */
        }
        return
      }
      settled = true
      clearT(timer)
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    },
  }
}
