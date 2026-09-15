import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { renderPosthogConfig, resolvePosthogEnv } from './posthog-env.mjs';

const source = new URL('../public/', import.meta.url);
const output = new URL('../dist/', import.meta.url);
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

const posthog = resolvePosthogEnv();
await writeFile(new URL('posthog-config.js', output), renderPosthogConfig(posthog));
console.log(
  posthog.key
    ? 'Built RivetHub static site in apps/rivethub-site/dist (PostHog pageviews enabled)'
    : 'Built RivetHub static site in apps/rivethub-site/dist (PostHog pageviews off — no PUBLIC_POSTHOG_KEY)',
);
