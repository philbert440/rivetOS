/**
 * Plugin interface — a loadable extension that provides tools, channels, etc.
 */

import type { Tool } from './tool.js';

/** Runtime config passed to plugin.init() */
export interface PluginConfig {
  [key: string]: unknown;
}

export interface Plugin {
  name: string;
  version: string;
  description?: string;
  init(config: PluginConfig): Promise<void>;
  getTools?(): Tool[];
  shutdown?(): Promise<void>;
}
