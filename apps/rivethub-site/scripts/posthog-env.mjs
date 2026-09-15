/** Resolve public PostHog env for the rivethub.io static build. */

const DEFAULT_HOST = 'https://us.i.posthog.com';

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
