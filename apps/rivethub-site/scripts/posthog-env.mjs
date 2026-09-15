import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_HOST = 'https://us.i.posthog.com';

export const HUB_ENV_FILES = ['.env'];
export const ASTRO_ENV_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
];

const CLICK_IDS =
  /^(gclid|gclsrc|dclid|fbclid|msclkid|twclid|ttclid|li_fat_id|rdt_cid|wbraid|gbraid)$/i;

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
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
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

export function isCampaignProperty(name) {
  const n = String(name);
  if (/(^|_)utm_/i.test(n)) return true;
  if (CLICK_IDS.test(n)) return true;
  return n === '$search_engine';
}

export function isAnalyticsUrlProperty(name) {
  return /url|referrer|href/i.test(String(name));
}

export function sanitizeAnalyticsProperties(properties, base) {
  if (!properties || typeof properties !== 'object') return properties;
  const next = { ...properties };
  for (const name of Object.keys(next)) {
    const value = next[name];
    if (isCampaignProperty(name)) {
      delete next[name];
      continue;
    }
    if ((name === '$set' || name === '$set_once') && value && typeof value === 'object') {
      next[name] = sanitizeAnalyticsProperties(value, base);
      continue;
    }
    if (typeof value === 'string' && isAnalyticsUrlProperty(name)) {
      next[name] = sanitizeAnalyticsUrl(value, base);
    }
  }
  return next;
}
