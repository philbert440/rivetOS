const DEFAULT_HOST = 'https://us.i.posthog.com';

export const ANALYTICS_URL_PROPS = [
  '$current_url',
  '$initial_current_url',
  '$referrer',
  '$initial_referrer',
  '$session_entry_url',
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
  const next = { ...properties };
  for (const name of ANALYTICS_URL_PROPS) {
    if (typeof next[name] === 'string') {
      next[name] = sanitizeAnalyticsUrl(next[name], base);
    }
  }
  return next;
}
