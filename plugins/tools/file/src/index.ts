/**
 * @rivetos/tool-file
 *
 * File read, write, and edit tools for RivetOS agents.
 */

export { createFileReadTool, type FileReadConfig } from './tools/file-read.js'
export { createFileWriteTool } from './tools/file-write.js'
export { createFileEditTool } from './tools/file-edit.js'

import type { ToolPlugin, PluginConfig } from '@rivetos/types'
import { createFileReadTool, type FileReadConfig } from './tools/file-read.js'
import { createFileWriteTool } from './tools/file-write.js'
import { createFileEditTool } from './tools/file-edit.js'

export type FileToolsConfig = FileReadConfig

export function createPlugin(config?: FileToolsConfig): ToolPlugin {
  return {
    name: '@rivetos/tool-file',
    version: '0.1.0',
    description: 'File read, write, and edit tools',
    async init(_config: PluginConfig) {},
    getTools() {
      return [createFileReadTool(config), createFileWriteTool(), createFileEditTool()]
    },
    async shutdown() {},
  }
}

/** @deprecated Use createPlugin() instead */
export const createFileToolsPlugin = createPlugin
