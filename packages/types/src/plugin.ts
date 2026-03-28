/**
 * Plugin interface — a loadable extension that provides tools, channels, providers, or memory.
 *
 * All plugin types extend the base Plugin interface. Each adds a factory method
 * for its specific concern:
 *   - ToolPlugin.getTools()       → Tool[]
 *   - ProviderPlugin.createProvider() → Provider
 *   - ChannelPlugin.createChannel()   → Channel
 *   - MemoryPlugin.createMemory()     → Memory
 *
 * Convention: every plugin package exports a `createPlugin(config)` function
 * that returns the appropriate plugin type.
 */

import type { Tool } from './tool.js'
import type { Provider } from './provider.js'
import type { Channel } from './channel.js'
import type { Memory } from './memory.js'

// ---------------------------------------------------------------------------
// Plugin manifest — declared in package.json under "rivetos" field
// ---------------------------------------------------------------------------

export type PluginType = 'provider' | 'channel' | 'tool' | 'memory'

export interface PluginManifest {
  /** Plugin type */
  type: PluginType
  /** Plugin name (used in config to reference this plugin) */
  name: string
  /** Export name of the createPlugin function (default: 'createPlugin') */
  factory?: string
}

// ---------------------------------------------------------------------------
// Base plugin
// ---------------------------------------------------------------------------

/** Runtime config passed to plugin.init() */
export interface PluginConfig {
  [key: string]: unknown
}

export interface Plugin {
  name: string
  version: string
  description?: string
  init(config: PluginConfig): Promise<void>
  shutdown?(): Promise<void>
}

// ---------------------------------------------------------------------------
// Typed plugin variants
// ---------------------------------------------------------------------------

export interface ToolPlugin extends Plugin {
  getTools(): Tool[]
}

export interface ProviderPlugin extends Plugin {
  createProvider(config: PluginConfig): Provider
}

export interface ChannelPlugin extends Plugin {
  createChannel(config: PluginConfig): Channel
}

export interface MemoryPlugin extends Plugin {
  createMemory(config: PluginConfig): Memory
}

// ---------------------------------------------------------------------------
// Backward compat — the original Plugin with optional getTools
// ---------------------------------------------------------------------------

/** @deprecated Use ToolPlugin instead */
export interface LegacyPlugin extends Plugin {
  getTools?(): Tool[]
}
