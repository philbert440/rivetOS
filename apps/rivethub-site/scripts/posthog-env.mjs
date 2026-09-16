import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const DEFAULT_HOST = 'https://us.i.posthog.com';

export const HUB_ENV_FILES = ['.env'];
export const ASTRO_ENV_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
];

export const PAGEVIEW_ALLOWLIST = [
  'token',
  'distinct_id',
  '$current_url',
  '$pathname',
  '$host',
  '$referring_domain',
  '$browser',
  '$browser_version',
  '$browser_language',
  '$os',
  '$os_version',
  '$device_type',
  '$screen_height',
  '$screen_width',
  '$viewport_height',
  '$viewport_width',
  '$lib',
  '$lib_version',
  '$insert_id',
  '$time',
  '$timestamp',
  '$sent_at',
  '$session_id',
];

export function resolvePosthogEnv(env = process.env) {
  const key = String(env.PUBLIC_POSTHOG_KEY || env.NEXT_PUBLIC_POSTHOG_KEY || '').trim();
  const host = String(
    env.PUBLIC_POSTHOG_HOST || env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_HOST,
  ).trim() || DEFAULT_HOST;
  return { key, host };
}

export function renderPosthogConfig({ key, host }) {
  return (
    `window.RIVET_POSTHOG_KEY = ${JSON.stringify(key)};\n` +
    `window.RIVET_POSTHOG_HOST = ${JSON.stringify(host)};\n`
  );
}

export function parseEnvFile(text) {
  return parseEnv(text);
}

export function resolveProjectPosthogEnv(root, env = process.env, files = HUB_ENV_FILES) {
  const fromFiles = {};
  for (const name of files) {
    const file = resolve(root, name);
    if (!existsSync(file)) continue;
    Object.assign(fromFiles, parseEnvFile(readFileSync(file, 'utf8')));
  }
  const merged = { ...fromFiles };
  for (const [name, value] of Object.entries(env)) {
    if (value) merged[name] = value;
  }
  return resolvePosthogEnv(merged);
}

export function posthogCacheDigest(root, env = process.env, files = HUB_ENV_FILES) {
  return createHash('sha256')
    .update(JSON.stringify(resolveProjectPosthogEnv(root, env, files)))
    .digest('hex');
}

export function sanitizeAnalyticsUrl(raw, base = 'https://rivethub.io') {
  try {
    const parsed = new URL(String(raw), base);
    return parsed.origin + parsed.pathname;
  } catch {
    const text = String(raw);
    const cut = text.search(/[?#]/);
    return cut === -1 ? text : text.slice(0, cut);
  }
}

export function sanitizeAnalyticsProperties(properties, base) {
  if (!properties || typeof properties !== 'object') return properties;
  const next = {};
  for (const name of PAGEVIEW_ALLOWLIST) {
    if (!Object.hasOwn(properties, name)) continue;
    const value = properties[name];
    next[name] =
      name === '$current_url' && typeof value === 'string'
        ? sanitizeAnalyticsUrl(value, base)
        : value;
  }
  return next;
}
