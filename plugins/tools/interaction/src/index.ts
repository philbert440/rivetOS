/**
 * @rivetos/tool-interaction
 *
 * Interaction tools (todo, ask_user) for RivetOS agents.
 */

export { createTodoTool } from './tools/todo.js';

import type { Plugin, PluginConfig } from '@rivetos/types';
import { createTodoTool } from './tools/todo.js';

export function createInteractionToolsPlugin(): Plugin {
  return {
    name: '@rivetos/tool-interaction',
    version: '0.1.0',
    description: 'Interaction tools (todo)',
    async init(_config: PluginConfig) {},
    getTools() {
      return [
        createTodoTool(),
      ];
    },
    async shutdown() {},
  };
}
