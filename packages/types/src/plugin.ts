/**
 * Plugin interface — a loadable extension that provides tools, channels, providers, or memory.
 *
 * Self-registration model:
 *   Each plugin package's index.ts exports a `manifest: PluginManifest` const.
 *   Boot discovers plugins via `package.json#rivetos`, dynamic-imports the
 *   package, and calls `manifest.register(ctx)`. The plugin owns its own
 *   config resolution, constructor args, env-var lookup, and shutdown wiring.
 *   Boot has no per-plugin knowledge.
 *
 * The package.json#rivetos descriptor (kind + name) is duplicated in the
 * exported manifest so discovery can find packages without importing them
 * and runtime registration has a typed contract.
 */

import type { Tool } from './tool.js'
import type { Provider } from './provider.js'
import type { Channel } from './channel.js'
import type { Memory } from './memory.js'
import type { HookContext, HookRegistration } from './hooks.js'

// ---------------------------------------------------------------------------
// Plugin descriptor (package.json#rivetos field — used by discovery)
// ---------------------------------------------------------------------------

export type PluginType = 'provider' | 'channel' | 'tool' | 'memory' | 'transport'

/**
 * Static descriptor — what discovery reads out of `package.json#rivetos`.
 * Identifies the plugin without requiring a dynamic import.
 */
export interface PluginDescriptor {
  type: PluginType
  name: string
}

// ---------------------------------------------------------------------------
// Registration context — passed to manifest.register() at boot time.
// Plugins use this to read config, resolve env vars, and register themselves
// with the runtime. Kept minimal and runtime-agnostic so the types package
// stays a leaf.
// ---------------------------------------------------------------------------

export interface PluginLogger {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export interface RegistrationContext {
  /** Full validated runtime config (cast to RivetConfig in boot consumers) */
  readonly config: unknown
  /**
   * Per-plugin config slice. For providers/channels: `config.<kind>s[name]`.
   * For tools/memory/transports: undefined (the plugin reads from `config`
   * directly since its config lives elsewhere — e.g., config.mcp.servers).
   */
  readonly pluginConfig: Record<string, unknown> | undefined
  readonly env: Record<string, string | undefined>
  readonly workspaceDir: string
  readonly logger: PluginLogger

  registerProvider(provider: Provider): void
  registerChannel(channel: Channel): void
  registerTool(tool: Tool): void
  registerMemory(memory: Memory): void
  registerHook<T extends HookContext>(hook: HookRegistration<T>): void
  registerShutdown(fn: () => Promise<void> | void): void

  /**
   * Returns a closure that, when invoked at tool-execution time, looks up
   * `toolName` in the runtime and invokes it. Used by composite tools like
   * coding-pipeline that orchestrate other tools whose registration order
   * is not guaranteed.
   */
  lateBindTool(toolName: string): (args: Record<string, unknown>) => Promise<string>
}

export interface PluginManifest extends PluginDescriptor {
  /**
   * Self-registration entrypoint. Boot calls this once per discovered plugin.
   * The plugin reads its config slice, instantiates whatever it provides,
   * and registers it with the runtime via the context's register* methods.
   */
  register(ctx: RegistrationContext): Promise<void> | void
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
