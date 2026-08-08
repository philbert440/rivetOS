/**
 * Default smoke-test tool — a minimal ToolRegistration every mount can
 * serve. Used by the sidecar as its always-present baseline tool and by
 * transport tests to verify end-to-end tool wiring.
 */

import { z } from 'zod'
import type { ToolRegistration } from './registration.js'

export function defaultEchoTool(): ToolRegistration {
  return {
    name: 'echo',
    description:
      'Smoke-test tool. Echoes its input back, prefixed with "echo:". ' +
      'Verifies end-to-end MCP tool wiring.',
    inputSchema: {
      message: z.string().describe('Text to echo back'),
    },
    execute(args) {
      const message = typeof args.message === 'string' ? args.message : ''
      return Promise.resolve(`echo: ${message}`)
    },
  }
}
