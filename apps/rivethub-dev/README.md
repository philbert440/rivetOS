# rivethub.dev

Contributor and plugin docs. Independent static site. Canonical origin https://rivethub.dev/.

This is not the RivetOS docs app. `apps/site` still builds https://rivetos.dev/ via `npx nx build site`. Do not replace that dist with this one.

Build:

```sh
node apps/rivethub-dev/scripts/build.mjs
# or
npx nx build rivethub-dev
```

Output: `apps/rivethub-dev/dist`. Copy is taken from CONTRIBUTING.md, docs/PLUGINS.md, and in-repo plugin/integration paths. Legal text that is not already a repo file is labeled DRAFT / PROPOSED.

Shared chrome lives in `apps/public-sites/`. Preview:

```sh
python3 -m http.server 8774 --directory apps/rivethub-dev/dist
```
