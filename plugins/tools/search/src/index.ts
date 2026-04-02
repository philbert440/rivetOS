/**
 * @rivetos/tool-search
 *
 * File search tools (glob and grep) for RivetOS agents.
 */

export { createSearchGlobTool, type SearchGlobConfig } from './tools/search-glob.js';
export { createSearchGrepTool, type SearchGrepConfig } from './tools/search-grep.js';

import type { Plugin, PluginConfig } from '@rivetos/types';
import { createSearchGlobTool, type SearchGlobConfig } from './tools/search-glob.js';
import { createSearchGrepTool, type SearchGrepConfig } from './tools/search-grep.js';

export interface SearchToolsConfig extends SearchGlobConfig, SearchGrepConfig {}

export function createSearchToolsPlugin(config?: SearchToolsConfig): Plugin {
  return {
    name: '@rivetos/tool-search',
    version: '0.1.0',
    description: 'File search tools (glob and grep)',
    async init(_config: PluginConfig) {},
    getTools() {
      return [
        createSearchGlobTool(config),
        createSearchGrepTool(config),
      ];
    },
    async shutdown() {},
  };
}
