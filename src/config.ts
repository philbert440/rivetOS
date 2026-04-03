/**
 * Config Loader — reads YAML config, validates schema, resolves env vars, returns typed config.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { validateConfig, formatValidationResult } from './validate.js';

export interface RivetConfig {
  runtime: {
    workspace: string;
    default_agent: string;
    max_tool_iterations?: number;
    skill_dirs?: string[];
    heartbeats?: Array<{
      agent: string;
      schedule: string;
      timezone?: string;
      prompt: string;
      outputChannel?: string;
      quietHours?: { start: number; end: number };
    }>;
    coding_pipeline?: {
      builder_agent?: string;
      validator_agent?: string;
      max_build_loops?: number;
      max_validation_loops?: number;
      auto_commit?: boolean;
    };
  };
  agents: Record<string, {
    provider: string;
    default_thinking?: string;
  }>;
  providers: Record<string, Record<string, unknown>>;
  channels: Record<string, Record<string, unknown>>;
  memory?: Record<string, Record<string, unknown>>;
  mcp?: {
    servers?: Record<string, {
      transport: 'stdio' | 'streamable-http' | 'sse';
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      url?: string;
      toolPrefix?: string;
      connectTimeout?: number;
      autoReconnect?: boolean;
    }>;
  };
}

export class ConfigValidationError extends Error {
  constructor(public readonly formatted: string) {
    super('Config validation failed');
    this.name = 'ConfigValidationError';
  }
}

/**
 * Load and parse YAML config file.
 * Validates schema (on raw parsed YAML, before env resolution).
 * Resolves ${ENV_VAR} references in string values.
 * Throws ConfigValidationError if validation fails.
 */
export async function loadConfig(path: string): Promise<RivetConfig> {
  const raw = await readFile(path, 'utf-8');
  const parsed = parseYaml(raw);

  // Validate before env resolution — catches structural issues and
  // can warn about missing env vars (${FOO} patterns still present)
  const result = validateConfig(parsed);

  // Log warnings to stderr (non-fatal)
  if (result.warnings.length > 0) {
    for (const warn of result.warnings) {
      console.warn(`[RivetOS] [WARN] [Config] ${warn.path ? `[${warn.path}] ` : ''}${warn.message}`);
    }
  }

  // Fatal errors — refuse to boot
  if (!result.valid) {
    const formatted = formatValidationResult(result);
    console.error(`[RivetOS] [ERROR] [Config] Validation failed:\n${formatted}`);
    throw new ConfigValidationError(formatted);
  }

  return resolveEnvVars(parsed as RivetConfig);
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
