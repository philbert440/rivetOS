/**
 * Config Loader — reads YAML config, resolves env vars, returns typed config.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

export interface RivetConfig {
  runtime: {
    workspace: string;
    default_agent: string;
    max_tool_iterations?: number;
  };
  agents: Record<string, {
    provider: string;
    default_thinking?: string;
  }>;
  providers: Record<string, Record<string, unknown>>;
  channels: Record<string, Record<string, unknown>>;
  memory?: Record<string, Record<string, unknown>>;
}

/**
 * Load and parse YAML config file.
 * Resolves ${ENV_VAR} references in string values.
 */
export async function loadConfig(path: string): Promise<RivetConfig> {
  const raw = await readFile(path, 'utf-8');
  const parsed = parseYaml(raw) as RivetConfig;
  return resolveEnvVars(parsed);
}

function resolveEnvVars<T>(obj: T): T {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => {
      return process.env[name] ?? '';
    }) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars) as T;
  }
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }
  return obj;
}
