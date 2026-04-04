/**
 * @rivetos/tool-interaction
 *
 * Interaction tools (todo, ask_user) for RivetOS agents.
 */

export { createTodoTool } from './tools/todo.js'
export { createAskUserTool } from './tools/ask-user.js'

import type { Plugin, PluginConfig } from '@rivetos/types'
import { createTodoTool } from './tools/todo.js'
import { createAskUserTool } from './tools/ask-user.js'

export function createInteractionToolsPlugin(): Plugin {
  return {
    name: '@rivetos/tool-interaction',
    version: '0.1.0',
    description: 'Interaction tools (todo, ask_user)',
    async init(_config: PluginConfig) {},
    getTools() {
      return [createTodoTool(), createAskUserTool()]
    },
    async shutdown() {},
  }
}
