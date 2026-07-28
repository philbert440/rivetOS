// HTTP status surface for MicBridge (GET /audio, GET /audio/health).

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MicBridge } from './bridge.js'

export interface AudioHttpDeps {
  bridge: () => MicBridge | null
  enabled: () => boolean
  gateError: () => string
}

const json = (res: ServerResponse, code: number, body: unknown, cors: Record<string, string>): void => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...cors })
  res.end(JSON.stringify(body))
}

/**
 * Handle /audio and /audio/* HTTP routes. Returns true if handled.
 */
export function handleAudioHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AudioHttpDeps,
  cors: Record<string, string>,
): boolean {
  if (url.pathname !== '/audio' && !url.pathname.startsWith('/audio/')) return false

  if (!deps.enabled()) {
    json(
      res,
      503,
      {
        error: deps.gateError() || 'audio mic bridge disabled on this node',
        hint: 'set RIVETOS_DEN_AUDIO=1',
      },
      cors,
    )
    return true
  }

  const bridge = deps.bridge()
  if (!bridge) {
    json(res, 503, { error: 'audio bridge unavailable' }, cors)
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/audio' || url.pathname === '/audio/status')) {
    // Ensure runtime so status.runtimeReady is meaningful after first probe.
    bridge.ensureRuntime()
    json(res, 200, bridge.status(), cors)
    return true
  }

  if (req.method === 'GET' && url.pathname === '/audio/health') {
    const rt = bridge.ensureRuntime()
    const st = bridge.status()
    json(
      res,
      rt.ok ? 200 : 503,
      {
        ok: rt.ok,
        runtimeReady: st.runtimeReady,
        fifoPath: st.fifoPath,
        message: rt.ok ? undefined : rt.message,
      },
      cors,
    )
    return true
  }

  json(res, 404, { error: 'not found' }, cors)
  return true
}
