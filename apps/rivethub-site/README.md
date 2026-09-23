# RivetHub website

Source for rivethub.io. The RivetOS documentation website remains in `apps/site`.

The site is plain HTML, CSS, and JavaScript with self-hosted fonts. Edit `public/` directly. The Omarchy page owns its theme independently; shared marketing appearance and the system/light/dark control are loaded only on the other pages.

Build with `npx nx build rivethub-site`, or without installing dependencies:

```sh
node apps/rivethub-site/scripts/build.mjs
```

The build copies `public/` to `dist/` and bakes `PUBLIC_POSTHOG_KEY` /
`PUBLIC_POSTHOG_HOST` (or the `NEXT_PUBLIC_*` house fallbacks) into
`dist/posthog-config.js`. Without a key the tracker is a no-op. Copy
`.env.example` to `.env` for a local bake; CI reads the same names from
GitHub secrets on the Pipeline **Build** job. Production deploys that
publish `dist/` must run this build with those variables set — this repo
does not have a separate site-deploy workflow.

Preview with any static file server, for example:

```sh
python3 -m http.server 8771 --directory apps/rivethub-site/public
```

Serving `public/` directly uses the empty config stub, so pageviews stay
off. Serve `dist/` after a keyed build to exercise PostHog locally.

Named marketing clicks use `data-ph-event` on landing CTAs. `public/posthog.js`
captures only these allowlisted names, plus the page path: `cta_setup_agent`,
`cta_install_local`, `cta_install_server`, `path_local`, `path_datahub`. No
session recording, no form fields, no PII.

Publish the contents of `dist/` to the rivethub.io web root. Release binaries and `releases/latest.json` are maintained by release publishing, not this site build. Preserve that directory when deploying. Without a release feed, the download pages retain their explicitly labelled bundled snapshot.

The Omarchy gallery contains actual desktop captures. Its manifest records themes and capture provenance. The homepage terminal image shows a replay of a saved exchange; its caption identifies it as such.
