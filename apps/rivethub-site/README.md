# RivetHub website

Source for rivethub.io. The RivetOS documentation website remains in `apps/site`.

The site is plain HTML, CSS, and JavaScript with self-hosted fonts. Edit `public/` directly. The Omarchy page owns its theme independently; shared marketing appearance and the system/light/dark control are loaded only on the other pages.

Build with `npx nx build rivethub-site`, or without installing dependencies:

```sh
node apps/rivethub-site/scripts/build.mjs
```

Preview with any static file server, for example:

```sh
python3 -m http.server 8771 --directory apps/rivethub-site/public
```

Publish the contents of `dist/` to the rivethub.io web root. Release binaries and `releases/latest.json` are maintained by release publishing, not this site build. Preserve that directory when deploying. Without a release feed, the download pages retain their explicitly labelled bundled snapshot.

The Omarchy gallery contains actual desktop captures. Its manifest records themes and capture provenance. The homepage terminal image shows a replay of a saved exchange; its caption identifies it as such.
