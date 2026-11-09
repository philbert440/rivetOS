# Public family sites

Shared registry and chrome for three independent static sites:

| Domain | Nx project | Source | Dist | Canonical |
| --- | --- | --- | --- | --- |
| rivethub.io | `rivethub-site` | `apps/rivethub-site` | `apps/rivethub-site/dist` | https://rivethub.io/ |
| rivethub.org | `rivethub-org` | `apps/rivethub-org` | `apps/rivethub-org/dist` | https://rivethub.org/ |
| rivethub.dev | `rivethub-dev` | `apps/rivethub-dev` | `apps/rivethub-dev/dist` | https://rivethub.dev/ |

RivetOS docs stay on `apps/site` (`nx site`, dist `apps/site/dist`, canonical https://rivetos.dev/). That app is not retargeted here.

## Build

No analytics keys are required.

```sh
node apps/rivethub-site/scripts/build.mjs
node apps/rivethub-org/scripts/build.mjs
node apps/rivethub-dev/scripts/build.mjs
```

Or:

```sh
npx nx build rivethub-site
npx nx build rivethub-org
npx nx build rivethub-dev
node apps/public-sites/build-family.mjs
```

Tests:

```sh
node --test apps/public-sites/*.test.mjs
node --test apps/rivethub-site/scripts/*.test.mjs
```

Pack hashed trees for transfer (gitignored `artifacts/`):

```sh
node apps/public-sites/pack-artifacts.mjs
```

## Deploy notes from this repo

- Publish each `dist/` to that domain's web root. Canonical URLs are baked into the HTML.
- For rivethub.io, preserve an existing `releases/` directory. That feed is not produced by this build. See `apps/rivethub-site/README.md`.
- Do not publish `apps/rivethub-dev/dist` over `apps/site/dist`. rivetos.dev remains the `nx site` output.
- Hosts, Caddy routes, and rsync jobs are not in this repository.

## Data

`family.mjs` is the site list. `catalog.mjs` scans `plugins/*/*/package.json#rivetos`, `docs/examples/*.yaml`, and `integrations/**/README.md`. Generator examples from CONTRIBUTING.md are stored as proposals, not as shipped packages.
