# rivethub.org

Community index for philbert440/rivetOS. Independent static site. Canonical origin https://rivethub.org/.

Build:

```sh
node apps/rivethub-org/scripts/build.mjs
# or
npx nx build rivethub-org
```

Output: `apps/rivethub-org/dist`. Pages are generated from in-repo plugins, `docs/examples/`, and `integrations/` READMEs. Starter-kit ideas that only appear as Nx generator examples in CONTRIBUTING.md are labeled Proposal. Extra community policy is labeled DRAFT.

Shared chrome lives in `apps/public-sites/`. Preview:

```sh
python3 -m http.server 8773 --directory apps/rivethub-org/dist
```
